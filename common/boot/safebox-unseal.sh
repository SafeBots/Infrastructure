#!/bin/bash
# safebox-unseal.sh - initramfs step 2 of the first boot sequence.
#
# Runs as root inside the dracut initramfs, after udev has settled and the
# vTPM is present, before any zfs-import unit. Implements exactly step 2 of
# "First boot sequence" in docs/HARDENING-PLAN.md:
#
#   No blobs in /boot/safebox/  -> generate zfs-key and hmac-seed, find the
#                                  data disk, zpool create (encrypted), create
#                                  datasets, seal both keys, write blobs,
#                                  extend PCR 15.
#   Blobs present               -> unseal both, zfs load-key, extend PCR 15.
#
# Either way /run/safebox/zfs-key is shredded after load-key succeeds and
# /run/safebox/hmac-seed is left as root 0400 for systemd to hand to
# safebox-system through LoadCredential= (the service never reads the file
# itself, and uid 990 cannot open it).
#
# Failure policy: any error prints "safebox-unseal: FATAL: <reason>" to the
# kernel console and exits 1. The unit is Type=oneshot and required by the
# initrd root target, so dracut falls into its emergency path, which the
# kernel command line (rd.shell=0 rd.emergency=reboot) and the dracut module
# (masked emergency/rescue units) turn into a reboot. The box therefore does
# not boot. That is intended: a safebox that cannot prove its boot state must
# not come up with its keys.
#
# WHEN PCR 15 IS EXTENDED. The sealing policy stays satisfiable until PCR 15
# leaves its reset value, so between "tpm2_unseal succeeded" and
# "tpm2_pcrextend 15" anything that runs as root can unseal the blobs a
# second time. Earlier versions of this script extended PCR 15 only at the
# very end, after zpool import and zfs load-key, which left a window: detach
# the data disk, let zpool import fail, and the failing boot would have
# handed a console shell a TPM whose policy still matched. To close it, PCR
# 15 is extended at the earliest point at which the keys are out of the TPM
# and the blobs are durable:
#   subsequent boot: immediately after both unseals succeed, before the
#                    pool is even looked for;
#   first boot:      immediately after both sealed blobs are written and
#                    fsynced to /boot, before anything else;
#   any failure:     the EXIT trap extends PCR 15 itself if the blobs exist
#                    and the phase has not been closed yet, before it shreds
#                    the plaintext keys from /run.
# A failed boot can therefore never leave the TPM in a state where the blobs
# on /boot can be opened again without a reset.
#
# Datasets are created with mountpoint=legacy. ZFS never mounts them on its
# own; the booted system mounts them through the /etc/fstab entries baked
# into the image (common/image/fstab), which gives each one a real systemd
# mount unit. Nothing in this script mounts them after switch-root; on first
# boot it mounts three of them briefly at a scratch path to set ownership
# and mode on their root directories, then unmounts.
#
# The pool is imported here (-N, no mounts) and stays imported across
# switch-root: pools are kernel state, not initramfs state. This script
# must never export it; the booted system's zfs-import-scan.service finds
# it already imported and is a no-op.

set -euo pipefail
umask 077

# ---------------------------------------------------------------------------
# Constants from the contract
# ---------------------------------------------------------------------------
readonly POOL="safebox-pool"
readonly RUN_DIR="/run/safebox"
readonly RUN_ZFS_KEY="${RUN_DIR}/zfs-key"
readonly RUN_HMAC_SEED="${RUN_DIR}/hmac-seed"
readonly BOOT_MNT="/boot"
readonly BLOB_DIR="${BOOT_MNT}/safebox"
readonly BOOT_PARTLABEL="SAFEBOX-BOOT"
readonly ROOT_PARTLABEL="SAFEBOX-ROOT"
readonly INFRA_UID=990
readonly INFRA_GID=990
readonly TENANTS_GID=991
readonly DNS_UID=992
readonly DNS_GID=992
readonly MIN_DATADISK_BYTES=$((50 * 1024 * 1024 * 1024))
readonly LIB="/usr/lib/safebox/safebox-seal.sh"
# First-boot identity: written to /boot/safebox/first-boot-id and to the
# pool as ZFS user property safebox:firstboot on the root dataset. A later
# boot refuses to continue if the two differ, which is what a /boot
# partition transplanted from another instance (with that instance's blobs,
# or with the blobs deleted to force a re-seal) looks like.
readonly FIRSTBOOT_ID_FILE="${BLOB_DIR}/first-boot-id"
readonly FIRSTBOOT_PROP="safebox:firstboot"

# ---------------------------------------------------------------------------
# Logging and failure
# ---------------------------------------------------------------------------
log() {
    local msg="safebox-unseal: $*"
    if [ -w /dev/kmsg ]; then
        echo "$msg" > /dev/kmsg
    fi
    echo "$msg" >&2
}

die() {
    local msg="safebox-unseal: FATAL: $*"
    if [ -w /dev/kmsg ]; then
        echo "$msg" > /dev/kmsg
    fi
    echo "$msg" >&2
    exit 1
}

BOOT_MOUNTED=0
TMP_MOUNTED=""
# PHASE_CLOSED flips to 1 once PCR 15 has been extended this boot.
# BLOBS_PRESENT flips to 1 as soon as sealed blobs are known to exist on
# /boot: found there on a subsequent boot, or written there on the first.
# Together they tell the EXIT trap whether the policy is still open.
PHASE_CLOSED=0
BLOBS_PRESENT=0

close_sealed_phase() {
    # Extend PCR 15. From here on the sealing policy no longer matches for
    # the rest of this boot and the blobs in /boot/safebox are inert.
    # Idempotent: a second call is a no-op so the EXIT trap can call it
    # without checking.
    [ "$PHASE_CLOSED" -eq 1 ] && return 0
    sb_extend_phase_complete || return 1
    PHASE_CLOSED=1
    return 0
}

cleanup() {
    # On any exit, make sure no plaintext key survives in /run unless we
    # reached the point where hmac-seed is supposed to persist, and unmount
    # whatever we mounted. Blob writes are already fsynced by the time this
    # runs on the success path.
    local rc=$?
    # Nothing below may change the exit status or abort the trap halfway:
    # the original failure must stay the failure, and every step after a
    # failing one must still run (shred, unmount).
    set +e
    trap - ERR
    if [ "$rc" -ne 0 ] && [ "$BLOBS_PRESENT" -eq 1 ] && [ "$PHASE_CLOSED" -eq 0 ]; then
        # Failure with sealed blobs on /boot and PCR 15 still at reset: the
        # keys may already be out of the TPM and the policy still matches.
        # Close the phase first, before anything else in this trap, so that
        # whatever dracut does next (reboot, by the kernel command line)
        # cannot find a TPM that would unseal the blobs again. The key
        # material in /run is shredded right after; order matters only in
        # that the extend must not wait on anything that could hang.
        if command -v sb_extend_phase_complete >/dev/null 2>&1; then
            if sb_extend_phase_complete; then
                PHASE_CLOSED=1
                log "failure after unseal: PCR 15 extended from the exit path"
            else
                log "failure after unseal: could NOT extend PCR 15; policy stays open until reset"
            fi
        fi
    fi
    # The seal library's own cleanup (flush TPM sessions, wipe /run/safebox/tpm)
    # runs from here; it does not install its own EXIT trap when one exists.
    if command -v sb_cleanup >/dev/null 2>&1; then
        sb_cleanup
    fi
    if [ "$rc" -ne 0 ]; then
        # Failure path: nothing downstream may use a half-initialised state.
        [ -e "$RUN_ZFS_KEY" ] && shred -u "$RUN_ZFS_KEY" 2>/dev/null
        [ -e "$RUN_HMAC_SEED" ] && shred -u "$RUN_HMAC_SEED" 2>/dev/null
    fi
    if [ -n "$TMP_MOUNTED" ]; then
        umount "$TMP_MOUNTED" 2>/dev/null
    fi
    if [ "$BOOT_MOUNTED" -eq 1 ]; then
        sync -f "$BOOT_MNT" 2>/dev/null
        umount "$BOOT_MNT" 2>/dev/null
    fi
    exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
require_cmd() {
    local c
    for c in "$@"; do
        command -v "$c" >/dev/null 2>&1 || die "required tool '$c' missing from initramfs (dracut module 90safebox incomplete)"
    done
}

cmdline_value() {
    # Print the value of key=value from /proc/cmdline, or nothing.
    local key="$1" word cmdline
    read -r cmdline < /proc/cmdline
    for word in $cmdline; do
        case "$word" in
            "${key}="*) printf '%s\n' "${word#"${key}"=}"; return 0 ;;
        esac
    done
    return 0
}

wait_for_path() {
    # udev may still be creating by-partlabel links when we start; give it a
    # bounded amount of time rather than racing it.
    local path="$1" tries=0
    while [ ! -e "$path" ]; do
        tries=$((tries + 1))
        [ "$tries" -le 60 ] || return 1
        sleep 0.5
    done
    return 0
}

root_parent_disk() {
    # The whole-disk device that holds SAFEBOX-ROOT. Used to make sure the
    # data-disk search can never pick the image disk even if it somehow
    # looked blank.
    local part pk
    part="/dev/disk/by-partlabel/${ROOT_PARTLABEL}"
    wait_for_path "$part" || die "partition with PARTLABEL=${ROOT_PARTLABEL} not found"
    pk="$(lsblk -no PKNAME "$(readlink -f "$part")" 2>/dev/null | head -n1)"
    [ -n "$pk" ] || die "could not determine parent disk of ${ROOT_PARTLABEL}"
    printf '%s\n' "$pk"
}

find_data_disk_auto() {
    # Contract: the only disk with no partition table and no filesystem
    # signature that is at least 50 GiB, excluding the disk that holds the
    # image. Zero or several matches -> fail closed with a listing so the
    # operator can see what the VM actually attached.
    local root_disk sysdev name dev size_sectors size_bytes
    local -a candidates=()
    local -a seen=()
    root_disk="$(root_parent_disk)"
    for sysdev in /sys/block/*; do
        name="$(basename "$sysdev")"
        case "$name" in
            loop*|ram*|dm-*|zram*|sr*|fd*|md*|nbd*) continue ;;
        esac
        [ "$name" = "$root_disk" ] && { seen+=("$name: image disk (skipped)"); continue; }
        dev="/dev/${name}"
        [ -b "$dev" ] || continue
        size_sectors="$(cat "${sysdev}/size" 2>/dev/null || echo 0)"
        size_bytes=$((size_sectors * 512))
        if [ "$size_bytes" -lt "$MIN_DATADISK_BYTES" ]; then
            seen+=("$name: $((size_bytes / 1073741824)) GiB (too small)")
            continue
        fi
        # blkid -p probes the device directly, bypassing the cache, and prints
        # nothing / exits non-zero when there is no recognisable signature.
        if blkid -p -o value -s TYPE -s PTTYPE "$dev" 2>/dev/null | grep -q .; then
            seen+=("$name: has filesystem or partition table (skipped)")
            continue
        fi
        seen+=("$name: $((size_bytes / 1073741824)) GiB blank (candidate)")
        candidates+=("$dev")
    done
    if [ "${#candidates[@]}" -ne 1 ]; then
        log "data disk scan results:"
        local s
        for s in "${seen[@]}"; do log "  $s"; done
        die "safebox.datadisk=auto requires exactly one blank disk >= 50 GiB; found ${#candidates[@]}"
    fi
    printf '%s\n' "${candidates[0]}"
}

mount_boot() {
    local mode="$1" dev
    dev="/dev/disk/by-partlabel/${BOOT_PARTLABEL}"
    wait_for_path "$dev" || die "partition with PARTLABEL=${BOOT_PARTLABEL} not found"
    mkdir -p "$BOOT_MNT"
    mount -t ext4 -o "${mode},nosuid,nodev,noexec" "$dev" "$BOOT_MNT" \
        || die "could not mount ${BOOT_PARTLABEL} ${mode}"
    BOOT_MOUNTED=1
}

gen_key() {
    # 32 bytes from the kernel CSPRNG. getrandom semantics via /dev/urandom
    # are fine here: by the time udev has settled the pool is initialised on
    # every cloud vTPM platform we target.
    local out="$1"
    head -c 32 /dev/urandom > "$out" || die "could not read /dev/urandom"
    [ "$(stat -c %s "$out")" -eq 32 ] || die "short read generating $out"
    chmod 0400 "$out"
}

create_pool_and_datasets() {
    local disk="$1"
    log "creating encrypted pool ${POOL} on ${disk}"
    zpool create -f \
        -o ashift=12 \
        -O compression=lz4 \
        -O atime=off \
        -O xattr=sa \
        -O acltype=posixacl \
        -O encryption=aes-256-gcm \
        -O keyformat=raw \
        -O keylocation="file://${RUN_ZFS_KEY}" \
        -O mountpoint=none \
        "$POOL" "$disk" \
        || die "zpool create failed on ${disk}"

    # Datasets exactly as "Runtime paths" lists them. mountpoint=legacy: ZFS
    # never mounts them itself, so the initramfs cannot end up with them over
    # its own tree, and the booted system mounts each one from /etc/fstab
    # (common/image/fstab) as a real systemd mount unit. The target paths
    # live in the fstab, not on the dataset.
    local ds
    for ds in var safebox docker mariadb tenants clones models; do
        zfs create -o mountpoint=legacy "${POOL}/${ds}" \
            || die "zfs create ${POOL}/${ds} failed"
    done

    # Ownership and mode of the dataset root directories are stored in the
    # dataset, so they have to be set once while the dataset is mounted. The
    # booted system mounts them later over paths in the read-only root; doing
    # it here on the fresh, empty datasets at a scratch path avoids a race
    # with services that start as soon as the mount units are up.
    #   safebox -> 0771 root:safebox-infra. Group write is required: the
    #              system component (uid 990) replaces
    #              managed-containers.json by rename directly in this
    #              directory. The "other" execute bit is the only other bit:
    #              safebox-dns (uid 992) has to traverse this directory to
    #              reach its own dns/ subdirectory, but no other uid can
    #              list it, and every file and subdirectory inside carries
    #              its own owner and a mode without "other" bits, so nginx's
    #              workers and every other uid stay out of the contents.
    #              Per-service subdirectories, each owned by the uid that
    #              writes there:
    #                containers/ nginx/vhosts/  0750 safebox-infra (re-owned
    #                              by the units' ExecStartPre as well)
    #                dns/          0750 safebox-dns: dnsclient.json (written
    #                              by safebox-firstboot from the metadata
    #                              keys), identity.key, last-announce.json,
    #                              announced, dnsclient/
    #                boot/         0750 root:safebox-infra: the first-boot
    #                              PCR snapshot, readable by the system
    #                              component for the attested health
    #                              endpoint, written only from here.
    #                tenants/      0751 root: one state directory per
    #                              tenant instance inside, each 0750
    #                              <instance uid>:safebox-sys, created by
    #                              safebox-users at boot and by
    #                              safebox-instance on create. Root-owned
    #                              and unlistable so no instance can see
    #                              or reach another's.
    #                tenant-config/ 0751 safebox-infra: the one-entry copy
    #                              of each tenant's declaration (0644) that
    #                              its instance reads, written by the
    #                              operator instance.
    #                governance/   0751 safebox-infra: the governance key
    #                              registry (0644, public keys), read by
    #                              every tenant instance for /system claims.
    #   tenants -> 0750 safebox-infra:safebox-app
    #   clones  -> 0750 root:safebox-infra
    #   models  -> 0775 root:safebox-infra. The operator instance (uid 990,
    #              opsModels.js) downloads and materialises model weights
    #              under /srv/safebox/models and its .staging/ directory, so
    #              it needs group write; every tenant instance (its own uid)
    #              loads models from there for /embed, so the tree is
    #              world-readable (weights are public). The verity root is
    #              read-only, so this cannot live there.
    init_dataset_root safebox 0771 "0:${INFRA_GID}" \
        "containers:0750:${INFRA_UID}:${INFRA_GID}" \
        "nginx:0750:${INFRA_UID}:${INFRA_GID}" \
        "nginx/vhosts:0750:${INFRA_UID}:${INFRA_GID}" \
        "dns:0750:${DNS_UID}:${DNS_GID}" \
        "boot:0750:0:${INFRA_GID}" \
        "tenants:0751:0:0" \
        "tenant-config:0751:${INFRA_UID}:${INFRA_GID}" \
        "governance:0751:${INFRA_UID}:${INFRA_GID}"
    init_dataset_root tenants 0750 "${INFRA_UID}:${TENANTS_GID}"
    init_dataset_root clones  0750 "0:${INFRA_GID}"
    init_dataset_root models  0775 "0:${INFRA_GID}"
}

readonly SCRATCH="${RUN_DIR}/mnt"

mount_dataset_scratch() {
    # Mount ${POOL}/$1 at $SCRATCH. Legacy datasets mount with plain
    # mount(8); no zfsutil needed. Not a command substitution on purpose:
    # TMP_MOUNTED must be set in this shell so the EXIT trap sees it. The
    # caller must call umount_dataset_scratch when done.
    local ds="$1"
    mkdir -p "$SCRATCH"
    mount -t zfs "${POOL}/${ds}" "$SCRATCH" || die "could not mount ${POOL}/${ds} at scratch path"
    TMP_MOUNTED="$SCRATCH"
}

umount_dataset_scratch() {
    umount "$SCRATCH" || die "could not unmount scratch mount ${SCRATCH}"
    TMP_MOUNTED=""
    rmdir "$SCRATCH"
}

init_dataset_root() {
    # Mount ${POOL}/$1 at a scratch path, apply mode $2 and owner $3 to its
    # root directory, create the subdirectories given in $4.. as
    # "path:mode:uid:gid" (parents must be listed before children, or they
    # inherit the root's mode and owner), then unmount.
    local ds="$1" mode="$2" owner="$3"
    shift 3
    local spec sub smode suid sgid
    mount_dataset_scratch "$ds"
    chown "$owner" "$SCRATCH" || die "chown on ${POOL}/${ds} failed"
    chmod "$mode" "$SCRATCH" || die "chmod on ${POOL}/${ds} failed"
    for spec in "$@"; do
        IFS=: read -r sub smode suid sgid <<EOF
$spec
EOF
        [ -n "$sub" ] && [ -n "$smode" ] && [ -n "$suid" ] && [ -n "$sgid" ] \
            || die "bad subdirectory spec '${spec}' for ${POOL}/${ds}"
        mkdir -p "${SCRATCH}/${sub}" || die "mkdir ${sub} in ${POOL}/${ds} failed"
        chown "${suid}:${sgid}" "${SCRATCH}/${sub}" || die "chown ${sub} in ${POOL}/${ds} failed"
        chmod "$smode" "${SCRATCH}/${sub}" || die "chmod ${sub} in ${POOL}/${ds} failed"
    done
    umount_dataset_scratch
}

stash_on_safebox_dataset() {
    # Copy file $1 to <safebox dataset>/$2 with mode $3 and owner $4, by
    # mounting the dataset briefly at the scratch path. Used on first boot
    # to leave the PCR snapshot where the booted system can read it back.
    local src="$1" rel="$2" mode="$3" owner="$4"
    mount_dataset_scratch safebox
    mkdir -p "$(dirname "${SCRATCH}/${rel}")" || die "mkdir for ${rel} on ${POOL}/safebox failed"
    install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "${SCRATCH}/${rel}" \
        || die "could not write ${rel} to ${POOL}/safebox"
    umount_dataset_scratch
}

write_blob() {
    # Write-then-rename so a crash mid-write leaves either the old blob or
    # none, never a truncated one. Mode 0600 root; /boot is mounted nosuid
    # and the directory itself is 0700 from the image build.
    local src="$1" dst="$2"
    install -m 0600 -o 0 -g 0 "$src" "${dst}.tmp" || die "could not write ${dst}"
    mv -f "${dst}.tmp" "$dst" || die "could not rename ${dst}"
}

refuse_if_pool_exists_anywhere() {
    # First boot is legitimate only when no safebox-pool exists on any disk
    # the VM can see. If one does, the most likely explanation is that
    # someone deleted /boot/safebox/* offline to force this script to
    # generate fresh keys and seal them under PCR values of their choosing,
    # while the real pool (with the real state) sits on the data disk. A
    # pool that is merely unimportable because its key is gone is still a
    # pool, and the operator has to destroy it deliberately before this
    # instance may be treated as new. "zpool import -d /dev" with no pool
    # name only scans and prints; it imports nothing.
    local listing
    listing="$(zpool import -d /dev 2>/dev/null || true)"
    if printf '%s\n' "$listing" | grep -Eq "^[[:space:]]*pool:[[:space:]]+${POOL}[[:space:]]*$"; then
        log "zpool import scan found an existing ${POOL}:"
        printf '%s\n' "$listing" | while IFS= read -r line; do log "  $line"; done
        die "a ${POOL} already exists on an attached disk but /boot/safebox has no blobs; refusing to re-seal (destroy the pool first if this instance is really new)"
    fi
}

first_boot() {
    local disk policy pcrs firstboot_id
    log "no sealed blobs present: this is the first boot of this instance"

    refuse_if_pool_exists_anywhere

    # Keys first, before touching any disk, so a later failure leaves nothing
    # but tmpfs state behind.
    gen_key "$RUN_ZFS_KEY"
    gen_key "$RUN_HMAC_SEED"
    firstboot_id="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    [ "${#firstboot_id}" -eq 32 ] || die "could not generate first-boot-id"

    disk="$(find_data_disk_auto)"
    log "selected data disk ${disk}"
    create_pool_and_datasets "$disk"
    # Bind the pool to this /boot: see FIRSTBOOT_ID_FILE above.
    zfs set "${FIRSTBOOT_PROP}=${firstboot_id}" "$POOL" \
        || die "could not record ${FIRSTBOOT_PROP} on ${POOL}"

    # Seal both keys under the current PCR state. The policy digest and the
    # PCR snapshot are stored with the blobs so a mismatch on a later boot
    # can be diagnosed without the key material.
    policy="${RUN_DIR}/policy.digest"
    pcrs="${RUN_DIR}/pcr-values.txt"
    sb_tpm_primary || die "could not create TPM primary"
    sb_policy_create "$policy" || die "could not compute PCR policy"
    sb_pcr_snapshot "$pcrs" || die "could not snapshot PCRs"
    sb_seal "$RUN_ZFS_KEY" "${RUN_DIR}/zfs-key.pub" "${RUN_DIR}/zfs-key.priv" "$policy" \
        || die "sealing zfs-key failed"
    sb_seal "$RUN_HMAC_SEED" "${RUN_DIR}/hmac-seed.pub" "${RUN_DIR}/hmac-seed.priv" "$policy" \
        || die "sealing hmac-seed failed"

    mount_boot rw
    mkdir -p "$BLOB_DIR" && chmod 0700 "$BLOB_DIR"
    # Conservative: from the first write on, treat the blobs as present so
    # a failure halfway through still closes the phase from the EXIT trap.
    # Extending PCR 15 on a boot that has nothing sealed costs nothing.
    BLOBS_PRESENT=1
    write_blob "${RUN_DIR}/zfs-key.pub"    "${BLOB_DIR}/zfs-key.pub"
    write_blob "${RUN_DIR}/zfs-key.priv"   "${BLOB_DIR}/zfs-key.priv"
    write_blob "${RUN_DIR}/hmac-seed.pub"  "${BLOB_DIR}/hmac-seed.pub"
    write_blob "${RUN_DIR}/hmac-seed.priv" "${BLOB_DIR}/hmac-seed.priv"
    write_blob "$policy"                   "${BLOB_DIR}/policy.digest"
    write_blob "$pcrs"                     "${BLOB_DIR}/pcr-values.txt"
    printf '%s\n' "$firstboot_id" > "${RUN_DIR}/first-boot-id"
    write_blob "${RUN_DIR}/first-boot-id"  "$FIRSTBOOT_ID_FILE"
    sync -f "$BOOT_MNT" || die "fsync of /boot failed"
    sync
    # The blobs are durable and the keys are in /run: close the sealed
    # phase now, before anything else that could fail. See the header.
    close_sealed_phase || die "could not extend PCR 15 after sealing; refusing to continue with an open sealing policy"

    mount -o remount,ro "$BOOT_MNT" || die "could not remount /boot read-only"
    # Keep the first-boot PCR snapshot on the pool as well, where the
    # booted system can read it back through the attested health endpoint
    # (the /boot copy is root-only and /boot is not mounted after switch-root).
    stash_on_safebox_dataset "$pcrs" boot/pcr-values-first-boot.txt 0640 "0:${INFRA_GID}"
    rm -f "${RUN_DIR}"/zfs-key.pub "${RUN_DIR}"/zfs-key.priv \
          "${RUN_DIR}"/hmac-seed.pub "${RUN_DIR}"/hmac-seed.priv "$policy" "$pcrs" \
          "${RUN_DIR}/first-boot-id"
    log "sealed blobs written to ${BLOB_DIR}"
    # The pool was created with the key loaded; nothing further to load.
}

subsequent_boot() {
    log "sealed blobs present: unsealing"
    mount_boot ro
    local f
    for f in zfs-key.pub zfs-key.priv hmac-seed.pub hmac-seed.priv first-boot-id; do
        [ -s "${BLOB_DIR}/${f}" ] || die "${BLOB_DIR}/${f} is missing or empty; blob set is incomplete"
    done
    BLOBS_PRESENT=1
    local expected_id
    read -r expected_id < "$FIRSTBOOT_ID_FILE" || die "could not read ${FIRSTBOOT_ID_FILE}"
    [[ "$expected_id" =~ ^[0-9a-f]{32}$ ]] || die "${FIRSTBOOT_ID_FILE} is malformed"

    sb_tpm_primary || die "could not create TPM primary"
    sb_unseal "${BLOB_DIR}/zfs-key.pub" "${BLOB_DIR}/zfs-key.priv" "$RUN_ZFS_KEY" \
        || die "unseal of zfs-key refused"
    sb_unseal "${BLOB_DIR}/hmac-seed.pub" "${BLOB_DIR}/hmac-seed.priv" "$RUN_HMAC_SEED" \
        || die "unseal of hmac-seed refused"
    [ "$(stat -c %s "$RUN_ZFS_KEY")" -eq 32 ] || die "unsealed zfs-key has wrong length"
    [ "$(stat -c %s "$RUN_HMAC_SEED")" -eq 32 ] || die "unsealed hmac-seed has wrong length"
    # Both keys are out of the TPM: close the sealed phase before the pool
    # is even looked for, so a missing or foreign data disk below cannot
    # fail the boot with the policy still open. See the header.
    close_sealed_phase || die "could not extend PCR 15 after unsealing; refusing to continue with an open sealing policy"

    # Import without mounting (-N); the datasets are mountpoint=legacy and
    # mounting belongs to the booted system's fstab. There is no cachefile
    # in the read-only image, so this is a device scan (-d /dev). The pool
    # stays imported across switch-root; do not export it here.
    log "importing ${POOL}"
    zpool import -N -d /dev "$POOL" \
        || die "zpool import ${POOL} failed (data disk missing or not a safebox pool)"
    zfs load-key "$POOL" || die "zfs load-key ${POOL} failed: unsealed key does not open the pool"

    # The pool must be the one this /boot was sealed alongside. A /boot
    # swapped in from another instance carries that instance's
    # first-boot-id (and its blobs, which this TPM would not open anyway);
    # a /boot whose blobs were deleted never reaches this path because the
    # first-boot branch refuses when a pool already exists.
    local actual_id
    actual_id="$(zfs get -H -o value "$FIRSTBOOT_PROP" "$POOL" 2>/dev/null || true)"
    [ "$actual_id" = "$expected_id" ] \
        || die "first-boot-id mismatch: /boot says ${expected_id}, pool property ${FIRSTBOOT_PROP} says '${actual_id}'; /boot and the pool are from different instances"
}

main() {
    require_cmd tpm2_createprimary tpm2_create tpm2_load tpm2_unseal \
        tpm2_startauthsession tpm2_policypcr tpm2_flushcontext tpm2_pcrread \
        tpm2_pcrextend blkid lsblk shred sha256sum zpool zfs mount umount \
        chown chmod mkdir sync install stat head od tr grep dirname
    [ -r "$LIB" ] || die "library ${LIB} not found in initramfs"
    # shellcheck source=common/boot/safebox-seal.sh
    # shellcheck disable=SC1091
    . "$LIB"

    mkdir -p "$RUN_DIR" && chmod 0700 "$RUN_DIR"

    # Only "auto" is implemented. Anything else, including an explicit device
    # path, fails closed: the command line is measured into PCR 8, so a
    # different value would not unseal anyway, and we do not want a code
    # path that trusts a device name from the console.
    local mode
    mode="$(cmdline_value safebox.datadisk)"
    [ -n "$mode" ] || die "safebox.datadisk= is missing from the kernel command line"
    [ "$mode" = "auto" ] || die "safebox.datadisk=${mode} is not supported; only 'auto' is implemented"

    [ -c /dev/tpmrm0 ] || die "/dev/tpmrm0 is absent; the VM was launched without a vTPM"

    # Decide the path by probing /boot for the private blob. A read-only
    # mount is enough to decide; first_boot remounts rw itself.
    mount_boot ro
    local have_blobs=0
    [ -s "${BLOB_DIR}/zfs-key.priv" ] && have_blobs=1
    umount "$BOOT_MNT" || die "could not unmount /boot after probe"
    BOOT_MOUNTED=0

    if [ "$have_blobs" -eq 0 ]; then
        first_boot
    else
        subsequent_boot
    fi

    # Common tail (contract "Runtime paths"): the pool key leaves tmpfs the
    # moment the pool has it; the HMAC seed stays root 0400. systemd reads
    # it as root when safebox-system.service starts and passes it in through
    # LoadCredential=; the service's own uid (990) never opens the file.
    shred -u "$RUN_ZFS_KEY" || die "could not shred ${RUN_ZFS_KEY}"
    chown 0:0 "$RUN_HMAC_SEED" || die "chown hmac-seed failed"
    chmod 0400 "$RUN_HMAC_SEED" || die "chmod hmac-seed failed"

    # PCR 15 was extended inside first_boot/subsequent_boot, as early as the
    # keys were out of the TPM. This is only a guard against a future edit
    # that forgets to.
    [ "$PHASE_CLOSED" -eq 1 ] || die "internal error: sealed phase not closed"

    log "sealed phase complete; ${POOL} key loaded, hmac-seed ready for LoadCredential"
}

main "$@"
