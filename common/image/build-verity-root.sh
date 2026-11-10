#!/bin/bash
# build-verity-root.sh <rootfs-dir> <target-disk> <grub-password-hash>
#
# Step 4 of the build flow in docs/HARDENING-PLAN.md. Takes a finished,
# verified chroot and a blank block device, and produces the image disk:
#
#   p1  SAFEBOX-ESP   512 MiB  FAT32   EF00  shim + signed GRUB + stub grub.cfg (nothing else)
#   p2  SAFEBOX-BOOT    1 GiB  ext4    8300  kernel, initramfs, grub.cfg, /safebox blobs
#   p3  SAFEBOX-ROOT  sized    ext4    8300  root filesystem, dm-verity data
#   p4  SAFEBOX-HASH  rest     raw     8300  dm-verity hash tree
#
# Prints ROOTHASH=<hex> on stdout at the end and records the hash and the
# partition UUIDs in <rootfs-dir>/../manifests/verity.json.
#
# Host packages required (build instance, not the image):
#   gdisk        (sgdisk)
#   e2fsprogs    (mkfs.ext4, e2fsck)
#   dosfstools   (mkfs.vfat)
#   cryptsetup   (veritysetup)
#   rsync
#   util-linux   (wipefs, blkid, lsblk, findmnt, mount, umount, partprobe or blockdev)
#   udev         (udevadm)
#   coreutils, sed, python3 (for the JSON manifest only)
#
# The rootfs itself must already contain the signed shim and GRUB packages
# for its family (shim-x64 + grub2-efi-x64 on AL2023/OL9; shim-signed +
# grub-efi-amd64-signed on Debian/Ubuntu) and the dracut-built initramfs.
#
# Why we write grub.cfg directly and remove BLS entries: the distro's
# grub2-mkconfig and its BLS loader would add entries (recovery, older
# kernels) that bypass the measured command line. One entry, one command
# line, one hash.

set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/grub.cfg.tmpl"

die() {
    echo "build-verity-root: FATAL: $*" >&2
    exit 1
}

log() {
    echo "build-verity-root: $*" >&2
}

usage() {
    echo "usage: $0 <rootfs-dir> <target-disk> <grub-password-hash>" >&2
    exit 2
}

# ---------------------------------------------------------------------------
# Arguments and validation
# ---------------------------------------------------------------------------
[ "$#" -eq 3 ] || usage
ROOTFS="$(readlink -f "$1")"
DISK="$(readlink -f "$2")"
GRUB_HASH="$3"

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -d "$ROOTFS" ] || die "rootfs dir $ROOTFS does not exist"
[ -d "$ROOTFS/usr/lib/modules" ] || die "$ROOTFS has no /usr/lib/modules; not a bootstrapped rootfs"
[ -r "$ROOTFS/etc/os-release" ] || die "$ROOTFS has no /etc/os-release"
[ -b "$DISK" ] || die "$DISK is not a block device"
[ -r "$TEMPLATE" ] || die "grub template $TEMPLATE missing"
[ -x "$SCRIPT_DIR/compute-expected-pcrs.sh" ] || die "$SCRIPT_DIR/compute-expected-pcrs.sh missing or not executable"
case "$GRUB_HASH" in
    grub.pbkdf2.sha512.*) ;;
    *) die "grub password hash must start with grub.pbkdf2.sha512. (use make-grub-password.sh)" ;;
esac
# Refuse to touch a disk that is in use anywhere, including via any of its
# partitions, so a mistyped device cannot wipe the build host.
if findmnt -rn -S "$DISK" >/dev/null 2>&1; then
    die "$DISK is mounted"
fi
if lsblk -rno MOUNTPOINT "$DISK" | grep -q .; then
    die "$DISK has mounted partitions"
fi
if [ "$(lsblk -rno TYPE "$DISK" | head -n1)" != "disk" ]; then
    die "$DISK is not a whole disk"
fi
for c in sgdisk wipefs mkfs.vfat mkfs.ext4 e2fsck tune2fs debugfs blockdev veritysetup rsync udevadm blkid lsblk findmnt sed python3; do
    command -v "$c" >/dev/null 2>&1 || die "host tool '$c' not found (see required packages at top of script)"
done

# ---------------------------------------------------------------------------
# Distro family: decides the GRUB install method and config paths
# ---------------------------------------------------------------------------
# shellcheck disable=SC1091
OS_ID="$(. "$ROOTFS/etc/os-release" && echo "${ID:-}")"
case "$OS_ID" in
    amzn|ol|fedora|rhel|rocky|almalinux)
        FAMILY=fedora
        GRUB_DIR=grub2
        EFI_ID="$OS_ID"
        [ "$OS_ID" = "amzn" ] && EFI_ID=amzn
        [ "$OS_ID" = "ol" ] && EFI_ID=redhat
        ;;
    debian|ubuntu)
        FAMILY=debian
        GRUB_DIR=grub
        EFI_ID=safebox
        ;;
    *)
        die "unsupported distro ID '$OS_ID' in rootfs"
        ;;
esac
log "rootfs distro: $OS_ID (family $FAMILY)"

# ---------------------------------------------------------------------------
# Mount bookkeeping and cleanup
# ---------------------------------------------------------------------------
WORK="$(mktemp -d /var/tmp/safebox-verity.XXXXXX)"
MNT_ROOT="$WORK/root"
MNT_BOOT="$WORK/boot"
MOUNTED=()   # stack of mountpoints, unmounted in reverse order

cleanup() {
    local rc=$? m
    set +e
    sync
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        m="${MOUNTED[$i]}"
        umount -l "$m" 2>/dev/null
    done
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT

do_mount() {
    # do_mount <args...> <target>: wrapper that records the target for the trap.
    local target="${*: -1}"
    mkdir -p "$target"
    mount "$@" || die "mount $* failed"
    MOUNTED+=("$target")
}

do_umount() {
    local target="$1" i
    umount "$target" || die "umount $target failed"
    for (( i=${#MOUNTED[@]}-1; i>=0; i-- )); do
        if [ "${MOUNTED[$i]}" = "$target" ]; then
            unset 'MOUNTED[i]'
            MOUNTED=(${MOUNTED[@]+"${MOUNTED[@]}"})
            break
        fi
    done
}

part_dev() {
    # Partition device name for disk $DISK and index $1 (nvme/loop use "p").
    case "$DISK" in
        *[0-9]) echo "${DISK}p$1" ;;
        *)      echo "${DISK}$1"  ;;
    esac
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------
# Root partition: 1.3x the rootfs's used size rounded up to a GiB, at least
# 4 GiB. The headroom covers ext4 metadata and keeps fsck from complaining;
# nothing is ever written to this filesystem after build.
ROOTFS_BYTES="$(du -sx --block-size=1 --exclude=./boot --exclude=./proc --exclude=./sys \
    --exclude=./dev --exclude=./run --exclude=./tmp --exclude=./var "$ROOTFS" | cut -f1)"
ROOT_GIB=$(( (ROOTFS_BYTES * 13 / 10 + 1073741823) / 1073741824 ))
[ "$ROOT_GIB" -ge 4 ] || ROOT_GIB=4
DISK_BYTES="$(blockdev --getsize64 "$DISK")"
# 512M + 1G + root + at least 256M + GPT overhead
NEED_BYTES=$(( (512 + 1024 + ROOT_GIB * 1024 + 256 + 4) * 1024 * 1024 ))
[ "$DISK_BYTES" -ge "$NEED_BYTES" ] || die "target disk is $((DISK_BYTES / 1048576)) MiB; need at least $((NEED_BYTES / 1048576)) MiB for a ${ROOT_GIB} GiB root"
log "root partition ${ROOT_GIB} GiB (rootfs uses $((ROOTFS_BYTES / 1048576)) MiB)"

# ---------------------------------------------------------------------------
# Partition
# ---------------------------------------------------------------------------
log "wiping and partitioning $DISK"
wipefs -a "$DISK" >/dev/null
sgdisk --zap-all "$DISK" >/dev/null

# Deterministic partition GUIDs.  sgdisk normally assigns random GUIDs to
# each partition; fix them so the GPT table itself is reproducible.  The
# disk GUID is also fixed.
DISK_GUID="$(printf 'disk-guid-%s' "SAFEBOX" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/')"
P1_GUID="$(printf 'part-guid-%s' "SAFEBOX-ESP"  | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/')"
P2_GUID="$(printf 'part-guid-%s' "SAFEBOX-BOOT" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/')"
P3_GUID="$(printf 'part-guid-%s' "SAFEBOX-ROOT" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/')"
P4_GUID="$(printf 'part-guid-%s' "SAFEBOX-HASH" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/')"

sgdisk --disk-guid="$DISK_GUID" \
    --new=1:0:+512M  --typecode=1:EF00 --change-name=1:SAFEBOX-ESP  --partition-guid=1:"$P1_GUID" \
    --new=2:0:+1G    --typecode=2:8300 --change-name=2:SAFEBOX-BOOT --partition-guid=2:"$P2_GUID" \
    --new=3:0:+${ROOT_GIB}G --typecode=3:8300 --change-name=3:SAFEBOX-ROOT --partition-guid=3:"$P3_GUID" \
    --new=4:0:0      --typecode=4:8300 --change-name=4:SAFEBOX-HASH --partition-guid=4:"$P4_GUID" \
    "$DISK" >/dev/null || die "sgdisk failed"
if command -v partprobe >/dev/null 2>&1; then
    partprobe "$DISK"
else
    blockdev --rereadpt "$DISK"
fi
udevadm settle
P1="$(part_dev 1)"; P2="$(part_dev 2)"; P3="$(part_dev 3)"; P4="$(part_dev 4)"
for p in "$P1" "$P2" "$P3" "$P4"; do
    [ -b "$p" ] || die "partition $p did not appear after partprobe"
done
P4_BYTES="$(blockdev --getsize64 "$P4")"
[ "$P4_BYTES" -ge $((256 * 1024 * 1024)) ] || die "hash partition is only $((P4_BYTES / 1048576)) MiB; need >= 256 MiB"

# ---------------------------------------------------------------------------
# Reproducible filesystems
#
# For auditor-reproducible builds, mkfs.ext4 must produce bit-identical output
# given the same content. We fix three sources of nondeterminism:
#   1. UUID — normally random; use a fixed value derived from a build seed
#   2. Timestamps — use SOURCE_DATE_EPOCH (e2fsprogs >= 1.45.3)
#   3. Hash seed — htree directory hashing seed; normally random
#
# SOURCE_DATE_EPOCH is the Unix epoch seconds all filesystem timestamps are
# set to. If not set in the environment, default to 0 (1970-01-01T00:00:00Z).
# The caller should set it for a meaningful, auditable timestamp.
# ---------------------------------------------------------------------------
: "${SOURCE_DATE_EPOCH:=0}"
export SOURCE_DATE_EPOCH

# Deterministic UUID and hash seed. Derived from the partition label so they
# are stable across rebuilds of the same image from the same chroot.
uuid_for_label() {
    printf '%s' "$1" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
}
hash_seed_for_label() {
    printf 'hash-seed-%s' "$1" | sha256sum | sed 's/^\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
}

BOOT_UUID="$(uuid_for_label SAFEBOX-BOOT)"
ROOT_UUID="$(uuid_for_label SAFEBOX-ROOT)"
BOOT_HASH_SEED="$(hash_seed_for_label SAFEBOX-BOOT)"
ROOT_HASH_SEED="$(hash_seed_for_label SAFEBOX-ROOT)"

# Deterministic FAT32 volume ID.  mkfs.vfat normally generates a random
# serial number; -i fixes it.  The value is 8 hex digits (no dashes).
ESP_VOLID="$(printf 'fat32-volid-%s' "SAFEBOX-ESP" | sha256sum | cut -c1-8)"
log "creating filesystems (reproducible: SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
mkfs.vfat -F 32 -n SAFEBOX-ESP -i "$ESP_VOLID" "$P1" >/dev/null
mkfs.ext4 -q -F -L SAFEBOX-BOOT -U "$BOOT_UUID" -E "hash_seed=$BOOT_HASH_SEED" "$P2"
# No journal on the root: dm-verity requires the device to be bit-identical
# to what was hashed, and a journal that could replay on mount would be a
# write. ro + no journal means ext4 never touches the device.
mkfs.ext4 -q -F -L SAFEBOX-ROOT -O ^has_journal -U "$ROOT_UUID" -E "hash_seed=$ROOT_HASH_SEED" "$P3"
wipefs -a "$P4" >/dev/null

# ---------------------------------------------------------------------------
# Populate root via mkfs.ext4 -d (deterministic population)
#
# Using mkfs.ext4 -d instead of mount+rsync+umount eliminates three
# nondeterminism vectors that the kernel introduces during file creation:
#
#   1. Inode generation numbers — the kernel assigns a random i_generation
#      to every new inode (used for NFS handles). libext2fs sets them to 0.
#
#   2. Directory htree layout — when files are created through the kernel,
#      the htree splits depend on insertion order. The insertion order comes
#      from readdir() on the source filesystem, which varies with its hash
#      seed. mkfs.ext4 -d uses scandir()+alphasort, so entries within each
#      directory are always sorted alphabetically.
#
#   3. Block allocation order — the kernel's delayed allocator assigns data
#      blocks based on creation order. Different readdir order on the source
#      → different block allocation → different verity hash. mkfs.ext4 -d
#      allocates blocks sequentially via libext2fs in sorted filename order.
#
# Additionally, when SOURCE_DATE_EPOCH is set, mkfs.ext4 -d clamps every
# file timestamp (mtime, ctime) to that epoch, so files created by the seal
# script at different wall-clock times produce identical on-disk content.
# ---------------------------------------------------------------------------
log "preparing staging directory for root partition"
STAGING="$WORK/staging"
mkdir -p "$STAGING"

# Copy rootfs to staging, excluding runtime dirs and most of /var (which
# lives on ZFS datasets mounted over the read-only root).  /boot lives on
# p2.
rsync -aHAX --numeric-ids \
    --exclude=/boot/* --exclude=/proc/* --exclude=/sys/* --exclude=/dev/* \
    --exclude=/run/* --exclude=/tmp/* \
    --exclude=/var/* \
    --exclude=/etc/machine-id \
    "$ROOTFS/" "$STAGING/"

# Create empty mountpoint directories required by fstab and the boot chain.
for d in boot proc sys dev run tmp var; do
    mkdir -p "$STAGING/$d"
done
chmod 1777 "$STAGING/tmp"
# Mountpoints for ZFS datasets and boot partitions.  The root is read-only
# under verity, so every directory that fstab mounts over must exist in the
# hashed tree; mkdir at boot would fail on the read-only root.
for d in var var/lib/safebox var/lib/docker var/lib/mysql \
         srv/safebox/tenants srv/safebox/models srv/zfs-clones boot boot/efi; do
    mkdir -p "$STAGING/$d"
    chmod 0755 "$STAGING/$d"
done
# The fstab that mounts the datasets (see the header in common/image/fstab).
install -m 0644 -o 0 -g 0 "$SCRIPT_DIR/fstab" "$STAGING/etc/fstab" \
    || die "could not install $SCRIPT_DIR/fstab into staging"
# machine-id must be empty so systemd generates one per boot into the tmpfs
# overlay; a baked-in id would be shared across every box.
: > "$STAGING/etc/machine-id"
chmod 0444 "$STAGING/etc/machine-id"
# Any BLS entries the distro's kernel-install dropped are irrelevant on the
# verity root (grub lives on /boot), but remove them so nothing can be found
# and preferred by a grub that falls back to blscfg.
rm -rf "$STAGING/boot/loader" "$STAGING/boot/grub2" "$STAGING/boot/grub" 2>/dev/null || true

# Zero the partition before mkfs so unused blocks are deterministic.
# Without this, stale data from a previous build or the cloud's volume
# initialisation would appear in the verity hash.
log "zeroing partition $P3"
blkdiscard "$P3" 2>/dev/null || dd if=/dev/zero of="$P3" bs=1M status=none 2>/dev/null || true

# Create the ext4 filesystem and populate it in one step.
#
#   -d <staging>        Populate from directory using libext2fs (no kernel
#                       mount).  scandir()+alphasort for deterministic
#                       directory traversal; sequential block allocation;
#                       no random inode generation numbers; hard links
#                       detected and preserved via inode tracking.
#
#   -O ^has_journal     No journal — dm-verity requires bit-identical device
#
#   -U / -E hash_seed   Fixed UUID and htree hash seed for reproducibility
#
#   lazy_itable_init=0  Fully initialise all inode table blocks during mkfs.
#                       Without this, uninitialised inode table blocks could
#                       contain stale data from the disk.
#
# SOURCE_DATE_EPOCH causes e2fsprogs to clamp every file timestamp to epoch,
# making the result independent of when the seal script ran.
log "creating root filesystem (mkfs.ext4 -d, SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
mkfs.ext4 -q -F -L SAFEBOX-ROOT -O ^has_journal \
    -U "$ROOT_UUID" \
    -E "hash_seed=$ROOT_HASH_SEED,lazy_itable_init=0" \
    -d "$STAGING" "$P3" \
    || die "mkfs.ext4 -d failed"

# Clean up staging directory (no longer needed).
rm -rf "$STAGING"

# Verify the filesystem (there should be nothing to fix on a freshly created
# ext4, but this catches any e2fsprogs bugs).
e2fsck -f -p "$P3" >/dev/null || die "e2fsck of $P3 reported errors"
# Belt and braces: refuse to hash a filesystem that would need a journal
# replay or a check at mount time.
tune2fs -c 0 -i 0 "$P3" >/dev/null

# Normalize superblock timestamps for reproducibility.  e2fsck updates
# s_lastcheck and s_wtime; tune2fs updates s_wtime.  Reset all of them to
# SOURCE_DATE_EPOCH so the same chroot always produces the same verity hash.
if command -v debugfs >/dev/null 2>&1; then
    debugfs -w -R "set_super_value s_mtime $SOURCE_DATE_EPOCH" "$P3" 2>/dev/null
    debugfs -w -R "set_super_value s_wtime $SOURCE_DATE_EPOCH" "$P3" 2>/dev/null
    debugfs -w -R "set_super_value s_lastcheck $SOURCE_DATE_EPOCH" "$P3" 2>/dev/null
    debugfs -w -R "set_super_value s_mnt_count 0" "$P3" 2>/dev/null
    log "normalized superblock timestamps to SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
else
    log "WARNING: debugfs not found; superblock timestamps may not be reproducible"
fi

# ---------------------------------------------------------------------------
# Verity
# ---------------------------------------------------------------------------
log "building verity hash tree on $P4"
ROOTHASH_FILE="$WORK/roothash"
veritysetup format --root-hash-file="$ROOTHASH_FILE" "$P3" "$P4" >/dev/null \
    || die "veritysetup format failed"
ROOTHASH="$(tr -d '[:space:]' < "$ROOTHASH_FILE")"
[[ "$ROOTHASH" =~ ^[0-9a-f]{64}$ ]] || die "unexpected root hash '$ROOTHASH'"
veritysetup verify "$P3" "$P4" "$ROOTHASH" >/dev/null || die "veritysetup verify failed on the fresh tree"

# ---------------------------------------------------------------------------
# /boot and ESP
# ---------------------------------------------------------------------------
log "populating $P2 (/boot) and $P1 (ESP)"
do_mount "$P2" "$MNT_BOOT"
do_mount "$P1" "$MNT_BOOT/efi"

# Kernel and initramfs: take the newest kernel in the rootfs's /boot. The
# build installs exactly one kernel, verify-image.sh asserts that, so
# "newest" is a tie-break that should never fire.
KERNEL=""
for f in "$ROOTFS"/boot/vmlinuz-*; do
    [ -f "$f" ] || continue
    case "$f" in *.rescue*|*rescue*) continue ;; esac
    KERNEL="$(basename "$f")"
done
[ -n "$KERNEL" ] || die "no vmlinuz-* in $ROOTFS/boot"
KVER="${KERNEL#vmlinuz-}"
INITRD=""
for cand in "initramfs-${KVER}.img" "initrd.img-${KVER}" "initrd-${KVER}"; do
    if [ -f "$ROOTFS/boot/$cand" ]; then INITRD="$cand"; break; fi
done
[ -n "$INITRD" ] || die "no initramfs for kernel $KVER in $ROOTFS/boot (run dracut --force --kver $KVER in the chroot)"
# The initramfs must contain our dracut module; otherwise the box can never
# open its pool and the failure would only show at first boot.
if command -v lsinitrd >/dev/null 2>&1; then
    INITRD_LISTING="$(lsinitrd "$ROOTFS/boot/$INITRD" 2>/dev/null)"
    grep -q 'usr/lib/safebox/safebox-unseal.sh' <<<"$INITRD_LISTING" \
        || die "$INITRD does not contain usr/lib/safebox/safebox-unseal.sh; dracut module 90safebox missing"
    # The emergency shell must be masked inside the initrd (fix 1): a failed
    # unseal must reboot, never hand the console a shell while the sealing
    # policy may still be open.
    for u in dracut-emergency.service emergency.service rescue.service; do
        grep -Eq "systemd/system/${u} -> /dev/null" <<<"$INITRD_LISTING" \
            || die "$INITRD does not mask ${u}; dracut module 90safebox is stale"
    done
fi
install -m 0644 "$ROOTFS/boot/$KERNEL" "$MNT_BOOT/$KERNEL"
install -m 0600 "$ROOTFS/boot/$INITRD" "$MNT_BOOT/$INITRD"
# Sealed blobs go here on first boot. 0700: only root reads the blobs, and
# the dracut script creates files inside at 0600.
install -d -m 0700 "$MNT_BOOT/safebox"
rm -rf "$MNT_BOOT/loader"

# ---------------------------------------------------------------------------
# GRUB
# ---------------------------------------------------------------------------
render_grub_cfg() {
    # Substitute the four placeholders. The hash is a GRUB token with no
    # slashes or ampersands, but escape anyway so a future format cannot
    # break the sed expression silently.
    local out="$1" esc_hash
    esc_hash="$(printf '%s' "$GRUB_HASH" | sed -e 's/[\/&]/\\&/g')"
    sed -e "s/@ROOTHASH@/${ROOTHASH}/g" \
        -e "s/@KERNEL@/${KERNEL}/g" \
        -e "s/@INITRD@/${INITRD}/g" \
        -e "s/@GRUB_PASSWORD_HASH@/${esc_hash}/g" \
        "$TEMPLATE" > "$out"
    grep -q '@' "$out" && die "unrendered placeholder remains in $out"
    chmod 0600 "$out"
}

log "installing GRUB ($FAMILY)"
case "$FAMILY" in
    fedora)
        # shim-x64 and grub2-efi-x64 ship the signed binaries in the rootfs's
        # own /boot/efi/EFI/<id>/; the signed GRUB is not re-installable with
        # grub2-install (it would produce an unsigned image). Copy as-is.
        SRC_EFI="$ROOTFS/boot/efi/EFI"
        [ -d "$SRC_EFI/$EFI_ID" ] || die "$SRC_EFI/$EFI_ID missing in rootfs; install shim-x64 and grub2-efi-x64"
        [ -d "$SRC_EFI/BOOT" ] || die "$SRC_EFI/BOOT missing in rootfs; install shim-x64"
        mkdir -p "$MNT_BOOT/efi/EFI"
        cp -a "$SRC_EFI/BOOT" "$MNT_BOOT/efi/EFI/"
        cp -a "$SRC_EFI/$EFI_ID" "$MNT_BOOT/efi/EFI/"
        # The signed Fedora-family grub reads $prefix/grub.cfg from the ESP
        # first. Make that a stub that jumps to the real file on /boot so
        # there is a single measured configuration.
        cat > "$MNT_BOOT/efi/EFI/$EFI_ID/grub.cfg" <<'EOF'
# Stub: hand off to the measured configuration on SAFEBOX-BOOT.
insmod part_gpt
insmod ext2
insmod tpm
search --no-floppy --label SAFEBOX-BOOT --set=root
set prefix=($root)/grub2
configfile ($root)/grub2/grub.cfg
EOF
        rm -f "$MNT_BOOT/efi/EFI/$EFI_ID/grubenv"
        mkdir -p "$MNT_BOOT/$GRUB_DIR"
        render_grub_cfg "$MNT_BOOT/$GRUB_DIR/grub.cfg"
        # Fonts/locales are not needed; keep /boot/grub2 to one file.
        ;;
    debian)
        # grub-install with --uefi-secure-boot copies the signed monolithic
        # image and shim from grub-efi-amd64-signed / shim-signed. Run inside
        # the chroot so the right version is used; --no-nvram because we are
        # building an image, not booting this host.
        do_mount --bind "$MNT_BOOT" "$ROOTFS/boot"
        do_mount --bind "$MNT_BOOT/efi" "$ROOTFS/boot/efi"
        do_mount --bind /dev "$ROOTFS/dev"
        do_mount -t proc proc "$ROOTFS/proc"
        do_mount -t sysfs sysfs "$ROOTFS/sys"
        chroot "$ROOTFS" grub-install \
            --target=x86_64-efi \
            --efi-directory=/boot/efi \
            --boot-directory=/boot \
            --bootloader-id="$EFI_ID" \
            --uefi-secure-boot \
            --no-nvram \
            >/dev/null || die "grub-install failed in chroot"
        do_umount "$ROOTFS/sys"
        do_umount "$ROOTFS/proc"
        do_umount "$ROOTFS/dev"
        do_umount "$ROOTFS/boot/efi"
        do_umount "$ROOTFS/boot"
        # The signed Debian grub embeds a config that searches for
        # /boot/grub/grub.cfg via the ESP's grub.cfg stub; write the same
        # stub so behaviour matches the Fedora family.
        cat > "$MNT_BOOT/efi/EFI/$EFI_ID/grub.cfg" <<'EOF'
# Stub: hand off to the measured configuration on SAFEBOX-BOOT.
insmod part_gpt
insmod ext2
insmod tpm
search --no-floppy --label SAFEBOX-BOOT --set=root
set prefix=($root)/grub
configfile ($root)/grub/grub.cfg
EOF
        mkdir -p "$MNT_BOOT/$GRUB_DIR"
        render_grub_cfg "$MNT_BOOT/$GRUB_DIR/grub.cfg"
        rm -f "$MNT_BOOT/$GRUB_DIR/grubenv"
        ;;
esac
# Removable-media fallback so firmware that ignores NVRAM (every cloud) finds
# the loader. EFI/BOOT/ holds exactly three files: BOOTX64.EFI (shim),
# grubx64.efi (the signed GRUB shim chains to in its own directory) and the
# stub grub.cfg. Nothing else, on purpose: shim's fallback (fbx64.efi) and
# MokManager (mmx64.efi) are deliberately NOT copied. With fbx64.efi
# present, shim runs it on a boot where no NVRAM entry exists, fbx64 walks
# the ESP's CSV files and creates entries, and whether it runs, what it
# loads and what gets measured into PCR 4 then depends on the firmware's
# NVRAM state, which is not the same on every boot of every cloud. With
# only grubx64.efi beside it, shim loads grubx64.efi directly every time
# and PCR 4 is the same on every boot. MokManager is irrelevant here as
# well: the image enrols no MOK and never will (docs/HARDENING-PLAN.md,
# "Why Ubuntu on every cloud"), and leaving it out removes the one
# interactive path shim could otherwise offer on the console.
rm -rf "$MNT_BOOT/efi/EFI/BOOT"
mkdir -p "$MNT_BOOT/efi/EFI/BOOT"
SHIM="$(find "$MNT_BOOT/efi/EFI/$EFI_ID" -maxdepth 1 -iname 'shim*x64*.efi' | LC_ALL=C sort | head -n1)"
[ -n "$SHIM" ] || die "no shim binary found under EFI/$EFI_ID; cannot create EFI/BOOT/BOOTX64.EFI"
cp "$SHIM" "$MNT_BOOT/efi/EFI/BOOT/BOOTX64.EFI"
GRUBEFI="$(find "$MNT_BOOT/efi/EFI/$EFI_ID" -maxdepth 1 -iname 'grubx64.efi' | LC_ALL=C sort | head -n1)"
[ -n "$GRUBEFI" ] || die "no grubx64.efi under EFI/$EFI_ID"
cp "$GRUBEFI" "$MNT_BOOT/efi/EFI/BOOT/grubx64.efi"
cp "$MNT_BOOT/efi/EFI/$EFI_ID/grub.cfg" "$MNT_BOOT/efi/EFI/BOOT/grub.cfg"
# The vendor directory is what grub-install / the packages laid down; strip
# the same two binaries there so neither path through the ESP can reach
# them, and so the ESP contents are the same set of files on every cloud.
rm -f "$MNT_BOOT/efi/EFI/$EFI_ID"/fb*.efi "$MNT_BOOT/efi/EFI/$EFI_ID"/mm*.efi \
      "$MNT_BOOT/efi/EFI/$EFI_ID"/BOOT*.CSV "$MNT_BOOT/efi/EFI/$EFI_ID"/BOOT*.csv
# Belt and braces: the only .efi files on the ESP are shim and grubx64.
for f in $(find "$MNT_BOOT/efi" -iname '*.efi'); do
    case "$(basename "$f" | tr '[:upper:]' '[:lower:]')" in
        bootx64.efi|grubx64.efi|shimx64.efi) ;;
        *) die "unexpected EFI binary on the ESP: $f" ;;
    esac
done

# ---------------------------------------------------------------------------
# Expected PCR 8 and 9 for this build
# ---------------------------------------------------------------------------
# PCR 9 is exact (sha256 of the kernel and initrd bytes, extended in that
# order). PCR 8 is a model of the executed GRUB commands; the script's
# header explains why it must be confirmed against the first hardware
# boot's pcr-values.txt before the Safenet blessing pins it.
EXPECTED_PCRS_FILE="$WORK/expected-pcrs.json"
"$SCRIPT_DIR/compute-expected-pcrs.sh" "$MNT_BOOT" \
    "$MNT_BOOT/$GRUB_DIR/grub.cfg" "$MNT_BOOT/$KERNEL" "$MNT_BOOT/$INITRD" \
    "$MNT_BOOT/efi/EFI/$EFI_ID/grub.cfg" > "$EXPECTED_PCRS_FILE" \
    || die "compute-expected-pcrs.sh failed"
log "expected PCR 9 (exact): $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pcr9"])' "$EXPECTED_PCRS_FILE")"
log "expected PCR 8 (model): $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pcr8"])' "$EXPECTED_PCRS_FILE")"

sync -f "$MNT_BOOT"
do_umount "$MNT_BOOT/efi"
do_umount "$MNT_BOOT"

# Normalize the BOOT partition's superblock timestamps.  The boot partition
# is not covered by dm-verity (only the root hash matters for verification),
# but normalising it makes the entire disk reproducible for anyone who
# hashes the whole image rather than just the root partition.
if command -v debugfs >/dev/null 2>&1; then
    e2fsck -f -p "$P2" >/dev/null 2>&1 || true
    tune2fs -c 0 -i 0 "$P2" >/dev/null 2>&1 || true
    debugfs -w -R "set_super_value s_mtime $SOURCE_DATE_EPOCH" "$P2" 2>/dev/null
    debugfs -w -R "set_super_value s_wtime $SOURCE_DATE_EPOCH" "$P2" 2>/dev/null
    debugfs -w -R "set_super_value s_lastcheck $SOURCE_DATE_EPOCH" "$P2" 2>/dev/null
    debugfs -w -R "set_super_value s_mnt_count 0" "$P2" 2>/dev/null
    log "normalized BOOT superblock timestamps"
fi

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
MANIFEST_DIR="$(readlink -f "$ROOTFS/..")/manifests"
mkdir -p "$MANIFEST_DIR"
uuid_of() { blkid -s PARTUUID -o value "$1"; }
fsuuid_of() { blkid -s UUID -o value "$1" 2>/dev/null || true; }
python3 - "$MANIFEST_DIR/verity.json" "$ROOTHASH" "$DISK" "$OS_ID" "$KERNEL" "$INITRD" \
    "$(uuid_of "$P1")" "$(uuid_of "$P2")" "$(uuid_of "$P3")" "$(uuid_of "$P4")" \
    "$(fsuuid_of "$P1")" "$(fsuuid_of "$P2")" "$(fsuuid_of "$P3")" \
    "$(blkid -s PTUUID -o value "$DISK" 2>/dev/null || true)" "$EXPECTED_PCRS_FILE" <<'EOF'
import json, sys, datetime, os
(out, roothash, disk, osid, kernel, initrd, p1, p2, p3, p4, f1, f2, f3, dguid, pcrs_file) = sys.argv[1:16]
with open(pcrs_file) as fh:
    expected_pcrs = json.load(fh)
doc = {
    # pcr9 is exact; pcr8 is a model (see compute-expected-pcrs.sh). The
    # Safenet blessing pins the values confirmed by the first hardware
    # boot, not these, but these are what that confirmation is checked
    # against.
    "expectedPcrs": expected_pcrs,
    "schema": "safebox-verity-manifest/3",
    "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "source_date_epoch": int(os.environ.get("SOURCE_DATE_EPOCH", "0")),
    "reproducible": True,
    "e2fsprogs_version": os.popen("mkfs.ext4 -V 2>&1 | head -1").read().strip(),
    "distro_id": osid,
    "kernel": kernel,
    "initrd": initrd,
    "roothash": roothash,
    "disk_guid": dguid,
    "verity": {"data": "PARTLABEL=SAFEBOX-ROOT", "hash": "PARTLABEL=SAFEBOX-HASH", "algorithm": "sha256"},
    "partitions": {
        "SAFEBOX-ESP":  {"index": 1, "partuuid": p1, "fsuuid": f1},
        "SAFEBOX-BOOT": {"index": 2, "partuuid": p2, "fsuuid": f2},
        "SAFEBOX-ROOT": {"index": 3, "partuuid": p3, "fsuuid": f3},
        "SAFEBOX-HASH": {"index": 4, "partuuid": p4},
    },
}
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
EOF
chmod 0644 "$MANIFEST_DIR/verity.json"
log "manifest written to $MANIFEST_DIR/verity.json"

echo "ROOTHASH=${ROOTHASH}"
