#!/usr/bin/env bash
# End-to-end attestation chain test — real Ed25519, no hardware required.
# Exercises: measure record -> M-of-N bless -> combine -> verify.
# The hardware-quote step is gated by _hardware_verified (set by the per-cloud
# validator against a real cert chain); this test sets it to exercise the
# software trust-decision logic. On real hardware, omit that and run the
# per-cloud validator first.
#
# Requires: pynacl  (pip install pynacl --break-system-packages)
set -euo pipefail
cd "$(dirname "$0")/.."
B=bless/bless-measurement.py
V=verify/verify-attestation.py
W=$(mktemp -d)
trap "rm -rf $W" EXIT
pass=0; fail=0
chk(){ if eval "$2"; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }

python3 - "$W" <<'PY'
import base64,sys
from nacl.signing import SigningKey
W=sys.argv[1]
for n in ("auditorA","auditorB"):
    sk=SigningKey.generate()
    open(f"{W}/{n}.sk","w").write(base64.b64encode(bytes(sk)).decode())
    open(f"{W}/{n}.pk","w").write(base64.b64encode(bytes(sk.verify_key)).decode())
PY
cat > $W/measurement.json <<'JSON'
{ "cloud":"aws-nitro","root":"nitrotpm","measurement":{"pcr0":"aa..","pcr4":"bb..","pcr7":"cc.."} }
JSON
python3 $B sign --measurement $W/measurement.json --signing-key-b64 "$(cat $W/auditorA.sk)" --auditor-id auditorA --out $W/blessA.json --valid-days 90 >/dev/null
python3 $B sign --measurement $W/measurement.json --signing-key-b64 "$(cat $W/auditorB.sk)" --auditor-id auditorB --out $W/blessB.json --valid-days 90 >/dev/null
# NOTE: --blessing takes nargs="+", so pass files space-separated after ONE flag.
python3 $B combine --blessing $W/blessA.json $W/blessB.json --m 2 --out $W/entry.json >/dev/null

python3 - "$W" <<'PY'
import json,sys
W=sys.argv[1]; m=json.load(open(f"{W}/measurement.json"))
def att(fn,**kw):
    a={"cloud":m["cloud"],"root":m["root"],"measurement":dict(m["measurement"]),"_hardware_verified":True}
    a.update(kw); json.dump(a,open(f"{W}/{fn}","w"))
att("att.json")
bad=dict(m["measurement"]); bad["pcr0"]="TAMPERED"; att("att-bad.json",measurement=bad)
json.dump({"m":2,"auditors":{a:open(f"{W}/{a}.pk").read().strip() for a in ("auditorA","auditorB")}},open(f"{W}/pol2.json","w"))
json.dump({"m":2,"auditors":{"auditorA":open(f"{W}/auditorA.pk").read().strip()}},open(f"{W}/pol1.json","w"))
mid=json.load(open(f"{W}/entry.json"))["measurement_id"]
json.dump({"revoked":[mid]},open(f"{W}/rev.json","w"))
PY

chk "KOSHER: hw-verified + M=2 trusted fresh signers" \
  "{ python3 $V --attestation $W/att.json --approved-entry $W/entry.json --trust-policy $W/pol2.json 2>&1 || true; } | grep -q 'KOSHER ✅'"
chk "NOT KOSHER: only 1 trusted auditor, requires M=2" \
  "{ python3 $V --attestation $W/att.json --approved-entry $W/entry.json --trust-policy $W/pol1.json 2>&1 || true; } | grep -q 'NOT KOSHER'"
chk "NOT KOSHER: tampered measurement" \
  "{ python3 $V --attestation $W/att-bad.json --approved-entry $W/entry.json --trust-policy $W/pol2.json 2>&1 || true; } | grep -q 'NOT KOSHER'"
chk "NOT KOSHER: revoked measurement" \
  "{ python3 $V --attestation $W/att.json --approved-entry $W/entry.json --trust-policy $W/pol2.json --revocation-feed $W/rev.json 2>&1 || true; } | grep -q 'NOT KOSHER'"
chk "FAIL-CLOSED: requested revocation feed missing must refuse" \
  "{ python3 $V --attestation $W/att.json --approved-entry $W/entry.json --trust-policy $W/pol2.json --revocation-feed $W/does-not-exist.json 2>&1 || true; } | grep -q 'NOT KOSHER'"
chk "REFUSE: bare doc without _hardware_verified" \
  "python3 -c \"import json;a=json.load(open('$W/att.json'));a.pop('_hardware_verified');json.dump(a,open('$W/att-nohw.json','w'))\"; { python3 $V --attestation $W/att-nohw.json --approved-entry $W/entry.json --trust-policy $W/pol2.json 2>&1 || true; } | grep -q 'has not passed hardware-root'"

echo ""; echo "  $pass passed, $fail failed"
[ $fail -eq 0 ]
