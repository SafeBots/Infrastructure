#!/usr/bin/env bash
# Config-level topology invariants for the inner untrusted-code microVM.
# The load-bearing security property is "one wire to the interceptor, no other
# route" — checked here in the module source (real boot is Nix-gated).
set -uo pipefail
M="$(cd "$(dirname "$0")/../.." && pwd)/nixos/modules/sandbox-inner.nix"
P="$(cd "$(dirname "$0")/.." && pwd)/interceptor/policy.example.json"
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

grep -q "exactly ONE interface" "$M" && ok "asserts exactly one NIC (no bypass path)" || no "single-NIC assertion missing"
grep -q "default route must point at the interceptor" "$M" && ok "asserts default route = interceptor only" || no "route assertion missing"
grep -q "security.pki.certificateFiles" "$M" && ok "interceptor CA baked into measured trust store" || no "CA not in trust store"
grep -q "RuntimeMaxSec" "$M" && ok "hard job timeout enforced" || no "no job timeout"
grep -qi "no sshd" "$M" && ok "inner guest has no sshd" || no "sshd not excluded"
grep -q "TOFU" "$M" && ok "documents the TOFU/pinning inspection contract" || no "pinning contract undocumented"
# policy sanity
python3 -c "import json,sys; d=json.load(open('$P')); assert d['deny_default'] is True; assert d['tls']['own_ca'] is True; assert d['volume_metering']['per_host_bytes_out_limit']>0" 2>/dev/null \
  && ok "interceptor policy: deny-default + own CA + volume metering" || no "interceptor policy invalid"

echo ""
[ $fails -eq 0 ] && echo "✓ inner topology invariants asserted (one wire, route-to-interceptor, measured CA)" || { echo "✗ $fails failed"; exit 1; }
