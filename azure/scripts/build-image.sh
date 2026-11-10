#!/bin/bash
#
# build-image.sh -- build the Safebox Azure image (docs/HARDENING-PLAN.md,
# "Build flow").
#
#   sudo azure/scripts/build-image.sh \
#       --target /dev/disk/azure/scsi1/lun1 \
#       --target-disk-name safebox-image-target \
#       --resource-group safebox-build-rg \
#       [--components base,system,dnsclient,autovhost] \
#       [--grub-password-hash grub.pbkdf2.sha512....] \
#       [--rootfs /mnt/safebox-rootfs] \
#       [--audit-pubkeys /path/to/authorized_keys] \
#       [--gallery-name safebox] [--image-definition safebox-prod] \
#       [--security-type TrustedLaunch|ConfidentialVMSupported] \
#       [--mirror http://azure.archive.ubuntu.com/ubuntu] \
#       [--no-capture]
#
# The image is Ubuntu 24.04 LTS (noble), as on every other cloud: the data
# pool is ZFS and the VM boots with Secure Boot (Trusted Launch), so the ZFS
# kernel module must carry a signature the shim/kernel trust chain accepts.
# Ubuntu is the only distribution that ships distro-signed ZFS modules (in
# linux-modules-extra-*, signed with Canonical's kernel key) for its cloud
# kernels. The Azure-tuned kernel is linux-azure.
#
# Runs on a throwaway Ubuntu 24.04 build VM (the host release must match the
# image's so debootstrap has the noble suite script and ubuntu-keyring's
# archive keyring) with a second, empty managed disk attached at LUN 1. The
# build VM is never captured: the image is the target disk, written from a
# chroot that was bootstrapped from scratch with debootstrap, hardened by
# the component installers, cleaned and verified from the host side, and
# then laid out as a dm-verity root by common/image/build-verity-root.sh. Capture snapshots the target disk and
# publishes it as a Specialized Trusted Launch version in a Compute
# Gallery; a Specialized image boots exactly as captured, which is what a
# box with no agent and no cloud-init needs.
#
# Steps:
#   0. preflight        root, host tools, target is an unmounted whole disk, repo present
#   1. bootstrap        debootstrap minbase noble into $ROOTFS; write the deb822
#                       apt sources (noble, noble-updates, noble-security)
#   2. installers       bind-mount /proc /sys /dev /dev/pts /run and the repo (ro);
#                       chroot and run install-base, install-system,
#                       install-dnsclient, install-autovhost
#   3. cleanup          unmount; common/image/cleanup-image.sh $ROOTFS
#   4a. audit capture   verify --audit; build-verity-root; snapshot+gallery (audit)
#   4b. seal+capture    seal chroot; verify (prod); build-verity-root; snapshot+gallery (prod)
#   5. manifest         manifests/azure-<date>.json in the repo (schema v2)
#
# Every mount is recorded and undone in the EXIT trap, so a failed build
# leaves no chroot mounts behind on the build VM.
#
# Host packages (the build VM, not the image): debootstrap, ubuntu-keyring,
# gdisk, dosfstools, e2fsprogs, cryptsetup-bin, rsync, python3, jq, sudo,
# udev, util-linux, azure-cli (az). --mirror defaults to Azure's own Ubuntu
# mirror, http://azure.archive.ubuntu.com/ubuntu (or $SAFEBOX_UBUNTU_MIRROR).

set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLOUD=azure
DISTRO_SUITE=noble
DISTRO_LABEL=ubuntu-24.04
KERNEL_PKG=linux-azure
DEBOOTSTRAP_INCLUDE=systemd,systemd-sysv,dbus,ca-certificates,curl,gnupg,apt-utils
UBUNTU_KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg

die() { printf 'build-image: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf 'build-image: [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
TARGET=""
TARGET_DISK_NAME=""
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
COMPONENTS="base,system,dnsclient,autovhost,safenet"
GRUB_HASH=""
ROOTFS="/mnt/safebox-rootfs"
GALLERY_NAME="safebox"
IMAGE_DEFINITION="safebox-prod"
SECURITY_TYPE="TrustedLaunch"
MIRROR="${SAFEBOX_UBUNTU_MIRROR:-http://azure.archive.ubuntu.com/ubuntu}"
CAPTURE=1
AUDIT_PUBKEYS_FILE="${AUDIT_PUBKEYS:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)             TARGET="$2"; shift 2 ;;
        --target-disk-name)   TARGET_DISK_NAME="$2"; shift 2 ;;
        --resource-group|-g)  RESOURCE_GROUP="$2"; shift 2 ;;
        --components)         COMPONENTS="$2"; shift 2 ;;
        --grub-password-hash) GRUB_HASH="$2"; shift 2 ;;
        --rootfs)             ROOTFS="$2"; shift 2 ;;
        --audit-pubkeys)      AUDIT_PUBKEYS_FILE="$2"; shift 2 ;;
        --gallery-name)       GALLERY_NAME="$2"; shift 2 ;;
        --image-definition)   IMAGE_DEFINITION="$2"; shift 2 ;;
        --security-type)      SECURITY_TYPE="$2"; shift 2 ;;
        --mirror)             MIRROR="$2"; shift 2 ;;
        --no-capture)         CAPTURE=0; shift ;;
        -h|--help)            usage ;;
        *)                    die "unknown argument: $1 (try --help)" ;;
    esac
done

[[ -n $TARGET ]] || die "--target <block-device> is required"
case "$SECURITY_TYPE" in
    TrustedLaunch|ConfidentialVMSupported) ;;
    *) die "--security-type must be TrustedLaunch or ConfidentialVMSupported" ;;
esac
IFS=',' read -ra COMP_LIST <<<"$COMPONENTS"
has_component() { local c; for c in "${COMP_LIST[@]}"; do [[ $c == "$1" ]] && return 0; done; return 1; }
has_component base   || die "component 'base' is mandatory"
has_component system || die "component 'system' is mandatory"
for c in "${COMP_LIST[@]}"; do
    case "$c" in base|system|dnsclient|autovhost|safenet) ;; *) die "unknown component '$c'" ;; esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "must run as root"
[[ -f $REPO/docs/HARDENING-PLAN.md && -d $REPO/common/image ]] || die "repo not found at $REPO"
[[ -f $REPO/azure/scripts/components/base/install-base.sh ]] || die "azure installers missing under $REPO/azure"
# shellcheck disable=SC1091
HOST_ID="$(. /etc/os-release && echo "${ID:-}:${VERSION_ID:-}")"
[[ $HOST_ID == ubuntu:24.04 ]] || die "build host must be Ubuntu 24.04 (found $HOST_ID)"
[[ -r $UBUNTU_KEYRING ]] || die "$UBUNTU_KEYRING missing: apt-get install ubuntu-keyring"
[[ -r /usr/share/debootstrap/scripts/$DISTRO_SUITE ]] || die "debootstrap has no '$DISTRO_SUITE' suite script"

# Host tools. debootstrap for the bootstrap; the rest are what
# build-verity-root.sh, cleanup-image.sh and verify-image.sh need.
HOST_TOOLS=(debootstrap chroot sgdisk wipefs mkfs.vfat mkfs.ext4 e2fsck tune2fs blockdev
            veritysetup rsync udevadm blkid lsblk findmnt sed python3 jq sha256sum awk
            dpkg-query visudo mountpoint)
missing=()
for t in "${HOST_TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
[[ ${#missing[@]} -eq 0 ]] || die "missing host tools: ${missing[*]} (apt-get install debootstrap ubuntu-keyring gdisk e2fsprogs dosfstools cryptsetup-bin rsync python3 jq sudo udev util-linux)"
if [[ $CAPTURE -eq 1 ]]; then
    command -v az >/dev/null 2>&1 || die "az CLI not found (use --no-capture to skip the gallery publish)"
    [[ -n $RESOURCE_GROUP ]] || die "--resource-group is required for capture"
    [[ -n $TARGET_DISK_NAME ]] || die "--target-disk-name is required for capture (the managed disk attached as $TARGET)"
    az account show >/dev/null 2>&1 || die "az is not logged in"
    az disk show -g "$RESOURCE_GROUP" -n "$TARGET_DISK_NAME" >/dev/null 2>&1 \
        || die "managed disk $TARGET_DISK_NAME not found in resource group $RESOURCE_GROUP"
fi

TARGET="$(readlink -f "$TARGET")"
[[ -b $TARGET ]] || die "$TARGET is not a block device"
[[ $(lsblk -rno TYPE "$TARGET" | head -n1) == disk ]] || die "$TARGET is not a whole disk"
if findmnt -rn -S "$TARGET" >/dev/null 2>&1 || lsblk -rno MOUNTPOINT "$TARGET" | grep -q .; then
    die "$TARGET or one of its partitions is mounted; refusing"
fi
ROOT_DEV="$(findmnt -rn -o SOURCE / | sed 's/\[.*\]//')"
ROOT_DISK="$(lsblk -rno PKNAME "$ROOT_DEV" 2>/dev/null | head -n1 || true)"
[[ -n $ROOT_DISK && /dev/$ROOT_DISK == "$TARGET" ]] && die "$TARGET is the build VM's own root disk"
# Azure's resource (temp) disk is sdb on most sizes; it is ephemeral and an
# image written there would vanish on deallocate. The managed data disk is
# addressed through /dev/disk/azure/scsi1/lun<N>.
if [[ -e /dev/disk/azure/resource ]] && [[ "$(readlink -f /dev/disk/azure/resource)" == "$TARGET" ]]; then
    die "$TARGET is the Azure ephemeral resource disk"
fi

ROOTFS="$(readlink -f -m "$ROOTFS")"
[[ $ROOTFS != "/" ]] || die "rootfs must not be /"
if [[ -d $ROOTFS ]] && [[ -n "$(ls -A "$ROOTFS")" ]]; then
    die "$ROOTFS exists and is not empty; remove it or pass a fresh --rootfs"
fi
MANIFEST_DIR="$(dirname "$ROOTFS")/manifests"   # where build-verity-root.sh and verify-image.sh write
DATE="$(date -u +%Y%m%d)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ---------------------------------------------------------------------------
# Mount bookkeeping
# ---------------------------------------------------------------------------
MOUNTED=()
do_mount() {
    local target="${*: -1}"
    mkdir -p "$target"
    mount "$@" || die "mount $* failed"
    MOUNTED+=("$target")
}
unmount_all() {
    local i
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        umount -l "${MOUNTED[$i]}" 2>/dev/null || true
    done
    MOUNTED=()
}
cleanup() {
    local rc=$?
    set +e
    sync
    unmount_all
    exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Bootstrap
# ---------------------------------------------------------------------------
log "step 1: debootstrap $DISTRO_SUITE into $ROOTFS from $MIRROR"
mkdir -p "$ROOTFS" "$MANIFEST_DIR"
debootstrap --variant=minbase --arch=amd64 \
    --include="$DEBOOTSTRAP_INCLUDE" \
    --keyring="$UBUNTU_KEYRING" \
    "$DISTRO_SUITE" "$ROOTFS" "$MIRROR" \
    || die "debootstrap failed"
[[ -x $ROOTFS/bin/bash ]] || die "debootstrap produced no /bin/bash"
[[ -x $ROOTFS/usr/bin/apt-get ]] || die "debootstrap produced no apt-get"
# apt sources for the chroot (deb822). debootstrap leaves a one-line
# sources.list behind; replace it so the pockets are not listed twice.
# Nothing on the running box ever uses this file: apt cannot write to a
# verity root.
rm -f "$ROOTFS/etc/apt/sources.list" "$ROOTFS"/etc/apt/sources.list.d/*.list 2>/dev/null || true
mkdir -p "$ROOTFS/etc/apt/sources.list.d"
cat >"$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" <<EOF
# Written by azure/scripts/build-image.sh for the image build only.
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
# 2. Installers in the chroot
# ---------------------------------------------------------------------------
log "step 2: mounting chroot"
do_mount -t proc proc "$ROOTFS/proc"
do_mount -t sysfs sysfs "$ROOTFS/sys"
do_mount --bind /dev "$ROOTFS/dev"
do_mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts "$ROOTFS/dev/pts"
do_mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$ROOTFS/run"
mkdir -p "$ROOTFS/opt/safebox-src"
do_mount --bind "$REPO" "$ROOTFS/opt/safebox-src"
mount -o remount,ro,bind "$ROOTFS/opt/safebox-src" || die "could not make the repo mount read-only"
# Resolver for apt and npm during the build; replaced by the resolved stub
# symlink before cleanup so the image never carries the build VM's DNS.
rm -f "$ROOTFS/etc/resolv.conf"
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

log "step 2: apt-get update in the chroot"
chroot "$ROOTFS" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive \
    apt-get -q update || die "apt-get update failed in the chroot (mirror $MIRROR)"

run_in_chroot() {
    # run_in_chroot <path-inside-chroot> : runs the installer with the
    # contract's environment and nothing else inherited from the host.
    local script="$1"
    chroot "$ROOTFS" /usr/bin/env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root TERM="${TERM:-dumb}" DEBIAN_FRONTEND=noninteractive \
        SAFEBOX_CHROOT=1 SAFEBOX_SRC=/opt/safebox-src SAFEBOX_CLOUD="$CLOUD" \
        OPENSSL_VERSION="${OPENSSL_VERSION:-}" SAFEBOX_OPENSSL_SHA256="${SAFEBOX_OPENSSL_SHA256:-}" \
        NODE_VERSION="${NODE_VERSION:-}" SAFEBOX_NODE_SHA256="${SAFEBOX_NODE_SHA256:-}" \
        SAFEBOX_ALLOW_UNENCRYPTED_MEMORY="${SAFEBOX_ALLOW_UNENCRYPTED_MEMORY:-}" \
        SAFEBOX_DNS_RELAYS="${SAFEBOX_DNS_RELAYS:-}" SAFEBOX_SAFENET_LOGS="${SAFEBOX_SAFENET_LOGS:-}" \
        SAFEBOX_APT_PINS="${SAFEBOX_APT_PINS:-}" \
        AUDIT_PUBKEYS="${AUDIT_PUBKEYS_FILE:-}" \
        /bin/bash "$script" \
        || die "$script failed"
}

log "step 2: install-base.sh"
run_in_chroot /opt/safebox-src/azure/scripts/components/base/install-base.sh
log "step 2: install-system.sh"
run_in_chroot /opt/safebox-src/azure/scripts/components/system/install-system.sh
if has_component dnsclient; then
    log "step 2: install-dnsclient.sh"
    run_in_chroot /opt/safebox-src/common/dnsclient/install-dnsclient.sh
fi
if has_component autovhost; then
    log "step 2: install-autovhost.sh"
    run_in_chroot /opt/safebox-src/common/autovhost/install-autovhost.sh
fi
if has_component safenet; then
    log "step 2: install-safenet.sh"
    run_in_chroot /opt/safebox-src/common/safenet/install-safenet.sh
fi

# Record the kernel the installers put in the image; the manifest carries it
# next to the root hash so an operator can tell which signed kernel/ZFS pair
# the hash covers.
# shellcheck disable=SC2016  # ${Version} is a dpkg-query format, not a shell expansion
KERNEL_VERSION="$(chroot "$ROOTFS" dpkg-query -W -f '${Version}' "$KERNEL_PKG" 2>/dev/null || true)"
if [[ -n $KERNEL_VERSION ]]; then
    log "kernel package: $KERNEL_PKG $KERNEL_VERSION"
else
    log "WARNING: $KERNEL_PKG is not installed in the rootfs; build-verity-root.sh will fail if no kernel is present"
fi

# GRUB password hash: generated inside the chroot when the host lacks
# grub-mkpasswd-pbkdf2, while the repo mount is still up. The passphrase is
# random and discarded (see common/image/make-grub-password.sh).
if [[ -z $GRUB_HASH ]]; then
    log "generating GRUB password hash"
    if command -v grub-mkpasswd-pbkdf2 >/dev/null 2>&1 || command -v grub2-mkpasswd-pbkdf2 >/dev/null 2>&1; then
        GRUB_HASH="$(bash "$REPO/common/image/make-grub-password.sh")"
    else
        GRUB_HASH="$(chroot "$ROOTFS" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
            /bin/bash /opt/safebox-src/common/image/make-grub-password.sh)"
    fi
fi
[[ $GRUB_HASH == grub.pbkdf2.sha512.* ]] || die "GRUB password hash is not a grub.pbkdf2.sha512 hash"

# Restore the resolver the booted image uses (systemd-resolved stub).
ln -sf ../run/systemd/resolve/stub-resolv.conf "$ROOTFS/etc/resolv.conf"

log "step 2: unmounting chroot"
sync
unmount_all
rmdir "$ROOTFS/opt/safebox-src" 2>/dev/null || die "$ROOTFS/opt/safebox-src is not empty after unmount; refusing to continue"

# ---------------------------------------------------------------------------
# 3. Cleanup (shared between both AMIs)
# ---------------------------------------------------------------------------
log "step 3: cleanup-image.sh"
bash "$REPO/common/image/cleanup-image.sh" "$ROOTFS" || die "cleanup-image.sh failed"

# ---------------------------------------------------------------------------
# 4a. Audit AMI: verify --audit, build verity root, capture
# ---------------------------------------------------------------------------
log "step 4a: verify-image.sh --audit"
bash "$REPO/common/image/verify-image.sh" --audit "$ROOTFS" \
    || die "verify-image.sh --audit failed"
INVENTORY="$MANIFEST_DIR/image-inventory.json"
[[ -f $INVENTORY ]] || die "verify-image.sh did not write $INVENTORY"

log "step 4a: build-verity-root.sh (audit AMI) -> $TARGET"
: "${SOURCE_DATE_EPOCH:=0}"
export SOURCE_DATE_EPOCH
AUDIT_VERITY_OUT="$(bash "$REPO/common/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" \
    || die "build-verity-root.sh (audit) failed"
AUDIT_ROOTHASH="$(printf '%s\n' "$AUDIT_VERITY_OUT" | sed -n 's/^ROOTHASH=//p' | tail -n1)"
[[ $AUDIT_ROOTHASH =~ ^[0-9a-f]{64}$ ]] || die "could not read ROOTHASH from build-verity-root.sh (audit)"
AUDIT_VERITY_JSON="$MANIFEST_DIR/verity.json"
[[ -f $AUDIT_VERITY_JSON ]] || die "build-verity-root.sh (audit) did not write verity.json"
# Save audit verity manifest before the production build overwrites it.
cp "$AUDIT_VERITY_JSON" "$MANIFEST_DIR/verity-audit.json"
AUDIT_HASH8="${AUDIT_ROOTHASH:0:8}"
log "audit root hash $AUDIT_ROOTHASH"
sync
blockdev --flushbufs "$TARGET" || true

# Capture the audit AMI.
AUDIT_IMAGE_ID=""
AUDIT_SNAPSHOT_ID=""
AUDIT_IMAGE_VERSION=""
AUDIT_IMAGE_DEFINITION="safebox-audit"
if [[ $CAPTURE -eq 1 ]]; then
    log "step 4a: capture audit image (resource group $RESOURCE_GROUP, disk $TARGET_DISK_NAME)"
    DISK_ID="$(az disk show -g "$RESOURCE_GROUP" -n "$TARGET_DISK_NAME" --query id -o tsv)"
    LOCATION="$(az disk show -g "$RESOURCE_GROUP" -n "$TARGET_DISK_NAME" --query location -o tsv)"
    [[ -n $DISK_ID && -n $LOCATION ]] || die "could not resolve the target disk's id/location"

    AUDIT_SNAP_NAME="safebox-audit-${DATE}-${AUDIT_HASH8}"
    log "snapshot $AUDIT_SNAP_NAME"
    AUDIT_SNAPSHOT_ID="$(az snapshot create -g "$RESOURCE_GROUP" -n "$AUDIT_SNAP_NAME" \
        --source "$DISK_ID" --hyper-v-generation V2 --sku Standard_LRS \
        --tags "roothash=$AUDIT_ROOTHASH" "safebox=image" "role=audit" "built=$STAMP" \
        --query id -o tsv)" || die "az snapshot create (audit) failed"

    # Gallery and definitions are created once and reused. Specialized: we do
    # not run waagent deprovision/generalize (there is no agent), so the
    # image must boot as-is. TrustedLaunch (or ConfidentialVMSupported) is
    # what lets a VM with Secure Boot + vTPM launch from it; a plain managed
    # image cannot.
    if ! az sig show -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" >/dev/null 2>&1; then
        log "creating gallery $GALLERY_NAME"
        az sig create -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" --location "$LOCATION" >/dev/null \
            || die "az sig create failed"
    fi
    if ! az sig image-definition show -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$AUDIT_IMAGE_DEFINITION" >/dev/null 2>&1; then
        log "creating image definition $AUDIT_IMAGE_DEFINITION ($SECURITY_TYPE, Specialized, V2, x64)"
        az sig image-definition create -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$AUDIT_IMAGE_DEFINITION" --location "$LOCATION" \
            --publisher Safebots --offer safebox --sku audit \
            --os-type Linux --os-state Specialized --hyper-v-generation V2 \
            --architecture x64 --features "SecurityType=$SECURITY_TYPE" >/dev/null \
            || die "az sig image-definition create (audit) failed"
    fi

    N="$(az sig image-version list -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$AUDIT_IMAGE_DEFINITION" --query "length([?starts_with(name, '${DATE}.0.')])" -o tsv 2>/dev/null || echo 0)"
    AUDIT_IMAGE_VERSION="${DATE}.0.${N:-0}"
    log "audit image version $AUDIT_IMAGE_VERSION"
    AUDIT_IMAGE_ID="$(az sig image-version create -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
        --gallery-image-definition "$AUDIT_IMAGE_DEFINITION" --gallery-image-version "$AUDIT_IMAGE_VERSION" \
        --location "$LOCATION" --target-regions "$LOCATION" \
        --os-snapshot "$AUDIT_SNAPSHOT_ID" \
        --tags "roothash=$AUDIT_ROOTHASH" "safebox=image" "role=audit" "built=$STAMP" \
        --query id -o tsv)" || die "az sig image-version create (audit) failed"
    log "published audit image $AUDIT_IMAGE_ID"
fi

# ---------------------------------------------------------------------------
# 4b. Seal the chroot, then build and capture the production AMI
# ---------------------------------------------------------------------------
log "step 4b: safebox-seal-image.sh --chroot $ROOTFS"
bash "$REPO/common/seal/safebox-seal-image.sh" --chroot "$ROOTFS" \
    || die "safebox-seal-image.sh failed"

log "step 4b: verify-image.sh (production)"
bash "$REPO/common/image/verify-image.sh" "$ROOTFS" \
    || die "verify-image.sh (production) failed"

log "step 4b: build-verity-root.sh (production AMI) -> $TARGET"
VERITY_OUT="$(bash "$REPO/common/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" \
    || die "build-verity-root.sh (production) failed"
ROOTHASH="$(printf '%s\n' "$VERITY_OUT" | sed -n 's/^ROOTHASH=//p' | tail -n1)"
[[ $ROOTHASH =~ ^[0-9a-f]{64}$ ]] || die "could not read ROOTHASH from build-verity-root.sh (production)"
VERITY_JSON="$MANIFEST_DIR/verity.json"
[[ -f $VERITY_JSON ]] || die "build-verity-root.sh (production) did not write verity.json"
HASH8="${ROOTHASH:0:8}"
log "production root hash $ROOTHASH"
sync
blockdev --flushbufs "$TARGET" || true

# Capture the production AMI.
IMAGE_ID=""
SNAPSHOT_ID=""
IMAGE_VERSION=""
if [[ $CAPTURE -eq 1 ]]; then
    log "step 4b: capture production image"

    SNAP_NAME="safebox-${DATE}-${HASH8}"
    log "snapshot $SNAP_NAME"
    SNAPSHOT_ID="$(az snapshot create -g "$RESOURCE_GROUP" -n "$SNAP_NAME" \
        --source "$DISK_ID" --hyper-v-generation V2 --sku Standard_LRS \
        --tags "roothash=$ROOTHASH" "safebox=image" "role=production" "built=$STAMP" \
        --query id -o tsv)" || die "az snapshot create (production) failed"

    if ! az sig image-definition show -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$IMAGE_DEFINITION" >/dev/null 2>&1; then
        log "creating image definition $IMAGE_DEFINITION ($SECURITY_TYPE, Specialized, V2, x64)"
        az sig image-definition create -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$IMAGE_DEFINITION" --location "$LOCATION" \
            --publisher Safebots --offer safebox --sku prod \
            --os-type Linux --os-state Specialized --hyper-v-generation V2 \
            --architecture x64 --features "SecurityType=$SECURITY_TYPE" >/dev/null \
            || die "az sig image-definition create (production) failed"
    fi

    N="$(az sig image-version list -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
            --gallery-image-definition "$IMAGE_DEFINITION" --query "length([?starts_with(name, '${DATE}.0.')])" -o tsv 2>/dev/null || echo 0)"
    IMAGE_VERSION="${DATE}.0.${N:-0}"
    log "production image version $IMAGE_VERSION"
    IMAGE_ID="$(az sig image-version create -g "$RESOURCE_GROUP" --gallery-name "$GALLERY_NAME" \
        --gallery-image-definition "$IMAGE_DEFINITION" --gallery-image-version "$IMAGE_VERSION" \
        --location "$LOCATION" --target-regions "$LOCATION" \
        --os-snapshot "$SNAPSHOT_ID" \
        --tags "roothash=$ROOTHASH" "safebox=image" "role=production" "built=$STAMP" \
        --query id -o tsv)" || die "az sig image-version create (production) failed"
    log "published production image $IMAGE_ID"
else
    log "capture skipped (--no-capture); the image is on $TARGET"
fi

# ---------------------------------------------------------------------------
# 5. Manifest in the repo
# ---------------------------------------------------------------------------
log "step 5: manifest"
mkdir -p "$REPO/manifests"
OUT="$REPO/manifests/${CLOUD}-${DATE}.json"
[[ -e $OUT ]] && OUT="$REPO/manifests/${CLOUD}-${DATE}-${HASH8}.json"
GIT_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "")"
GIT_DIRTY="false"
if [[ -n $GIT_COMMIT ]] && ! git -C "$REPO" diff --quiet 2>/dev/null; then GIT_DIRTY="true"; fi
BASE_JSON="$ROOTFS/opt/safebox/manifests/base.json"
jq -n \
    --arg cloud "$CLOUD" --arg built "$STAMP" \
    --arg roothash "$ROOTHASH" --arg audit_roothash "$AUDIT_ROOTHASH" \
    --arg image_id "$IMAGE_ID" --arg image_version "$IMAGE_VERSION" --arg snapshot_id "$SNAPSHOT_ID" \
    --arg audit_image_id "$AUDIT_IMAGE_ID" --arg audit_image_version "$AUDIT_IMAGE_VERSION" --arg audit_snapshot_id "$AUDIT_SNAPSHOT_ID" \
    --arg gallery "$GALLERY_NAME" --arg prod_def "$IMAGE_DEFINITION" --arg audit_def "$AUDIT_IMAGE_DEFINITION" \
    --arg security "$SECURITY_TYPE" \
    --arg components "$COMPONENTS" \
    --arg distro "$DISTRO_LABEL" --arg kernel_pkg "$KERNEL_PKG" --arg kernel_ver "$KERNEL_VERSION" \
    --arg inv_sha "$(sha256sum "$INVENTORY" | awk '{print $1}')" \
    --arg base_sha "$([[ -f $BASE_JSON ]] && sha256sum "$BASE_JSON" | awk '{print $1}' || echo "")" \
    --arg git "$GIT_COMMIT" --argjson dirty "$GIT_DIRTY" \
    --slurpfile verity "$VERITY_JSON" \
    --slurpfile audit_verity "$MANIFEST_DIR/verity-audit.json" \
    '{
        schema: "safebox-image-manifest/2",
        cloud: $cloud, builtAt: $built, components: ($components | split(",")),
        distro: $distro, kernelPackage: $kernel_pkg,
        kernelPackageVersion: (if $kernel_ver == "" then null else $kernel_ver end),
        production: {
            roothash: $roothash,
            image: {id: $image_id, galleryName: $gallery, imageDefinition: $prod_def, version: $image_version,
                    snapshotId: $snapshot_id, securityType: $security, osState: "Specialized", hyperVGeneration: "V2"},
            verity: $verity[0]
        },
        audit: {
            roothash: $audit_roothash,
            image: {id: $audit_image_id, galleryName: $gallery, imageDefinition: $audit_def, version: $audit_image_version,
                    snapshotId: $audit_snapshot_id, securityType: $security, osState: "Specialized", hyperVGeneration: "V2"},
            verity: $audit_verity[0]
        },
        inventorySha256: $inv_sha,
        baseManifestSha256: $base_sha,
        git: {commit: $git, dirty: $dirty}
    }' >"$OUT"
cp "$INVENTORY" "$REPO/manifests/${CLOUD}-${DATE}-${HASH8}.inventory.json"
log "manifest written to $OUT"

echo "ROOTHASH=$ROOTHASH"
echo "AUDIT_ROOTHASH=$AUDIT_ROOTHASH"
[[ -n $IMAGE_ID ]] && echo "IMAGE_ID=$IMAGE_ID"
[[ -n $AUDIT_IMAGE_ID ]] && echo "AUDIT_IMAGE_ID=$AUDIT_IMAGE_ID"
cat <<EOF

=== Auditor Verification ===
To verify the production image was derived from the audit image:
  1. Boot audit image $AUDIT_IMAGE_ID (throwaway VM) for runtime inspection.
  2. Extract the audit image's root filesystem.
  3. Run: safebox-seal-image.sh --chroot <extracted-rootfs>
  4. Run: SOURCE_DATE_EPOCH=0 build-verity-root.sh <sealed-rootfs> <disk> <grub-hash>
  5. The root hash must match: $ROOTHASH
EOF
log "done"
