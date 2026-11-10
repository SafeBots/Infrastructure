#!/usr/bin/env bash
#
# Safebox image builder — NixOS path (Turn 4).
#
# Replaces the component/dnf model (build-ami.sh) with a per-cloud pipeline over
# the pinned flake. The base is now the whole NixOS closure; system/dnsclient/
# autohost install onto it as Node services (see nixos/PARITY.md).
#
#   build.sh <cloud>        cloud in: aws gcp azure oci ibm alibaba
#
# Steps (each documented; the ones needing real Nix/cloud are marked):
#   1. nix build .#<cloud>-builder       # reproducible SSH-ingress builder image
#   2. launch builder, run seal-image.sh  # remove SSH, normalize nondeterminism
#   3. image the sealed rootfs -> cloud format, register as custom/marketplace img
#   4. record image id + reference measurement
#
# GUARD: this path requires Turn 1 (a committed flake.lock + a nixpkgs pin) to be
# done. If the flake is still on the PIN_ME placeholder, we STOP rather than
# pretend — the old build-ami.sh remains the only proven path until then.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLAKE_DIR="${SCRIPT_DIR}/../../nixos"

CLOUD="${1:?usage: build.sh <aws|gcp|azure|oci|ibm|alibaba>}"
case "$CLOUD" in
  aws)     TARGET="ami-builder" ;;
  gcp)     TARGET="gce-builder" ;;
  azure)   TARGET="azure-builder" ;;
  oci)     TARGET="oci-builder" ;;
  ibm)     TARGET="ibm-builder" ;;
  alibaba) TARGET="alibaba-builder" ;;
  *) echo "unknown cloud: $CLOUD (want: aws gcp azure oci ibm alibaba)" >&2; exit 2 ;;
esac

# --- Turn-1 guard: refuse to run against an unpinned flake -------------------
if grep -q "PIN_ME_TO_A_COMMIT_SHA" "${FLAKE_DIR}/flake.nix"; then
  echo "ERROR: nixos/flake.nix still holds the PIN_ME_TO_A_COMMIT_SHA placeholder." >&2
  echo "       Turn 1 is not done: pin nixpkgs + run 'nix flake lock' first." >&2
  echo "       Until then, the legacy build-ami.sh remains the proven build path." >&2
  exit 3
fi
if [ ! -f "${FLAKE_DIR}/flake.lock" ]; then
  echo "ERROR: nixos/flake.lock missing. Run 'cd nixos && nix flake lock' (Turn 1)." >&2
  exit 3
fi
if ! command -v nix >/dev/null 2>&1; then
  echo "ERROR: 'nix' not found. This path needs a Nix-capable machine (Turn 1/3)." >&2
  exit 3
fi

echo "==> Building Safebox image for ${CLOUD} (flake target .#${TARGET})"
( cd "$FLAKE_DIR" && nix build ".#${TARGET}" )
echo "==> Builder image built. Next: launch it, run attestation/image-seal/seal-image.sh,"
echo "    image the sealed rootfs, and register it. See nixos/TURN3-RUNBOOK.md for the"
echo "    per-cloud register + attest commands."
