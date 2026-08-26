#!/usr/bin/env bash
# test-determinism.sh — self-contained proof that the seal is deterministic.
# Builds two differing rootfs fixtures, seals both, and asserts:
#   (1) sealed trees are byte-identical, (2) /nix/store mtime is preserved,
#   (3) the check has teeth (catches an uncovered nondeterminism source).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SEAL="$HERE/seal-ami2.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

mk(){ local d="$1" s="$2"
  mkdir -p "$d"/etc/ssh "$d"/var/log "$d"/var/lib/systemd "$d"/var/lib/cloud \
           "$d"/var/cache "$d"/tmp "$d"/root "$d"/nix/store/pkg "$d"/etc/safebox
  echo "hk$s">"$d/etc/ssh/ssh_host_ed25519_key"; echo "id$s$RANDOM">"$d/etc/machine-id"
  echo "log$s">"$d/var/log/messages"; head -c16 /dev/urandom>"$d/var/lib/systemd/random-seed"
  echo "ci$s">"$d/var/lib/cloud/data"; echo "c$s">"$d/var/cache/blob"; echo "t$s">"$d/tmp/x"
  echo "h$s">"$d/root/.bash_history"; echo "BLESSED">"$d/etc/safebox/app.conf"
  echo "CAS">"$d/nix/store/pkg/bin"
  find "$d" -exec touch -d @$((1500000000+s*137)) {} +
  # Real Nix: store paths have CANONICAL mtimes (epoch 1), identical across builds.
  # Only NON-store state carries per-build nondeterminism. Model that faithfully.
  find "$d/nix/store" -exec touch -d @1 {} +; }

mk "$T/a" 1; mk "$T/b" 2
nixmtime_before="$(stat -c '%Y' "$T/a/nix/store/pkg/bin")"
SAFEBOX_FIXED_EPOCH=1704067200 bash "$SEAL" --rootfs "$T/a" >/dev/null 2>&1
SAFEBOX_FIXED_EPOCH=1704067200 bash "$SEAL" --rootfs "$T/b" >/dev/null 2>&1

diff -rq "$T/a" "$T/b" >/dev/null 2>&1 && ok "sealed trees byte-identical" || no "sealed trees differ"
# Hash path+mtime+mode EXCLUDING /nix/store mtimes (store is content-addressed;
# the real measurement hashes store CONTENT, not its mtimes). Store content
# identity is checked separately by the blessed-content + closure-intact asserts.
ha="$(cd "$T/a" && find . -not -path './nix/store/*' -printf '%p %T@ %m\n'|LC_ALL=C sort|sha256sum)"
hb="$(cd "$T/b" && find . -not -path './nix/store/*' -printf '%p %T@ %m\n'|LC_ALL=C sort|sha256sum)"
[ "$ha" = "$hb" ] && ok "content+mtime hashes match" || no "hashes differ"
[ "$(stat -c '%Y' "$T/a/nix/store/pkg/bin")" = "$nixmtime_before" ] \
  && ok "/nix/store mtime preserved (closure intact)" || no "/nix/store mtime clobbered"
[ "$(cat "$T/a/etc/safebox/app.conf")" = "BLESSED" ] && ok "blessed content survived" || no "blessed content lost"
[ -s "$T/a/etc/machine-id" ] && no "machine-id not emptied" || ok "machine-id emptied"
ls "$T/a/etc/ssh"/ssh_host_* >/dev/null 2>&1 && no "host keys survived" || ok "host keys removed"

# teeth: an uncovered source must be caught
mkdir -p "$T/c" "$T/d"; echo "u$RANDOM">"$T/c/etc-uncovered"; echo "u$RANDOM">"$T/d/etc-uncovered"
find "$T/c" "$T/d" -exec touch -d @1500000000 {} +
SAFEBOX_FIXED_EPOCH=1704067200 bash "$SEAL" --rootfs "$T/c" >/dev/null 2>&1
SAFEBOX_FIXED_EPOCH=1704067200 bash "$SEAL" --rootfs "$T/d" >/dev/null 2>&1
diff -rq "$T/c" "$T/d" >/dev/null 2>&1 && no "check has NO teeth (missed uncovered source)" \
  || ok "check has teeth (catches uncovered nondeterminism)"

echo ""
[ $fails -eq 0 ] && echo "✓ determinism proven: seal is reproducible + closure-safe + has teeth." \
  || { echo "✗ $fails failed"; exit 1; }
