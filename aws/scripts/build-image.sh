#!/usr/bin/env bash
#
# build-image.sh — build a hardened Safebox AMI on Ubuntu 24.04 LTS (noble).
#
# This is step-for-step the "Build flow" in docs/HARDENING-PLAN.md. It takes a
# BLANK second disk (--target) attached to an Ubuntu 24.04 build instance,
# debootstraps a minimal noble root into a directory, runs the component
# installers inside a chroot, cleans and verifies the chroot from the host,
# writes the root as a dm-verity volume onto the target disk with
# build-verity-root.sh, snapshots the target volume, and registers an AMI with
# UEFI + Secure Boot + vTPM turned on.
#
# Why Ubuntu on every cloud (this one included, instead of Amazon Linux 2023):
# the data pool is ZFS and the image boots under Secure Boot, so the ZFS kernel
# module must carry a signature the shim/kernel trust chain accepts. Ubuntu is
# the only distribution that ships distro-signed ZFS modules (in
# linux-modules-extra-*, signed with Canonical's kernel key) for its cloud
# kernels. AL2023, OL9 and Debian would all need ZFS built from source and a
# MOK enrolled in the firmware, which a verity root with no console cannot do.
# The AWS-tuned kernel is linux-aws.
#
# The BUILD INSTANCE IS NEVER CAPTURED. We image the separate --target disk, so
# the AMI contains only the bytes build-verity-root.sh wrote, hashed by verity,
# and nothing from the build host's running root. That is what lets the root
# hash on the kernel command line mean something.
#
# Why a chroot and not a running image: the installers must be chroot-safe
# (no systemctl start, no TPM, no zpool, no IMDS). Everything that needs the
# live box — sealing keys, creating the pool, registration — happens on the
# first boot of each production instance, bound to that instance's TPM.
#
# The build host must itself be Ubuntu 24.04: debootstrap then finds the
# noble suite script and ubuntu-keyring's archive keyring without any extra
# --keyring plumbing, and the host's apt/gpg verify the same archive.
#
# Host packages required on the Ubuntu 24.04 build instance (NOT in the image):
#   debootstrap, ubuntu-keyring, gdisk (sgdisk), dosfstools, e2fsprogs,
#   cryptsetup-bin (veritysetup), rsync, util-linux, python3, jq, curl,
#   awscli (aws), nvme-cli, python3-uefivars (the `uefivars` command, for the
#   Secure Boot var store).
#
# Usage:
#   build-image.sh --target /dev/nvme1n1 [options]
#
# Options:
#   --target <block-device>      REQUIRED. Blank disk the image is written to.
#   --components base,system,dnsclient,autovhost,safenet
#                                Default all five. base and system are
#                                mandatory and are added if omitted.
#   --grub-password-hash <hash>  grub.pbkdf2.sha512.* hash. Default: generated
#                                by common/image/make-grub-password.sh (random
#                                passphrase, discarded).
#   --rootfs <dir>               Chroot build directory. Default /mnt/safebox-rootfs.
#   --audit-pubkeys <file>       File containing SSH public keys (one per line)
#                                for the safebox-audit user in the audit AMI.
#                                Default: $AUDIT_PUBKEYS env var.
#   --no-capture                 Build the disk but do not snapshot/register an AMI.
#   --region <aws-region>        Override the region for the capture (else the
#                                build instance's own region from IMDS).
#   --mirror <url>               Ubuntu archive mirror for debootstrap and the
#                                chroot's apt. Default http://archive.ubuntu.com/ubuntu
#                                (or $SAFEBOX_UBUNTU_MIRROR). From inside EC2 the
#                                regional mirror is faster:
#                                http://<region>.ec2.archive.ubuntu.com/ubuntu

set -euo pipefail
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# ---------------------------------------------------------------------------
# Constants and small helpers
# ---------------------------------------------------------------------------
CLOUD=aws
DISTRO_SUITE=noble
DISTRO_LABEL=ubuntu-24.04
KERNEL_PKG=linux-aws
DEBOOTSTRAP_INCLUDE=systemd,systemd-sysv,dbus,ca-certificates,curl,gnupg,apt-utils
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root is three levels up: aws/scripts/build-image.sh -> aws/scripts -> aws -> repo.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON="$REPO_ROOT/common"
DATE_TAG="$(date -u +%Y%m%d)"

die() { echo "build-image: FATAL: $*" >&2; exit 1; }
log() { echo "build-image: $*" >&2; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
TARGET=""
COMPONENTS="base,system,dnsclient,autovhost,safenet"
GRUB_HASH=""
ROOTFS="/mnt/safebox-rootfs"
CAPTURE=1
REGION=""
MIRROR="${SAFEBOX_UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
AUDIT_PUBKEYS_FILE="${AUDIT_PUBKEYS:-}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)              TARGET="${2:-}"; shift 2 ;;
        --components)          COMPONENTS="${2:-}"; shift 2 ;;
        --grub-password-hash)  GRUB_HASH="${2:-}"; shift 2 ;;
        --rootfs)              ROOTFS="${2:-}"; shift 2 ;;
        --audit-pubkeys)       AUDIT_PUBKEYS_FILE="${2:-}"; shift 2 ;;
        --no-capture)          CAPTURE=0; shift ;;
        --region)              REGION="${2:-}"; shift 2 ;;
        --mirror)              MIRROR="${2:-}"; shift 2 ;;
        -h|--help)
            sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

[ -n "$TARGET" ] || die "--target <block-device> is required"

# base and system are mandatory; add them if the operator left them out, and
# normalise to a de-duplicated, order-preserving list that always begins with
# base,system so the dependency order (system needs base; dnsclient/autovhost
# need system) holds.
normalise_components() {
    local requested="$1" out="base,system" c
    IFS=',' read -ra _reqs <<<"$requested"
    for c in "${_reqs[@]}"; do
        c="${c// /}"
        [ -n "$c" ] || continue
        case "$c" in
            base|system) ;;                 # already at the front
            dnsclient|autovhost|safenet)
                case ",$out," in *",$c,"*) ;; *) out="$out,$c" ;; esac ;;
            *) die "unknown component '$c' (base,system,dnsclient,autovhost,safenet)" ;;
        esac
    done
    echo "$out"
}
COMPONENTS="$(normalise_components "$COMPONENTS")"
log "components: $COMPONENTS"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -f "$COMMON/image/build-verity-root.sh" ] || die "repo layout wrong: $COMMON/image/build-verity-root.sh not found"

# The bootstrap relies on the host's debootstrap suite scripts and
# ubuntu-keyring; keep the host and the image on the same release.
# shellcheck disable=SC1091
HOST_ID="$(. /etc/os-release && echo "${ID:-}:${VERSION_ID:-}")"
[ "$HOST_ID" = "ubuntu:24.04" ] || die "build host must be Ubuntu 24.04 (found $HOST_ID)"
[ -r /usr/share/keyrings/ubuntu-archive-keyring.gpg ] || die "ubuntu-archive-keyring.gpg missing: apt-get install ubuntu-keyring"
[ -r "/usr/share/debootstrap/scripts/$DISTRO_SUITE" ] || die "debootstrap has no '$DISTRO_SUITE' suite script"

# Host tools. aws/nvme are only needed when we capture.
HOST_TOOLS="debootstrap chroot sgdisk mkfs.ext4 mkfs.vfat e2fsck veritysetup rsync python3 jq curl blkid lsblk findmnt wipefs blockdev udevadm"
[ "$CAPTURE" -eq 1 ] && HOST_TOOLS="$HOST_TOOLS aws nvme"
for t in $HOST_TOOLS; do
    command -v "$t" >/dev/null 2>&1 || die "host tool '$t' not found (see header: 'Host packages required')"
done

# The target must be a whole, unmounted, unused block device: imaging it wipes
# it, so a mistyped root device must be refused rather than destroyed.
[ -b "$TARGET" ] || die "$TARGET is not a block device"
[ "$(lsblk -rno TYPE "$TARGET" | head -n1)" = "disk" ] || die "$TARGET is not a whole disk"
if findmnt -rn -S "$TARGET" >/dev/null 2>&1 || lsblk -rno MOUNTPOINT "$TARGET" | grep -q .; then
    die "$TARGET or one of its partitions is mounted; refusing to image it"
fi

# A GRUB password hash is mandatory for the image (verify-image.sh enforces a
# superuser). Generate a throwaway one if the operator did not supply it.
if [ -z "$GRUB_HASH" ]; then
    log "no --grub-password-hash given; generating a random one (passphrase discarded)"
    GRUB_HASH="$(bash "$COMMON/image/make-grub-password.sh")" || die "make-grub-password.sh failed"
fi
case "$GRUB_HASH" in
    grub.pbkdf2.sha512.*) ;;
    *) die "grub password hash must start with grub.pbkdf2.sha512." ;;
esac

# ---------------------------------------------------------------------------
# Mount bookkeeping / EXIT trap
# ---------------------------------------------------------------------------
# Everything we bind-mount into the chroot is recorded and torn down in reverse
# on exit, success or failure, so a failed build never leaves /proc, /sys, the
# read-only source bind, or the pseudo-filesystems mounted under $ROOTFS.
MOUNTED=()
do_mount() {
    local target="${*: -1}"
    mkdir -p "$target"
    mount "$@" || die "mount failed: $*"
    MOUNTED+=("$target")
}
cleanup() {
    local rc=$? i m
    set +e
    sync
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        m="${MOUNTED[$i]}"
        umount -l "$m" 2>/dev/null
    done
    exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1: debootstrap a minimal Ubuntu noble root into $ROOTFS
# ---------------------------------------------------------------------------
# Deliberately minimal (minbase): just enough of a root that apt and the
# component installers run inside the chroot (step 2) can install the full
# stack, including the signed linux-aws kernel and its ZFS modules. The
# archive keyring comes from the host's ubuntu-keyring package; debootstrap
# verifies the Release files against it.
log "debootstrap $DISTRO_SUITE into $ROOTFS from $MIRROR"
[ -e "$ROOTFS" ] && [ -n "$(ls -A "$ROOTFS" 2>/dev/null)" ] && die "$ROOTFS exists and is not empty; remove it or pass a fresh --rootfs"
mkdir -p "$ROOTFS"

debootstrap --variant=minbase --arch=amd64 \
    --include="$DEBOOTSTRAP_INCLUDE" \
    --keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg \
    "$DISTRO_SUITE" "$ROOTFS" "$MIRROR" \
    || die "debootstrap failed"
[ -x "$ROOTFS/bin/bash" ] || die "debootstrap produced no /bin/bash"
[ -x "$ROOTFS/usr/bin/apt-get" ] || die "debootstrap produced no apt-get in the rootfs"

# apt sources for the chroot (deb822). debootstrap leaves a one-line
# sources.list behind; replace it so the pockets are not listed twice. Nothing
# on the running box ever reads this: apt cannot write to a verity root.
rm -f "$ROOTFS/etc/apt/sources.list" "$ROOTFS"/etc/apt/sources.list.d/*.list 2>/dev/null || true
mkdir -p "$ROOTFS/etc/apt/sources.list.d"
cat >"$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" <<SOURCES
# Written by aws/scripts/build-image.sh for the image build only.
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
SOURCES

# ---------------------------------------------------------------------------
# Step 2: bind-mount and run the component installers in the chroot
# ---------------------------------------------------------------------------
log "preparing chroot mounts"
do_mount -t proc    proc    "$ROOTFS/proc"
do_mount -t sysfs   sysfs   "$ROOTFS/sys"
do_mount --bind     /dev    "$ROOTFS/dev"
do_mount --bind     /dev/pts "$ROOTFS/dev/pts"
do_mount -t tmpfs   tmpfs   "$ROOTFS/run"
# The whole repo, read-only, at the path every installer expects.
mkdir -p "$ROOTFS/opt/safebox-src"
do_mount --bind "$REPO_ROOT" "$ROOTFS/opt/safebox-src"
mount -o remount,ro,bind "$ROOTFS/opt/safebox-src" || die "could not remount source bind read-only"
# DNS for package/npm downloads inside the chroot.
rm -f "$ROOTFS/etc/resolv.conf"
cp -L /etc/resolv.conf "$ROOTFS/etc/resolv.conf" || die "cannot copy /etc/resolv.conf"

log "apt-get update in the chroot"
chroot "$ROOTFS" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive \
    apt-get -q update || die "apt-get update failed in the chroot (mirror $MIRROR)"

run_installer() {
    # run_installer <component> <path-inside-chroot>
    local name="$1" path="$2"
    log "running installer: $name ($path)"
    chroot "$ROOTFS" /usr/bin/env \
        DEBIAN_FRONTEND=noninteractive \
        SAFEBOX_CHROOT=1 SAFEBOX_SRC=/opt/safebox-src SAFEBOX_CLOUD="$CLOUD" \
        OPENSSL_VERSION="${OPENSSL_VERSION:-}" SAFEBOX_OPENSSL_SHA256="${SAFEBOX_OPENSSL_SHA256:-}" \
        NODE_VERSION="${NODE_VERSION:-}" SAFEBOX_NODE_SHA256="${SAFEBOX_NODE_SHA256:-}" \
        SAFEBOX_ALLOW_UNENCRYPTED_MEMORY="${SAFEBOX_ALLOW_UNENCRYPTED_MEMORY:-}" \
        SAFEBOX_DNS_RELAYS="${SAFEBOX_DNS_RELAYS:-}" SAFEBOX_SAFENET_LOGS="${SAFEBOX_SAFENET_LOGS:-}" \
        AUDIT_PUBKEYS="${AUDIT_PUBKEYS_FILE:-}" \
        /bin/bash "$path" || die "installer '$name' failed"
}

IFS=',' read -ra COMP_LIST <<<"$COMPONENTS"
for c in "${COMP_LIST[@]}"; do
    case "$c" in
        base)      run_installer base      /opt/safebox-src/aws/scripts/components/base/install-base.sh ;;
        system)    run_installer system    /opt/safebox-src/aws/scripts/components/system/install-system.sh ;;
        dnsclient) run_installer dnsclient /opt/safebox-src/common/dnsclient/install-dnsclient.sh ;;
        autovhost) run_installer autovhost /opt/safebox-src/common/autovhost/install-autovhost.sh ;;
        safenet)   run_installer safenet   /opt/safebox-src/common/safenet/install-safenet.sh ;;
    esac
done

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

# ---------------------------------------------------------------------------
# Step 3: host-side cleanup and verification of the chroot
# ---------------------------------------------------------------------------
# cleanup-image.sh and verify-image.sh take a ROOTFS DIRECTORY and run from the
# HOST against it (they chroot internally only for userdel/visudo). Tear down
# the pseudo-filesystems and the read-only source bind first so they are not
# swept, inventoried, or mistaken for image content.
log "unmounting chroot pseudo-filesystems before cleanup/verify"
for m in "$ROOTFS/opt/safebox-src" "$ROOTFS/run" "$ROOTFS/dev/pts" "$ROOTFS/dev" "$ROOTFS/sys" "$ROOTFS/proc"; do
    if mountpoint -q "$m" 2>/dev/null; then
        umount -l "$m" 2>/dev/null || true
        # Drop it from the trap stack so cleanup() does not try again.
        for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
            [ "${MOUNTED[$i]}" = "$m" ] && unset 'MOUNTED[i]'
        done
    fi
done
MOUNTED=(${MOUNTED[@]+"${MOUNTED[@]}"})
# Runtime resolver: systemd-resolved's stub, populated under /run at boot.
rm -f "$ROOTFS/etc/resolv.conf"
ln -s ../run/systemd/resolve/stub-resolv.conf "$ROOTFS/etc/resolv.conf"

log "cleanup-image.sh"
bash "$COMMON/image/cleanup-image.sh" "$ROOTFS" || die "cleanup-image.sh failed"

# ---------------------------------------------------------------------------
# Step 4: Two-AMI workflow
#
# AMI A (audit): SSH enabled, safebox-audit user present. Auditors boot this
# to inspect the image, run checks, and verify it matches the spec.
#
# AMI B (production): SSH removed, all accounts locked, sealed flag set.
# Deterministic: an auditor who extracts AMI A's root, runs the seal script,
# and rebuilds the verity disk must get the same root hash as AMI B.
#
# Flow:
#   4a. verify --audit → build-verity-root → snapshot → register audit AMI
#   4b. seal chroot → verify (production) → build-verity-root → snapshot → register production AMI
# ---------------------------------------------------------------------------

# --- 4a: Audit AMI ---
log "verify-image.sh --audit"
bash "$COMMON/image/verify-image.sh" --audit "$ROOTFS" || die "verify-image.sh --audit failed"

log "build-verity-root.sh (audit AMI)"
: "${SOURCE_DATE_EPOCH:=0}"
export SOURCE_DATE_EPOCH
AUDIT_VERITY_OUT="$(bash "$COMMON/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" || die "build-verity-root.sh (audit) failed"
echo "$AUDIT_VERITY_OUT" >&2
AUDIT_ROOTHASH="$(printf '%s\n' "$AUDIT_VERITY_OUT" | sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' | head -n1)"
[ -n "$AUDIT_ROOTHASH" ] || die "could not parse ROOTHASH from audit build"
log "audit root hash: $AUDIT_ROOTHASH"

# --- 4b: Seal and build production AMI ---
log "safebox-seal-image.sh --chroot $ROOTFS"
bash "$COMMON/seal/safebox-seal-image.sh" --chroot "$ROOTFS" || die "safebox-seal-image.sh failed"

log "verify-image.sh (production)"
bash "$COMMON/image/verify-image.sh" "$ROOTFS" || die "verify-image.sh (production) failed"

log "build-verity-root.sh (production AMI)"
VERITY_OUT="$(bash "$COMMON/image/build-verity-root.sh" "$ROOTFS" "$TARGET" "$GRUB_HASH")" || die "build-verity-root.sh (production) failed"
echo "$VERITY_OUT" >&2
ROOTHASH="$(printf '%s\n' "$VERITY_OUT" | sed -n 's/^ROOTHASH=\([0-9a-f]\{64\}\)$/\1/p' | head -n1)"
[ -n "$ROOTHASH" ] || die "could not parse ROOTHASH from production build"
ROOTHASH8="${ROOTHASH:0:8}"
log "production root hash: $ROOTHASH"

# ---------------------------------------------------------------------------
# Step 5 (AWS capture): snapshot the target volume and register the AMI
# ---------------------------------------------------------------------------
# Resolve the EBS volume id of --target. On Nitro the NVMe controller carries
# the volume id in its serial as "volXXXX" (no dash); turn it back into
# "vol-XXXX".
resolve_volume_id() {
    local dev="$1" serial=""
    serial="$(nvme id-ctrl "$dev" 2>/dev/null | sed -n 's/^sn[[:space:]]*:[[:space:]]*\(vol[0-9a-f]*\).*/\1/p' | head -n1)"
    [ -n "$serial" ] || serial="$(lsblk -dno SERIAL "$dev" 2>/dev/null | tr -d '[:space:]')"
    case "$serial" in
        vol-*) echo "$serial" ;;
        vol*)  echo "vol-${serial#vol}" ;;
        *)     echo "" ;;
    esac
}

AUDIT_AMI_ID=""
AUDIT_SNAPSHOT_ID=""
AMI_ID=""
SNAPSHOT_ID=""
if [ "$CAPTURE" -eq 1 ]; then
    # Region and the uefivars tool are only needed on capture.
    if [ -z "$REGION" ]; then
        IMDS_TOKEN="$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
            -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
        REGION="$(curl -sS -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN:-}" \
            "http://169.254.169.254/latest/meta-data/placement/region" 2>/dev/null || true)"
    fi
    [ -n "$REGION" ] || die "could not determine AWS region; pass --region"
    command -v uefivars >/dev/null 2>&1 || die "uefivars (python-uefivars) not found; needed to build the Secure Boot var store"

    TARGET_VOLUME_ID="$(resolve_volume_id "$TARGET")"
    [ -n "$TARGET_VOLUME_ID" ] || die "could not resolve EBS volume id for $TARGET (nvme id-ctrl / lsblk SERIAL both failed)"
    log "target EBS volume: $TARGET_VOLUME_ID in $REGION"

    # Build the UEFI variable store for Secure Boot.
    UEFI_DATA="$(mktemp /var/tmp/safebox-uefi.XXXXXX.bin)"
    if ! uefivars -i none -o aws -O "$UEFI_DATA" --secure-boot 2>/dev/null; then
        uefivars --input-format none --output-format aws --output "$UEFI_DATA" --secure-boot \
            || die "uefivars failed to produce a Secure Boot var store; check its version/flags"
    fi
    [ -s "$UEFI_DATA" ] || die "uefivars produced an empty var store"

    # Helper: snapshot a volume and register an AMI from it.
    capture_ami() {
        local ami_name="$1" description="$2" roothash="$3" role="$4"
        local snap_id ami_id

        log "create-snapshot of $TARGET_VOLUME_ID ($role)"
        snap_id="$(aws ec2 create-snapshot --region "$REGION" \
            --volume-id "$TARGET_VOLUME_ID" \
            --description "$description" \
            --query 'SnapshotId' --output text)" || die "create-snapshot ($role) failed"
        [ -n "$snap_id" ] && [ "$snap_id" != "None" ] || die "create-snapshot ($role) returned no id"
        log "waiting for $snap_id to complete"
        aws ec2 wait snapshot-completed --region "$REGION" --snapshot-ids "$snap_id" \
            || die "snapshot $snap_id ($role) did not complete"

        log "register-image $ami_name ($role)"
        ami_id="$(aws ec2 register-image --region "$REGION" \
            --name "$ami_name" \
            --description "$description" \
            --architecture x86_64 \
            --virtualization-type hvm \
            --ena-support \
            --boot-mode uefi \
            --tpm-support v2.0 \
            --imds-support v2.0 \
            --root-device-name /dev/xvda \
            --uefi-data "file://$UEFI_DATA" \
            --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"SnapshotId\":\"$snap_id\",\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
            --query 'ImageId' --output text)" || die "register-image ($role) failed"
        [ -n "$ami_id" ] && [ "$ami_id" != "None" ] || die "register-image ($role) returned no image id"

        aws ec2 create-tags --region "$REGION" --resources "$ami_id" \
            --tags "Key=Name,Value=$ami_name" "Key=RootHash,Value=$roothash" "Key=Build,Value=safebox" "Key=Role,Value=$role" \
            || log "WARNING: create-tags failed for $ami_id (image still registered)"
        log "registered $role AMI: $ami_id ($snap_id)"

        # Return both IDs via globals (bash can't return strings).
        _CAPTURE_AMI_ID="$ami_id"
        _CAPTURE_SNAPSHOT_ID="$snap_id"
    }

    # --- Capture audit AMI (AMI A) ---
    # The audit AMI was already written to the target disk in step 4a.
    capture_ami "safebox-audit-${DATE_TAG}-${AUDIT_ROOTHASH:0:8}" \
        "Safebox audit AMI (SSH enabled, root hash $AUDIT_ROOTHASH)" \
        "$AUDIT_ROOTHASH" "audit"
    AUDIT_AMI_ID="$_CAPTURE_AMI_ID"
    AUDIT_SNAPSHOT_ID="$_CAPTURE_SNAPSHOT_ID"

    # --- Capture production AMI (AMI B) ---
    # The production image was written to the target disk in step 4b (after seal).
    capture_ami "safebox-${DATE_TAG}-${ROOTHASH8}" \
        "Safebox production AMI (sealed, root hash $ROOTHASH)" \
        "$ROOTHASH" "production"
    AMI_ID="$_CAPTURE_AMI_ID"
    SNAPSHOT_ID="$_CAPTURE_SNAPSHOT_ID"

    rm -f "$UEFI_DATA"
else
    log "--no-capture: skipping snapshot and AMI registration"
fi

# ---------------------------------------------------------------------------
# Step 6: build manifest
# ---------------------------------------------------------------------------
MANIFEST_DIR="$REPO_ROOT/manifests"
mkdir -p "$MANIFEST_DIR"
MANIFEST="$MANIFEST_DIR/${CLOUD}-${DATE_TAG}.json"
VERITY_JSON="$(readlink -f "$ROOTFS/..")/manifests/verity.json"
INVENTORY_JSON="$(readlink -f "$ROOTFS/..")/manifests/image-inventory.json"
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")"

python3 -I - "$MANIFEST" "$CLOUD" "$ROOTHASH" "${AMI_ID:-}" "${SNAPSHOT_ID:-}" \
    "$VERITY_JSON" "$INVENTORY_JSON" "$GIT_COMMIT" "$COMPONENTS" \
    "$DISTRO_LABEL" "$KERNEL_PKG" "${KERNEL_VERSION:-}" \
    "$AUDIT_ROOTHASH" "${AUDIT_AMI_ID:-}" "${AUDIT_SNAPSHOT_ID:-}" <<'PY'
import json, sys, hashlib, datetime, os
(out, cloud, roothash, ami, snap, verity_path, inv_path, commit, components,
 distro, kernel_pkg, kernel_ver,
 audit_roothash, audit_ami, audit_snap) = sys.argv[1:16]

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
    "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "cloud": cloud,
    "distro": distro,
    "kernelPackage": kernel_pkg,
    "kernelPackageVersion": kernel_ver or None,
    "components": components.split(","),
    "production": {
        "roothash": roothash,
        "imageId": ami or None,
        "snapshotId": snap or None,
    },
    "audit": {
        "roothash": audit_roothash or None,
        "imageId": audit_ami or None,
        "snapshotId": audit_snap or None,
    },
    "roothash": roothash,
    "imageId": ami or None,
    "snapshotId": snap or None,
    "gitCommit": commit or None,
    "verity": load(verity_path),
    "inventorySha256": sha256_file(inv_path),
    "inventoryPath": inv_path if os.path.exists(inv_path) else None,
}
with open(out, "w") as f:
    json.dump(doc, f, indent=2, sort_keys=True)
    f.write("\n")
PY
log "manifest written to $MANIFEST"

echo ""
log "BUILD COMPLETE (two-AMI workflow)"
log "  audit root hash      : $AUDIT_ROOTHASH"
[ -n "$AUDIT_AMI_ID" ] && log "  audit AMI (AMI A)    : $AUDIT_AMI_ID ($REGION)"
[ -n "$AUDIT_SNAPSHOT_ID" ] && log "  audit snapshot       : $AUDIT_SNAPSHOT_ID"
log "  production root hash : $ROOTHASH"
[ -n "$AMI_ID" ] && log "  production AMI (AMI B): $AMI_ID ($REGION)"
[ -n "$SNAPSHOT_ID" ] && log "  production snapshot  : $SNAPSHOT_ID"
log "  manifest             : $MANIFEST"
log ""
log "Auditors: boot AMI A (throwaway) to inspect. Then extract AMI A root,"
log "run safebox-seal-image.sh --chroot, run build-verity-root.sh with"
log "SOURCE_DATE_EPOCH=0, and compare the root hash to AMI B's."
log "The build instance is NOT the image; terminate it when done."
