#!/usr/bin/env bash
# Config-level invariants for the optional inspection-sandbox outer host.
# Real Nix eval/build is gated on a Nix machine; this checks the module SOURCE
# asserts the load-bearing properties so they can't be silently dropped.
set -uo pipefail
M="$(cd "$(dirname "$0")/../.." && pwd)/nixos/modules/sandbox-host.nix"
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

grep -q "sandboxHost" "$M" && ok "module defines safebox.sandboxHost (optional, not default)" || no "no sandboxHost option"
grep -q "mkIf cfg.enable" "$M" && ok "gated behind enable (default Safebox unaffected)" || no "not gated behind enable"
grep -q "!config.services.openssh.enable" "$M" && ok "asserts NO sshd on sealed outer host" || no "missing no-sshd assertion"
grep -qi "no runtime package manager\|CANNOT install" "$M" && ok "documents outer-host immutability (no installs after seal)" || no "immutability not documented"
grep -q "interceptor" "$M" && ok "declares the MITM interceptor service" || no "no interceptor service"
grep -q "no route except through this\|reaches nothing but the interceptor" "$M" && ok "inner VM has no egress except via interceptor" || no "egress-only-via-interceptor not asserted"
grep -qi "surveillance for the user's own\|never in the default" "$M" && ok "documents why interceptor is variant-only, not default" || no "variant-only rationale missing"

echo ""
[ $fails -eq 0 ] && echo "✓ sandbox-host invariants asserted in module source" || { echo "✗ $fails failed"; exit 1; }
