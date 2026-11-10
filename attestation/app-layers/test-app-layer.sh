#!/usr/bin/env bash
# Prove the layered-blessing chain: org-blessed layer on a platform-blessed base
# passes; unblessed base / under-threshold / untrusted-org-signer / base-shadowing
# all refused. Self-contained.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

# 3 org auditor keys + 1 untrusted; platform base allow-list with one blessed base digest
python3 - "$T" <<'PY'
import sys, base64, json
from nacl.signing import SigningKey
T=sys.argv[1]; pubs=[]
for i in (1,2,3):
    sk=SigningKey.generate(); open(f"{T}/org{i}.seed","w").write(base64.b64encode(bytes(sk)).decode())
    pubs.append(base64.b64encode(sk.verify_key.encode()).decode())
json.dump(pubs, open(f"{T}/org-trusted.json","w"))
sk4=SigningKey.generate(); open(f"{T}/org4.seed","w").write(base64.b64encode(bytes(sk4)).decode())  # untrusted
# platform-blessed standard container allow-list
json.dump({"allowed":["sha256:BASEBLESSED0000000000000000000000000000000000000000000000000000000"]},
          open(f"{T}/platform-base-allow.json","w"))
PY

BASE="sha256:BASEBLESSED0000000000000000000000000000000000000000000000000000000"
UNBLESSED_BASE="sha256:ATTACKERBASE000000000000000000000000000000000000000000000000000000"

mklayer(){ # $1=base_digest -> writes layer.json
cat > "$T/layer.json" <<J
{"org":"acme","app":"crm","layer_digest":"sha256:LAYER111111111111111111111111111111111111111111111111111111111111","base_digest":"$1"}
J
}
sign(){ python3 "$HERE/bless-app-layer.py" sign --layer "$T/layer.json" --signing-key "$T/$1.seed" --auditor-id "$2" 2>/dev/null > "$T/sig-$2.json"; }

# --- Case 1: 2-of-3 org-blessed on a PLATFORM-BLESSED base -> PASS ---
mklayer "$BASE"; sign org1 a1; sign org2 a2
python3 "$HERE/bless-app-layer.py" combine --signatures "$T/sig-a1.json" "$T/sig-a2.json" --threshold 2 2>/dev/null > "$T/blessed.json"
echo '{"adds_paths":["/opt/acme/node_modules","/opt/acme/app.js"],"bind_mounts":[]}' > "$T/manifest-ok.json"
if python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/blessed.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" --layer-manifest "$T/manifest-ok.json" >/dev/null 2>&1; then
  ok "org-blessed layer on blessed base, additive-only, accepted"; else no "valid layer rejected"; fi

# --- Case 2: base NOT platform-blessed -> REFUSED ---
mklayer "$UNBLESSED_BASE"; sign org1 b1; sign org2 b2
python3 "$HERE/bless-app-layer.py" combine --signatures "$T/sig-b1.json" "$T/sig-b2.json" --threshold 2 2>/dev/null > "$T/blessed2.json"
if python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/blessed2.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" >/dev/null 2>&1; then
  no "layer on UNBLESSED base accepted (HOLE!)"; else ok "layer forking an unblessed base is refused"; fi

# --- Case 3: only 1 org sig, threshold 2 -> REFUSED ---
mklayer "$BASE"; sign org1 c1
python3 "$HERE/bless-app-layer.py" combine --signatures "$T/sig-c1.json" --threshold 2 2>/dev/null > "$T/under.json" || true
if [ -s "$T/under.json" ]; then
  python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/under.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" >/dev/null 2>&1 \
     && no "under-threshold accepted" || ok "under-threshold (1 of 2) refused"
else ok "under-threshold refused at combine step"; fi

# --- Case 4: signed by UNTRUSTED org auditor -> doesn't count -> REFUSED ---
mklayer "$BASE"; sign org4 d4; sign org1 d1
python3 "$HERE/bless-app-layer.py" combine --signatures "$T/sig-d4.json" "$T/sig-d1.json" --threshold 2 2>/dev/null > "$T/mixed.json"
if python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/mixed.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" >/dev/null 2>&1; then
  no "untrusted org auditor counted (HOLE!)"; else ok "untrusted org auditor does not count"; fi

# --- Case 5: additive-only VIOLATION — layer shadows the base's node -> REFUSED ---
mklayer "$BASE"; sign org1 e1; sign org2 e2
python3 "$HERE/bless-app-layer.py" combine --signatures "$T/sig-e1.json" "$T/sig-e2.json" --threshold 2 2>/dev/null > "$T/blessed5.json"
echo '{"adds_paths":["/usr/bin/node"],"bind_mounts":[]}' > "$T/manifest-bad.json"
if python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/blessed5.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" --layer-manifest "$T/manifest-bad.json" >/dev/null 2>&1; then
  no "layer shadowing base /usr/bin/node accepted (HOLE!)"; else ok "layer shadowing base node is refused (additive-only)"; fi

# --- Case 6: additive-only VIOLATION — bind-mount over /nix/store -> REFUSED ---
echo '{"adds_paths":[],"bind_mounts":[{"target":"/nix/store/xxx-nodejs"}]}' > "$T/manifest-mount.json"
if python3 "$HERE/verify-app-layer.py" --blessed-layer "$T/blessed5.json" --org-trusted-keys "$T/org-trusted.json" \
     --platform-base-allow "$T/platform-base-allow.json" --layer-manifest "$T/manifest-mount.json" >/dev/null 2>&1; then
  no "bind-mount over /nix/store accepted (HOLE!)"; else ok "bind-mount over base store path is refused"; fi

echo ""
[ $fails -eq 0 ] && echo "✓ layered blessing proven: org-blessed+blessed-base+additive-only passes; every violation refused." \
  || { echo "✗ $fails failed"; exit 1; }
