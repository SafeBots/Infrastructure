#!/usr/bin/env python3
"""bless-app-layer.py — ORG-scoped M-of-N approval for one app layer.

The layered-blessing model has two authorities:
  - PLATFORM M-of-N blesses the base closure + the standard app container.
  - ORG M-of-N blesses that org's OWN app layer, built ON TOP of a
    platform-blessed standard container (npm/composer deps installed at build).

This tool is what an ORG auditor runs to sign their app layer's image digest.
It mirrors attestation/bless/bless-measurement.py exactly (detached Ed25519 over
a canonical JSON record) — same PKI, different signer set and different subject:
here the subject is (app_layer_digest, base_digest) and the signers are the ORG's
auditors, not the platform's.

The blessing binds BOTH digests on purpose:
  - app_layer_digest : the org's layer (its code + its installed deps), frozen.
  - base_digest      : the platform-blessed standard container it derives from.
Binding both is what lets app-verify enforce ADDITIVE-ONLY: an org can bless a
layer that sits on top of a blessed base, but cannot bless a layer whose base is
not itself platform-blessed (that check happens at verify time against the
platform allow-list shipped in the measured base).
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

def layer_core(rec: dict) -> dict:
    # The blessing binds EXACTLY these — the org layer and the base it forks from.
    return {
        "org":          rec["org"],
        "app":          rec["app"],
        "layer_digest": rec["layer_digest"],   # sha256:... of the org's app layer
        "base_digest":  rec["base_digest"],     # sha256:... of the platform standard container
    }

def layer_id(rec: dict) -> str:
    return hashlib.sha256(canonical(layer_core(rec))).hexdigest()[:32]

def cmd_sign(args):
    rec = json.loads(args.layer.read_text())
    core = layer_core(rec)
    sk = SigningKey(base64.b64decode(args.signing_key.read_text().strip()))
    sig = sk.sign(canonical(core)).signature
    out = {
        "layer": core,
        "layer_id": layer_id(rec),
        "org_auditor": args.auditor_id,
        "signature_b64": base64.b64encode(sig).decode(),
        "pubkey_b64": base64.b64encode(sk.verify_key.encode()).decode(),
    }
    print(json.dumps(out, indent=2))
    sys.stderr.write(f"[bless-app-layer] org={core['org']} app={core['app']} "
                     f"layer {out['layer_id']} signed by {args.auditor_id}\n")

def cmd_combine(args):
    sigs = [json.loads(p.read_text()) for p in args.signatures]
    ids = {s["layer_id"] for s in sigs}
    if len(ids) != 1:
        sys.exit("ERROR: signatures cover different layers; refusing to combine.")
    blessed = {
        "layer": sigs[0]["layer"],
        "layer_id": sigs[0]["layer_id"],
        "threshold": args.threshold,
        "signatures": [
            {"org_auditor": s["org_auditor"], "signature_b64": s["signature_b64"],
             "pubkey_b64": s["pubkey_b64"]} for s in sigs
        ],
    }
    if len(blessed["signatures"]) < args.threshold:
        sys.exit(f"ERROR: {len(blessed['signatures'])} sigs < threshold {args.threshold}.")
    print(json.dumps(blessed, indent=2))

def main():
    ap = argparse.ArgumentParser(description="ORG M-of-N approval for one app layer.")
    sub = ap.add_subparsers(required=True)
    s = sub.add_parser("sign", help="One org auditor signs one app layer.")
    s.add_argument("--layer", type=Path, required=True,
                   help='JSON {org,app,layer_digest,base_digest}')
    s.add_argument("--signing-key", type=Path, required=True,
                   help="base64 Ed25519 seed (org auditor, off-box)")
    s.add_argument("--auditor-id", required=True)
    s.set_defaults(fn=cmd_sign)
    c = sub.add_parser("combine", help="Combine M org signatures into a blessed layer.")
    c.add_argument("--signatures", type=Path, nargs="+", required=True)
    c.add_argument("--threshold", type=int, required=True)
    c.set_defaults(fn=cmd_combine)
    args = ap.parse_args(); args.fn(args)

if __name__ == "__main__":
    main()
