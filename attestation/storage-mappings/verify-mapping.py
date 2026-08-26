#!/usr/bin/env python3
"""verify-mapping.py — is THIS object-storage mapping blessed by M-of-N auditors?

Called by object-backend.sh before it will read/write a mapping. Exit 0 only if
the requested (kind,bucket,endpoint,prefix) is in the blessed set with >= M valid
signatures from auditors the box trusts. Anything else => exit non-zero => the
backend refuses (fail-closed). Mirrors verify-attestation.py's trust model:
signatures verified against the trusted auditor keys shipped in the measured base.

The blessed set (/etc/safebox/blessed-storage-mappings.json) and the trusted
auditor keys are part of the measured base — tampering with either changes M0 and
fails attestation. So the egress-relaxing decision is measured, not operator-local.
"""
import argparse, base64, json, sys, hashlib
from pathlib import Path
try:
    from nacl.signing import VerifyKey
    from nacl.exceptions import BadSignatureError
except ImportError:
    sys.exit("ERROR: PyNaCl required (pip install pynacl).")

def canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def mapping_core(m: dict) -> dict:
    return {"kind": m["kind"], "bucket": m["bucket"],
            "endpoint": m.get("endpoint"), "prefix": m.get("prefix", "safebox")}

def mapping_id(m: dict) -> str:
    return hashlib.sha256(canonical(mapping_core(m))).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", type=Path, required=True, help="the requested mapping JSON")
    ap.add_argument("--blessed-set", type=Path, required=True, help="blessed-storage-mappings.json (in measured base)")
    ap.add_argument("--trusted-keys", type=Path, required=True, help="JSON [base64 auditor pubkeys] the box trusts")
    args = ap.parse_args()

    requested = json.loads(args.mapping.read_text())
    rid = mapping_id(requested)
    blessed_set = json.loads(args.blessed_set.read_text())
    trusted = set(json.loads(args.trusted_keys.read_text()))

    entry = next((e for e in blessed_set if e.get("mapping_id") == rid), None)
    if entry is None:
        sys.exit(f"REFUSED: mapping {rid[:16]}… is not in the blessed set. "
                 f"An object-storage destination must be M-of-N auditor-approved.")

    core = mapping_core(entry["mapping"])
    threshold = int(entry["threshold"])
    valid = 0
    seen = set()
    for s in entry["signatures"]:
        pk = s["pubkey"]
        if pk not in trusted:      # only auditors the box trusts count
            continue
        if pk in seen:             # no double-counting one auditor
            continue
        try:
            VerifyKey(base64.b64decode(pk)).verify(canonical(core), base64.b64decode(s["signature"]))
            valid += 1; seen.add(pk)
        except BadSignatureError:
            continue

    if valid < threshold:
        sys.exit(f"REFUSED: mapping {rid[:16]}… has {valid} valid trusted signatures, "
                 f"needs {threshold} (M-of-N). Egress destination not approved.")
    print(f"OK: mapping {rid[:16]}… blessed by {valid}/{threshold} auditors.")
    sys.exit(0)

if __name__ == "__main__":
    main()
