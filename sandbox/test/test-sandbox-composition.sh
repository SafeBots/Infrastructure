#!/usr/bin/env bash
# Hardening tests found during the correctness pass:
#  1. base safebox has ZERO sandbox references (ships alone)
#  2. outer host COMPOSES the base (imports hosts/safebox.nix) + adds wrapper
#  3. host.bridgeAddr default == inner.interceptorAddr default (or egress silently breaks)
#  4. flake actually defines .#sandbox-outer and .#sandbox-inner (BUILD.md doesn't lie)
#  5. interceptor service has a real ExecStart (not an invalid empty unit)
set -uo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

# 1. base standalone
if grep -qE "sandbox" "$R/nixos/hosts/safebox.nix" 2>/dev/null; then
  no "base safebox.nix must have NO sandbox references (ships alone)"
else ok "base safebox.nix stands alone (zero sandbox references)"; fi

# 2. outer composes base
grep -q './safebox.nix' "$R/nixos/hosts/sandbox-outer.nix" && ok "outer host imports (composes) the base safebox" || no "outer host does not import the base"
( grep -q 'safebox.sandboxHost' "$R/nixos/hosts/sandbox-outer.nix" && grep -q 'enable = true' "$R/nixos/hosts/sandbox-outer.nix" ) && ok "outer host enables the wrapper on top of the base" || no "outer host does not enable wrapper"

# 3. address consistency (the silent-egress-break bug)
HOST_ADDR=$(grep -A1 'bridgeAddr = lib.mkOption' "$R/nixos/modules/sandbox-host.nix" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
INNER_ADDR=$(grep -A1 'interceptorAddr = lib.mkOption' "$R/nixos/modules/sandbox-inner.nix" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -n "$HOST_ADDR" ] && [ "$HOST_ADDR" = "$INNER_ADDR" ]; then
  ok "interceptor address agrees: host bridge $HOST_ADDR == inner gateway $INNER_ADDR"
else no "ADDRESS MISMATCH: host bridge '$HOST_ADDR' != inner gateway '$INNER_ADDR' (inner would have no egress)"; fi

# 4. flake defines the targets BUILD.md references
grep -q 'sandbox-outer = nixos-generators' "$R/nixos/flake.nix" && ok ".#sandbox-outer defined in flake" || no ".#sandbox-outer missing from flake (BUILD.md would lie)"
grep -q 'sandbox-inner = nixos-generators' "$R/nixos/flake.nix" && ok ".#sandbox-inner defined in flake" || no ".#sandbox-inner missing from flake"

# 5. interceptor has a real ExecStart
grep -q 'ExecStart = "${interceptor}/bin/safebox-interceptor' "$R/nixos/modules/sandbox-host.nix" && ok "interceptor service has a real ExecStart (valid unit)" || no "interceptor ExecStart missing (invalid/no-op unit)"

echo ""
[ $fails -eq 0 ] && echo "✓ composition + consistency proven: base alone, outer composes it, addresses agree, flake targets exist" || { echo "✗ $fails failed"; exit 1; }
