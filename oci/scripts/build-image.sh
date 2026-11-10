#!/bin/bash
#
# build-image.sh - Safebox OCI image builder (Ubuntu 24.04 LTS noble)
#
# Implements the "Build flow" in docs/HARDENING-PLAN.md for OCI. Runs as root
# on a throwaway Ubuntu 24.04 build instance that has a second, empty block
# volume attached. The build instance itself is never captured: the image is
# assembled in a chroot, written to the empty volume as a dm-verity root, and
# that volume is what becomes the OCI custom image.
#
# Why Ubuntu rather than Oracle Linux: the data pool is ZFS and the image
# launches shielded (Secure Boot + measured boot + vTPM), so the ZFS kernel
# module must carry a signature the shim/kernel trust chain accepts. Ubuntu
# is the only distribution that ships distro-signed ZFS modules (in
# linux-modules-extra-*, signed with Canonical's kernel key) for its cloud
# kernels; OL9/UEK would need ZFS built from source and a MOK enrolled in the
# firmware, which a verity root with no console cannot do. The OCI-tuned
# kernel is linux-oracle. Ubuntu uses AppArmor, so there is no SELinux
# relabel step any more.
#
# The build host must itself be Ubuntu 24.04 so debootstrap has the noble
# suite script and ubuntu-keyring's archive keyring without extra plumbing.
#
#   1. preflight        root, host tools, target is an unmounted whole disk
#   2. bootstrap        debootstrap minbase noble into $ROOTFS; write the deb822
#                       apt sources (noble, noble-updates, noble-security)
#   3. chroot installs  install-base.sh, install-system.sh, install-dnsclient.sh,
#                       install-autovhost.sh (each chroot-safe: no service
#                       starts, no TPM, no zpool, no metadata service)
#   4. cleanup          common/image/cleanup-image.sh from the host against $ROOTFS
#   5. two-image flow   (a) verify --audit → build-verity-root → capture audit image
#                       (b) seal chroot → verify → build-verity-root → capture production image
#                       Each capture: raw → qcow2 → Object Storage → image import
#                       with UEFI_64 launch mode (unless --no-capture)
#   6. manifest         $R/manifests/oci-<date>.json (schema v2 with audit + production)
#
# Host packages (the build instance, not the image): debootstrap,
# ubuntu-keyring, gdisk, dosfstools, e2fsprogs, cryptsetup-bin, rsync,
# python3, sudo, util-linux, qemu-utils (qemu-img) and the oci CLI.
#
# Usage:
#   build-image.sh --target /dev/sdb [--components base,system,dnsclient,autovhost]
#                  [--grub-password-hash <grub.pbkdf2.sha512...>]
#                  [--rootfs /mnt/safebox-rootfs] [--no-capture]
#                  [--mirror http://archive.ubuntu.com/ubuntu]
#
# --mirror is the Ubuntu archive used by debootstrap and the chroot's apt.
# Default http://archive.ubuntu.com/ubuntu (or $SAFEBOX_UBUNTU_MIRROR); OCI
# publishes no Ubuntu mirror of its own that we are sure of, so point it at
# whatever is nearest to the build region.
#
# Capture needs these in the environment (or in ~/.oci/config via the CLI):
#   OCI_COMPARTMENT_ID   compartment that receives the image
#   OCI_BUCKET           Object Storage bucket for the qcow2 upload
#   OCI_NAMESPACE        Object Storage namespace (defaults to `oci os ns get`)
#
# Why a chroot and a separate disk instead of "install on this instance and
# snapshot it": the produced root must be bit-for-bit what was hashed, with
# no operator account, no SSH host keys, no cloud-init state, no journal. A
# chroot built from nothing and copied onto an empty disk gives that; a
# snapshot of a running instance never does.

set -euo pipefail
umask 022
export LC_ALL=C

CLOUD=oci
DISTRO_SUITE=noble
DISTRO_LABEL=ubuntu-24.04
KERNEL_PKG=linux-oracle
DEBOOTSTRAP_INCLUDE=systemd,systemd-sysv,dbus,ca-certificates,curl,gnupg,apt-utils
UBUNTU_KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPONENTS_DIR="$SCRIPT_DIR/components"
COMMON="$R/common"

die() {
    echo "build-image: FATAL: $*" >&2
    exit 1
}

log() {
    echo "build-image: $*" >&2
}

usage() {
    cat >&2 <<EOF
usage: $0 --target <block-device> [options]
  --target <dev>               empty, unmounted whole disk that becomes the image (required)
  --components a,b,c           subset of base,system,dnsclient,autovhost,safenet (default: all five;
                               base and system are mandatory)
  --grub-password-hash <hash>  grub.pbkdf2.sha512.* (default: generated, passphrase discarded)
  --rootfs <dir>               chroot directory (default: /mnt/safebox-rootfs)
  --audit-pubkeys <file>       SSH public keys for the safebox-audit user (default: \$AUDIT_PUBKEYS)
  --no-capture                 stop after the verity disk is written
  --mirror <url>               Ubuntu archive mirror (default: http://archive.ubuntu.com/ubuntu)
EOF
    exit 2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
TARGET=""
COMPONENTS="base,system,dnsclient,autovhost,safenet"
GRUB_HASH=""
ROOTFS="/mnt/safebox-rootfs"
CAPTURE=1
MIRROR="${SAFEBOX_UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
AUDIT_PUBKEYS_FILE="${AUDIT_PUBKEYS:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        --target)             TARGET="${2:-}"; shift 2 ;;
        --components)         COMPONENTS="${2:-}"; shift 2 ;;
        --grub-password-hash) GRUB_HASH="${2:-}"; shift 2 ;;
        --rootfs)             ROOTFS="${2:-}"; shift 2 ;;
        --audit-pubkeys)      AUDIT_PUBKEYS_FILE="${2:-}"; shift 2 ;;
        --no-capture)         CAPTURE=0; shift ;;
        --mirror)             MIRROR="${2:-}"; shift 2 ;;
        -h|--help)            usage ;;
        *)                    die "unknown argument: $1" ;;
    esac
done
[ -n "$TARGET" ] || usage

IFS=',' read -r -a COMPONENT_LIST <<< "$COMPONENTS"
has_component() {
    local c
    for c in "${COMPONENT_LIST[@]}"; do [ "$c" = "$1" ] && return 0; done
    return 1
}
for c in "${COMPONENT_LIST[@]}"; do
    case "$c" in
        base|system|dnsclient|autovhost|safenet) ;;
        *) die "unknown component '$c' (allowed: base,system,dnsclient,autovhost,safenet)" ;;
    esac
done
has_component base   || die "component 'base' is mandatory"
has_component system || die "component 'system' is mandatory"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -f "$R/docs/HARDENING-PLAN.md" ] || die "repository root not found at $R"
[ -f "$COMMON/image/build-verity-root.sh" ] || die "$COMMON/image/build-verity-root.sh missing"
[ -f "$COMMON/image/cleanup-image.sh" ] || die "$COMMON/image/cleanup-image.sh missing"
[ -f "$COMMON/image/verify-image.sh" ] || die "$COMMON/image/verify-image.sh missing"
[ -f "$COMMON/seal/safebox-seal-image.sh" ] || die "$COMMON/seal/safebox-seal-image.sh missing"
[ -f "$COMPONENTS_DIR/base/install-base.sh" ] || die "install-base.sh missing"
[ -f "$COMPONENTS_DIR/system/install-system.sh" ] || die "install-system.sh missing"

# The build host must be Ubuntu 24.04: debootstrap takes the noble suite
# script and the archive keyring from the host's own packages, and the
# chroot's dpkg database is then written by a compatible dpkg.
# shellcheck disable=SC1091
HOST_ID="$(. /etc/os-release && echo "${ID:-}:${VERSION_ID:-}")"
[ "$HOST_ID" = "ubuntu:24.04" ] || die "build host must be Ubuntu 24.04 (found $HOST_ID)"
[ -r "$UBUNTU_KEYRING" ] || die "$UBUNTU_KEYRING missing on host (apt-get install ubuntu-keyring)"
[ -r "/usr/share/debootstrap/scripts/$DISTRO_SUITE" ] || die "debootstrap has no '$DISTRO_SUITE' suite script"

# Host tools. qemu-img and the oci CLI are only needed for capture.
HOST_TOOLS="debootstrap chroot sgdisk wipefs mkfs.vfat mkfs.ext4 e2fsck tune2fs blockdev veritysetup rsync udevadm blkid lsblk findmnt sed python3 visudo sha256sum"
for t in $HOST_TOOLS; do
    command -v "$t" >/dev/null 2>&1 || die "host tool '$t' missing (apt-get install debootstrap ubuntu-keyring gdisk e2fsprogs dosfstools cryptsetup-bin rsync sudo python3)"
done
if [ "$CAPTURE" -eq 1 ]; then
    for t in qemu-img oci; do
        command -v "$t" >/dev/null 2>&1 || die "host tool '$t' missing (apt-get install qemu-utils; pip install oci-cli) or pass --no-capture"
    done
    : "${OCI_COMPARTMENT_ID:?set OCI_COMPARTMENT_ID for capture or pass --no-capture}"
    : "${OCI_BUCKET:?set OCI_BUCKET (Object Storage bucket) for capture or pass --no-capture}"
fi

TARGET="$(readlink -f "$TARGET")"
[ -b "$TARGET" ] || die "$TARGET is not a block device"
[ "$(lsblk -rno TYPE "$TARGET" | head -n1)" = "disk" ] || die "$TARGET is not a whole disk"
if findmnt -rn -S "$TARGET" >/dev/null 2>&1 || lsblk -rno MOUNTPOINT "$TARGET" | grep -q .; then
    die "$TARGET or one of its partitions is mounted"
fi
# Refuse the disk the host is running from, even if nothing is mounted via
# findmnt (e.g. LVM or overlay on top of it).
ROOT_SRC="$(findmnt -rno SOURCE / || true)"
ROOT_DISK="$(lsblk -rno PKNAME "$ROOT_SRC" 2>/dev/null | head -n1 || true)"
[ -n "$ROOT_DISK" ] && [ "/dev/$ROOT_DISK" = "$TARGET" ] && die "$TARGET is the host's root disk"

if [ -z "$GRUB_HASH" ]; then
    log "generating GRUB password hash (passphrase is discarded)"
    GRUB_HASH="$(bash "$COMMON/image/make-grub-password.sh")"
fi
case "$GRUB_HASH" in
    grub.pbkdf2.sha512.*) ;;
    *) die "--grub-password-hash must start with grub.pbkdf2.sha512." ;;
esac

if [ -e "$ROOTFS" ] && [ -n "$(ls -A "$ROOTFS" 2>/dev/null)" ]; then
    die "$ROOTFS exists and is not empty; remove it or pass --rootfs"
fi
mkdir -p "$ROOTFS"
ROOTFS="$(readlink -f "$ROOTFS")"
[ "$ROOTFS" != "/" ] || die "rootfs cannot be /"

DATE="$(date -u +%Y%m%d)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d /var/tmp/safebox-build.XXXXXX)"
MANIFEST_DIR="$R/manifests"
mkdir -p "$MANIFEST_DIR"

# ---------------------------------------------------------------------------
# Mount bookkeeping. Everything mounted under $ROOTFS is recorded and undone
# in reverse order on exit, whether the build succeeds or dies half way.
# ---------------------------------------------------------------------------
MOUNTED=()
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() {
    local rc=$? m i
    set +e
    sync
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        m="${MOUNTED[$i]}"
        umount -l "$m" 2>/dev/null
    done
    rm -rf "$WORK"
    if [ "$rc" -ne 0 ]; then
        log "build FAILED (exit $rc); $ROOTFS is left in place for inspection"
    fi
    exit "$rc"
}
trap cleanup EXIT

do_mount() {
    local target="${*: -1}"
    mkdir -p "$target"
    mount "$@" || die "mount $* failed"
    MOUNTED+=("$target")
}

unmount_all() {
    local i m
    sync
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        m="${MOUNTED[$i]}"
        umount "$m" || umount -l "$m" || die "cannot unmount $m"
    done
    MOUNTED=()
}

# ---------------------------------------------------------------------------
# Step 1: debootstrap a minimal Ubuntu noble root
# ---------------------------------------------------------------------------
# Deliberately minimal (minbase): just enough of a root that apt and the
# component installers run inside the chroot (step 2) can install the full
# stack, including the signed linux-oracle kernel and its ZFS modules. The
# archive keyring comes from the host's ubuntu-keyring package; debootstrap
# verifies the Release files against it.
log "debootstrap $DISTRO_SUITE into $ROOTFS from $MIRROR"
debootstrap --variant=minbase --arch=amd64 \
    --include="$DEBOOTSTRAP_INCLUDE" \
    --keyring="$UBUNTU_KEYRING" \
    "$DISTRO_SUITE" "$ROOTFS" "$MIRROR" \
    || die "debootstrap failed"
[ -x "$ROOTFS/bin/bash" ] || die "bootstrap did not produce /bin/bash"
[ -x "$ROOTFS/usr/bin/apt-get" ] || die "bootstrap did not produce apt-get"
# apt sources for the chroot (deb822). debootstrap leaves a one-line
# sources.list behind; replace it so the pockets are not listed twice.
# Nothing on the running box ever reads this: apt cannot write to a verity
# root.
rm -f "$ROOTFS/etc/apt/sources.list" "$ROOTFS"/etc/apt/sources.list.d/*.list 2>/dev/null || true
install -d -m 0755 "$ROOTFS/etc/apt/sources.list.d"
cat >"$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" <<EOF
# Written by oci/scripts/build-image.sh for the image build only.
Types: deb
URIs: $MIRROR
Suites: $DISTRO_SUITE $DISTRO_SUITE-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: $DISTRO_SUITE-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

# ---------------------------------------------------------------------------
# Step 2: chroot and run the component installers
# ---------------------------------------------------------------------------
log "mounting pseudo filesystems and the repository into the chroot"
do_mount -t proc proc "$ROOTFS/proc"
do_mount -t sysfs sysfs "$ROOTFS/sys"
do_mount --bind /dev "$ROOTFS/dev"
do_mount --bind /dev/pts "$ROOTFS/dev/pts"
do_mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$ROOTFS/run"
# The repository, read-only, at the path every installer expects.
do_mount --bind "$R" "$ROOTFS/opt/safebox-src"
mount -o remount,bind,ro "$ROOTFS/opt/safebox-src" || die "cannot make /opt/safebox-src read-only"
# DNS for apt and npm inside the chroot. Replaced by the systemd-resolved
# stub symlink before cleanup so the image never carries the build host's DNS.
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

log "apt-get update in the chroot"
chroot "$ROOTFS" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive \
    apt-get -q update || die "apt-get update failed in the chroot (mirror $MIRROR)"

run_installer() {
    # run_installer <component> : chroot and run its installer with the
    # environment the installers are written against.
    local comp="$1" path
    case "$comp" in
        base)      path="/opt/safebox-src/$CLOUD/scripts/components/base/install-base.sh" ;;
        system)    path="/opt/safebox-src/$CLOUD/scripts/components/system/install-system.sh" ;;
        dnsclient) path="/opt/safebox-src/common/dnsclient/install-dnsclient.sh" ;;
        autovhost) path="/opt/safebox-src/common/autovhost/install-autovhost.sh" ;;
        safenet)   path="/opt/safebox-src/common/safenet/install-safenet.sh" ;;
        *) die "no installer for $comp" ;;
    esac
    [ -f "$ROOTFS$path" ] || die "installer $path not found in chroot"
    log "running installer: $comp"
    chroot "$ROOTFS" /usr/bin/env -i \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root \
        LC_ALL=C \
        TERM=dumb \
        DEBIAN_FRONTEND=noninteractive \
        SAFEBOX_CHROOT=1 \
        SAFEBOX_SRC=/opt/safebox-src \
        SAFEBOX_CLOUD="$CLOUD" \
        SAFEBOX_REPO_ROOT=/opt/safebox-src \
        OPENSSL_VERSION="${OPENSSL_VERSION:-}" SAFEBOX_OPENSSL_SHA256="${SAFEBOX_OPENSSL_SHA256:-}" \
        NODE_VERSION="${NODE_VERSION:-}" SAFEBOX_NODE_SHA256="${SAFEBOX_NODE_SHA256:-}" \
        SAFEBOX_ALLOW_UNENCRYPTED_MEMORY="${SAFEBOX_ALLOW_UNENCRYPTED_MEMORY:-}" \
        SAFEBOX_DNS_RELAYS="${SAFEBOX_DNS_RELAYS:-}" SAFEBOX_SAFENET_LOGS="${SAFEBOX_SAFENET_LOGS:-}" \
        AUDIT_PUBKEYS="${AUDIT_PUBKEYS_FILE:-}" \
        /bin/bash "$path" || die "installer $comp failed"
}

# Order matters: base provides the OS, system creates the users and the
# wrappers that dnsclient and autovhost check for.
run_installer base
run_installer system
has_component dnsclient && run_installer dnsclient
has_component autovhost && run_installer autovhost
has_component safenet   && run_installer safenet

# Record the kernel the installers put in the image; the manifest carries it
# next to the root hash so an operator can tell which signed kernel/ZFS pair
# the hash covers.
# shellcheck disable=SC2016  # ${Version} is a dpkg-query format, not a shell expansion
KERNEL_VERSION="$(chroot "$ROOTFS" dpkg-query -W -f '${Version}' "$KERNEL_PKG" 2>/dev/null || true)"
if [ -n "$KERNEL_VERSION" ]; then
    log "kernel package: $KERNEL_PKG $KERNEL_VERSION"
else
    log "WARNING: $KERNEL_PKG is not installed in the rootfs; build-verity-root.sh will fail if no kernel is present"
fi

# Runtime resolver: systemd-resolved's stub, populated under /run at boot.
rm -f "$ROOTFS/etc/resolv.conf"
ln -s ../run/systemd/resolve/stub-resolv.conf "$ROOTFS/etc/resolv.conf"
log "unmounting chroot filesystems"
unmount_all

# ---------------------------------------------------------------------------
# Step 3: cleanup (host side, against the chroot directory)
# ---------------------------------------------------------------------------
log "cleanup-image.sh"
bash "$COMMON/image/cleanup-image.sh" "$ROOTFS" || die "cleanup-image.sh failed"
# cleanup/verify write their manifests next to the rootfs dir.
ROOTFS_MANIFESTS="$(dirname "$ROOTFS")/manifests"

# ---------------------------------------------------------------------------
# Steps 4–5: Two-image workflow (verify → verity → capture, twice)
#
# Image A (audit): SSH enabled, safebox-audit user present. Auditors boot
# this to inspect the image, run checks, and verify it matches the spec.
#
# Image B (production): SSH removed, all accounts locked, sealed flag set.
# Deterministic: an auditor who extracts Image A's root, runs the seal
# script, and rebuilds the verity disk must get the same root hash as
# Image B.
#
# Both images are written to the same target disk, so the OCI capture
# (raw → qcow2 → Object Storage → image import) MUST happen immediately
# after each build-verity-root, before the disk is overwritten.
#
# Flow:
#   4a. verify --audit → build-verity-root → capture audit image
#   4b. seal chroot → verify (production) → build-verity-root → capture production image
# ---------------------------------------------------------------------------

AUDIT_IMAGE_ID=""
IMAGE_ID=""

# Helper: convert target disk to qcow2, upload to Object Storage, import as
# a custom image, tag it, and add shape compatibility entries.
# OCI cannot make a custom image from a block volume directly. The route is:
# raw disk → qcow2 → Object Storage → `oci compute image import from-object`
# with launch mode UEFI_64. Secure Boot on OCI validates against the
# Microsoft UEFI CA, which signs Ubuntu's shim; shim chains to the
# Canonical-signed GRUB, kernel and ZFS modules.
capture_oci_image() {
    local image_name="$1" roothash="$2" role="$3"
    local qcow qcow_sha img_id

    NAMESPACE="${OCI_NAMESPACE:-$(oci os ns get --query data --raw-output)}"
    [ -n "$NAMESPACE" ] || die "could not determine the Object Storage namespace"

    qcow="$WORK/${image_name}.qcow2"
    log "converting $TARGET to compressed qcow2 ($role)"
    qemu-img convert -f raw -O qcow2 -c -p "$TARGET" "$qcow" || die "qemu-img convert failed ($role)"
    qcow_sha="$(sha256sum "$qcow" | awk '{print $1}')"

    log "uploading $qcow to bucket $OCI_BUCKET ($role)"
    oci os object put --bucket-name "$OCI_BUCKET" --namespace "$NAMESPACE" \
        --name "${image_name}.qcow2" --file "$qcow" --force \
        --metadata "{\"roothash\":\"$roothash\",\"sha256\":\"$qcow_sha\",\"role\":\"$role\"}" >/dev/null \
        || die "object upload failed ($role)"

    log "importing image $image_name ($role)"
    img_id="$(oci compute image import from-object \
        --compartment-id "$OCI_COMPARTMENT_ID" \
        --bucket-name "$OCI_BUCKET" --namespace "$NAMESPACE" \
        --name "${image_name}.qcow2" \
        --display-name "$image_name" \
        --launch-mode UEFI_64 \
        --source-image-type QCOW2 \
        --operating-system "Ubuntu" \
        --operating-system-version "24.04" \
        --query data.id --raw-output)" || die "image import failed ($role)"
    [ -n "$img_id" ] || die "image import returned no id ($role)"

    log "waiting for $img_id to become AVAILABLE ($role)"
    oci compute image get --image-id "$img_id" \
        --wait-for-state AVAILABLE --wait-interval-seconds 30 --max-wait-seconds 3600 >/dev/null \
        || die "image did not reach AVAILABLE ($role)"

    oci compute image update --image-id "$img_id" \
        --freeform-tags "{\"roothash\":\"$roothash\",\"safebox-build\":\"$STAMP\",\"role\":\"$role\"}" --force >/dev/null \
        || die "image tag update failed ($role)"

    # Shielded (Secure Boot + measured boot + vTPM) launches require the
    # image to be marked compatible with the shapes that support them.
    for shape in VM.Standard.E4.Flex VM.Standard.E5.Flex; do
        oci compute image-shape-compatibility-entry add --image-id "$img_id" --shape-name "$shape" >/dev/null \
            || log "WARNING: could not add shape compatibility for $shape ($role)"
    done

    rm -f "$qcow"
    log "image $image_name ($role) is $img_id"

    # Return via global (bash can't return strings).
    _CAPTURE_IMAGE_ID="$img_id"
}

# --- 4a: Audit image ---
log "verify-image.sh --audit"
bash "$COMMON/image/verify-image.sh" --audit "$ROOTFS" || die "verify-image.sh --audit failed"

log "build-verity-root.sh (audit image)"
: "${SOURCE_DATE_EPOCH:=0}"
export SOURCE_DATE_EPOCH
AUDIT_VERITY_OUT="$(bash "$COMMON/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" || die "build-verity-root.sh (audit) failed"
echo "$AUDIT_VERITY_OUT" >&2
AUDIT_ROOTHASH="$(printf '%s\n' "$AUDIT_VERITY_OUT" | sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' | head -n1)"
[ -n "$AUDIT_ROOTHASH" ] || die "could not parse ROOTHASH from audit build"
log "audit root hash: $AUDIT_ROOTHASH"
sync
udevadm settle

# Capture the audit image NOW, before the disk is overwritten by the
# production build.
if [ "$CAPTURE" -eq 1 ]; then
    capture_oci_image "safebox-audit-${DATE}-${AUDIT_ROOTHASH:0:8}" \
        "$AUDIT_ROOTHASH" "audit"
    AUDIT_IMAGE_ID="$_CAPTURE_IMAGE_ID"
fi

# --- 4b: Seal and build production image ---
log "safebox-seal-image.sh --chroot $ROOTFS"
bash "$COMMON/seal/safebox-seal-image.sh" --chroot "$ROOTFS" || die "safebox-seal-image.sh failed"

log "verify-image.sh (production)"
bash "$COMMON/image/verify-image.sh" "$ROOTFS" || die "verify-image.sh (production) failed"

log "build-verity-root.sh (production image)"
PROD_VERITY_OUT="$(bash "$COMMON/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" || die "build-verity-root.sh (production) failed"
echo "$PROD_VERITY_OUT" >&2
ROOTHASH="$(printf '%s\n' "$PROD_VERITY_OUT" | sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' | head -n1)"
[ -n "$ROOTHASH" ] || die "could not parse ROOTHASH from production build"
ROOTHASH8="${ROOTHASH:0:8}"
log "production root hash: $ROOTHASH"
sync
udevadm settle

# Capture the production image.
if [ "$CAPTURE" -eq 1 ]; then
    capture_oci_image "safebox-${DATE}-${ROOTHASH8}" \
        "$ROOTHASH" "production"
    IMAGE_ID="$_CAPTURE_IMAGE_ID"
else
    log "--no-capture: skipping qcow2 export and image import"
fi

# ---------------------------------------------------------------------------
# Step 6: manifest
# ---------------------------------------------------------------------------
GIT_COMMIT="$(git -C "$R" rev-parse HEAD 2>/dev/null || echo "")"
ROOTFS_MANIFESTS="$(dirname "$ROOTFS")/manifests"
INVENTORY_JSON="$ROOTFS_MANIFESTS/image-inventory.json"
VERITY_JSON="$ROOTFS_MANIFESTS/verity.json"
OUT="$MANIFEST_DIR/${CLOUD}-${DATE}.json"
python3 -I - "$OUT" "$CLOUD" "$ROOTHASH" "${IMAGE_ID:-}" \
    "$VERITY_JSON" "$INVENTORY_JSON" "$GIT_COMMIT" "$COMPONENTS" \
    "$DISTRO_LABEL" "$KERNEL_PKG" "${KERNEL_VERSION:-}" \
    "$AUDIT_ROOTHASH" "${AUDIT_IMAGE_ID:-}" "$STAMP" <<'PY'
import json, sys, hashlib, os
(out, cloud, roothash, image_id, verity_path, inv_path, commit, components,
 distro, kernel_pkg, kernel_ver,
 audit_roothash, audit_image_id, stamp) = sys.argv[1:15]

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None

def sha256_file(p):
    try:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None

doc = {
    "schema": "safebox-image-manifest/2",
    "built_at": stamp,
    "cloud": cloud,
    "distro": distro,
    "kernelPackage": kernel_pkg,
    "kernelPackageVersion": kernel_ver or None,
    "components": components.split(","),
    "production": {
        "roothash": roothash,
        "imageId": image_id or None,
    },
    "audit": {
        "roothash": audit_roothash or None,
        "imageId": audit_image_id or None,
    },
    "roothash": roothash,
    "imageId": image_id or None,
    "gitCommit": commit or None,
    "verity": load(verity_path),
    "inventorySha256": sha256_file(inv_path),
    "inventoryPath": inv_path if os.path.exists(inv_path) else None,
    "launch": {"launchMode": "UEFI_64", "secureBoot": True, "measuredBoot": True, "vtpm": True},
}
with open(out, "w") as f:
    json.dump(doc, f, indent=2, sort_keys=True)
    f.write("\n")
PY
cp "$ROOTFS_MANIFESTS/verity.json" "$MANIFEST_DIR/${CLOUD}-${DATE}-verity.json" 2>/dev/null || true
cp "$ROOTFS_MANIFESTS/image-inventory.json" "$MANIFEST_DIR/${CLOUD}-${DATE}-inventory.json" 2>/dev/null || true
chmod 0644 "$OUT" "$MANIFEST_DIR/${CLOUD}-${DATE}-verity.json" "$MANIFEST_DIR/${CLOUD}-${DATE}-inventory.json" 2>/dev/null || true

echo ""
log "BUILD COMPLETE (two-image workflow)"
log "  audit root hash      : $AUDIT_ROOTHASH"
[ -n "$AUDIT_IMAGE_ID" ] && log "  audit image (A)      : $AUDIT_IMAGE_ID"
log "  production root hash : $ROOTHASH"
[ -n "$IMAGE_ID" ] && log "  production image (B) : $IMAGE_ID"
log "  manifest             : $OUT"
log ""
log "Auditors: boot Image A (throwaway) to inspect. Then extract Image A root,"
log "run safebox-seal-image.sh --chroot, run build-verity-root.sh with"
log "SOURCE_DATE_EPOCH=0, and compare the root hash to Image B's."
log "The build instance is NOT the image; terminate it when done."
exit 0
