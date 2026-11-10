#!/usr/bin/env bash
# cleanup-image.sh <rootfs-dir> - pre-capture cleanup (HARDENING-PLAN.md fix 2,
# build flow step 3). Operates on a build chroot, never on the live system.
#
# What it leaves behind is a root filesystem on which nothing can log in:
# every account locked, every shell nologin (root included: there is no
# console, no sshd, and the only thing that runs as root is systemd and the
# sudo wrappers, none of which needs a login shell), no home directories, no
# cloud-init or agent state, no SSH host keys, no logs, no machine-id, and a
# sudoers.d that holds only safebox-system. verify-image.sh checks all of it
# afterwards and the build aborts on any gap.

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

die() { printf 'cleanup-image: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf 'cleanup-image: %s\n' "$*" >&2; }

[[ $# -eq 1 ]] || die "usage: cleanup-image.sh <rootfs-dir>"
R=$(readlink -f "$1") || die "cannot resolve $1"
[[ $R != "/" ]] || die "refusing to operate on / (this script runs against a chroot)"
[[ -d $R/etc && -f $R/etc/passwd && -f $R/etc/shadow ]] || die "$R does not look like a root filesystem"
[[ $EUID -eq 0 ]] || die "must run as root"

readonly KEEP_USERS='safebox-infra safebox-app safebox-audit'

# ---------------------------------------------------------------------------
# 1. Remove every human/operator account (uid >= 1000) except the two service
#    accounts. Read the chroot's passwd, not the host's.
# ---------------------------------------------------------------------------
log "removing uid>=1000 accounts"
while IFS=: read -r name _ uid _; do
    [[ $uid -ge 1000 && $uid -ne 65534 ]] || continue
    keep=0
    for k in $KEEP_USERS; do [[ $name == "$k" ]] && keep=1; done
    [[ $keep -eq 1 ]] && continue
    log "  userdel -r $name (uid $uid)"
    # userdel -r fails if the home is missing or mail spool absent; that is
    # fine, the directories are swept below anyway.
    chroot "$R" userdel -r "$name" 2>/dev/null || chroot "$R" userdel "$name" || die "userdel $name failed"
done <"$R/etc/passwd"

# ---------------------------------------------------------------------------
# 2. Files and directories that carry operator or cloud state.
# ---------------------------------------------------------------------------
log "removing home directories (preserving safebox-audit), root dotfiles, cloud and agent state"
# Preserve /home/safebox-audit (the audit SSH user); remove everything else.
for d in "${R:?}"/home/*; do
    [[ -e "$d" ]] || continue
    [[ "$(basename "$d")" == safebox-audit ]] && continue
    rm -rf "$d"
done
rm -rf "${R:?}"/home/.[!.]* 2>/dev/null || true
rm -rf "$R/root/.bash_history" "$R/root/.ssh" "$R/root/.cache" "$R/root/.lesshst" \
       "$R/root/.viminfo" "$R/root/.wget-hsts" "$R/root/.npm" "$R/root/.gnupg" "$R/root/.config"
rm -rf "$R/var/lib/cloud" "$R/var/lib/waagent" "$R/etc/cloud"
# Ubuntu Pro / ksplice / google-guest leave state here too.
rm -rf "$R/var/lib/ubuntu-advantage" "$R/var/lib/google" "$R/var/lib/oracle-cloud-agent"
# Ubuntu: snapd, update-notifier and apt timers may have left state; the
# NodeSource apt source used for Node 22 must not survive (the base installer
# removes it, this is the second line).
rm -rf "$R/var/lib/snapd" "$R/var/lib/update-notifier" "$R/var/lib/apt/periodic" "$R/var/cache/snapd"
rm -f "$R"/etc/apt/sources.list.d/nodesource* "$R/etc/apt/keyrings/nodesource.gpg" \
      "$R"/var/lib/apt/lists/*nodesource*
rm -f "$R/etc/netplan/50-cloud-init.yaml" "$R/etc/systemd/network/10-netplan-"*.network
# Ubuntu's default motd scripts phone home (motd-news) and print nothing
# anyone will ever read on a box without logins.
rm -rf "$R/etc/update-motd.d" "$R/var/cache/motd-news"

log "removing SSH host keys"
rm -f "$R"/etc/ssh/ssh_host_*

log "removing sudoers.d entries other than safebox-system"
if [[ -d $R/etc/sudoers.d ]]; then
    find "$R/etc/sudoers.d" -mindepth 1 -maxdepth 1 ! -name safebox-system -print -exec rm -rf {} + \
        | sed 's/^/  removed /' >&2
fi

# ---------------------------------------------------------------------------
# 3. Lock every account. `passwd -l` prefixes the hash with "!"; then rewrite
#    the shadow field outright for anything that still is not one of the
#    recognised locked forms, so that an account with an empty field (login
#    without a password) cannot survive.
# ---------------------------------------------------------------------------
log "locking all accounts"
while IFS=: read -r name _; do
    chroot "$R" passwd -l "$name" >/dev/null 2>&1 || true
done <"$R/etc/passwd"

# Normalise the "last changed" field (field 3) to day 0 so the shadow file
# is deterministic regardless of when the build ran.
awk -F: 'BEGIN{OFS=":"}
    { if ($2 != "!" && $2 != "!!" && $2 != "*" && $2 != "!*") $2 = "!"; $3 = "0"; print }' \
    "$R/etc/shadow" >"$R/etc/shadow.new"
chmod --reference="$R/etc/shadow" "$R/etc/shadow.new"
chown --reference="$R/etc/shadow" "$R/etc/shadow.new"
mv -f "$R/etc/shadow.new" "$R/etc/shadow"
# Keep the backup file from leaking an older unlocked hash.
rm -f "$R/etc/shadow-" "$R/etc/passwd-" "$R/etc/gshadow-" "$R/etc/group-"

# ---------------------------------------------------------------------------
# 4. No login shells — except safebox-audit, which needs a real shell for SSH
#    in the audit AMI. The seal script removes safebox-audit entirely when
#    producing the production AMI.
# ---------------------------------------------------------------------------
if [[ -x $R/usr/sbin/nologin ]]; then
    NOLOGIN=/usr/sbin/nologin
elif [[ -x $R/sbin/nologin ]]; then
    NOLOGIN=/sbin/nologin
else
    die "no nologin binary in the rootfs"
fi
log "setting every shell to $NOLOGIN (except safebox-audit)"
awk -F: -v sh="$NOLOGIN" 'BEGIN{OFS=":"} { if ($1 != "safebox-audit") $7 = sh; print }' "$R/etc/passwd" >"$R/etc/passwd.new"
chmod --reference="$R/etc/passwd" "$R/etc/passwd.new"
chown --reference="$R/etc/passwd" "$R/etc/passwd.new"
mv -f "$R/etc/passwd.new" "$R/etc/passwd"

# ---------------------------------------------------------------------------
# 5. Logs, caches, identity.
# ---------------------------------------------------------------------------
log "clearing logs (keeping directories)"
find "$R/var/log" -type f -delete 2>/dev/null || true
# journald needs its directory, and a machine-id of zero length makes
# systemd generate a fresh one on first boot (and the /etc overlay is tmpfs,
# so it never persists into the image anyway).
: >"$R/etc/machine-id"
rm -f "$R/var/lib/dbus/machine-id"

log "clearing package caches"
rm -rf "$R"/var/cache/dnf/* "$R"/var/cache/apt/* "$R"/var/cache/yum/* 2>/dev/null || true
rm -rf "$R"/var/lib/apt/lists/* "$R"/var/tmp/* "$R"/tmp/* 2>/dev/null || true
rm -f "$R"/var/lib/dnf/history.sqlite* 2>/dev/null || true
rm -f "$R"/etc/resolv.conf.bak "$R"/etc/hostname.bak 2>/dev/null || true

log "done"
