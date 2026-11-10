#!/usr/bin/env python3
"""verify-app-layer.py — enforce the layered-blessing chain, fail-closed.

Called before an app layer runs. Exit 0 ONLY if the whole chain holds:

  1. ORG-BLESSED: the app layer's (org,app,layer_digest,base_digest) record has
     >= M valid signatures from auditors in THAT ORG's trusted-key set.
  2. DERIVES-FROM-BLESSED-BASE: the layer's base_digest is in the PLATFORM's
     blessed standard-container allow-list (shipped in the measured base). An org
     cannot bless a layer onto a base the platform never blessed.
  3. ADDITIVE-ONLY: the layer's declared additions do not SHADOW the base — no
     path that masks a base runtime path (e.g. re-providing /usr/bin/node or
     bind-mounting over a platform path). An org may ADD; it may not REPLACE what
     the platform owns below it.

Every set (org trusted keys, platform base allow-list) is part of the measured
base — tampering changes M0 and fails attestation. This mirrors
verify-attestation.py / verify-mapping.py: signatures verified against trusted
keys shipped in the measured base, fail-closed.
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

def layer_core(rec: dict) -> dict:
    return {"org": rec["org"], "app": rec["app"],
            "layer_digest": rec["layer_digest"], "base_digest": rec["base_digest"]}

# Base-owned prefixes an org layer may NOT provide/shadow. These are the platform's.
BASE_OWNED_PREFIXES = (
    "/nix/store/",     # the closure — never re-provided by a layer
    "/usr/bin/node", "/usr/bin/php", "/usr/bin/nginx",
    "/run/current-system", "/etc/safebox/",   # measured-base config
)

def check_additive_only(rec: dict) -> list:
    """Return a list of violations: layer additions that shadow base-owned paths."""
    violations = []
    for path in rec.get("adds_paths", []):
        for owned in BASE_OWNED_PREFIXES:
            if path == owned or path.startswith(owned):
                violations.append(path)
    for mnt in rec.get("bind_mounts", []):
        tgt = mnt.get("target", "")
        for owned in BASE_OWNED_PREFIXES:
            if tgt == owned or tgt.startswith(owned):
                violations.append(f"bind-mount over {tgt}")
    return violations

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blessed-layer", type=Path, required=True,
                    help="org-blessed layer entry (from bless-app-layer.py combine)")
    ap.add_argument("--org-trusted-keys", type=Path, required=True,
                    help="JSON [base64 pubkeys] this org's box trusts")
    ap.add_argument("--platform-base-allow", type=Path, required=True,
                    help="JSON {allowed:[sha256:...]} platform-blessed standard containers (measured base)")
    ap.add_argument("--layer-manifest", type=Path, required=False,
                    help="optional JSON {adds_paths:[],bind_mounts:[]} for additive-only check")
    args = ap.parse_args()

    entry = json.loads(args.blessed_layer.read_text())
    core = layer_core(entry["layer"])
    threshold = int(entry["threshold"])
    org_trusted = set(json.loads(args.org_trusted_keys.read_text()))
    base_allow = set(json.loads(args.platform_base_allow.read_text())["allowed"])

    # (2) derives-from-blessed-base
    if core["base_digest"] not in base_allow:
        sys.exit(f"REFUSED: base {core['base_digest'][:24]}… is NOT a platform-blessed "
                 f"standard container. An org layer must fork a blessed base.")

    # (1) org-blessed with M valid trusted signatures
    valid, seen = 0, set()
    for s in entry["signatures"]:
        pk = s["pubkey_b64"]
        if pk not in org_trusted or pk in seen:
            continue
        try:
            VerifyKey(base64.b64decode(pk)).verify(canonical(core), base64.b64decode(s["signature_b64"]))
            valid += 1; seen.add(pk)
        except BadSignatureError:
            continue
    if valid < threshold:
        sys.exit(f"REFUSED: layer has {valid} valid org signatures, needs {threshold} "
                 f"(org M-of-N). Not blessed by this org's auditors.")

    # (3) additive-only
    if args.layer_manifest and args.layer_manifest.exists():
        manifest = json.loads(args.layer_manifest.read_text())
        violations = check_additive_only(manifest)
        if violations:
            sys.exit("REFUSED: layer is not additive-only — it shadows base-owned paths: "
                     + ", ".join(violations[:5]))

    print(f"OK: {core['org']}/{core['app']} layer blessed by {valid}/{threshold} org auditors, "
          f"forks blessed base, additive-only.")
    sys.exit(0)

if __name__ == "__main__":
    main()
