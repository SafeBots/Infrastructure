#!/usr/bin/env bash
# test-mapping-approval.sh — prove the M-of-N gate: blessed mapping passes,
# unblessed/under-threshold/untrusted-signer all refused. Self-contained.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

# 3 auditor keypairs (seeds), collect their pubkeys
python3 - "$T" <<'PY'
import sys, base64, json
from nacl.signing import SigningKey
T=sys.argv[1]; pubs=[]
for i in (1,2,3):
    sk=SigningKey.generate()
    open(f"{T}/auditor{i}.seed","w").write(base64.b64encode(bytes(sk)).decode())
    pubs.append(base64.b64encode(sk.verify_key.encode()).decode())
json.dump(pubs, open(f"{T}/trusted.json","w"))
# an untrusted 4th auditor
sk4=SigningKey.generate()
open(f"{T}/auditor4.seed","w").write(base64.b64encode(bytes(sk4)).decode())
PY

# the mapping we want to approve
cat > "$T/mapping.json" <<J
{"kind":"s3","bucket":"safebox-cold-prod","endpoint":null,"prefix":"safebox"}
J

sign(){ python3 "$HERE/bless-mapping.py" sign --mapping "$T/mapping.json" \
        --signing-key "$T/$1.seed" --signer "$2" 2>/dev/null > "$T/sig-$2.json"; }

# --- Case 1: 2-of-3 blessed -> gate PASSES ---
sign auditor1 a1; sign auditor2 a2
python3 "$HERE/bless-mapping.py" combine --signatures "$T/sig-a1.json" "$T/sig-a2.json" \
   --threshold 2 2>/dev/null > "$T/blessed.json"
# put it in a blessed-SET (array)
python3 -c "import json;json.dump([json.load(open('$T/blessed.json'))],open('$T/set.json','w'))"
if python3 "$HERE/verify-mapping.py" --mapping "$T/mapping.json" \
     --blessed-set "$T/set.json" --trusted-keys "$T/trusted.json" >/dev/null 2>&1; then
  ok "blessed 2-of-3 mapping is accepted"; else no "blessed mapping rejected"; fi

# --- Case 2: a DIFFERENT bucket (not blessed) -> REFUSED ---
cat > "$T/other.json" <<J
{"kind":"s3","bucket":"attacker-exfil-bucket","endpoint":null,"prefix":"safebox"}
J
if python3 "$HERE/verify-mapping.py" --mapping "$T/other.json" \
     --blessed-set "$T/set.json" --trusted-keys "$T/trusted.json" >/dev/null 2>&1; then
  no "unblessed bucket was accepted (HOLE!)"; else ok "unblessed bucket is refused"; fi

# --- Case 3: only 1 signature but threshold 2 -> REFUSED ---
python3 "$HERE/bless-mapping.py" combine --signatures "$T/sig-a1.json" \
   --threshold 2 2>/dev/null > "$T/under.json" || true
if [ -s "$T/under.json" ]; then
  python3 -c "import json;json.dump([json.load(open('$T/under.json'))],open('$T/underset.json','w'))"
  python3 "$HERE/verify-mapping.py" --mapping "$T/mapping.json" \
     --blessed-set "$T/underset.json" --trusted-keys "$T/trusted.json" >/dev/null 2>&1 \
     && no "under-threshold accepted" || ok "under-threshold (1 of 2) refused at combine or verify"
else
  ok "under-threshold refused at combine step"
fi

# --- Case 4: signed by an UNTRUSTED auditor -> REFUSED ---
sign auditor4 a4; sign auditor1 a1b
python3 "$HERE/bless-mapping.py" combine --signatures "$T/sig-a4.json" "$T/sig-a1b.json" \
   --threshold 2 2>/dev/null > "$T/mixed.json"
python3 -c "import json;json.dump([json.load(open('$T/mixed.json'))],open('$T/mixedset.json','w'))"
# only a1 is trusted here; a4 is not -> only 1 valid trusted sig < 2
if python3 "$HERE/verify-mapping.py" --mapping "$T/mapping.json" \
     --blessed-set "$T/mixedset.json" --trusted-keys "$T/trusted.json" >/dev/null 2>&1; then
  no "untrusted-signer counted toward threshold (HOLE!)"; else ok "untrusted signer does not count"; fi

echo ""
[ $fails -eq 0 ] && echo "✓ M-of-N mapping gate proven: blessed passes; unblessed/under/untrusted all refused." \
  || { echo "✗ $fails failed"; exit 1; }
