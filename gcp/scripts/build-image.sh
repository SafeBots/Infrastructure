#!/bin/bash
#
# build-image.sh - build the Safebox GCE image (Ubuntu 24.04 LTS noble,
# dm-verity root, TPM-sealed pool) on a build VM and capture it as a GCE
# image.
#
# Why Ubuntu rather than Debian: the data pool is ZFS and the image boots as
# a Shielded VM with Secure Boot, so the ZFS kernel module must carry a
# signature the shim/kernel trust chain accepts. Ubuntu is the only
# distribution that ships distro-signed ZFS modules (in linux-modules-extra-*,
# signed with Canonical's kernel key) for its cloud kernels; Debian would
# need a DKMS build and a MOK enrolled in the firmware, which a verity root
# with no console cannot do. The GCE-tuned kernel is linux-gcp.
#
# Implements "Build flow" from docs/HARDENING-PLAN.md for GCP:
#
#   1. debootstrap a minimal noble root into --rootfs, write the deb822 apt
#      sources (noble, noble-updates, noble-security; main universe)
#   2. bind-mount /proc /sys /dev /dev/pts /run and this repository
#      (read-only at /opt/safebox-src), chroot, run the component installers
#      base -> system -> dnsclient -> autovhost
#   3. run common/image/cleanup-image.sh and verify-image.sh from the host
#      against the rootfs (both take a rootfs directory; any failure aborts)
#   4. common/image/build-verity-root.sh <rootfs> <target-disk> <grub-hash>
#   5. detach the target disk and `gcloud compute images create` from it with
#      the Shielded VM guest-OS features (UEFI_COMPATIBLE for Secure Boot
#      and the vTPM) unless --no-capture
#   6. write manifests/gcp-<date>.json with the image id, the root hash, the
#      verity manifest, the inventory digest and the git commit
#
# The build VM itself is never captured: everything that ends up in the
# image goes through the chroot and the verity builder, so the image holds
# no trace of the operator, the build host's keys, or its guest agent.
#
# Usage:
#   build-image.sh --target /dev/disk/by-id/google-safebox-target \
#                  [--components base,system,dnsclient,autovhost] \
#                  [--grub-password-hash grub.pbkdf2.sha512....] \
#                  [--rootfs /mnt/safebox-rootfs] [--no-capture] \
#                  [--zone ZONE] [--project PROJECT] [--image-family safebox] \
#                  [--mirror http://archive.ubuntu.com/ubuntu]
#
# --mirror is the Ubuntu archive used by debootstrap and the chroot's apt
# (default http://archive.ubuntu.com/ubuntu, or $SAFEBOX_UBUNTU_MIRROR). From
# inside GCE the regional mirror is faster:
# http://<region>.gce.archive.ubuntu.com/ubuntu
#
# --target is a second, empty persistent disk attached to the build VM. Pass
# its /dev/disk/by-id/google-<name> path; <name> is the GCE disk name the
# capture step needs. A plain /dev/sdX also works if a google-* symlink
# points at it.
#
# The build VM must itself be Ubuntu 24.04: debootstrap then has the noble
# suite script and ubuntu-keyring's archive keyring without extra plumbing.
#
# Host packages (the build VM, not the image): debootstrap, ubuntu-keyring,
# gdisk, dosfstools, e2fsprogs, cryptsetup-bin, rsync, python3, jq,
# grub-common (grub-mkpasswd-pbkdf2), sudo (visudo for verify-image.sh),
# dracut-core (lsinitrd, optional), google-cloud-cli.

set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON_IMAGE="$REPO/common/image"
CLOUD=gcp
DISTRO_SUITE=noble
DISTRO_LABEL=ubuntu-24.04
KERNEL_PKG=linux-gcp
DISTRO_MIRROR="${SAFEBOX_UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
SECURITY_MIRROR=http://security.ubuntu.com/ubuntu
DEBOOTSTRAP_INCLUDE=systemd,systemd-sysv,dbus,ca-certificates,curl,gnupg,apt-utils
UBUNTU_KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg

die() { printf 'build-image: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf 'build-image: %s\n' "$*" >&2; }
usage() {
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
TARGET=""
COMPONENTS="base,system,dnsclient,autovhost,safenet"
GRUB_HASH=""
ROOTFS=/mnt/safebox-rootfs
CAPTURE=1
ZONE=""
PROJECT=""
IMAGE_FAMILY=safebox
AUDIT_PUBKEYS_FILE="${AUDIT_PUBKEYS:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)             TARGET="${2:-}"; shift 2 ;;
        --components)         COMPONENTS="${2:-}"; shift 2 ;;
        --grub-password-hash) GRUB_HASH="${2:-}"; shift 2 ;;
        --rootfs)             ROOTFS="${2:-}"; shift 2 ;;
        --audit-pubkeys)      AUDIT_PUBKEYS_FILE="${2:-}"; shift 2 ;;
        --no-capture)         CAPTURE=0; shift ;;
        --zone)               ZONE="${2:-}"; shift 2 ;;
        --project)            PROJECT="${2:-}"; shift 2 ;;
        --image-family)       IMAGE_FAMILY="${2:-}"; shift 2 ;;
        --mirror)             DISTRO_MIRROR="${2:-}"; shift 2 ;;
        -h|--help)            usage ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done
[[ -n $TARGET ]] || die "--target <block-device> is required"

# Component list: base and system are mandatory and the order is fixed,
# because system creates the users dnsclient and autovhost need and
# dnsclient copies the attestation client that system installs.
IFS=',' read -r -a WANTED <<<"$COMPONENTS"
has_component() { local c; for c in "${WANTED[@]}"; do [[ $c == "$1" ]] && return 0; done; return 1; }
for c in "${WANTED[@]}"; do
    case "$c" in base|system|dnsclient|autovhost|safenet) ;; *) die "unknown component '$c' (valid: base,system,dnsclient,autovhost,safenet)" ;; esac
done
has_component base   || die "component 'base' is mandatory"
has_component system || die "component 'system' is mandatory"
ORDERED=(base system)
has_component dnsclient && ORDERED+=(dnsclient)
has_component autovhost && ORDERED+=(autovhost)
has_component safenet   && ORDERED+=(safenet)

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "must run as root"
for t in debootstrap sgdisk mkfs.vfat mkfs.ext4 veritysetup rsync python3 jq chroot \
         blockdev lsblk findmnt wipefs udevadm sha256sum visudo; do
    command -v "$t" >/dev/null 2>&1 || die "host tool '$t' missing (see header for host packages)"
done
# shellcheck disable=SC1091
HOST_ID="$(. /etc/os-release && echo "${ID:-}:${VERSION_ID:-}")"
[[ $HOST_ID == ubuntu:24.04 ]] || die "build host must be Ubuntu 24.04 (found $HOST_ID)"
[[ -r $UBUNTU_KEYRING ]] || die "$UBUNTU_KEYRING missing: install ubuntu-keyring on the build host"
[[ -r /usr/share/debootstrap/scripts/$DISTRO_SUITE ]] || die "debootstrap has no '$DISTRO_SUITE' suite script"
[[ -x $COMMON_IMAGE/build-verity-root.sh ]] || die "$COMMON_IMAGE/build-verity-root.sh missing"
[[ -x $COMMON_IMAGE/cleanup-image.sh ]]     || die "$COMMON_IMAGE/cleanup-image.sh missing"
[[ -x $COMMON_IMAGE/verify-image.sh ]]      || die "$COMMON_IMAGE/verify-image.sh missing"
[[ -x $COMMON_IMAGE/make-grub-password.sh ]] || die "$COMMON_IMAGE/make-grub-password.sh missing"
[[ -f $REPO/common/sudo/safebox-system ]]   || die "repository layout unexpected: $REPO/common/sudo/safebox-system missing"
for c in "${ORDERED[@]}"; do
    case "$c" in
        base|system) inst="$SCRIPT_DIR/components/$c/install-$c.sh" ;;
        *)           inst="$REPO/common/$c/install-$c.sh" ;;
    esac
    [[ -f $inst ]] || die "installer for '$c' missing: $inst"
done
if [[ $CAPTURE -eq 1 ]]; then
    command -v gcloud >/dev/null 2>&1 || die "gcloud missing (needed for capture; pass --no-capture to skip)"
    command -v curl >/dev/null 2>&1 || die "curl missing"
fi

# Target disk: whole, unmounted, not the host's root disk.
TARGET_REAL="$(readlink -f "$TARGET")" || die "cannot resolve $TARGET"
[[ -b $TARGET_REAL ]] || die "$TARGET ($TARGET_REAL) is not a block device"
[[ "$(lsblk -rno TYPE "$TARGET_REAL" | head -n1)" == disk ]] || die "$TARGET_REAL is not a whole disk"
if lsblk -rno MOUNTPOINT "$TARGET_REAL" | grep -q .; then
    die "$TARGET_REAL or one of its partitions is mounted"
fi
ROOT_SRC="$(findmnt -no SOURCE / || true)"
if [[ -n $ROOT_SRC ]]; then
    ROOT_DISK="$(lsblk -rno PKNAME "$ROOT_SRC" 2>/dev/null | head -n1 || true)"
    [[ -n $ROOT_DISK && /dev/$ROOT_DISK == "$TARGET_REAL" ]] && die "$TARGET_REAL is the build host's root disk"
fi
TARGET_BYTES="$(blockdev --getsize64 "$TARGET_REAL")"
[[ $TARGET_BYTES -ge $((10 * 1024 * 1024 * 1024)) ]] || die "target disk is $((TARGET_BYTES / 1048576)) MiB; use at least 10 GiB"

# GCE disk name from the by-id symlink (google-<name>). Needed only for
# capture, but resolve it now so a bad --target fails before an hour of work.
gce_disk_name() {
    local dev="$1" link
    case "$dev" in
        /dev/disk/by-id/google-*)
            basename "$dev" | sed 's/^google-//'; return 0 ;;
    esac
    for link in /dev/disk/by-id/google-*; do
        [[ -L $link ]] || continue
        case "$link" in *-part[0-9]*) continue ;; esac
        if [[ "$(readlink -f "$link")" == "$TARGET_REAL" ]]; then
            basename "$link" | sed 's/^google-//'; return 0
        fi
    done
    return 1
}
DISK_NAME=""
if [[ $CAPTURE -eq 1 ]]; then
    DISK_NAME="$(gce_disk_name "$TARGET")" || die "cannot derive the GCE disk name of $TARGET from /dev/disk/by-id/google-*; pass the by-id path"
    [[ $DISK_NAME =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || die "derived disk name '$DISK_NAME' is not a valid GCE resource name"
fi

# Rootfs directory: must not exist or must be empty, and must not be /.
ROOTFS="$(readlink -f "$ROOTFS")"
[[ $ROOTFS != / ]] || die "--rootfs may not be /"
if [[ -e $ROOTFS ]]; then
    [[ -d $ROOTFS ]] || die "$ROOTFS exists and is not a directory"
    [[ -z "$(ls -A "$ROOTFS")" ]] || die "$ROOTFS is not empty; remove it or pass a fresh --rootfs"
fi
WORK_PARENT="$(dirname "$ROOTFS")"
MANIFEST_DIR="$WORK_PARENT/manifests"   # where build-verity-root.sh and verify-image.sh write
mkdir -p "$ROOTFS" "$MANIFEST_DIR"

# ---------------------------------------------------------------------------
# Mount bookkeeping: everything mounted under the rootfs is recorded and
# unmounted in reverse order by the EXIT trap, success or failure.
# ---------------------------------------------------------------------------
MOUNTED=()
cleanup() {
    local rc=$? m
    set +e
    sync
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        m="${MOUNTED[$i]}"
        umount -l "$m" 2>/dev/null
    done
    MOUNTED=()
    if [[ $rc -ne 0 ]]; then
        log "FAILED (exit $rc); rootfs left at $ROOTFS for inspection"
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
do_umount() {
    local target="$1" i
    umount "$target" || umount -l "$target" || die "umount $target failed"
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        if [[ ${MOUNTED[$i]} == "$target" ]]; then
            unset 'MOUNTED[i]'
            MOUNTED=(${MOUNTED[@]+"${MOUNTED[@]}"})
            break
        fi
    done
}
umount_all() {
    sync
    while [[ ${#MOUNTED[@]} -gt 0 ]]; do
        do_umount "${MOUNTED[${#MOUNTED[@]}-1]}"
    done
}

# ---------------------------------------------------------------------------
# 1. Bootstrap
# ---------------------------------------------------------------------------
log "debootstrap $DISTRO_SUITE into $ROOTFS from $DISTRO_MIRROR"
debootstrap --variant=minbase --arch=amd64 \
    --include="$DEBOOTSTRAP_INCLUDE" \
    --keyring="$UBUNTU_KEYRING" \
    "$DISTRO_SUITE" "$ROOTFS" "$DISTRO_MIRROR" \
    || die "debootstrap failed"
[[ -x $ROOTFS/bin/bash ]] || die "debootstrap produced no /bin/bash"
[[ -x $ROOTFS/usr/bin/apt-get ]] || die "debootstrap produced no apt-get"
# apt sources for the chroot (deb822). debootstrap leaves a one-line
# sources.list behind; replace it so the pockets are not listed twice.
# Nothing on the running box ever reads this: apt cannot write to a verity
# root.
rm -f "$ROOTFS/etc/apt/sources.list" "$ROOTFS"/etc/apt/sources.list.d/*.list 2>/dev/null || true
mkdir -p "$ROOTFS/etc/apt/sources.list.d"
cat >"$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" <<EOF
# Written by gcp/scripts/build-image.sh for the image build only.
Types: deb
URIs: $DISTRO_MIRROR
Suites: $DISTRO_SUITE $DISTRO_SUITE-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: $SECURITY_MIRROR
Suites: $DISTRO_SUITE-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

# ---------------------------------------------------------------------------
# 2. Chroot and run installers
# ---------------------------------------------------------------------------
log "mounting pseudo filesystems and the repository into the chroot"
do_mount -t proc proc "$ROOTFS/proc"
do_mount -t sysfs sysfs "$ROOTFS/sys"
do_mount --bind /dev "$ROOTFS/dev"
do_mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts "$ROOTFS/dev/pts"
do_mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$ROOTFS/run"
do_mount --bind "$REPO" "$ROOTFS/opt/safebox-src"
mount -o remount,bind,ro "$ROOTFS/opt/safebox-src" || die "could not remount /opt/safebox-src read-only"
# Name resolution for apt, npm and the nodejs.org download. The host file is
# copied (dereferenced), and replaced with the resolved stub symlink once
# the last installer has run.
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf" || die "cannot copy /etc/resolv.conf"

log "apt-get update in the chroot"
chroot "$ROOTFS" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive \
    apt-get -q update || die "apt-get update failed in the chroot (mirror $DISTRO_MIRROR)"

run_installer() {
    local name="$1" path="$2"
    log "==> installer: $name ($path)"
    chroot "$ROOTFS" /usr/bin/env -i \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root TERM="${TERM:-dumb}" LC_ALL=C \
        DEBIAN_FRONTEND=noninteractive \
        SAFEBOX_CHROOT=1 SAFEBOX_SRC=/opt/safebox-src SAFEBOX_CLOUD="$CLOUD" \
        OPENSSL_VERSION="${OPENSSL_VERSION:-}" SAFEBOX_OPENSSL_SHA256="${SAFEBOX_OPENSSL_SHA256:-}" \
        NODE_VERSION="${NODE_VERSION:-}" SAFEBOX_NODE_SHA256="${SAFEBOX_NODE_SHA256:-}" \
        SAFEBOX_ALLOW_UNENCRYPTED_MEMORY="${SAFEBOX_ALLOW_UNENCRYPTED_MEMORY:-}" \
        SAFEBOX_DNS_RELAYS="${SAFEBOX_DNS_RELAYS:-}" SAFEBOX_SAFENET_LOGS="${SAFEBOX_SAFENET_LOGS:-}" \
        /bin/bash "$path" \
        || die "installer '$name' failed"
}
for c in "${ORDERED[@]}"; do
    case "$c" in
        base|system) run_installer "$c" "/opt/safebox-src/$CLOUD/scripts/components/$c/install-$c.sh" ;;
        *)           run_installer "$c" "/opt/safebox-src/common/$c/install-$c.sh" ;;
    esac
done

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

# Runtime resolver: systemd-resolved's stub. The symlink target lives in
# /run, which is populated at boot.
rm -f "$ROOTFS/etc/resolv.conf"
ln -s /run/systemd/resolve/stub-resolv.conf "$ROOTFS/etc/resolv.conf"

# Belt and braces: install-base.sh stripped setuid bits, but later
# installers ran npm ci and copied files; strip again before the assertions
# so a stray bit fails here with a name rather than only in verify-image.sh.
while IFS= read -r f; do
    rel="${f#"$ROOTFS"}"
    case "$rel" in
        /usr/bin/sudo|/usr/bin/newuidmap|/usr/bin/newgidmap|/usr/bin/mount|/usr/bin/umount) ;;
        *) chmod u-s "$f"; log "stripped setuid: $rel" ;;
    esac
done < <(find "$ROOTFS" -xdev -type f -perm -4000 2>/dev/null)

# ---------------------------------------------------------------------------
# 3. Cleanup and audit-mode verification
# ---------------------------------------------------------------------------
# The repository bind mount comes out first so nothing under
# /opt/safebox-src can be swept or counted. /proc, /sys, /dev stay for the
# chroot calls (userdel, passwd -l, visudo, systemctl) the two scripts make.
do_umount "$ROOTFS/opt/safebox-src"
rmdir "$ROOTFS/opt/safebox-src" 2>/dev/null || true

log "cleanup-image.sh $ROOTFS"
"$COMMON_IMAGE/cleanup-image.sh" "$ROOTFS" || die "cleanup-image.sh failed"
log "verify-image.sh --audit $ROOTFS"
"$COMMON_IMAGE/verify-image.sh" --audit "$ROOTFS" || die "verify-image.sh --audit failed; the audit image is not shippable"
INVENTORY="$MANIFEST_DIR/image-inventory.json"
[[ -s $INVENTORY ]] || die "verify-image.sh did not write $INVENTORY"
umount_all

# ---------------------------------------------------------------------------
# GRUB password (shared by both verity builds)
# ---------------------------------------------------------------------------
if [[ -z $GRUB_HASH ]]; then
    log "generating a GRUB superuser password hash (random passphrase, not stored)"
    GRUB_HASH="$("$COMMON_IMAGE/make-grub-password.sh")" || die "make-grub-password.sh failed"
fi
case "$GRUB_HASH" in grub.pbkdf2.sha512.*) ;; *) die "--grub-password-hash must be a grub.pbkdf2.sha512 hash" ;; esac

# ---------------------------------------------------------------------------
# 4. Two-AMI workflow: audit capture → seal → production capture
# ---------------------------------------------------------------------------
export SOURCE_DATE_EPOCH=0
DATE_TAG="$(date -u +%Y%m%d)"

# --- GCE metadata helper --------------------------------------------------
metadata() {
    curl -sf --max-time 5 -H 'Metadata-Flavor: Google' "http://169.254.169.254/computeMetadata/v1/$1"
}

# Resolve project / zone / instance once (needed for capture and disk ops).
BUILD_INSTANCE=""
if [[ $CAPTURE -eq 1 ]]; then
    if [[ -z $PROJECT ]]; then
        PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
        [[ -n $PROJECT ]] || PROJECT="$(metadata project/project-id || true)"
    fi
    [[ -n $PROJECT ]] || die "cannot determine the project; pass --project"
    if [[ -z $ZONE ]]; then
        ZONE="$(metadata instance/zone | awk -F/ '{print $NF}' || true)"
    fi
    [[ -n $ZONE ]] || die "cannot determine the zone; pass --zone"
    BUILD_INSTANCE="$(metadata instance/name || true)"
fi

# --- Helper: capture a GCE image from the target disk ---------------------
# Usage: capture_gce_image <image-name> <role> <roothash>
# Sets: LAST_IMAGE_ID, LAST_IMAGE_SELF_LINK
LAST_IMAGE_ID=""
LAST_IMAGE_SELF_LINK=""
capture_gce_image() {
    local img_name="$1" role="$2" rh="$3"
    LAST_IMAGE_ID=""
    LAST_IMAGE_SELF_LINK=""

    sync
    blockdev --flushbufs "$TARGET_REAL" || true
    udevadm settle || true

    # Detach the disk before imaging so the image is taken from a quiescent
    # device. Fall back to --force if detach is not possible.
    local -a FORCE=()
    if [[ -n $BUILD_INSTANCE ]]; then
        log "detaching $DISK_NAME from $BUILD_INSTANCE"
        if ! gcloud compute instances detach-disk "$BUILD_INSTANCE" --disk "$DISK_NAME" \
                --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null; then
            log "detach failed; imaging the attached disk with --force"
            FORCE=(--force)
        fi
    else
        FORCE=(--force)
    fi

    # UEFI_COMPATIBLE makes the image launchable as a Shielded VM (Secure
    # Boot, vTPM, integrity monitoring). The label value limit is 63
    # characters and a sha256 is 64, so the hash is split across two labels.
    log "creating $role image $img_name (family $IMAGE_FAMILY) from disk $DISK_NAME"
    gcloud compute images create "$img_name" \
        --project "$PROJECT" \
        --source-disk "$DISK_NAME" \
        --source-disk-zone "$ZONE" \
        --family "$IMAGE_FAMILY" \
        --guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,SEV_SNP_CAPABLE \
        --labels="roothash-a=${rh:0:32},roothash-b=${rh:32:32},safebox=image,role=$role" \
        --description="safebox verity root ($role); roothash=${rh}" \
        "${FORCE[@]}" \
        --quiet >/dev/null \
        || die "gcloud compute images create failed for $role image"
    LAST_IMAGE_ID="$(gcloud compute images describe "$img_name" --project "$PROJECT" --format='value(id)')"
    LAST_IMAGE_SELF_LINK="$(gcloud compute images describe "$img_name" --project "$PROJECT" --format='value(selfLink)')"
    log "$role image created: $img_name (id $LAST_IMAGE_ID)"
}

# --- Helper: re-attach the target disk after capture ----------------------
reattach_disk() {
    if [[ -n $BUILD_INSTANCE ]]; then
        log "re-attaching $DISK_NAME to $BUILD_INSTANCE"
        gcloud compute instances attach-disk "$BUILD_INSTANCE" --disk "$DISK_NAME" \
            --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null \
            || die "failed to re-attach $DISK_NAME"
        local attempts=0
        while [[ ! -b "$TARGET_REAL" ]] && (( attempts < 30 )); do
            sleep 1; attempts=$((attempts + 1))
        done
        [[ -b "$TARGET_REAL" ]] || die "$TARGET_REAL did not appear after re-attach"
        udevadm settle || true
    fi
}

# --- 4a. Build and capture the AUDIT image --------------------------------
log "=== building AUDIT image ==="
log "build-verity-root.sh (audit) $ROOTFS $TARGET_REAL"
VERITY_OUT="$(mktemp "$WORK_PARENT/verity-out.XXXXXX")"
"$COMMON_IMAGE/build-verity-root.sh" "$ROOTFS" "$TARGET_REAL" "$GRUB_HASH" | tee "$VERITY_OUT" \
    || die "build-verity-root.sh (audit) failed"
AUDIT_ROOTHASH="$(sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' "$VERITY_OUT" | tail -n1)"
rm -f "$VERITY_OUT"
[[ $AUDIT_ROOTHASH =~ ^[0-9a-f]{64}$ ]] || die "build-verity-root.sh did not print a ROOTHASH (audit)"
log "audit root hash: $AUDIT_ROOTHASH"

AUDIT_IMAGE_NAME="safebox-audit-${DATE_TAG}-${AUDIT_ROOTHASH:0:8}"
AUDIT_IMAGE_ID=""
AUDIT_IMAGE_SELF_LINK=""
if [[ $CAPTURE -eq 1 ]]; then
    capture_gce_image "$AUDIT_IMAGE_NAME" "audit" "$AUDIT_ROOTHASH"
    AUDIT_IMAGE_ID="$LAST_IMAGE_ID"
    AUDIT_IMAGE_SELF_LINK="$LAST_IMAGE_SELF_LINK"
    reattach_disk
else
    log "--no-capture: skipping audit image capture"
fi

# --- 4b. Seal the chroot and capture the PRODUCTION image -----------------
log "=== sealing chroot for PRODUCTION image ==="

# Re-mount pseudo filesystems for chroot operations (seal + verify).
do_mount -t proc proc "$ROOTFS/proc"
do_mount -t sysfs sysfs "$ROOTFS/sys"
do_mount --bind /dev "$ROOTFS/dev"
do_mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts "$ROOTFS/dev/pts"
do_mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$ROOTFS/run"

log "safebox-seal-image.sh --chroot $ROOTFS"
"$REPO/common/seal/safebox-seal-image.sh" --chroot "$ROOTFS" || die "safebox-seal-image.sh failed"

log "verify-image.sh $ROOTFS (production)"
"$COMMON_IMAGE/verify-image.sh" "$ROOTFS" || die "verify-image.sh failed; the production image is not shippable"
umount_all

log "build-verity-root.sh (production) $ROOTFS $TARGET_REAL"
VERITY_OUT="$(mktemp "$WORK_PARENT/verity-out.XXXXXX")"
"$COMMON_IMAGE/build-verity-root.sh" "$ROOTFS" "$TARGET_REAL" "$GRUB_HASH" | tee "$VERITY_OUT" \
    || die "build-verity-root.sh (production) failed"
ROOTHASH="$(sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' "$VERITY_OUT" | tail -n1)"
rm -f "$VERITY_OUT"
[[ $ROOTHASH =~ ^[0-9a-f]{64}$ ]] || die "build-verity-root.sh did not print a ROOTHASH (production)"
VERITY_JSON="$MANIFEST_DIR/verity.json"
[[ -s $VERITY_JSON ]] || die "$VERITY_JSON missing after build-verity-root.sh"
[[ "$(jq -r .roothash "$VERITY_JSON")" == "$ROOTHASH" ]] || die "verity.json roothash does not match the printed one"
log "production root hash: $ROOTHASH"

IMAGE_NAME="safebox-${DATE_TAG}-${ROOTHASH:0:8}"
IMAGE_ID=""
IMAGE_SELF_LINK=""
if [[ $CAPTURE -eq 1 ]]; then
    capture_gce_image "$IMAGE_NAME" "production" "$ROOTHASH"
    IMAGE_ID="$LAST_IMAGE_ID"
    IMAGE_SELF_LINK="$LAST_IMAGE_SELF_LINK"
else
    log "--no-capture: skipping production image capture"
fi

# ---------------------------------------------------------------------------
# 5. Manifest
# ---------------------------------------------------------------------------
mkdir -p "$REPO/manifests"
OUT="$REPO/manifests/${CLOUD}-${DATE_TAG}.json"
GIT_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "")"
GIT_DIRTY="false"
if [[ -n $GIT_COMMIT ]] && ! git -C "$REPO" diff --quiet 2>/dev/null; then GIT_DIRTY="true"; fi
BASE_MANIFEST_SHA=""
[[ -f $ROOTFS/opt/safebox/manifests/base.json ]] && BASE_MANIFEST_SHA="$(sha256sum "$ROOTFS/opt/safebox/manifests/base.json" | awk '{print $1}')"
SYSTEM_MANIFEST_SHA=""
[[ -f $ROOTFS/opt/safebox/manifests/system.json ]] && SYSTEM_MANIFEST_SHA="$(sha256sum "$ROOTFS/opt/safebox/manifests/system.json" | awk '{print $1}')"
jq -n \
    --arg cloud "$CLOUD" \
    --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg imageName "${IMAGE_NAME}" \
    --arg imageId "$IMAGE_ID" \
    --arg imageSelfLink "$IMAGE_SELF_LINK" \
    --arg auditImageName "${AUDIT_IMAGE_NAME}" \
    --arg auditImageId "$AUDIT_IMAGE_ID" \
    --arg auditImageSelfLink "$AUDIT_IMAGE_SELF_LINK" \
    --arg imageFamily "$IMAGE_FAMILY" \
    --arg project "${PROJECT:-}" \
    --arg zone "${ZONE:-}" \
    --arg roothash "$ROOTHASH" \
    --arg auditRoothash "$AUDIT_ROOTHASH" \
    --arg components "$(IFS=,; echo "${ORDERED[*]}")" \
    --arg distro "$DISTRO_LABEL" \
    --arg kernelPkg "$KERNEL_PKG" \
    --arg kernelVer "$KERNEL_VERSION" \
    --arg inventorySha "$(sha256sum "$INVENTORY" | awk '{print $1}')" \
    --arg baseSha "$BASE_MANIFEST_SHA" \
    --arg systemSha "$SYSTEM_MANIFEST_SHA" \
    --arg gitCommit "$GIT_COMMIT" \
    --argjson gitDirty "$GIT_DIRTY" \
    --argjson captured "$CAPTURE" \
    --slurpfile verity "$VERITY_JSON" \
    '{
      schema: "safebox-image-manifest/2",
      cloud: $cloud,
      distro: $distro,
      kernelPackage: $kernelPkg,
      kernelPackageVersion: (if $kernelVer == "" then null else $kernelVer end),
      builtAt: $builtAt,
      production: {
        image: { name: $imageName, id: $imageId, selfLink: $imageSelfLink, family: $imageFamily, project: $project, sourceZone: $zone, captured: ($captured == 1) },
        roothash: $roothash
      },
      audit: {
        image: { name: $auditImageName, id: $auditImageId, selfLink: $auditImageSelfLink, family: $imageFamily, project: $project, sourceZone: $zone, captured: ($captured == 1) },
        roothash: $auditRoothash
      },
      components: ($components | split(",")),
      verity: $verity[0],
      inventorySha256: $inventorySha,
      componentManifests: { "base.json": $baseSha, "system.json": $systemSha },
      git: { commit: $gitCommit, dirty: $gitDirty },
      guestOsFeatures: ["UEFI_COMPATIBLE", "VIRTIO_SCSI_MULTIQUEUE", "GVNIC", "SEV_SNP_CAPABLE"]
    }' >"$OUT"
cp -f "$VERITY_JSON" "$REPO/manifests/${CLOUD}-${DATE_TAG}-verity.json"
cp -f "$INVENTORY"   "$REPO/manifests/${CLOUD}-${DATE_TAG}-inventory.json"
log "manifest written: $OUT"

AUDIT_LINE="$AUDIT_IMAGE_NAME (not captured)"
[[ -n $AUDIT_IMAGE_ID ]] && AUDIT_LINE="$AUDIT_IMAGE_NAME (id $AUDIT_IMAGE_ID)"
PROD_LINE="$IMAGE_NAME (not captured)"
[[ -n $IMAGE_ID ]] && PROD_LINE="$IMAGE_NAME (id $IMAGE_ID)"
cat >&2 <<EOF

build-image: done (two-AMI workflow)
  audit root hash : $AUDIT_ROOTHASH
  audit image     : $AUDIT_LINE
  prod root hash  : $ROOTHASH
  prod image      : $PROD_LINE
  manifest        : $OUT
  rootfs          : $ROOTFS (safe to delete)

Auditor reproduction:
  1. Boot the audit image ($AUDIT_IMAGE_NAME) as a throwaway Shielded VM
  2. SSH in and inspect (see AUDIT.md)
  3. From a build host, extract the audit image's rootfs
  4. Run: safebox-seal-image.sh --chroot <rootfs>
  5. Run: SOURCE_DATE_EPOCH=0 build-verity-root.sh <rootfs> <disk> <grub-hash>
  6. The resulting root hash must equal: $ROOTHASH
EOF
