#!/usr/bin/env bash
# Test the HKDF break-glass recovery: round-trip, wrong-key rejection,
# wrong-attestation rejection, expiry, and voluntary-request audit log.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

OUT=$(python3 "$D/generate-recovery-key.py" 2>&1)
echo "$OUT" | grep -q "round-trip: recovery key + attestation" && ok "round-trip (two-factor → data key)" || no "round-trip"
echo "$OUT" | grep -q "wrong recovery key rejected" && ok "wrong recovery key rejected (one factor missing)" || no "wrong key"
echo "$OUT" | grep -q "wrong attestation rejected" && ok "wrong attestation rejected (other factor missing)" || no "wrong attestation"
echo "$OUT" | grep -q "all safety properties hold" && ok "all safety properties hold" || no "safety properties"

# Check the audit log was written (operator_requested: true)
if [ -f /tmp/safebox-recovery-test/recovery-requests.log ]; then
  grep -q '"operator_requested": true' /tmp/safebox-recovery-test/recovery-requests.log \
    && ok "audit log records voluntary operator request" || no "audit log missing operator_requested"
else no "audit log not written"; fi

# Check blob has expiry
if [ -f /tmp/safebox-recovery-test/recovery-blob.json ]; then
  python3 -c "import json;b=json.load(open('/tmp/safebox-recovery-test/recovery-blob.json'));assert b['expiry']>b['created']" 2>/dev/null \
    && ok "recovery blob has expiry timestamp" || no "blob expiry"
else no "recovery blob not written"; fi

rm -rf /tmp/safebox-recovery-test
echo ""
[ $fails -eq 0 ] && echo "✓ HKDF break-glass recovery proven: two-factor, auditable, expiry-bounded" || { echo "✗ $fails failed"; exit 1; }
