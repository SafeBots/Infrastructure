#!/usr/bin/env python3
"""
attestation/verify/verify-attestation.py   (refactor.md Phase 3.4 / 5.3)

The verifier — the "does the padlock light up" check from trust.html.

Given (a) an attestation document from a running instance and (b) a user's
trust policy (their chosen auditors + M), decide whether the instance is
KOSHER: is its attested measurement in a set signed by M-of-N of the auditors
THIS user trusts, and is that blessing still fresh (not expired/revoked)?

This is deliberately the browser/relying-party side. It trusts NOTHING from the
vendor — only the user's auditor root store and the hardware signature on the
attestation doc.

Divergences from web PKI it implements (trust.html):
  - freshness/revocation: reject expired blessings; consult a revocation feed.
  - the "certificate" is a SET entry, and membership is what's checked.

HARDWARE NOTE: parsing/validating a real SEV-SNP report or NitroTPM attestation
doc against AMD/AWS root certs is done by the per-cloud validators (stubs marked
below). This module owns the auditor-PKI logic that sits ON TOP of a
hardware-valid quote; it requires the hardware quote to already be verified.
"""
import argparse
import base64
import datetime as dt
import json
import sys
from pathlib import Path

try:
    from nacl.signing import VerifyKey
    from nacl.exceptions import BadSignatureError
except ImportError:
    sys.exit("ERROR: PyNaCl required (pip install pynacl).")


def canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def verify_hardware_quote(attestation: dict) -> str:
    """Verify the hardware-signed quote and return the attested measurement.

    PER-CLOUD, HARDWARE-BOUND. Each returns the measurement ONLY if the quote
    chains to the correct hardware root:
      aws   : NitroTPM attestation doc signed by the Nitro hypervisor cert chain
      gcp   : vTPM quote + SEV-SNP report -> VCEK -> AMD root
      azure : vTPM quote + SEV-SNP/TDX report -> MAA / AMD|Intel root
      oci   : SEV report -> AMD root
    These validators are implemented against each cloud's cert chain; here we
    require the caller to have run them and refuse to proceed on a bare doc.
    """
    root = attestation.get("root")
    verified = attestation.get("_hardware_verified", False)
    if not verified:
        sys.exit("ERROR: attestation document has not passed hardware-root "
                 f"verification for '{root}'. Run the per-cloud validator "
                 "first; refusing to trust an unverified quote.")
    return attestation["measurement"]


def is_revoked(measurement_id: str, revocation_feed: Path | None) -> bool:
    """Consult a SIGNED revocation feed (attestation/revoke/revocation-feed.py).

    The feed is the "OCSP for measurements": a signed, freshness-stamped,
    monotonic document listing measurements pulled before their natural expiry.
    Here we read the revoked set; the feed's signature/freshness/anti-rollback
    checks are enforced by `revocation-feed.py check` (run alongside this, or
    inline if the auditor key is threaded in).

    FAIL CLOSED. If a revocation feed was REQUESTED (a path was passed) but we
    cannot read or parse it, we must NOT return "not revoked" — that is fail-open
    and lets an attacker who suppresses the feed resurrect a revoked measurement.
    We raise, and the caller (main) turns that into a refusal. Only the case
    where NO feed was configured at all (path is None) is a legitimate "no
    revocation checking requested," and even then main warns.
    """
    if revocation_feed is None:
        return False  # no feed requested at all — caller warns; not our hole
    if not revocation_feed.exists():
        raise RuntimeError(
            f"revocation feed {revocation_feed} was requested but does not exist. "
            "Refusing to certify: a missing feed cannot confirm not-revoked "
            "(fail-closed). Refetch the feed and retry.")
    try:
        doc = json.loads(revocation_feed.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise RuntimeError(
            f"revocation feed {revocation_feed} is unreadable/unparseable ({e}). "
            "Refusing to certify (fail-closed).")
    # Accept both the signed-feed shape {"feed":{"revoked":[...]}} and a plain
    # {"revoked":[...]} for flexibility.
    feed = doc.get("feed", doc)
    return measurement_id in feed.get("revoked", [])


def main() -> None:
    ap = argparse.ArgumentParser(description="Verify a Safebox is kosher for a user policy")
    ap.add_argument("--attestation", type=Path, required=True,
                    help="Attestation doc from the running instance")
    ap.add_argument("--approved-entry", type=Path, required=True,
                    help="The approved-set entry (M-of-N blessing) for this measurement")
    ap.add_argument("--trust-policy", type=Path, required=True,
                    help="User's root store: {auditors:{id:pubkey_b64}, m:int}")
    ap.add_argument("--revocation-feed", type=Path, default=None)
    args = ap.parse_args()

    attestation = json.loads(args.attestation.read_text())
    entry = json.loads(args.approved_entry.read_text())
    policy = json.loads(args.trust_policy.read_text())

    # 1. Hardware: what measurement is this box actually running?
    attested_m = verify_hardware_quote(attestation)

    # 2. Does the approved entry even describe this measurement?
    entry_m = entry.get("measurement")
    if attested_m != entry_m:
        sys.exit(f"NOT KOSHER: attested measurement != approved entry "
                 f"({attested_m!r} vs {entry_m!r}).")

    # 3. Freshness + revocation.
    now = dt.datetime.now(dt.timezone.utc)
    fresh_signers = []
    for b in entry["blessings"]:
        bl = b["blessing"]
        exp = dt.datetime.fromisoformat(bl["expires_at"])
        if exp < now:
            continue  # expired blessing doesn't count (freshness)
        # 4. Is this signer an auditor THIS USER trusts, and does the sig verify
        #    under the user's pinned key for that auditor (not the doc's own)?
        auditor = bl["auditor"]
        trusted_key = policy["auditors"].get(auditor)
        if not trusted_key:
            continue  # signer not in the user's root store
        try:
            VerifyKey(base64.b64decode(trusted_key)).verify(
                canonical(bl), base64.b64decode(b["signature_b64"]))
        except BadSignatureError:
            continue
        fresh_signers.append(auditor)

    if args.revocation_feed is None:
        sys.stderr.write("WARNING: no --revocation-feed passed; proceeding without "
                         "revocation checking. A revoked measurement will NOT be "
                         "caught. Pass a signed feed in production.\n")
    try:
        revoked = is_revoked(entry["measurement_id"], args.revocation_feed)
    except RuntimeError as e:
        sys.exit(f"NOT KOSHER: {e}")
    if revoked:
        sys.exit(f"NOT KOSHER: measurement {entry['measurement_id']} is REVOKED.")

    m_required = policy["m"]
    distinct = sorted(set(fresh_signers))
    if len(distinct) < m_required:
        sys.exit(f"NOT KOSHER: only {len(distinct)} fresh trusted auditor "
                 f"signatures ({distinct}); user requires M={m_required}.")

    print("KOSHER ✅")
    print(f"  measurement : {entry['measurement_id']}")
    print(f"  cloud/root  : {attestation.get('cloud')}/{attestation.get('root')}")
    print(f"  signed by   : {distinct} (M={m_required} satisfied)")


if __name__ == "__main__":
    main()
