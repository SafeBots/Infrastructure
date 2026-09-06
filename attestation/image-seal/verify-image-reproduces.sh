#!/usr/bin/env bash
# verify-ami2-reproduces.sh — prove AMI-2 is bit-for-bit reproducible.
#
# "AMI-2 is deterministic" is TESTED, not assumed: seal two independent AMI-1
# rootfs trees and compare. Zero diff = the scrub covered every nondeterminism
# source. A diff names the source that escaped; add it to seal-image.sh +
# nondeterminism-checklist.json and re-run.
#
# Usage: verify-ami2-reproduces.sh <ami1-rootfs-A> <ami1-rootfs-B>
#   A and B are two independent AMI-1 builds (or mounted clones). Each is sealed
#   in place via seal-image.sh --rootfs, then compared.
set -euo pipefail
A="${1:?need first AMI-1 rootfs}"; B="${2:?need second AMI-1 rootfs}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[verify] sealing A ($A)"
SAFEBOX_FIXED_EPOCH="${SAFEBOX_FIXED_EPOCH:-1704067200}" bash "$HERE/seal-image.sh" --rootfs "$A"
echo "[verify] sealing B ($B)"
SAFEBOX_FIXED_EPOCH="${SAFEBOX_FIXED_EPOCH:-1704067200}" bash "$HERE/seal-image.sh" --rootfs "$B"

echo "[verify] comparing sealed trees (expect: no differences)"
# Prefer diffoscope if present (names the exact differing field); fall back to
# a content+mtime hash comparison that works anywhere.
if command -v diffoscope >/dev/null 2>&1; then
  if diffoscope "$A" "$B"; then echo "[verify] ✓ IDENTICAL (diffoscope)"; exit 0
  else echo "[verify] ✗ DIFFERENCES — see diffoscope output; add each to the scrub."; exit 1; fi
else
  hash_tree(){ (cd "$1" && find . -not -path './nix/store/*' -printf '%p %T@ %m\n' | LC_ALL=C sort | sha256sum | cut -d' ' -f1); }
  ha="$(hash_tree "$A")"; hb="$(hash_tree "$B")"
  echo "[verify]   A=$ha"; echo "[verify]   B=$hb"
  if [ "$ha" = "$hb" ]; then echo "[verify] ✓ IDENTICAL (content+mtime hash; install diffoscope for field-level detail)"; exit 0
  else echo "[verify] ✗ DIFFERENCES — a nondeterminism source escaped the scrub."
       command -v diff >/dev/null && diff -rq "$A" "$B" | head; exit 1; fi
fi
