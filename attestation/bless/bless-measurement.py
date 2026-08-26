#!/usr/bin/env python3
"""
attestation/bless/bless-measurement.py   (refactor.md Phase 3.4 / 5.3)

Turn a pre-computed measurement into a BLESSED measurement: an entry in the
approved-measurement set, signed by M-of-N of the auditors.

This is the PKI issuance step from trust.html — the auditors are the CAs, and a
blessing is the certificate they issue over a measurement. A verifier (or a
browser, Phase 5) accepts an instance iff its attested measurement is in a set
signed by M-of-N of the auditors THAT USER trusts.

The blessing carries the two things that make this PKI, not just a signature:
  - EXPIRY  — freshness, so a once-blessed-now-vulnerable measurement stops
              being kosher (the revocation/freshness hard core, trust.html).
  - a TRANSPARENCY-LOG entry id — so the blessing is publicly auditable and a
              bad auditor is discoverable (Phase 5.3 accountability).

CRYPTO NOTE: this uses detached signatures over a canonical JSON encoding of the
measurement record. The signing keys belong to auditors and live OFF the box.
This tool is what an auditor runs to sign; collecting M signatures is the
governance step. Key management (HSM, threshold sig) is deliberately pluggable —
the record format is the stable contract.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

try:
    from nacl.signing import SigningKey, VerifyKey       # PyNaCl (Ed25519)
    from nacl.exceptions import BadSignatureError
except ImportError:
    sys.exit("ERROR: PyNaCl required (pip install pynacl). "
             "Refusing to fake signatures.")


def canonical(obj: dict) -> bytes:
    """Deterministic bytes for signing — sorted keys, no whitespace drift."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def measurement_id(record: dict) -> str:
    """Stable id for a measurement, used as the transparency-log key."""
    core = {k: record[k] for k in ("cloud", "root") if k in record}
    core["m"] = record.get("measurement") or record.get("pcrs")
    return hashlib.sha256(canonical(core)).hexdigest()[:32]


def cmd_sign(args) -> None:
    record = json.loads(args.measurement.read_text())
    sk = SigningKey(base64.b64decode(args.signing_key_b64))
    blessing = {
        "measurement_id": measurement_id(record),
        "measurement": record.get("measurement") or record.get("pcrs"),
        "cloud": record["cloud"],
        "root": record["root"],
        "blessed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        # Freshness: blessings EXPIRE. A verifier must reject an expired one.
        "expires_at": (dt.datetime.now(dt.timezone.utc)
                       + dt.timedelta(days=args.valid_days)).isoformat(),
        "auditor": args.auditor_id,
    }
    sig = sk.sign(canonical(blessing)).signature
    out = {
        "blessing": blessing,
        "signature_b64": base64.b64encode(sig).decode(),
        "auditor_pubkey_b64": base64.b64encode(bytes(sk.verify_key)).decode(),
    }
    args.out.write_text(json.dumps(out, indent=2))
    print(f"Auditor {args.auditor_id} signed measurement "
          f"{blessing['measurement_id']} (expires {blessing['expires_at']}).")
    print(f"  -> {args.out}")
    print("Collect M such signatures from independent auditors to form the "
          "approved-set entry, then publish to the transparency log.")


def cmd_combine(args) -> None:
    """Combine M single-auditor blessings into one approved-set entry, checking
    that they all bless the SAME measurement and each signature verifies."""
    blessings = [json.loads(p.read_text()) for p in args.blessing]
    ids = {b["blessing"]["measurement_id"] for b in blessings}
    if len(ids) != 1:
        sys.exit(f"ERROR: blessings cover different measurements: {ids}")
    verified = []
    for b in blessings:
        vk = VerifyKey(base64.b64decode(b["auditor_pubkey_b64"]))
        try:
            vk.verify(canonical(b["blessing"]),
                      base64.b64decode(b["signature_b64"]))
        except BadSignatureError:
            sys.exit(f"ERROR: bad signature from auditor "
                     f"{b['blessing']['auditor']}")
        verified.append(b["blessing"]["auditor"])
    if len(set(verified)) < args.m:
        sys.exit(f"ERROR: need M={args.m} DISTINCT auditors, got "
                 f"{len(set(verified))}: {verified}")
    entry = {
        "measurement_id": ids.pop(),
        "measurement": blessings[0]["blessing"]["measurement"],
        "cloud": blessings[0]["blessing"]["cloud"],
        "m_of_n": {"m": args.m, "signers": sorted(set(verified))},
        "blessings": blessings,
    }
    args.out.write_text(json.dumps(entry, indent=2))
    print(f"Approved-set entry formed: measurement {entry['measurement_id']} "
          f"blessed by {len(set(verified))} auditors (M={args.m}).")


def main() -> None:
    ap = argparse.ArgumentParser(description="Bless a Safebox measurement (M-of-N)")
    sub = ap.add_subparsers(required=True)

    s = sub.add_parser("sign", help="One auditor signs one measurement")
    s.add_argument("--measurement", type=Path, required=True)
    s.add_argument("--signing-key-b64", required=True,
                   help="Auditor Ed25519 signing key (base64, 32 bytes)")
    s.add_argument("--auditor-id", required=True)
    s.add_argument("--valid-days", type=int, default=90,
                   help="Freshness window before re-blessing is required")
    s.add_argument("--out", type=Path, required=True)
    s.set_defaults(func=cmd_sign)

    c = sub.add_parser("combine", help="Combine M blessings into an approved entry")
    c.add_argument("--blessing", type=Path, nargs="+", required=True)
    c.add_argument("--m", type=int, required=True)
    c.add_argument("--out", type=Path, required=True)
    c.set_defaults(func=cmd_combine)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
