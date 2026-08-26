#!/usr/bin/env python3
"""bless-mapping.py — M-of-N auditor approval for a SINGLE object-storage mapping.

Turning on the object backend RELAXES the box's egress posture: it opens a
sanctioned high-bandwidth outbound path to a blob store. So it is NOT an operator
config toggle — each concrete mapping (which provider, which bucket, which
endpoint) must be blessed by M-of-N of the auditors, exactly like a measurement.
A mapping the auditors did not sign is refused, fail-closed, at start.

This mirrors attestation/bless/bless-measurement.py: detached Ed25519 signatures
over a canonical JSON encoding. Auditor keys live OFF the box. Collecting M
signatures is the governance step. Per-mapping: re-bless to add a bucket, and a
bucket that was never blessed can never be written to, no matter what config says.
"""
import argparse, base64, json, sys, hashlib
from pathlib import Path
try:
    from nacl.signing import SigningKey, VerifyKey
    from nacl.exceptions import BadSignatureError
except ImportError:
    sys.exit("ERROR: PyNaCl required (pip install pynacl). Refusing to fake signatures.")

def canonical(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def mapping_core(m: dict) -> dict:
    # The blessing binds EXACTLY these fields — the egress destination. Change any
    # (different bucket, different endpoint) => different id => needs re-blessing.
    return {
        "kind":     m["kind"],
        "bucket":   m["bucket"],
        "endpoint": m.get("endpoint"),
        "prefix":   m.get("prefix", "safebox"),
    }

def mapping_id(m: dict) -> str:
    return hashlib.sha256(canonical(mapping_core(m))).hexdigest()

def cmd_sign(args):
    mapping = json.loads(args.mapping.read_text())
    core = mapping_core(mapping)
    mid = mapping_id(mapping)
    sk = SigningKey(base64.b64decode(args.signing_key.read_text().strip()))
    sig = sk.sign(canonical(core)).signature
    entry = {
        "mapping": core,
        "mapping_id": mid,
        "signer": args.signer,
        "signature": base64.b64encode(sig).decode(),
        "pubkey": base64.b64encode(sk.verify_key.encode()).decode(),
    }
    print(json.dumps(entry, indent=2))
    sys.stderr.write(f"[bless-mapping] signed mapping {mid[:16]}… as {args.signer}\n")

def cmd_combine(args):
    # Collect the individual auditor signatures into one blessed-set entry.
    sigs = [json.loads(p.read_text()) for p in args.signatures]
    ids = {s["mapping_id"] for s in sigs}
    if len(ids) != 1:
        sys.exit("ERROR: signatures cover different mappings; refusing to combine.")
    blessed = {
        "mapping": sigs[0]["mapping"],
        "mapping_id": sigs[0]["mapping_id"],
        "threshold": args.threshold,
        "signatures": [
            {"signer": s["signer"], "signature": s["signature"], "pubkey": s["pubkey"]}
            for s in sigs
        ],
    }
    if len(blessed["signatures"]) < args.threshold:
        sys.exit(f"ERROR: {len(blessed['signatures'])} sigs < threshold {args.threshold}.")
    print(json.dumps(blessed, indent=2))

def main():
    ap = argparse.ArgumentParser(description="M-of-N approval for one object-storage mapping.")
    sub = ap.add_subparsers(required=True)
    s = sub.add_parser("sign", help="One auditor signs one mapping.")
    s.add_argument("--mapping", type=Path, required=True, help="JSON {kind,bucket,endpoint?,prefix?}")
    s.add_argument("--signing-key", type=Path, required=True, help="base64 Ed25519 seed (auditor, off-box)")
    s.add_argument("--signer", required=True, help="auditor id")
    s.set_defaults(fn=cmd_sign)
    c = sub.add_parser("combine", help="Combine M signatures into a blessed-set entry.")
    c.add_argument("--signatures", type=Path, nargs="+", required=True)
    c.add_argument("--threshold", type=int, required=True, help="M")
    c.set_defaults(fn=cmd_combine)
    args = ap.parse_args(); args.fn(args)

if __name__ == "__main__":
    main()
