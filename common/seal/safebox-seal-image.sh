#!/bin/bash
# safebox-seal-image.sh — Transition an audit image into a production image.
#
# The Safebox two-image workflow:
#   1. build-image.sh produces an audit image with SSH enabled and the
#      safebox-audit user so external auditors can log in, inspect every
#      file, run every check in AUDIT.md, and verify the image matches the
#      spec.
#   2. After the audit passes, this script "seals" the image by writing a
#      single flag file: /etc/safebox/sealed.
#   3. The build pipeline patches this ONE file into Image A's raw disk
#      (one block change) and recomputes the dm-verity hash tree to produce
#      Image B. No filesystem rebuild is needed.
#   4. On every subsequent boot of a sealed box, safebox-sealed-boot.service
#      detects the flag and applies production hardening:
#        - masks SSH in the overlay (whiteouts hide the verity-root copies)
#        - kernel.modules_disabled=1 (no new modules for this boot)
#        - hidepid=2 on /proc (processes invisible to non-owners)
#
# This design eliminates all seal-step nondeterminism: the only change
# between Image A and Image B is the content of one file at a known block
# offset, so the verity hash difference is exactly one leaf hash plus
# ~21 Merkle tree interior nodes (for an 8 GB partition).
#
# Usage:  safebox-seal-image.sh --chroot <rootfs>
#
#   --chroot <rootfs>   Write the sealed flag into a chroot directory
#                        (REQUIRED). All paths are interpreted relative to
#                        <rootfs>.
#
# The script is idempotent: running it twice on an already-sealed chroot is
# safe. It exits non-zero on any failure so build pipelines can abort.

set -euo pipefail

CHROOT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --chroot) CHROOT="${2:?--chroot requires a path}"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
done

[[ -n "$CHROOT" ]] || { echo "safebox-seal: FATAL: --chroot <rootfs> is required" >&2; exit 1; }

# All paths are relative to the chroot.
R="${CHROOT%/}"

log()  { echo "safebox-seal: $*"; }
die()  { echo "safebox-seal: FATAL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
[[ -d "${R}" ]] || die "chroot directory ${R} does not exist"
[[ "${R}" != "/" ]] || die "refusing to operate on / (this script runs against a chroot)"
[[ -d "${R}/etc/safebox" ]] || die "${R}/etc/safebox does not exist; is this a Safebox image?"
[[ -f "${R}/opt/safebox/manifests/base.json" ]] || die "base.json manifest missing"

if [[ -f "${R}/etc/safebox/sealed" ]]; then
    log "already sealed (${R}/etc/safebox/sealed exists); nothing to do"
    exit 0
fi

# ---------------------------------------------------------------------------
# Write the sealed flag (deterministic content — no timestamps)
# ---------------------------------------------------------------------------
log "writing sealed flag"
install -d -m 0755 "${R}/etc/safebox"
cat > "${R}/etc/safebox/sealed" <<'SEAL_EOF'
# This file marks the image as sealed. Its presence causes
# safebox-sealed-boot.service to apply production hardening at boot:
#   - SSH masked in the overlay   (whiteouts hide verity-root copies)
#   - kernel.modules_disabled=1   (no new modules after boot)
#   - hidepid=2 on /proc          (process isolation)
#
# The file is the ONLY difference between Image A (audit) and Image B
# (production). SSH, the audit user, and all other audit-time facilities
# remain on the dm-verity root filesystem — they are masked at boot by
# the overlay, not removed from the disk.
#
# Created by: safebox-seal-image.sh
SEAL_EOF
chmod 0444 "${R}/etc/safebox/sealed"

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
log "verifying seal"
[[ -f "${R}/etc/safebox/sealed" ]] || die "sealed flag missing after write"
[[ "$(stat -c '%a' "${R}/etc/safebox/sealed")" == "444" ]] || die "sealed flag permissions are not 0444"

log "seal complete. The sealed flag is the only change to the chroot."
log "On boot, safebox-sealed-boot.service will mask SSH, set kernel.modules_disabled=1, and apply hidepid=2."
