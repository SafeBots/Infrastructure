#!/usr/bin/env python3
"""
attestation/revoke/revocation-feed.py   (refactor.md Phase 5.3 — the hard core)

The "OCSP for measurements" from trust.html. When a vulnerability is found in a
version whose measurement was previously blessed, that measurement must be
UN-blessed — and every verifier must be able to learn this promptly. This is the
freshness/revocation mechanism, and it's the genuinely hard part of the PKI.

Design (three mechanisms, composed — matching trust.html):

1. EXPIRY (already in blessings). Every blessing carries expires_at; a verifier
   rejects expired ones. This bounds staleness even with no active revocation:
   a measurement stops being kosher when its blessings age out, forcing periodic
   re-blessing (which won't happen for a known-bad version). Passive, always-on.

2. ACTIVE REVOCATION (this feed). Auditors publish a SIGNED revocation feed that
   names measurements pulled before their natural expiry. The feed itself is
   freshness-stamped (issued_at + next_update) and signed, so a stale or forged
   feed is detectable. A verifier fetches it, checks the signature against the
   user's trusted auditors, checks it's fresh, then treats listed measurements
   as NOT kosher regardless of unexpired blessings.

3. RE-BLESSING (via bless-measurement.py). The positive counterpart: to KEEP a
   measurement kosher past expiry, auditors re-sign it. A patched-and-re-audited
   version gets fresh blessings; a bad one simply doesn't.

The feed is a signed, monotonic (version-numbered) document. A verifier keeps
the highest version it has seen so a replayed older feed (hiding a revocation)
is rejected — the anti-rollback property that OCSP/CRL systems need.

This is a reference implementation of the FEED CONTRACT. Production hardens the
distribution (witnessed, replicated, gossip) but the signed-freshness-stamped-
monotonic-document contract is the stable core.
"""
import argparse
import base64
import datetime as dt
import json
import sys
from pathlib import Path

try:
    from nacl.signing import SigningKey, VerifyKey
    from nacl.exceptions import BadSignatureError
except ImportError:
    sys.exit("ERROR: PyNaCl required (pip install pynacl).")


def canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def cmd_publish(args) -> None:
    """An auditor publishes/updates their signed revocation feed."""
    prev = json.loads(args.feed.read_text()) if args.feed.exists() else None
    version = (prev["feed"]["version"] + 1) if prev else 1
    revoked = set(prev["feed"]["revoked"]) if prev else set()
    if args.revoke:
        revoked.update(args.revoke)
    if args.unrevoke:                      # e.g. a measurement re-audited as fine
        revoked.difference_update(args.unrevoke)

    feed = {
        "auditor": args.auditor_id,
        "version": version,                # monotonic — anti-rollback
        "issued_at": now().isoformat(),
        # Freshness window: a verifier treats the feed as stale after this and
        # should refetch. Short windows = tighter revocation latency.
        "next_update": (now() + dt.timedelta(hours=args.valid_hours)).isoformat(),
        "revoked": sorted(revoked),
    }
    sk = SigningKey(base64.b64decode(args.signing_key_b64))
    sig = sk.sign(canonical(feed)).signature
    out = {
        "feed": feed,
        "signature_b64": base64.b64encode(sig).decode(),
        "auditor_pubkey_b64": base64.b64encode(bytes(sk.verify_key)).decode(),
    }
    args.feed.write_text(json.dumps(out, indent=2))
    print(f"Published revocation feed v{version} for {args.auditor_id}: "
          f"{len(revoked)} revoked, fresh until {feed['next_update']}.")


def cmd_check(args) -> None:
    """A verifier checks a feed: signature, freshness, anti-rollback — then asks
    whether a given measurement is revoked. Exit 0 = NOT revoked/usable feed;
    exit 3 = REVOKED; other nonzero = feed unusable (treat conservatively)."""
    doc = json.loads(args.feed.read_text())
    policy = json.loads(args.trust_policy.read_text())
    feed = doc["feed"]
    auditor = feed["auditor"]

    trusted_key = policy["auditors"].get(auditor)
    if not trusted_key:
        sys.exit(f"UNUSABLE: feed auditor {auditor} not in user's trust policy.")
    try:
        VerifyKey(base64.b64decode(trusted_key)).verify(
            canonical(feed), base64.b64decode(doc["signature_b64"]))
    except BadSignatureError:
        sys.exit("UNUSABLE: feed signature invalid under the user's pinned key.")

    # Freshness.
    if dt.datetime.fromisoformat(feed["next_update"]) < now():
        sys.exit(f"STALE: feed v{feed['version']} past next_update "
                 f"({feed['next_update']}). Refetch before trusting it.")

    # Anti-rollback: reject a feed older than the highest version seen.
    if args.seen_version is not None and feed["version"] < args.seen_version:
        sys.exit(f"ROLLBACK: feed v{feed['version']} < last seen "
                 f"v{args.seen_version}. Possible replay hiding a revocation.")

    if args.measurement_id and args.measurement_id in feed["revoked"]:
        print(f"REVOKED: {args.measurement_id} is on {auditor}'s feed "
              f"v{feed['version']}.")
        sys.exit(3)
    print(f"OK: feed v{feed['version']} valid & fresh; "
          f"{args.measurement_id or '(no id given)'} not revoked. "
          f"Record seen_version={feed['version']}.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Signed measurement-revocation feed")
    sub = ap.add_subparsers(required=True)

    p = sub.add_parser("publish", help="Auditor publishes/updates their feed")
    p.add_argument("--feed", type=Path, required=True)
    p.add_argument("--auditor-id", required=True)
    p.add_argument("--signing-key-b64", required=True)
    p.add_argument("--revoke", nargs="*", default=[], help="measurement_ids to revoke")
    p.add_argument("--unrevoke", nargs="*", default=[], help="measurement_ids to clear")
    p.add_argument("--valid-hours", type=int, default=6,
                   help="Freshness window; shorter = tighter revocation latency")
    p.set_defaults(func=cmd_publish)

    c = sub.add_parser("check", help="Verifier checks feed + queries a measurement")
    c.add_argument("--feed", type=Path, required=True)
    c.add_argument("--trust-policy", type=Path, required=True)
    c.add_argument("--measurement-id", default=None)
    c.add_argument("--seen-version", type=int, default=None,
                   help="Highest feed version this verifier has already seen")
    c.set_defaults(func=cmd_check)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
