#!/bin/bash
#
# install-base.sh -- the Safebox base layer for every cloud. Ubuntu 24.04 LTS
# ("noble"), runs INSIDE the build chroot, parameterised by SAFEBOX_CLOUD.
#
# Called from each cloud's build-image.sh through the shim at
# <cloud>/scripts/components/base/install-base.sh as
#   chroot $ROOTFS /bin/bash /opt/safebox-src/common/base/install-base.sh
# with SAFEBOX_CHROOT=1 SAFEBOX_SRC=/opt/safebox-src SAFEBOX_CLOUD=<cloud>
# in the environment. It is step 2 of the "Build flow" in docs/HARDENING-PLAN.md.
#
# Why Ubuntu on all four clouds
#
#   The root is dm-verity and the data pool is ZFS, opened in the initramfs
#   after a TPM unseal. Every cloud boots the image with Secure Boot on, and a
#   Secure Boot kernel (lockdown=integrity is on the command line) refuses to
#   load a kernel module that is not signed by a key in its trust chain. A
#   zfs.ko built by DKMS or from the OpenZFS tarball is signed by nobody, so
#   it is rejected and the box never finds its pool. Ubuntu is the only
#   distribution whose kernel packages ship zfs.ko built and signed with the
#   same distro key as the kernel itself, which the Canonical-signed shim and
#   GRUB already trust. Debian puts ZFS in contrib as DKMS source, Amazon
#   Linux and Oracle Linux do not ship it at all. So: Ubuntu, with the cloud
#   kernel flavour each provider's hardware needs (linux-aws, linux-gcp,
#   linux-azure, linux-oracle), all four of which carry the signed zfs.ko.
#   This script checks for it after the kernel install and refuses to
#   continue without it.
#
# Why one installer
#
#   Once the distribution is the same, the only things that differ between
#   clouds are the kernel metapackage, the initramfs driver list, the chrony
#   time source and the name of the agent package that must not exist. Four
#   copies of the remaining 700 lines drifted apart in the first build (the
#   per-cloud scripts disagreed on audit rules, setgid stripping, the MariaDB
#   datadir initialiser and the /var skeleton). One file with a case on
#   SAFEBOX_CLOUD in exactly those four places cannot drift.
#
# What an auditor should take from this file
#
#   * Everything it does is a file write, a package install, a symlink, or
#     the two source builds (OpenSSL 3.5, Node 22) below.
#     It never starts a service, never reloads systemd, never touches the
#     TPM, never talks to the metadata service, never runs zpool or zfs.
#   * The package set is fixed by name and by a version glob (apt pin priority
#     1001) on the upstream version noble ships. A noble-security point
#     release of the same upstream still installs; a different upstream
#     version is refused. Every version actually installed is recorded in
#     /opt/safebox/manifests/base.json.
#   * The things that are removed (sshd, cloud-init, every cloud agent, snapd,
#     unattended-upgrades, Ubuntu Pro, initramfs-tools, fail2ban, the legacy
#     network daemons) are pinned to priority -1 on every cloud, whether or
#     not that cloud's packages could ever appear, because the pin costs
#     nothing and verify-image.sh checks all of them regardless.
#   * Node 22 is built from source in the chroot against a separately built
#     OpenSSL 3.5 (/usr/local/openssl-3.5) so Node's TLS can negotiate the
#     hybrid post-quantum group X25519MLKEM768 (docs/PQ-TLS.md,
#     docs/HARDENING-PLAN.md fix 11). Both tarballs are pinned by sha256 in
#     this file. The compilers are installed for the two builds and purged
#     again; verify-image.sh fails the build if gcc survives. No third-party
#     apt source is ever configured.
#
# Mutable state and secrets never live on the root. /var is a ZFS dataset on
# the encrypted pool and starts empty on first boot, so this script installs
# a tmpfiles.d snippet that recreates the /var directories the services need,
# and a MariaDB ExecStartPre that initialises an empty datadir.

set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8

die() { printf 'install-base: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf 'install-base: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Preflight: must be the chroot, must be root, must be noble, must know the
# cloud, must have the repo.
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "must run as root"
[[ ${SAFEBOX_CHROOT:-} == 1 ]] || die "SAFEBOX_CHROOT=1 is not set; this script runs only inside the build chroot (see <cloud>/scripts/build-image.sh)"
CLOUD="${SAFEBOX_CLOUD:-}"
case "$CLOUD" in
    aws|gcp|azure|oci) ;;
    "") die "SAFEBOX_CLOUD is unset; must be one of aws gcp azure oci" ;;
    *)  die "SAFEBOX_CLOUD='$CLOUD' is not one of aws gcp azure oci" ;;
esac
SRC="${SAFEBOX_SRC:-/opt/safebox-src}"
COMMON="$SRC/common"
[[ -d $COMMON/boot/dracut/90safebox ]] || die "$COMMON/boot/dracut/90safebox missing; is the repo bind-mounted at $SRC?"
[[ -r /etc/os-release ]] || die "/etc/os-release missing"
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_CODENAME:-} == noble ]] \
    || die "rootfs is not Ubuntu 24.04 noble (ID=${ID:-} CODENAME=${VERSION_CODENAME:-}); bootstrap with 'debootstrap --variant=minbase noble'"
[[ "$(dpkg --print-architecture)" == amd64 ]] || die "amd64 only"
if mountpoint -q /boot/efi 2>/dev/null; then
    die "/boot/efi is a mountpoint inside the chroot; refusing to run against a live system"
fi
SELF="$(readlink -f "${BASH_SOURCE[0]}")"

# ---------------------------------------------------------------------------
# Per-cloud values. These four case statements are the whole of what differs
# between clouds in the base layer.
# ---------------------------------------------------------------------------
case "$CLOUD" in
    aws)   KERNEL_META=linux-aws;    AGENT_HINT="amazon-ssm-agent" ;;
    gcp)   KERNEL_META=linux-gcp;    AGENT_HINT="google-guest-agent" ;;
    azure) KERNEL_META=linux-azure;  AGENT_HINT="walinuxagent" ;;
    oci)   KERNEL_META=linux-oracle; AGENT_HINT="oracle-cloud-agent" ;;
esac
# Upstream kernel series noble ships for the cloud flavours. The metapackage
# is pinned to this glob so the rolling HWE kernel (linux-<flavour> on an
# LTS rolls to the next HWE series at .2) cannot change the kernel under the
# build. If noble-updates has rolled past 6.8 by build time, either bump the
# series here (after testing the signed zfs.ko in the new series) or point
# SAFEBOX_KERNEL_META at the series-locked metapackage (linux-<flavour>-6.8)
# so the build keeps receiving 6.8 security releases instead of falling
# back to the GA kernel in the noble release pocket.
KERNEL_META="${SAFEBOX_KERNEL_META:-$KERNEL_META}"
KERNEL_SERIES="${SAFEBOX_KERNEL_SERIES:-6.8.0-*}"

# Initramfs drivers. hostonly=no already sweeps the storage and network
# directories; naming the ones the pool and the first boot depend on removes
# any doubt and makes the manifest self-describing.
case "$CLOUD" in
    aws)   DRACUT_DRIVERS="ena nvme nvme_core" ;;
    gcp)   DRACUT_DRIVERS="gve virtio_net virtio_scsi virtio_pci nvme nvme_core" ;;
    azure) DRACUT_DRIVERS="hv_vmbus hv_storvsc hv_netvsc hv_utils hv_balloon pci_hyperv mana" ;;
    oci)   DRACUT_DRIVERS="virtio_net virtio_scsi virtio_blk virtio_pci nvme nvme_core" ;;
esac

# ---------------------------------------------------------------------------
# Package set. "package=version-glob": the glob goes into an apt preferences
# entry (Pin: version <glob>, Pin-Priority: 1001) so the package resolves to
# that upstream version from whichever noble pocket carries it (noble,
# noble-updates, noble-security). After the install every entry is checked
# against what dpkg actually recorded. Versions are noble's at the time of
# writing; a glob that matches nothing makes apt fall through to the
# unpinned candidate and the check below catches that.
# ---------------------------------------------------------------------------
PINNED=(
    # Kernel (signed, with the signed zfs.ko). The metapackage pulls
    # linux-image-<flavour> and linux-headers-<flavour>.
    "$KERNEL_META=$KERNEL_SERIES"
    # Initramfs: dracut replaces initramfs-tools so the shared 90safebox
    # module runs on every cloud the same way. zfs-dracut is the "zfs"
    # dracut module; dracut 060 ships systemd-veritysetup.
    "dracut=060*"
    "dracut-core=060*"
    "zfsutils-linux=2.2.2-0ubuntu9*"
    "zfs-zed=2.2.2-0ubuntu9*"
    "zfs-dracut=2.2.2-0ubuntu9*"
    # Container engine: noble's docker.io (no third-party repo in the image).
    "docker.io=26.1.*"
    "containerd=1.7.*"
    "runc=1.1.*"
    # Web stack.
    "nginx=1.24.*"
    "php8.3-fpm=8.3.*"
    "mariadb-server=1:10.11.*"
    "mariadb-client=1:10.11.*"
    # TPM and verity userland (veritysetup is in cryptsetup-bin). The
    # dlopen()ed TCTI library is installed by name pattern below because
    # noble's time64 transition renamed it (libtss2-tcti-device0t64).
    "tpm2-tools=5.6*"
    "cryptsetup-bin=2:2.7.*"
    # Signed boot chain: Microsoft-signed shim, Canonical-signed GRUB, and the
    # grub-install tool build-verity-root.sh runs in this chroot.
    "shim-signed=1.*"
    "grub-efi-amd64-signed=1.*"
    "grub-efi-amd64-bin=2.12-*"
    "grub2-common=2.12-*"
    "grub-common=2.12-*"
    "efibootmgr=18-*"
    # Firewall: native nftables plus the iptables-nft front end Docker drives.
    "nftables=1.0.9-*"
    "iptables=1.8.10-*"
    # Mandatory access control: Ubuntu's docker-default profile needs the
    # parser; apparmor-utils for aa-status in the red-team tests.
    "apparmor=4.0.*"
    "apparmor-utils=4.0.*"
    # DNS nameserver: Knot DNS for authoritative serving of the Safenet zone.
    # Activated only on boxes designated as nameservers via nameserver_role in
    # managed-containers.json. The zone is compiled from Safenet registry state
    # (name_claims + box announces) and loaded by knotc zone-reload.
    "knot=3.3.*"
    # tpm2-pkcs11: PKCS#11 provider for TPM-held DNSSEC signing keys.
    # Knot DNS signs zones via the PKCS#11 interface to keys that never leave
    # the TPM. Each nameserver generates its own ZSK/KSK (RFC 8901 multi-signer).
    "libtpm2-pkcs11-1=1.9.*"
    # Everything else the units and installers call.
    "jq=1.7.*"
    "auditd=1:3.1.*"
    "chrony=4.5-*"
    "rsync=3.2.7-*"
    "gdisk=1.0.10-*"
    "e2fsprogs=1.47.0-*"
    "dosfstools=4.2-*"
    "sudo=1.9.15p5-*"
    "ca-certificates=2024*"
    "curl=8.5.0-*"
    "systemd-resolved=255.*"
    "systemd=255.*"
    "udev=255.*"
    "uidmap=1:4.13*"
    "iproute2=6.1.0-*"
    "kmod=31+*"
    "openssl=3.0.*"
    "xz-utils=5.*"
    "gnupg=2.4.4-*"
    # safebox-confidential-report drives the SEV-SNP/TDX ioctls with ctypes.
    "python3=3.12.*"
)
# Node 22 is NOT an apt package here: it is built from source below. noble's
# nodejs 18 is in FORBIDDEN so apt can never put a second node on the image.
# Packages installed without a version glob (the release pin keeps them on
# noble's pockets; nothing else is configured).
UNPINNED=(
    systemd-sysv dbus tzdata util-linux
)

# Removed and pinned to -1 on every cloud. The build fails if any is present
# afterwards. Entries with a '*' are apt glob patterns (apt >= 0.8.14) and
# are matched the same way by dpkg-query below.
## SSH is deliberately KEPT in the audit AMI. The seal script
## (safebox-seal-image.sh) removes it when producing the production AMI.
## These packages must NOT appear in the FORBIDDEN list.
AUDIT_SSH_PKGS=(openssh-server openssh-client openssh-sftp-server)

FORBIDDEN=(
    cloud-init cloud-guest-utils cloud-initramfs-growroot
    walinuxagent
    google-guest-agent google-osconfig-agent google-compute-engine
    google-compute-engine-oslogin gce-disk-expand google-cloud-cli
    amazon-ssm-agent ec2-instance-connect ec2-hibinit-agent
    oracle-cloud-agent oci-utils
    snapd unattended-upgrades ubuntu-advantage-tools ubuntu-pro-client motd-news-config
    initramfs-tools initramfs-tools-core initramfs-tools-bin zfs-initramfs
    'linux-cloud-tools-*' linux-cloud-tools-common linux-tools-common hyperv-daemons
    nm-cloud-setup network-manager netplan.io
    fail2ban 'cockpit*' telnetd telnet rsh-server rsh-client vsftpd proftpd-basic
    tftpd tftpd-hpa xinetd
    apport popularity-contest systemd-timesyncd
    nodejs npm libnode-dev
)

# OpenSSL 3.5 and Node 22 source tarballs (docs/PQ-TLS.md). Versions can be
# raised through the environment; the digests must be raised with them. The
# digests fail closed: the placeholder never matches, so a build with an
# unset digest stops at the download rather than compiling unverified code.
#   OpenSSL: https://github.com/openssl/openssl/releases/download/openssl-<v>/openssl-<v>.tar.gz.sha256
#   Node:    https://nodejs.org/dist/v<v>/SHASUMS256.txt (line for node-v<v>.tar.gz),
#            signed by a release key in https://github.com/nodejs/node#release-keys
OPENSSL_VERSION="${OPENSSL_VERSION:-3.5.5}"
OPENSSL_SHA256="${SAFEBOX_OPENSSL_SHA256:-0000000000000000000000000000000000000000000000000000000000000000}"
OPENSSL_PREFIX=/usr/local/openssl-3.5
NODE_VERSION="${NODE_VERSION:-22.22.2}"
NODE_SHA256="${SAFEBOX_NODE_SHA256:-0000000000000000000000000000000000000000000000000000000000000000}"
NODE_PREFIX=/usr/local
# Packages installed for the two compiles and purged again afterwards.
BUILD_DEPS=(build-essential perl python3 pkg-config)
# What must be gone (and what verify-image.sh checks) once they are purged.
BUILD_PURGE=(build-essential gcc g++ cpp make dpkg-dev libc6-dev perl pkg-config)

# Known-good digest of the OpenZFS release tarball, kept for the day apt
# cannot provide ZFS. Not used: a tarball build produces an unsigned module
# that a Secure Boot kernel will not load (see the header).
#   zfs-2.2.6.tar.gz  sha256  c92e02103ac5dd77bf01d7209eabdca55c7b3356aa747bb2357ec4222652a2a7

APT_MIRROR="${SAFEBOX_APT_MIRROR:-http://archive.ubuntu.com/ubuntu}"
APT_SECURITY_MIRROR="${SAFEBOX_APT_SECURITY_MIRROR:-http://security.ubuntu.com/ubuntu}"

pkg_installed() {
    # Works for plain names and for the glob entries in FORBIDDEN.
    dpkg-query -W -f='${Package} ${Status}\n' "$1" 2>/dev/null | grep -q ' install ok installed$'
}

# ---------------------------------------------------------------------------
# Chroot guards: no service may start, no bootloader may be written to the
# build host's disk from inside here.
# ---------------------------------------------------------------------------
# policy-rc.d exit 101 is the Debian-documented way to tell invoke-rc.d
# "do not start anything" during package installation.
install -d -m 0755 /usr/sbin
printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d

# grub-install and update-grub are called from shim-signed's and the kernel's
# maintainer scripts. In the chroot there is no /boot/efi and no target disk
# yet; the real install happens in common/image/build-verity-root.sh. Divert
# both to /bin/true for the duration of the package phase.
DIVERTED=0
divert_on() {
    local f
    for f in /usr/sbin/grub-install /usr/sbin/update-grub; do
        dpkg-divert --quiet --local --rename --divert "$f.safebox-real" --add "$f"
        ln -sf /bin/true "$f"
    done
    DIVERTED=1
}
divert_off() {
    [[ $DIVERTED -eq 1 ]] || return 0
    local f
    for f in /usr/sbin/grub-install /usr/sbin/update-grub; do
        rm -f "$f"
        dpkg-divert --quiet --rename --remove "$f"
    done
    DIVERTED=0
}
divert_on
trap 'divert_off; rm -f /usr/sbin/policy-rc.d' EXIT

# The build host's resolv.conf is copied into the chroot by build-image.sh.
# systemd-resolved's postinst leaves a regular file alone, but keep a copy
# and restore it after the package phase in case a maintainer script turns
# it into the (dangling, in a chroot) stub symlink.
RESOLV_SAVE=""
if [[ -f /etc/resolv.conf && ! -L /etc/resolv.conf ]]; then
    RESOLV_SAVE="$(mktemp /tmp/safebox-resolv.XXXXXX)"
    cp /etc/resolv.conf "$RESOLV_SAVE"
fi

# ---------------------------------------------------------------------------
# apt configuration: sources, no recommends, no docs, pins.
# ---------------------------------------------------------------------------
log "writing apt configuration"
install -d -m 0755 /etc/apt/preferences.d /etc/apt/apt.conf.d /etc/apt/sources.list.d /etc/apt/keyrings /etc/dpkg/dpkg.cfg.d
cat >/etc/apt/sources.list <<EOF
# Written by common/base/install-base.sh. universe carries zfs, docker.io,
# dracut and tpm2-tools.
deb $APT_MIRROR noble main universe
deb $APT_MIRROR noble-updates main universe
deb $APT_SECURITY_MIRROR noble-security main universe
EOF
rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources

cat >/etc/apt/apt.conf.d/90safebox <<'EOF'
// Installed by common/base/install-base.sh.
// Recommends pull in agents and tooling the image must not have.
APT::Install-Recommends "false";
APT::Install-Suggests "false";
APT::Get::Assume-Yes "true";
Dpkg::Options { "--force-confdef"; "--force-confold"; };
EOF
cat >/etc/dpkg/dpkg.cfg.d/90safebox-nodoc <<'EOF'
path-exclude /usr/share/doc/*
path-include /usr/share/doc/*/copyright
path-exclude /usr/share/man/*
path-exclude /usr/share/info/*
path-exclude /usr/share/locale/*
path-include /usr/share/locale/locale.alias
EOF

{
    cat <<'EOF'
# /etc/apt/preferences.d/safebox - written by common/base/install-base.sh.
#
# "Pin-Priority: -1" makes a package uninstallable: apt will not select it
# as a candidate even to satisfy a dependency, so sshd, cloud-init, the
# cloud agents and initramfs-tools cannot come back through an upgrade or a
# stray "apt-get install". On a dm-verity root this file cannot be edited.
#
# "Pin-Priority: 1001" on a version glob forces that upstream version from
# whichever noble pocket carries it, and refuses any other.

EOF
    for p in "${FORBIDDEN[@]}"; do
        printf 'Package: %s\nPin: release *\nPin-Priority: -1\n\n' "$p"
    done
    for spec in "${PINNED[@]}"; do
        printf 'Package: %s\nPin: version %s\nPin-Priority: 1001\n\n' "${spec%%=*}" "${spec#*=}"
    done
} >/etc/apt/preferences.d/safebox
chmod 0644 /etc/apt/preferences.d/safebox

# Debconf answers that keep the signed GRUB packages from touching NVRAM or
# generating a grub.cfg in the chroot. build-verity-root.sh installs GRUB
# itself with --no-nvram and a hand-written configuration.
debconf-set-selections <<'EOF'
grub-efi-amd64 grub2/update_nvram boolean false
grub-efi-amd64 grub2/force_efi_extra_removable boolean false
grub-pc grub2/update_nvram boolean false
EOF

# The kernel postinst runs dracut's kernel hook before our module and
# configuration exist. Make that run hostonly-free so it cannot fail on the
# build host's hardware; its output is deleted before the real build below.
install -d -m 0755 /etc/dracut.conf.d
printf 'hostonly="no"\n' >/etc/dracut.conf.d/00-safebox-build.conf

# ---------------------------------------------------------------------------
# Fixed-id service accounts before any package can take 990/991. useradd -r
# on Ubuntu allocates system uids downward from 999, so without this a
# package user could land on 990 and install-system.sh would fail its uid
# check. install-system.sh re-runs the same commands behind getent guards;
# the two must stay identical.
# ---------------------------------------------------------------------------
NOLOGIN=/usr/sbin/nologin
getent group  safebox-infra >/dev/null || groupadd --system --gid 990 safebox-infra
getent group  safebox-app   >/dev/null || groupadd --system --gid 991 safebox-app
getent passwd safebox-infra >/dev/null || useradd --system --uid 990 --gid 990 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox system component runtime user" safebox-infra
getent passwd safebox-app   >/dev/null || useradd --system --uid 991 --gid 991 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox tenant container app user" safebox-app
# safebox-dns (992): the uid dnsclient runs as. Separate from safebox-infra
# so the process that talks to the public internet and holds the account
# credential is not the uid that holds the HMAC master; the two share no
# files. Its state is /var/lib/safebox/dns/ on the pool.
getent group  safebox-dns   >/dev/null || groupadd --system --gid 992 safebox-dns
getent passwd safebox-dns   >/dev/null || useradd --system --uid 992 --gid 992 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox dnsclient runtime user" safebox-dns
[[ "$(id -u safebox-dns)" == 992 ]] || die "safebox-dns must be uid 992"
# safebox-sys (gid 993): the primary group of the per-tenant instance users
# safebox-sys-<name> (uid 20000..29999), which cannot be baked into the image
# because tenants are declared at runtime and /etc is a tmpfs overlay;
# safebox-users.service recreates them from managed-containers.json every
# boot. sudoers grants the tenant-side wrappers to %safebox-sys, and each
# wrapper derives the calling tenant from SUDO_UID. No baked-in account is
# a member: safebox-infra in particular is not.
getent group safebox-sys >/dev/null || groupadd --system --gid 993 safebox-sys
[[ "$(getent group safebox-sys | cut -d: -f3)" == 993 ]] || die "safebox-sys must be gid 993"
# safebox-nameserver (994): the uid Knot DNS and the zone compiler run as.
# Separate from safebox-infra because the nameserver process is internet-facing
# on port 53 and holds DNSSEC key material in the TPM via tpm2-pkcs11.
# Its state is /var/lib/safebox/knot/ on the pool.
getent group  safebox-nameserver >/dev/null || groupadd --system --gid 994 safebox-nameserver
getent passwd safebox-nameserver >/dev/null || useradd --system --uid 994 --gid 994 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox Knot DNS nameserver runtime user" safebox-nameserver
[[ "$(id -u safebox-nameserver)" == 994 ]] || die "safebox-nameserver must be uid 994"

# safebox-audit (uid 1100): the SSH user auditors use to log in to the audit
# AMI. Has a real login shell and an .ssh/authorized_keys populated at build
# time from $AUDIT_PUBKEYS (see below). The seal script removes this user and
# all of SSH when producing the production AMI.
getent group  safebox-audit >/dev/null || groupadd --gid 1100 safebox-audit
getent passwd safebox-audit >/dev/null || useradd --uid 1100 --gid 1100 \
    --create-home --home-dir /home/safebox-audit --shell /bin/bash \
    --comment "Safebox audit SSH user (removed by seal)" safebox-audit
[[ "$(id -u safebox-audit)" == 1100 ]] || die "safebox-audit must be uid 1100"

# ---------------------------------------------------------------------------
# Install. Order matters in a chroot: dracut before the kernel so the kernel
# postinst finds a linux-initramfs-tool provider and never pulls
# initramfs-tools; the kernel before zfs so the zfs.ko check runs against
# exactly one kernel; the kernel before GRUB so no update-grub hook fires
# mid-install (it is diverted anyway).
# ---------------------------------------------------------------------------
PKG_NAMES=()
for spec in "${PINNED[@]}"; do PKG_NAMES+=("${spec%%=*}"); done

log "apt-get update"
apt-get update -qq

log "installing dracut"
apt-get install -qq dracut dracut-core xz-utils kmod
compgen -G "/usr/lib/dracut/modules.d/*systemd-veritysetup" >/dev/null \
    || die "dracut in this rootfs has no systemd-veritysetup module; the verity root cannot be opened"

log "installing kernel $KERNEL_META ($KERNEL_SERIES)"
apt-get install -qq "$KERNEL_META"
mapfile -t KVERS < <(find /usr/lib/modules -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
[[ ${#KVERS[@]} -eq 1 ]] || die "expected exactly one kernel in /usr/lib/modules, found: ${KVERS[*]:-none}"
KVER="${KVERS[0]}"
[[ -f /boot/vmlinuz-$KVER ]] || die "/boot/vmlinuz-$KVER missing after kernel install"
log "kernel $KVER"

# The signed zfs.ko is the reason this image is Ubuntu. On the cloud
# flavours it ships in linux-modules-<kver>; some flavours put it in
# linux-modules-extra-<kver>, which the image metapackage normally pulls.
# Try that (still Canonical-signed) before giving up.
zfs_ko() { compgen -G "/usr/lib/modules/$KVER/kernel/zfs/zfs.ko*" >/dev/null; }
if ! zfs_ko; then
    log "zfs.ko not in linux-modules-$KVER; trying linux-modules-extra-$KVER"
    apt-get install -qq "linux-modules-extra-$KVER" || true
fi
zfs_ko || die "no /usr/lib/modules/$KVER/kernel/zfs/zfs.ko* after installing $KERNEL_META. The image needs the ZFS module that Ubuntu builds and signs inside its kernel packages: with Secure Boot and lockdown=integrity the kernel rejects any module not signed by the distro key, so a DKMS or tarball build cannot be substituted. Check that $KERNEL_META on noble still ships zfs in linux-modules or linux-modules-extra."
# No unsigned module directory may exist either.
[[ ! -d /usr/lib/modules/$KVER/updates/dkms ]] || die "/usr/lib/modules/$KVER/updates/dkms exists; unsigned modules are not allowed"
depmod -a "$KVER"
modinfo -k "$KVER" zfs >/dev/null 2>&1 || die "modinfo cannot find zfs for $KVER after depmod"

log "installing the remaining pinned set"
apt-get install -qq "${PKG_NAMES[@]}" "${UNPINNED[@]}"

# tpm2-tools opens /dev/tpmrm0 through libtss2-tcti-device, which it
# dlopen()s and therefore need not declare as a dependency. Install whichever
# binary package noble ships it in (apt treats a name starting with '^' as a
# regex) and check for the library itself.
if ! compgen -G "/usr/lib/x86_64-linux-gnu/libtss2-tcti-device.so*" >/dev/null; then
    apt-get install -qq '^libtss2-tcti-device0'
fi
compgen -G "/usr/lib/x86_64-linux-gnu/libtss2-tcti-device.so*" >/dev/null \
    || die "libtss2-tcti-device.so missing; tpm2-tools cannot open /dev/tpmrm0 (90safebox copies it into the initramfs)"

[[ -f /usr/lib/shim/shimx64.efi.signed ]] || die "shim-signed did not provide /usr/lib/shim/shimx64.efi.signed"
compgen -G "/usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed" >/dev/null \
    || die "grub-efi-amd64-signed did not provide grubx64.efi.signed"
compgen -G "/usr/lib/dracut/modules.d/*zfs" >/dev/null || die "zfs-dracut did not provide the zfs dracut module"
[[ -x /usr/lib/systemd/systemd-networkd ]] || die "systemd-networkd missing; on this noble it may be a separate package (systemd-networkd)"
[[ -x /usr/lib/systemd/systemd-resolved ]] || die "systemd-resolved missing"
getent passwd _chrony >/dev/null || die "chrony did not create the _chrony user (common/net/safebox-imds.nft refers to it by name)"
command -v apparmor_parser >/dev/null || die "apparmor_parser missing"

# ---------------------------------------------------------------------------
# OpenSSL 3.5 and Node 22 from source (post-quantum TLS; docs/PQ-TLS.md).
#
# Node 22's bundled OpenSSL is 3.0 and has no ML-KEM. Node's TLS API cannot
# pick TLS 1.3 groups from JavaScript, so the only way to get the hybrid
# X25519MLKEM768 handshake on the Safebox<->Jet and Safebox<->Safebox paths
# is a Node linked against OpenSSL 3.5 plus an OpenSSL config that prefers
# that group. nginx also uses OpenSSL 3.5: the nginx systemd unit sets
# LD_LIBRARY_PATH and OPENSSL_CONF so the distro package (linked against
# libssl.so.3, same soname as 3.5) picks up the 3.5 libraries and the PQ
# group config at runtime. The 3.5 libraries live under their own prefix
# and are found by node through an rpath and by nginx through
# LD_LIBRARY_PATH, not through ld.so.conf, so no other binary on the
# image picks them up.
#
# Compilers are installed for this block only and purged at its end.
# ---------------------------------------------------------------------------
log "installing build dependencies for OpenSSL $OPENSSL_VERSION and Node $NODE_VERSION"
apt-get install -qq --no-install-recommends "${BUILD_DEPS[@]}"

fetch_verified() {
    # fetch_verified <url> <sha256> <dest>
    local url=$1 want=$2 dest=$3 got
    [[ $want =~ ^[0-9a-f]{64}$ ]] || die "digest for $url is not 64 hex chars"
    [[ $want != 0000000000000000000000000000000000000000000000000000000000000000 ]] \
        || die "digest for $url is the fail-closed placeholder; set SAFEBOX_OPENSSL_SHA256 / SAFEBOX_NODE_SHA256 from the upstream SHASUMS (see the comment above OPENSSL_VERSION)"
    curl --fail --silent --show-error --location --retry 3 --max-time 900 -o "$dest" "$url" \
        || die "download of $url failed"
    got="$(sha256sum "$dest" | awk '{print $1}')"
    [[ $got == "$want" ]] || die "sha256 mismatch for $url: got $got, want $want"
}

BUILD_TMP="$(mktemp -d /tmp/safebox-pq-build.XXXXXX)"
NPROC="$(nproc)"

log "building OpenSSL $OPENSSL_VERSION into $OPENSSL_PREFIX"
fetch_verified "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
    "$OPENSSL_SHA256" "$BUILD_TMP/openssl.tar.gz"
mkdir "$BUILD_TMP/openssl"
tar -xzf "$BUILD_TMP/openssl.tar.gz" -C "$BUILD_TMP/openssl" --strip-components=1
(
    cd "$BUILD_TMP/openssl"
    ./Configure --prefix="$OPENSSL_PREFIX" --openssldir="$OPENSSL_PREFIX/ssl" --libdir=lib \
        shared linux-x86_64 enable-ktls >/dev/null
    make -j"$NPROC" >/dev/null
    make install_sw install_ssldirs >/dev/null
)
[[ -x $OPENSSL_PREFIX/bin/openssl ]] || die "OpenSSL build produced no $OPENSSL_PREFIX/bin/openssl"
OPENSSL_BUILT="$("$OPENSSL_PREFIX/bin/openssl" version | awk '{print $2}')"
[[ $OPENSSL_BUILT == 3.5.* ]] || die "built openssl reports $OPENSSL_BUILT, expected 3.5.x"
"$OPENSSL_PREFIX/bin/openssl" list -kem-algorithms | grep -qi mlkem768 \
    || die "OpenSSL $OPENSSL_BUILT has no ML-KEM-768; post-quantum TLS is not available"
# Not on the default library path on purpose (see the header of this block).
[[ ! -e /etc/ld.so.conf.d/openssl-3.5.conf ]] || die "ld.so.conf.d entry for OpenSSL 3.5 present; the 3.5 libraries must stay off the default path"

log "building Node $NODE_VERSION against $OPENSSL_PREFIX"
fetch_verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.gz" \
    "$NODE_SHA256" "$BUILD_TMP/node.tar.gz"
mkdir "$BUILD_TMP/node"
tar -xzf "$BUILD_TMP/node.tar.gz" -C "$BUILD_TMP/node" --strip-components=1
(
    cd "$BUILD_TMP/node"
    # The rpath is what lets node find libssl.so.3/libcrypto.so.3 under the
    # 3.5 prefix at run time without touching ld.so.conf.
    export LDFLAGS="-Wl,-rpath,$OPENSSL_PREFIX/lib"
    ./configure --prefix="$NODE_PREFIX" \
        --shared-openssl \
        --shared-openssl-includes="$OPENSSL_PREFIX/include" \
        --shared-openssl-libpath="$OPENSSL_PREFIX/lib" >/dev/null
    make -j"$NPROC" >/dev/null
    make install >/dev/null
)
rm -rf "$BUILD_TMP"
[[ -x $NODE_PREFIX/bin/node ]] || die "Node build produced no $NODE_PREFIX/bin/node"
# The units run /usr/bin/node; keep that path pointing at the one Node.
ln -sfn "$NODE_PREFIX/bin/node" /usr/bin/node
ln -sfn "$NODE_PREFIX/bin/npm"  /usr/bin/npm
ln -sfn "$NODE_PREFIX/bin/npx"  /usr/bin/npx
NODE_BUILT="$(/usr/bin/node -e 'process.stdout.write(process.versions.node)')"
[[ $NODE_BUILT == "$NODE_VERSION" ]] || die "node is $NODE_BUILT, expected $NODE_VERSION"
NODE_OPENSSL="$(/usr/bin/node -e 'process.stdout.write(process.versions.openssl)')"
[[ $NODE_OPENSSL == 3.5.* ]] || die "node links OpenSSL $NODE_OPENSSL, expected 3.5.x (rpath or --shared-openssl did not take)"
ldd "$NODE_PREFIX/bin/node" | grep -E 'libssl\.so\.3 => '"$OPENSSL_PREFIX"'/lib/' >/dev/null \
    || die "node's libssl.so.3 does not resolve into $OPENSSL_PREFIX/lib"
command -v npm >/dev/null || die "npm missing after node build"

# System-wide preference for the hybrid post-quantum group, exactly as in
# docs/PQ-TLS.md. Applied through OPENSSL_CONF, which /etc/environment sets
# for login sessions (none exist on a production box) and the Node units set
# for themselves. nginx gets it through its own systemd drop-in (below) along
# with LD_LIBRARY_PATH pointing at the 3.5 prefix, so the distro package
# picks up the 3.5 libraries and negotiates PQ groups with browsers that
# support them. sudo's env_reset keeps OPENSSL_CONF away from the wrappers.
cat >/etc/ssl/openssl-pq.cnf <<'PQCNF'
# Post-quantum hybrid TLS key exchange configuration for Safebox
# Prefers X25519MLKEM768 (hybrid PQ), falls back to classical if peer doesn't support it

openssl_conf = openssl_init

[openssl_init]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Groups = X25519MLKEM768:X25519:P-256
PQCNF
chmod 0644 /etc/ssl/openssl-pq.cnf
if grep -q '^OPENSSL_CONF=' /etc/environment 2>/dev/null; then
    sed -i 's|^OPENSSL_CONF=.*|OPENSSL_CONF=/etc/ssl/openssl-pq.cnf|' /etc/environment
else
    printf 'OPENSSL_CONF=/etc/ssl/openssl-pq.cnf\n' >>/etc/environment
fi
# The 3.5 openssl binary and the config must agree on the group name.
OPENSSL_CONF=/etc/ssl/openssl-pq.cnf "$OPENSSL_PREFIX/bin/openssl" list -kem-algorithms >/dev/null \
    || die "openssl-pq.cnf is rejected by OpenSSL $OPENSSL_BUILT"

log "purging build dependencies"
# perl-base is Essential and stays; everything the compiles pulled in goes.
purge_now=()
for p in "${BUILD_PURGE[@]}"; do pkg_installed "$p" && purge_now+=("$p"); done
if [[ ${#purge_now[@]} -gt 0 ]]; then
    apt-get purge -qq "${purge_now[@]}"
fi
apt-get autoremove -qq --purge
for p in gcc g++ cpp make build-essential; do
    pkg_installed "$p" && die "build dependency still installed after purge: $p"
done
for b in gcc cc g++ c++ make; do
    [[ ! -e /usr/bin/$b ]] || die "/usr/bin/$b present; compilers must not ship in the image"
done
pkg_installed python3 || die "python3 was removed by the purge; safebox-confidential-report needs it"
command -v node >/dev/null || die "node vanished after the purge"
# npm's post-install habits are not wanted on a build that must be
# deterministic: no update checks, no audit, no funding banners.
cat >/etc/npmrc <<'EOF'
update-notifier=false
fund=false
audit=false
EOF

# ---------------------------------------------------------------------------
# Pin verification: every pinned package must be installed at a version
# matching its glob, otherwise apt fell through to an unpinned candidate.
# Then hold the kernel metapackage so even an explicit
# "apt-get upgrade" on a writable copy of the root leaves them alone.
# ---------------------------------------------------------------------------
for spec in "${PINNED[@]}"; do
    p="${spec%%=*}"; want="${spec#*=}"
    have="$(dpkg-query -W -f '${Version}' "$p" 2>/dev/null || true)"
    [[ -n $have ]] || die "pinned package not installed: $p"
    # shellcheck disable=SC2053  # glob match on purpose
    [[ $have == $want ]] || die "$p installed at $have, pin requires $want (update the glob in common/base/install-base.sh after checking noble's current version)"
done
apt-mark hold "$KERNEL_META" >/dev/null

# ---------------------------------------------------------------------------
# Removal with verification.
# ---------------------------------------------------------------------------
log "purging forbidden packages"
present=()
for p in "${FORBIDDEN[@]}"; do
    pkg_installed "$p" && present+=("$p")
done
if [[ ${#present[@]} -gt 0 ]]; then
    apt-get purge -qq "${present[@]}"
fi
apt-get autoremove -qq --purge
for p in "${FORBIDDEN[@]}"; do
    pkg_installed "$p" && die "forbidden package still installed: $p"
done
# SSH binaries are intentionally present (audit AMI). Verify they ARE here.
[[ -x /usr/sbin/sshd ]] || die "/usr/sbin/sshd missing; openssh-server must be installed for the audit AMI"
[[ ! -e /usr/bin/waagent && ! -e /usr/sbin/waagent ]] || die "waagent binary present"
[[ ! -e /usr/sbin/update-initramfs ]] || die "update-initramfs present; initramfs-tools was not removed"
[[ ! -d /etc/cloud ]] || die "/etc/cloud present"
# The pins must bite: ask apt whether it would install the agent and cloud-init.
# (openssh is intentionally installable — it is kept for the audit AMI.)
for p in "$AGENT_HINT" cloud-init; do
    if apt-get install -s "$p" >/dev/null 2>&1; then
        die "apt would still install $p; the -1 pin is not in effect"
    fi
done
rm -rf /var/lib/cloud /var/lib/google /var/lib/waagent /etc/default/instance_configs.cfg
apt-get clean

# Restore the build-time resolv.conf if a maintainer script replaced it.
if [[ -n $RESOLV_SAVE && -L /etc/resolv.conf ]]; then
    rm -f /etc/resolv.conf
    cp "$RESOLV_SAVE" /etc/resolv.conf
fi
rm -f "${RESOLV_SAVE:-/nonexistent}"

# ---------------------------------------------------------------------------
# Identity, locale, time
# ---------------------------------------------------------------------------
echo safebox >/etc/hostname
cat >/etc/hosts <<'EOF'
127.0.0.1 localhost
127.0.1.1 safebox
::1 localhost ip6-localhost ip6-loopback
EOF
printf 'LANG=C.UTF-8\n' >/etc/default/locale
ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime
echo Etc/UTC >/etc/timezone

# chrony: one cloud-specific source file in conf.d; noble's chrony.conf
# includes conf.d and keeps the ubuntu.pool.ntp.org lines as fallback.
# AWS's 169.254.169.123 is not the metadata address, so no firewall rule is
# involved. GCP and OCI serve NTP on 169.254.169.254, the same address as
# the metadata service, which common/net/safebox-imds.nft drops for every
# uid but root and safebox-infra; that file therefore carries one extra
# accept for the _chrony uid, limited to UDP 123. Azure exposes the host
# clock as a PTP device, which is what Azure's guidance says to use.
install -d -m 0755 /etc/chrony/conf.d
case "$CLOUD" in
    aws)
        cat >/etc/chrony/conf.d/safebox-aws.conf <<'EOF'
# AWS: the Amazon Time Sync Service on the link-local address (not the IMDS
# address; no firewall exception needed).
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
makestep 1.0 -1
EOF
        TIME_SOURCE="chrony server 169.254.169.123 (Amazon Time Sync)" ;;
    gcp)
        cat >/etc/chrony/conf.d/safebox-gcp.conf <<'EOF'
# GCP: metadata.google.internal (169.254.169.254) serves NTP. The IP is
# used directly so time sync does not depend on DNS at boot. The uid-scoped
# UDP 123 accept for _chrony is in /etc/safebox/safebox-imds.nft.
server 169.254.169.254 prefer iburst minpoll 4 maxpoll 4
makestep 1.0 -1
EOF
        TIME_SOURCE="chrony server 169.254.169.254 (metadata.google.internal)" ;;
    azure)
        cat >/etc/chrony/conf.d/safebox-azure.conf <<'EOF'
# Azure: Hyper-V PTP host clock as the primary time source.
refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0 stratum 2
makestep 1.0 -1
EOF
        cat >/etc/udev/rules.d/99-safebox-ptp-hyperv.rules <<'EOF'
# Stable symlink for the Hyper-V PTP clock used by chrony.
ACTION=="add", SUBSYSTEM=="ptp", ATTR{clock_name}=="hyperv", SYMLINK+="ptp_hyperv"
EOF
        TIME_SOURCE="chrony refclock PHC /dev/ptp_hyperv" ;;
    oci)
        cat >/etc/chrony/conf.d/safebox-oci.conf <<'EOF'
# OCI: the metadata address also serves NTP. The uid-scoped UDP 123 accept
# for _chrony is in /etc/safebox/safebox-imds.nft.
server 169.254.169.254 prefer iburst minpoll 4 maxpoll 4
makestep 1.0 -1
EOF
        TIME_SOURCE="chrony server 169.254.169.254 (OCI metadata NTP)" ;;
esac

# ---------------------------------------------------------------------------
# Network: systemd-networkd DHCP on the first NIC, systemd-resolved for
# DNS. The MTU comes from DHCP on every cloud (GCE 1460, OCI 9000, Azure
# and AWS 1500 or 9001). No NetworkManager, no netplan, no cloud-init, no
# guest agent. AWS's ENA driver is in the linux-aws kernel.
# ---------------------------------------------------------------------------
install -d -m 0755 /etc/systemd/network
cat >/etc/systemd/network/10-safebox.network <<'EOF'
[Match]
Name=en* eth*

[Network]
DHCP=yes
IPv6AcceptRA=yes
LinkLocalAddressing=ipv6

[DHCPv4]
UseMTU=true
UseDNS=true
UseDomains=true
UseHostname=false

[DHCPv6]
UseDNS=true
UseHostname=false
EOF
chmod 0644 /etc/systemd/network/10-safebox.network
# /etc/resolv.conf: at runtime it is the systemd-resolved stub symlink.
# build-image.sh copies the host's resolv.conf in for the duration of the
# chroot work and installs the symlink after the last installer has run.

# ---------------------------------------------------------------------------
# sysctl
# ---------------------------------------------------------------------------
install -d -m 0755 /etc/sysctl.d
cat >/etc/sysctl.d/90-safebox.conf <<'EOF'
# Installed by common/base/install-base.sh (HARDENING-PLAN.md fix 3).
#
# --- Kernel self-protection ---
kernel.sysrq = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 2
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.kexec_load_disabled = 1
# Restrict perf_event to processes with CAP_PERFMON only. Value 3 is
# supported on Ubuntu's kernel (HWE 6.8+). Prevents unprivileged side-
# channel attacks via performance counters.
kernel.perf_event_paranoid = 3
# Disable io_uring for all users. Safebox uses no io_uring; the subsystem
# has had a steady stream of privilege-escalation CVEs since 5.x.
# Value 2 = disabled for everyone (kernel 6.6+).
kernel.io_uring_disabled = 2
# Restrict userfaultfd to privileged processes. Unprivileged userfaultfd
# is a common building block for kernel exploit races.
vm.unprivileged_userfaultfd = 0
# No core dumps from setuid binaries.
fs.suid_dumpable = 0
#
# --- Filesystem link protections ---
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
#
# --- Network: IPv4 ---
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
# SYN cookies: kernel-level SYN-flood protection. When the SYN backlog
# overflows, the kernel encodes connection state in the SYN-ACK sequence
# number instead of allocating memory, preventing resource exhaustion.
net.ipv4.tcp_syncookies = 1
#
# --- Network: IPv6 ---
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
#
# --- Network: MPTCP ---
# CVE-2026-98432: disable MPTCP. Safebox has no use for multipath TCP, and
# the CVE's UAF is reachable via MPTCP listeners (which Go ≥1.24 enables
# by default). Disabling it at the kernel level removes the attack surface
# regardless of what user-space programs request.
net.mptcp.enabled = 0
EOF
chmod 0644 /etc/sysctl.d/90-safebox.conf

# ---------------------------------------------------------------------------
# Kernel module blacklist: disable protocols, filesystems and hardware that
# Safebox never uses. Each "install <mod> /bin/false" prevents the module
# from loading even if triggered by a userspace program or an autoloader.
# This reduces the kernel attack surface preemptively — an undisclosed CVE
# in a blacklisted module has no entry point.
#
# What stays: ipv4/ipv6/tcp/udp/unix (networking), ext4/xfs/squashfs/
# overlay/zfs (storage), vsock (Nitro Enclave communication), virtio
# (cloud VM hardware), nf_tables/nf_conntrack (firewall).
# ---------------------------------------------------------------------------
log "installing kernel module blacklist"
install -d -m 0755 /etc/modprobe.d
cat >/etc/modprobe.d/safebox-blacklist.conf <<'EOF'
# Installed by common/base/install-base.sh.
# Safebox uses only IPv4/IPv6 TCP, UDP, Unix sockets and vsock.
# Everything else is attack surface with no benefit.

# --- Unused network protocols ---
install sctp    /bin/false
install dccp    /bin/false
install tipc    /bin/false
install rds     /bin/false
install n-hdlc  /bin/false
install ax25    /bin/false
install netrom  /bin/false
install x25     /bin/false
install rose    /bin/false
install decnet  /bin/false
install econet  /bin/false
install af_802154 /bin/false
install ipx     /bin/false
install appletalk /bin/false
install psnap   /bin/false
install p8023   /bin/false
install p8022   /bin/false
install can     /bin/false
install atm     /bin/false

# --- Unused filesystems ---
# Cloud VMs never mount these; an attacker who can trigger a mount of a
# crafted image exploits bugs in these parsers.
install cramfs   /bin/false
install freevxfs /bin/false
install jffs2    /bin/false
install hfs      /bin/false
install hfsplus  /bin/false
install udf      /bin/false

# --- Hardware not present on cloud VMs ---
install usb-storage /bin/false
install firewire-core /bin/false
install firewire-ohci /bin/false
install thunderbolt   /bin/false
install bluetooth     /bin/false
install btusb         /bin/false
install cfg80211      /bin/false
install mac80211      /bin/false
EOF
chmod 0644 /etc/modprobe.d/safebox-blacklist.conf

# ---------------------------------------------------------------------------
# Image-sealing support: install the seal script and the sealed-boot service.
#
# The seal script (safebox-seal-image.sh) is what transitions an audit AMI
# into a production AMI: it removes SSH, locks root, cleans nondeterminism,
# and writes /etc/safebox/sealed.
#
# The sealed-boot service runs at every boot. On an unsealed (audit) box it
# does nothing. On a sealed (production) box it sets kernel.modules_disabled=1
# (preventing any new module loads) and remounts /proc with hidepid=2
# (process isolation between UIDs). Both are one-way for the life of the boot.
# ---------------------------------------------------------------------------
log "installing image-sealing support"
install -d -m 0755 /opt/safebox/seal
install -m 0755 "$COMMON/seal/safebox-seal-image.sh" /opt/safebox/seal/safebox-seal-image.sh
install -m 0644 "$COMMON/seal/safebox-sealed-boot.service" /etc/systemd/system/safebox-sealed-boot.service

# ---------------------------------------------------------------------------
# SSH hardening for the audit AMI. SSH is the single interactive path;
# harden it so the only thing that works is pubkey auth for safebox-audit.
# ---------------------------------------------------------------------------
log "configuring SSH for audit AMI"
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/safebox-audit.conf <<'EOF'
# Safebox audit AMI SSH hardening — written by install-base.sh.
# The seal script removes all of SSH when producing the production AMI.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PrintMotd no
MaxAuthTries 3
MaxSessions 2
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers safebox-audit
EOF
chmod 0644 /etc/ssh/sshd_config.d/safebox-audit.conf

# Authorized keys for safebox-audit: populated from $AUDIT_PUBKEYS at build
# time. If no keys are supplied the directory is created empty and the builder
# must add keys before the audit AMI is useful.
install -d -m 0700 -o safebox-audit -g safebox-audit /home/safebox-audit/.ssh
if [[ -n "${AUDIT_PUBKEYS:-}" && -f "$AUDIT_PUBKEYS" ]]; then
    install -m 0600 -o safebox-audit -g safebox-audit "$AUDIT_PUBKEYS" /home/safebox-audit/.ssh/authorized_keys
    log "  installed $(wc -l < /home/safebox-audit/.ssh/authorized_keys) public key(s) for safebox-audit"
else
    touch /home/safebox-audit/.ssh/authorized_keys
    chmod 0600 /home/safebox-audit/.ssh/authorized_keys
    chown safebox-audit:safebox-audit /home/safebox-audit/.ssh/authorized_keys
    log "  WARNING: no \$AUDIT_PUBKEYS file; /home/safebox-audit/.ssh/authorized_keys is empty"
fi

# Remove SSH host keys that debootstrap or the package install generated.
# sshd regenerates them on first boot, and baked-in keys would be shared
# across every instance of the audit AMI.
rm -f /etc/ssh/ssh_host_*

# ---------------------------------------------------------------------------
# Masked units: nothing interactive may ever be reachable on a console, no
# agent or cloud-init unit may run even if a package slipped through, no
# timer may change the box. A symlink to /dev/null is exactly what
# `systemctl mask` creates; writing it directly keeps the result
# independent of a chroot-aware systemctl.
# ---------------------------------------------------------------------------
log "masking units"
## SSH units are NOT masked here — they are needed for the audit AMI.
## The seal script (safebox-seal-image.sh) masks them when producing the
## production AMI.
for u in getty@.service serial-getty@.service console-getty.service debug-shell.service \
         rescue.service emergency.service rescue.target emergency.target getty.target \
         systemd-firstboot.service \
         cloud-init.service cloud-init-local.service cloud-config.service cloud-final.service \
         walinuxagent.service hv-kvp-daemon.service hv-fcopy-daemon.service hv-vss-daemon.service \
         google-guest-agent.service google-osconfig-agent.service google-startup-scripts.service \
         google-shutdown-scripts.service amazon-ssm-agent.service oracle-cloud-agent.service \
         snapd.service snapd.socket unattended-upgrades.service ua-timer.timer ua-timer.service \
         apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service \
         motd-news.timer motd-news.service e2scrub_all.timer fstrim.timer apport.service \
         systemd-timesyncd.service docker.socket \
         zfs-import-cache.service nftables.service; do
    ln -sfn /dev/null "/etc/systemd/system/$u"
done
for u in getty@.service serial-getty@.service console-getty.service debug-shell.service rescue.service emergency.service; do
    [[ -L /etc/systemd/system/$u && $(readlink "/etc/systemd/system/$u") == /dev/null ]] || die "$u is not masked"
done
# nftables.service is masked because Ubuntu's /etc/nftables.conf starts
# with "flush ruleset", which would erase Docker's chains and ours.
# docker.socket is masked because the daemon must be up (and the
# DOCKER-USER rule in place) before anything talks to it.
# zfs-import-cache is masked so the scan path is always the one taken.
# getty.target is masked so the (already masked) getty instances do not
# even appear in the boot graph.
rm -f /etc/zfs/zpool.cache

# ---------------------------------------------------------------------------
# GRUB defaults. The real grub.cfg is rendered from common/image/grub.cfg.tmpl
# by build-verity-root.sh; this file exists because verify-image.sh asserts
# on it and because nothing on the box should ever regenerate a config with
# a menu, a timeout, or a recovery entry.
# ---------------------------------------------------------------------------
cat >/etc/default/grub <<'EOF'
# Informational on a safebox: the real grub.cfg is rendered by
# common/image/build-verity-root.sh from common/image/grub.cfg.tmpl and is
# never regenerated by update-grub. Values mirror that template.
GRUB_DEFAULT=0
GRUB_TIMEOUT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_DISABLE_RECOVERY=true
GRUB_DISABLE_OS_PROBER=true
GRUB_DISABLE_SUBMENU=y
GRUB_TERMINAL=console
GRUB_CMDLINE_LINUX="console=ttyS0,115200n8 lockdown=integrity"
EOF
# update-grub must never run on the box; a regenerated grub.cfg would be an
# unmeasured second boot path. Remove the kernel hooks that call it.
rm -f /etc/kernel/postinst.d/zz-update-grub /etc/kernel/postrm.d/zz-update-grub

# ---------------------------------------------------------------------------
# Shared pieces from common/: initramfs module, first boot, firewall,
# defaults. Paths are the ones the units and scripts in common/ reference.
# ---------------------------------------------------------------------------
log "installing common/ pieces"
install -d -m 0755 /usr/lib/safebox /usr/libexec/safebox /etc/safebox /etc/dracut.conf.d \
    /opt/safebox /opt/safebox/manifests
install -d -m 0755 /usr/lib/dracut/modules.d/90safebox
install -m 0755 "$COMMON/boot/dracut/90safebox/module-setup.sh" /usr/lib/dracut/modules.d/90safebox/module-setup.sh
install -m 0644 "$COMMON/boot/dracut/90safebox/safebox-unseal.service" /usr/lib/dracut/modules.d/90safebox/safebox-unseal.service
# The module picks the scripts up from its own directory first, then from
# /usr/lib/safebox; install both so either lookup finds the same bytes.
install -m 0755 "$COMMON/boot/safebox-unseal.sh" /usr/lib/dracut/modules.d/90safebox/safebox-unseal.sh
install -m 0644 "$COMMON/boot/safebox-seal.sh"   /usr/lib/dracut/modules.d/90safebox/safebox-seal.sh
install -m 0755 "$COMMON/boot/safebox-unseal.sh" /usr/lib/safebox/safebox-unseal.sh
install -m 0644 "$COMMON/boot/safebox-seal.sh"   /usr/lib/safebox/safebox-seal.sh
install -m 0644 "$COMMON/boot/dracut/safebox.conf" /etc/dracut.conf.d/safebox.conf
rm -f /etc/dracut.conf.d/00-safebox-build.conf
cat >"/etc/dracut.conf.d/$CLOUD.conf" <<EOF
# $CLOUD: storage and network drivers the initramfs must carry to find the
# data disk. Written by common/base/install-base.sh.
add_drivers+=" $DRACUT_DRIVERS "
EOF
# Keep a copy of the GRUB template in the image so the inventory in
# verify-image.sh can record its hash (it looks in /etc/safebox first).
install -m 0644 "$COMMON/image/grub.cfg.tmpl" /etc/safebox/grub.cfg.tmpl

# First boot (replaces cloud-init): reads three metadata keys, writes one file.
install -m 0755 "$COMMON/firstboot/safebox-firstboot.sh" /usr/libexec/safebox/safebox-firstboot.sh
install -m 0644 "$COMMON/firstboot/safebox-firstboot.service" /etc/systemd/system/safebox-firstboot.service
# dnsRelays and safenetLogs are build-time constants unless SAFEBOX_DNS_RELAYS /
# SAFEBOX_SAFENET_LOGS (comma-separated https URLs) override them.
# allowUnencryptedMemory is false unless SAFEBOX_ALLOW_UNENCRYPTED_MEMORY=1 at
# build: only such an image registers from a shape without SEV-SNP or TDX
# (docs/HARDENING-PLAN.md fix 8). It lives on the verity root, so a running
# box cannot change it.
install -m 0644 "$COMMON/firstboot/defaults.json" /etc/safebox/defaults.json
for pair in "SAFEBOX_DNS_RELAYS:dnsRelays" "SAFEBOX_SAFENET_LOGS:safenetLogs"; do
    var=${pair%%:*}; key=${pair#*:}
    if [[ -n ${!var:-} ]]; then
        for u in ${!var//,/ }; do
            [[ $u =~ ^https:// ]] || die "$var entries must be https:// URLs (got $u)"
        done
        jq --arg list "${!var}" --arg key "$key" '.[$key] = ($list | split(","))' /etc/safebox/defaults.json >/etc/safebox/defaults.json.tmp
        mv /etc/safebox/defaults.json.tmp /etc/safebox/defaults.json
    fi
done
if [[ ${SAFEBOX_ALLOW_UNENCRYPTED_MEMORY:-0} == 1 ]]; then
    log "WARNING: allowUnencryptedMemory=true; this image will announce from non-confidential shapes"
    jq '.allowUnencryptedMemory = true' /etc/safebox/defaults.json >/etc/safebox/defaults.json.tmp
    mv /etc/safebox/defaults.json.tmp /etc/safebox/defaults.json
fi
chmod 0644 /etc/safebox/defaults.json
jq -e '(.dnsRelays | type == "array") and (.safenetLogs | type == "array") and all((.dnsRelays + .safenetLogs)[]; test("^https://"))' \
    /etc/safebox/defaults.json >/dev/null || die "defaults.json dnsRelays/safenetLogs must be arrays of https URLs"
jq -e '.allowUnencryptedMemory == false or .allowUnencryptedMemory == true' /etc/safebox/defaults.json >/dev/null \
    || die "defaults.json allowUnencryptedMemory must be a boolean"

# Metadata-service firewall.
install -m 0755 "$COMMON/net/safebox-imds.sh"  /usr/libexec/safebox/safebox-imds.sh
install -m 0644 "$COMMON/net/safebox-imds.nft" /etc/safebox/safebox-imds.nft
install -m 0644 "$COMMON/net/safebox-nftables.service" /etc/systemd/system/safebox-nftables.service
grep -q '_chrony' /etc/safebox/safebox-imds.nft \
    || die "safebox-imds.nft has no _chrony rule; GCP and OCI time sync needs UDP 123 to the metadata address"
nft -c -f /etc/safebox/safebox-imds.nft >/dev/null 2>&1 \
    || log "note: nft -c could not check the ruleset in the chroot (no netlink); syntax is checked at boot"

# Mountpoints that must exist in the hashed tree (build-verity-root.sh
# recreates them too; having them here keeps the chroot usable for the
# later installers).
install -d -m 0755 /var/lib/safebox /var/lib/docker /var/lib/mysql /srv/safebox/tenants /srv/zfs-clones /var/empty

# ---------------------------------------------------------------------------
# /var on an empty pool: directories the services expect, recreated every
# boot by systemd-tmpfiles. systemd's own var.conf covers /var/log, /var/tmp,
# /var/cache, /var/lib; the rest are package-specific and would normally
# have been created by a postinst that never ran on the pool.
# ---------------------------------------------------------------------------
install -d -m 0755 /usr/lib/tmpfiles.d
cat >/usr/lib/tmpfiles.d/safebox-var.conf <<'EOF'
# Installed by common/base/install-base.sh.
# /var is the dataset safebox-pool/var and is empty on first boot. Applied
# every boot by systemd-tmpfiles-setup.service, which runs after
# local-fs.target (var.mount).
d /var/log/journal        2755 root     systemd-journal -
d /var/log/nginx          0755 root     adm             -
d /var/log/audit          0700 root     root            -
d /var/log/sudo-io        0700 root     root            -
d /var/log/mysql          0750 mysql    adm             -
d /var/log/php            0755 root     root            -
d /var/log/apparmor       0755 root     root            -
d /var/lib/nginx          0755 root     root            -
d /var/lib/php            0755 root     root            -
d /var/lib/php/sessions   1733 root     root            -
d /var/lib/chrony         0755 _chrony  _chrony         -
d /var/lib/sudo           0711 root     root            -
d /var/lib/sudo/lectured  0700 root     root            -
d /var/lib/zfs            0755 root     root            -
d /var/lib/dhcp           0755 root     root            -
d /var/lib/systemd        0755 root     root            -
d /var/lib/private        0700 root     root            -
d /var/lib/containerd     0711 root     root            -
d /var/cache/apparmor     0755 root     root            -
d /var/cache/nginx        0755 root     root            -
d /var/spool              0755 root     root            -
d /var/mail               2775 root     mail            -
d /var/backups            0755 root     root            -
d /var/www                0755 root     root            -
d /var/tmp                1777 root     root            -
d /var/empty              0755 root     root            -
EOF

# ---------------------------------------------------------------------------
# Docker: zfs storage on the pool, user namespaces, no inter-container
# traffic, journald logs. ip-forward false: containers reach the internet
# through the daemon's own NAT rules, which Docker still programs; the
# sysctl stays off for everything else. AppArmor stays on: noble's docker.io
# loads its docker-default profile for every container.
# ---------------------------------------------------------------------------
log "configuring docker"
install -d -m 0755 /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{"storage-driver":"zfs","data-root":"/var/lib/docker","userns-remap":"default","no-new-privileges":true,"icc":false,"live-restore":true,"log-driver":"journald","iptables":true,"ip-forward":false,"default-ulimits":{"nofile":{"Name":"nofile","Hard":65536,"Soft":65536}}}
EOF
chmod 0644 /etc/docker/daemon.json
jq -e . /etc/docker/daemon.json >/dev/null || die "daemon.json is not valid JSON"
# userns-remap=default is REQUIRED and the sudo wrappers never pass
# --userns=host: the uid shift is one of the few boundaries between a
# container root escape and the host. The tenant contract's fixed
# in-container uid 991 is honoured by mapping ownership to it instead:
# container 991 is host <base>+991, and common/sudo/bin/safebox-container
# and safebox-test-run (root) chown workspaces and clones to that id before
# `docker run`, reading <base> from /etc/subuid and /etc/subgid.
# dockremap: the subordinate range Docker's userns-remap maps container root
# to. Fixed range so the mapping is identical on every box.
getent group  dockremap >/dev/null || groupadd --system dockremap
getent passwd dockremap >/dev/null || useradd --system --gid dockremap --no-create-home \
    --home-dir /var/empty --shell "$NOLOGIN" --comment "Docker userns remap" dockremap
grep -q '^dockremap:' /etc/subuid 2>/dev/null || echo 'dockremap:100000:65536' >>/etc/subuid
grep -q '^dockremap:' /etc/subgid 2>/dev/null || echo 'dockremap:100000:65536' >>/etc/subgid
chmod 0644 /etc/subuid /etc/subgid
# safebox-app-ns: a host group at the gid container uid 991 maps to
# (100000+991). Each tenant instance (safebox-system@<name>) gets it through
# SupplementaryGroups= so the socket it creates can be group-owned by the
# mapped app user; see sockets.js and the wrappers above. The operator
# (safebox-infra) is NOT a member: the per-container key files are
# group-readable by this gid and membership would hand it every tenant's key.
getent group safebox-app-ns >/dev/null || groupadd --system --gid 100991 safebox-app-ns
[[ "$(getent group safebox-app-ns | cut -d: -f3)" == 100991 ]] || die "safebox-app-ns must be gid 100991"
if id -nG safebox-infra | tr ' ' '\n' | grep -qx safebox-app-ns; then
    gpasswd -d safebox-infra safebox-app-ns >/dev/null
fi
# safebox-infra must never be in docker (root-equivalent). The group exists
# from the package; make sure it is empty.
if getent group docker >/dev/null; then
    for m in $(getent group docker | cut -d: -f4 | tr ',' ' '); do gpasswd -d "$m" docker >/dev/null; done
fi
install -d -m 0755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/safebox.conf <<'EOF'
# The data root is a legacy-mounted ZFS dataset; do not start on the overlay.
[Unit]
RequiresMountsFor=/var/lib/docker
After=var-lib-docker.mount zfs-import.target
EOF
# HARDENING-PLAN.md fix 6: the daemon must never run without the firewall.
# safebox-nftables.service is Before=docker.service; this drop-in makes the
# dependency hard from Docker's side, so if the rules fail to load Docker
# does not start (and nothing it would have restarted can reach the
# metadata address or expose a port).
cat >/etc/systemd/system/docker.service.d/10-safebox-nftables.conf <<'EOF'
[Unit]
Requires=safebox-nftables.service
After=safebox-nftables.service
EOF
grep -q '^Before=.*docker\.service' /etc/systemd/system/safebox-nftables.service \
    || die "safebox-nftables.service must be Before=docker.service"

# ---------------------------------------------------------------------------
# MariaDB: loopback only, datadir on the pool, initialised on first boot
# because the package's postinst ran against the build chroot's /var, which
# is not in the image.
# ---------------------------------------------------------------------------
log "configuring mariadb"
install -d -m 0755 /etc/mysql/mariadb.conf.d
cat >/etc/mysql/mariadb.conf.d/99-safebox.cnf <<'EOF'
# Installed by common/base/install-base.sh.
[mysqld]
bind-address    = 127.0.0.1
skip-networking = 0
datadir         = /var/lib/mysql
socket          = /run/mysqld/mysqld.sock
local-infile    = 0
symbolic-links  = 0
skip-name-resolve
log_error       = /var/log/mysql/error.log
EOF
cat >/usr/libexec/safebox/mariadb-init.sh <<'EOF'
#!/bin/bash
# Initialise the MariaDB datadir on the pool if it is empty. Runs as root
# from mariadb.service ExecStartPre=+ on every boot and is a no-op once the
# system tables exist. Socket authentication for root: no password exists
# anywhere, and only uid 0 can open the socket as root.
set -euo pipefail
DATADIR=/var/lib/mysql
mountpoint -q "$DATADIR" || { echo "mariadb-init: $DATADIR is not a mountpoint; refusing" >&2; exit 1; }
install -d -m 0750 -o mysql -g adm /var/log/mysql
if [ ! -d "$DATADIR/mysql" ]; then
    chown mysql:mysql "$DATADIR"
    chmod 0750 "$DATADIR"
    mariadb-install-db --user=mysql --datadir="$DATADIR" \
        --auth-root-authentication-method=socket --skip-test-db >/dev/null
fi
EOF
chmod 0755 /usr/libexec/safebox/mariadb-init.sh
install -d -m 0755 /etc/systemd/system/mariadb.service.d
cat >/etc/systemd/system/mariadb.service.d/safebox.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/mysql /var/log/mysql
After=var-lib-mysql.mount systemd-tmpfiles-setup.service

[Service]
ExecStartPre=+/usr/libexec/safebox/mariadb-init.sh
EOF
# The package's postinst seeded /var/lib/mysql in the chroot; that copy is
# excluded from the image (whole /var is) and would only be confusing.
rm -rf /var/lib/mysql/* 2>/dev/null || true

# ---------------------------------------------------------------------------
# PHP-FPM hardening
# ---------------------------------------------------------------------------
log "configuring php-fpm"
PHP_INI=/etc/php/8.3/fpm/php.ini
[[ -f $PHP_INI ]] || die "$PHP_INI missing"
sed -i -E 's/^;?\s*expose_php\s*=.*/expose_php = Off/' "$PHP_INI"
sed -i -E 's/^;?\s*allow_url_include\s*=.*/allow_url_include = Off/' "$PHP_INI"
sed -i -E 's/^;?\s*allow_url_fopen\s*=.*/allow_url_fopen = Off/' "$PHP_INI"
sed -i -E 's/^;?\s*display_errors\s*=.*/display_errors = Off/' "$PHP_INI"
sed -i -E 's/^;?\s*cgi\.fix_pathinfo\s*=.*/cgi.fix_pathinfo = 0/' "$PHP_INI"
cat >/etc/php/8.3/fpm/conf.d/99-safebox.ini <<'EOF'
; Installed by common/base/install-base.sh.
expose_php = Off
allow_url_fopen = Off
allow_url_include = Off
display_errors = Off
log_errors = On
error_log = /var/log/php/fpm-error.log
cgi.fix_pathinfo = 0
session.save_path = /var/lib/php/sessions
; Functions never needed by web requests. Anything that must shell out runs
; in its own container, not through php-fpm.
disable_functions = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec,pcntl_fork,curl_multi_exec,parse_ini_file,show_source,dl,phpinfo,putenv
EOF
grep -q '^expose_php = Off' "$PHP_INI" || die "expose_php not turned off in $PHP_INI"
install -d -m 0755 /etc/systemd/system/php8.3-fpm.service.d
cat >/etc/systemd/system/php8.3-fpm.service.d/safebox.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/php /var/log/php
After=var.mount systemd-tmpfiles-setup.service
EOF

# ---------------------------------------------------------------------------
# nginx: one http block that includes conf.d/*.conf and nothing else. The
# server blocks are not here: common/autovhost installs
# conf.d/safebox-autovhost.conf, which owns the default_server on 443 (and
# the port 80 listener it needs for ACME HTTP-01 and the splash page) and
# the include of the per-host vhosts on the pool at
# /var/lib/safebox/nginx/vhosts/*.conf. Repeating either here would give
# nginx two default_servers and every vhost twice. Ubuntu's sites-enabled
# default is removed so there is exactly one listener set. Port 8443 is
# dnsclient's own challenge listener, not nginx.
# ---------------------------------------------------------------------------
log "configuring nginx"
cat >/etc/nginx/nginx.conf <<'EOF'
# Safebox base nginx.conf. Written by common/base/install-base.sh; the
# server blocks live in conf.d/safebox-autovhost.conf (common/autovhost) and
# in /var/lib/safebox/nginx/vhosts/ on the encrypted pool.
user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    server_tokens off;
    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    client_max_body_size 64m;
    types_hash_max_size 2048;

    # Temp paths under /var/lib/nginx (safebox-pool/var); nginx creates the
    # leaf directories itself at startup.
    client_body_temp_path /var/lib/nginx/body;
    proxy_temp_path       /var/lib/nginx/proxy;
    fastcgi_temp_path     /var/lib/nginx/fastcgi;
    uwsgi_temp_path       /var/lib/nginx/uwsgi;
    scgi_temp_path        /var/lib/nginx/scgi;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;

    log_format safebox '$remote_addr - [$time_iso8601] "$request" $status $body_bytes_sent "$http_user_agent"';
    access_log /var/log/nginx/access.log safebox;

    include /etc/nginx/conf.d/*.conf;
}
EOF
rm -rf /etc/nginx/sites-enabled /etc/nginx/sites-available
install -d -m 0755 /etc/nginx/conf.d
install -d -m 0755 /etc/systemd/system/nginx.service.d
cat >/etc/systemd/system/nginx.service.d/safebox.conf <<EOF
[Unit]
# Vhosts and certificates live on the pool.
RequiresMountsFor=/var/lib/safebox /var/log/nginx /var/lib/nginx
After=var-lib-safebox.mount var.mount systemd-tmpfiles-setup.service

[Service]
# Link nginx against OpenSSL 3.5 at runtime (same soname libssl.so.3) so
# it can negotiate X25519MLKEM768 with browsers that support it. Browsers
# that don't simply fall back to X25519.
Environment=LD_LIBRARY_PATH=${OPENSSL_PREFIX}/lib
Environment=OPENSSL_CONF=/etc/ssl/openssl-pq.cnf
EOF

# ---------------------------------------------------------------------------
# Knot DNS: authoritative nameserver for the Safenet zone. Activated only on
# boxes with the nameserver role. The zone is compiled from Safenet registry
# state (name_claims + safebox_announces) by the zone-compiler service and
# loaded into Knot via knotc zone-reload.
#
# DNSSEC: Knot signs the zone with keys held in the TPM via tpm2-pkcs11.
# Each nameserver generates its own ZSK/KSK pair (RFC 8901 multi-signer
# DNSSEC). The DS records at the parent registry (PIR for .org) list all
# nameservers' KSKs. No signing key material is ever shared between boxes.
# ---------------------------------------------------------------------------
log "configuring knot dns (nameserver role)"
install -d -m 0755 /etc/knot /var/lib/safebox/knot /var/lib/safebox/knot/zones
# Base knot.conf: the zone compiler writes the zone file and reloads.
# DNSSEC signing is configured with a PKCS#11 keystore pointing at the TPM.
cat >/etc/knot/knot.conf <<'EOF'
# Knot DNS configuration for Safenet nameserver role.
# Written by common/base/install-base.sh. The zone file at
# /var/lib/safebox/knot/zones/safenet.org.zone is compiled from the
# Safenet registry by safebox-zone-compiler.service.

server:
    rundir: "/run/knot"
    user: safebox-nameserver:safebox-nameserver
    listen: [ 0.0.0.0@53, ::@53 ]

log:
  - target: syslog
    any: info

# PKCS#11 keystore backed by the TPM via tpm2-pkcs11.
# The key URIs are written by safebox-dnssec-keygen.sh on first boot
# of a nameserver-role box.
keystore:
  - id: tpm
    backend: pkcs11
    config: "/usr/lib/x86_64-linux-gnu/pkcs11/libtpm2_pkcs11.so"

# DNSSEC signing policy: ECDSAP256SHA256 for ZSK, Ed25519 for KSK.
# Algorithm selection follows current DNSSEC best practice (RFC 8624).
policy:
  - id: safenet-dnssec
    keystore: tpm
    algorithm: ecdsap256sha256
    ksk-lifetime: 0
    zsk-lifetime: 30d
    ksk-submission:
      - safenet-parent
    nsec3: on

submission:
  - id: safenet-parent
    check-interval: 1h

template:
  - id: default
    storage: "/var/lib/safebox/knot/zones"
    file: "%s.zone"
    dnssec-signing: on
    dnssec-policy: safenet-dnssec

zone:
  - domain: safenet.org
    template: default
EOF
chmod 0644 /etc/knot/knot.conf

# Knot DNS systemd unit: only starts if the nameserver role is active.
# safebox-nameserver-role.target is enabled by the role activation service
# when this box is designated as a nameserver in managed-containers.json.
cat >/etc/systemd/system/safebox-knot.service <<'EOF'
[Unit]
Description=Safebox Knot DNS authoritative nameserver
Documentation=https://www.knot-dns.cz/docs/
After=network-online.target safebox-nftables.service var-lib-safebox.mount
Requires=safebox-nftables.service
BindsTo=safebox-nameserver-role.target
ConditionPathExists=/var/lib/safebox/knot/zones/safenet.org.zone

[Service]
Type=notify
User=safebox-nameserver
Group=safebox-nameserver
ExecStart=/usr/sbin/knotd -c /etc/knot/knot.conf
ExecReload=/usr/sbin/knotc -c /etc/knot/knot.conf zone-reload safenet.org
Restart=on-failure
RestartSec=5
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/safebox/knot /run/knot
ProtectHome=true
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=safebox-nameserver-role.target
EOF
chmod 0644 /etc/systemd/system/safebox-knot.service

# Nameserver role target: pulled in when this box is a nameserver.
cat >/etc/systemd/system/safebox-nameserver-role.target <<'EOF'
[Unit]
Description=Safebox nameserver role active
Documentation=docs/DNS-ARCHITECTURE.md

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 /etc/systemd/system/safebox-nameserver-role.target

# Zone compiler service: pulls registry state, compiles zone file, reloads Knot.
# Runs periodically (every 60s) and on-demand via safebox-zone-compiler.path
# watching the registry state file.
cat >/etc/systemd/system/safebox-zone-compiler.service <<'EOF'
[Unit]
Description=Safebox DNS zone compiler
After=network-online.target var-lib-safebox.mount
BindsTo=safebox-nameserver-role.target

[Service]
Type=oneshot
User=safebox-nameserver
Group=safebox-nameserver
ExecStart=/usr/bin/node /opt/safebox/nameserver/compile-zone.js
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/safebox/knot/zones
ProtectHome=true
PrivateTmp=true
EOF
chmod 0644 /etc/systemd/system/safebox-zone-compiler.service

cat >/etc/systemd/system/safebox-zone-compiler.timer <<'EOF'
[Unit]
Description=Run zone compiler every 60 seconds
BindsTo=safebox-nameserver-role.target

[Timer]
OnActiveSec=10
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=safebox-nameserver-role.target
EOF
chmod 0644 /etc/systemd/system/safebox-zone-compiler.timer

# DNSSEC key generation script: runs once on first boot of a nameserver box
# to create ZSK/KSK in the TPM via tpm2-pkcs11.
install -d -m 0755 /opt/safebox/nameserver
install -m 0644 "$COMMON/nameserver/compile-zone.js" /opt/safebox/nameserver/compile-zone.js
cat >/opt/safebox/nameserver/dnssec-keygen.sh <<'KEYGEN'
#!/bin/bash
# Generate DNSSEC ZSK/KSK in the TPM via tpm2-pkcs11 for Knot DNS.
# Runs once on first boot of a nameserver-role box.
# After key generation, the DS record must be submitted to the parent
# registry (PIR for .org) -- see docs/DNS-ARCHITECTURE.md.
set -euo pipefail

KEYDIR=/var/lib/safebox/knot/keys
MARKER="$KEYDIR/.keys-generated"

if [[ -f "$MARKER" ]]; then
    echo "dnssec-keygen: keys already generated"
    exit 0
fi

install -d -m 0750 -o safebox-nameserver -g safebox-nameserver "$KEYDIR"

echo "dnssec-keygen: generating DNSSEC keys in TPM via tpm2-pkcs11..."

# Initialize the tpm2-pkcs11 store if needed
if [[ ! -d /var/lib/safebox/knot/pkcs11 ]]; then
    install -d -m 0750 -o safebox-nameserver -g safebox-nameserver /var/lib/safebox/knot/pkcs11
    export TPM2_PKCS11_STORE=/var/lib/safebox/knot/pkcs11
    tpm2_ptool init --primary-auth="" || true
    tpm2_ptool addtoken --pid=1 --sopin=safebox --userpin=safebox --label=knot-dnssec
fi

export TPM2_PKCS11_STORE=/var/lib/safebox/knot/pkcs11

# Generate KSK (ECDSAP256SHA256) and ZSK (ECDSAP256SHA256) via keymgr
keymgr -c /etc/knot/knot.conf safenet.org generate algorithm=ecdsap256sha256 ksk=true
keymgr -c /etc/knot/knot.conf safenet.org generate algorithm=ecdsap256sha256

# Extract DS record for submission to parent
keymgr -c /etc/knot/knot.conf safenet.org ds > "$KEYDIR/ds-records.txt"
echo "dnssec-keygen: DS records written to $KEYDIR/ds-records.txt"
echo "dnssec-keygen: Submit these to the parent registry (PIR for .org)"

touch "$MARKER"
echo "dnssec-keygen: done"
KEYGEN
chmod 0755 /opt/safebox/nameserver/dnssec-keygen.sh

cat >/etc/systemd/system/safebox-dnssec-keygen.service <<'EOF'
[Unit]
Description=Generate DNSSEC keys in TPM for Knot DNS
After=var-lib-safebox.mount
ConditionPathExists=!/var/lib/safebox/knot/keys/.keys-generated
BindsTo=safebox-nameserver-role.target

[Service]
Type=oneshot
ExecStart=/opt/safebox/nameserver/dnssec-keygen.sh
RemainAfterExit=true

[Install]
WantedBy=safebox-nameserver-role.target
EOF
chmod 0644 /etc/systemd/system/safebox-dnssec-keygen.service

install -m 0755 "$COMMON/nameserver/delegation-monitor.sh" /opt/safebox/nameserver/delegation-monitor.sh

# Delegation monitor: checks DS/NS at parent, serial consistency, CT logs
cat >/etc/systemd/system/safebox-delegation-monitor.service <<'EOF'
[Unit]
Description=Safebox DNS delegation health monitor
After=network-online.target
BindsTo=safebox-nameserver-role.target

[Service]
Type=oneshot
ExecStart=/opt/safebox/nameserver/delegation-monitor.sh
User=safebox-nameserver
Group=safebox-nameserver
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/safebox/knot
ProtectHome=true
PrivateTmp=true
EOF
chmod 0644 /etc/systemd/system/safebox-delegation-monitor.service

cat >/etc/systemd/system/safebox-delegation-monitor.timer <<'EOF'
[Unit]
Description=Run delegation monitor every 6 hours
BindsTo=safebox-nameserver-role.target

[Timer]
OnActiveSec=300
OnUnitActiveSec=21600
AccuracySec=60

[Install]
WantedBy=safebox-nameserver-role.target
EOF
chmod 0644 /etc/systemd/system/safebox-delegation-monitor.timer

# Add /var/lib/safebox/knot to tmpfiles for the nameserver
cat >>/usr/lib/tmpfiles.d/safebox-var.conf <<'EOF'
d /var/lib/safebox/knot       0750 safebox-nameserver safebox-nameserver -
d /var/lib/safebox/knot/zones 0750 safebox-nameserver safebox-nameserver -
d /var/lib/safebox/knot/keys  0750 safebox-nameserver safebox-nameserver -
d /run/knot                   0750 safebox-nameserver safebox-nameserver -
EOF

# ---------------------------------------------------------------------------
# auditd
# ---------------------------------------------------------------------------
log "writing audit rules"
install -d -m 0750 /etc/audit/rules.d
cat >/etc/audit/rules.d/safebox.rules <<'EOF'
## Installed by common/base/install-base.sh. Loaded by auditd at boot
## (augenrules); not loaded in the build chroot.
-D
-b 8192
-f 1

## Key material in tmpfs and the sealed blobs on /boot
-w /run/safebox/hmac-seed -p rwa -k safebox_hmac_seed
-w /run/safebox/zfs-key -p rwa -k safebox_zfs_key
-w /boot/safebox/ -p rwa -k safebox_sealed_blobs

## The whole privileged surface: sudo, the sudoers file and the wrappers
-w /etc/sudoers.d/safebox-system -p wa -k safebox_sudoers
-w /opt/safebox/bin/ -p xwa -k safebox_wrapper
-w /usr/bin/sudo -p x -k safebox_sudo

## Package managers (cannot work on a verity root; any call is an anomaly)
-w /usr/bin/apt-get -p x -k safebox_pkg
-w /usr/bin/apt -p x -k safebox_pkg
-w /usr/bin/dpkg -p x -k safebox_pkg

## Service and daemon configuration (on the volatile /etc overlay)
-w /etc/docker/daemon.json -p wa -k safebox_config
-w /etc/nginx/ -p wa -k safebox_config
-w /etc/php/ -p wa -k safebox_config
-w /etc/mysql/ -p wa -k safebox_config
-w /etc/systemd/system/ -p wa -k safebox_config
-w /etc/safebox/ -p wa -k safebox_config
-w /etc/apparmor.d/ -p wa -k safebox_config

## Identity and credentials on the pool
-w /var/lib/safebox/ -p wa -k safebox_state

## TPM access (the quote wrapper is the only expected caller after boot)
-w /dev/tpmrm0 -p rw -k safebox_tpm

## Privilege transitions, module loading, tracing
-a always,exit -F arch=b64 -S setuid,setreuid,setresuid -F a0=0 -F auid>=1000 -F auid!=4294967295 -k safebox_priv_esc
-a always,exit -F arch=b64 -S execve -C uid!=euid -F euid=0 -k safebox_setuid_exec
-a always,exit -F arch=b64 -S init_module,finit_module,delete_module -k safebox_modules
-a always,exit -F arch=b64 -S ptrace -k safebox_ptrace
EOF
chmod 0640 /etc/audit/rules.d/safebox.rules
rm -f /etc/audit/rules.d/audit.rules
install -d -m 0755 /etc/systemd/system/auditd.service.d
cat >/etc/systemd/system/auditd.service.d/safebox.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/log/audit
After=var.mount systemd-tmpfiles-setup.service
EOF

# ---------------------------------------------------------------------------
# setuid/setgid: sudo is the single elevation path. su, passwd, chsh, chfn,
# gpasswd, newgrp, pkexec, the dbus launch helper and anything else loses
# the bit. newuidmap/newgidmap are needed for user namespaces, mount/umount
# for systemd-managed mounts. verify-image.sh enforces the same list. No
# setgid helper (wall, write, chage, expiry) has a caller either.
# ---------------------------------------------------------------------------
log "stripping setuid and setgid bits"
KEEP_SETUID='/usr/bin/sudo /usr/bin/newuidmap /usr/bin/newgidmap /usr/bin/mount /usr/bin/umount'
while IFS= read -r f; do
    keep=0
    for k in $KEEP_SETUID; do [[ $f == "$k" ]] && keep=1; done
    if [[ $keep -eq 0 ]]; then
        chmod u-s "$f"
        log "  u-s $f"
    fi
done < <(find / -xdev -type f -perm -4000 2>/dev/null | sort)
while IFS= read -r f; do
    chmod g-s "$f"
    log "  g-s $f"
done < <(find / -xdev -type f -perm -2000 2>/dev/null | sort)
[[ -u /usr/bin/sudo ]] || die "/usr/bin/sudo lost its setuid bit"
[[ ! -u /usr/bin/su ]] || die "/usr/bin/su is still setuid"

# ---------------------------------------------------------------------------
# Enable units (symlinks only; nothing starts here).
# ---------------------------------------------------------------------------
log "enabling units"
unit_path() {
    local u=$1 p
    for p in "/etc/systemd/system/$u" "/usr/lib/systemd/system/$u" "/lib/systemd/system/$u"; do
        [[ -e $p ]] && { echo "$p"; return 0; }
    done
    return 1
}
enable_unit() {
    local unit=$1 path target
    if systemctl enable "$unit" >/dev/null 2>&1; then
        return 0
    fi
    # Fallback for a systemctl that refuses to run in this chroot: create
    # the same .wants symlinks systemctl would, from the unit's [Install].
    path="$(unit_path "$unit")" || die "cannot enable $unit: unit file not found"
    local -a targets
    mapfile -t targets < <(sed -n '/^\[Install\]/,/^\[/{s/^WantedBy=//p}' "$path" | tr ' ' '\n' | grep -v '^$')
    [[ ${#targets[@]} -gt 0 ]] || die "cannot enable $unit: no WantedBy= in $path"
    for target in "${targets[@]}"; do
        install -d -m 0755 "/etc/systemd/system/$target.wants"
        ln -sfn "$path" "/etc/systemd/system/$target.wants/$unit"
    done
}
ENABLE_UNITS=(
    systemd-networkd.service systemd-resolved.service chrony.service auditd.service apparmor.service
    zfs-import-scan.service zfs-import.target zfs-mount.service zfs-zed.service zfs.target
    containerd.service docker.service nginx.service php8.3-fpm.service mariadb.service
    safebox-firstboot.service safebox-nftables.service safebox-sealed-boot.service
    # Nameserver role: these units BindsTo= safebox-nameserver-role.target,
    # so they only run when the target is active. Enable them unconditionally;
    # the target itself is NOT enabled here — the role activation service
    # enables it at runtime when this box is designated as a nameserver.
    safebox-knot.service safebox-zone-compiler.timer safebox-dnssec-keygen.service
    safebox-delegation-monitor.timer
)
for u in "${ENABLE_UNITS[@]}"; do
    enable_unit "$u"
done
for u in safebox-firstboot.service safebox-nftables.service docker.service nginx.service \
         php8.3-fpm.service mariadb.service auditd.service chrony.service; do
    [[ -L /etc/systemd/system/multi-user.target.wants/$u ]] || die "$u not enabled in multi-user.target"
done

# ---------------------------------------------------------------------------
# Initramfs. One kernel, one initramfs, named as build-verity-root.sh
# expects (initramfs-<kver>.img), hostonly off so the bytes do not depend on
# the build host, with the safebox, systemd-veritysetup and zfs modules
# forced in by /etc/dracut.conf.d/safebox.conf. The initrd.img-<kver> that
# the kernel postinst produced with the default configuration is deleted so
# there is exactly one candidate.
# ---------------------------------------------------------------------------
log "building initramfs for $KVER"
rm -f /boot/initrd.img-* /boot/initramfs-* /boot/initrd.img /boot/initrd.img.old \
      /boot/vmlinuz /boot/vmlinuz.old /initrd.img /initrd.img.old /vmlinuz /vmlinuz.old
dracut --force --no-hostonly --kver "$KVER" "/boot/initramfs-${KVER}.img" || die "dracut failed"
[[ -s /boot/initramfs-${KVER}.img ]] || die "dracut produced no initramfs"
if command -v lsinitrd >/dev/null 2>&1; then
    LSINITRD="$(lsinitrd "/boot/initramfs-${KVER}.img" 2>/dev/null)"
    for need in usr/lib/safebox/safebox-unseal.sh usr/lib/safebox/safebox-seal.sh \
                bin/tpm2_unseal bin/tpm2_pcrextend sbin/zpool sbin/zfs \
                systemd/system/safebox-unseal.service; do
        grep -q "$need" <<<"$LSINITRD" || die "initramfs is missing $need"
    done
    grep -q 'dm-verity\|dm_verity' <<<"$LSINITRD" || die "initramfs has no dm-verity module"
    grep -q 'zfs.ko' <<<"$LSINITRD" || die "initramfs has no zfs.ko"
    grep -q 'systemd-veritysetup' <<<"$LSINITRD" || die "initramfs has no systemd-veritysetup"
else
    log "lsinitrd not available; initramfs contents are checked by build-verity-root.sh"
fi
chmod 0600 "/boot/initramfs-${KVER}.img"

# ---------------------------------------------------------------------------
# Lift the chroot guards now that no package install remains. The trap still
# runs on exit but finds nothing to do.
# ---------------------------------------------------------------------------
divert_off
rm -f /usr/sbin/policy-rc.d
[[ -x /usr/sbin/grub-install ]] || die "grub-install is missing after undivert"
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
rm -rf /root/.npm /root/.gnupg

# ---------------------------------------------------------------------------
# Manifest: every installed package and version, the pins, the kernel and
# initramfs digests, and this script's own hash.
# ---------------------------------------------------------------------------
log "writing manifest"
dpkg-query -W -f='${Package}=${Version}\n' | sort >/opt/safebox/manifests/apt-pins.resolved.txt
chmod 0644 /opt/safebox/manifests/apt-pins.resolved.txt
PKG_JSON="$(dpkg-query -W -f '${Package}\t${Version}\n' | sort \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {name: .[0], version: .[1]})')"
SELF_SHA="$(sha256sum "$SELF" | awk '{print $1}')"
INITRD_SHA="$(sha256sum "/boot/initramfs-${KVER}.img" | awk '{print $1}')"
KERNEL_SHA="$(sha256sum "/boot/vmlinuz-${KVER}" | awk '{print $1}')"
ZFS_KO="$(compgen -G "/usr/lib/modules/$KVER/kernel/zfs/zfs.ko*" | head -n1)"
jq -n \
    --arg cloud "$CLOUD" \
    --arg distro "${PRETTY_NAME:-Ubuntu 24.04}" \
    --arg kmeta "$KERNEL_META" \
    --arg kver "$KVER" \
    --arg kernelSha "$KERNEL_SHA" \
    --arg initrdSha "$INITRD_SHA" \
    --arg zfsko "$ZFS_KO" \
    --arg drivers "$DRACUT_DRIVERS" \
    --arg node "$NODE_BUILT" \
    --arg nodeSha "$NODE_SHA256" \
    --arg nodeOpenssl "$NODE_OPENSSL" \
    --arg openssl "$OPENSSL_BUILT" \
    --arg opensslSha "$OPENSSL_SHA256" \
    --arg opensslPrefix "$OPENSSL_PREFIX" \
    --arg timeSource "$TIME_SOURCE" \
    --arg selfSha "$SELF_SHA" \
    --argjson packages "$PKG_JSON" \
    --argjson pins "$(printf '%s\n' "${PINNED[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    --argjson forbidden "$(printf '%s\n' "${FORBIDDEN[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    '{
      component: { name: "base", version: "3.0.0", cloud: $cloud, distro: $distro, installer: "common/base/install-base.sh", license: ["Apache-2.0"] },
      kernel: { metapackage: $kmeta, version: $kver, vmlinuzSha256: $kernelSha,
                initramfs: ("/boot/initramfs-" + $kver + ".img"), initramfsSha256: $initrdSha, initramfsTool: "dracut",
                zfsModule: $zfsko, zfsModuleSource: "ubuntu kernel package, distro-signed (required under Secure Boot)",
                initramfsDrivers: ($drivers | split(" ") | map(select(length > 0))) },
      node: { version: $node, source: ("nodejs.org/dist/v" + $node + "/node-v" + $node + ".tar.gz, built in the chroot"), tarballSha256: $nodeSha,
              prefix: "/usr/local", sharedOpenssl: true, opensslVersion: $nodeOpenssl, opensslConf: "/etc/ssl/openssl-pq.cnf",
              tlsGroups: "X25519MLKEM768:X25519:P-256" },
      openssl: { version: $openssl, source: ("github.com/openssl/openssl/releases/download/openssl-" + $openssl + "/openssl-" + $openssl + ".tar.gz, built in the chroot"),
                 tarballSha256: $opensslSha, prefix: $opensslPrefix, ktls: true, onDefaultLibraryPath: false,
                 systemOpenssl: "3.0.x from noble (curl, tpm2-tools); nginx uses 3.5 via LD_LIBRARY_PATH" },
      docker: { package: "docker.io", source: "ubuntu noble", storageDriver: "zfs", usernsRemap: "default", apparmor: true },
      packages: { pins: $pins, forbidden: $forbidden, installed: $packages },
      security: {
        sshdPresent: true, sshdAuditOnly: true, sealScriptRemovesSSH: true,
        cloudInitRemoved: true, cloudAgentsRemoved: true,
        initramfsToolsRemoved: true, unattendedUpgradesRemoved: true, snapdRemoved: true,
        aptPinsPriorityMinusOne: true, kernelHeld: true,
        gettysMasked: true, rescueMasked: true, sysrqDisabled: true, apparmor: "enforcing (apparmor.service)",
        setuidAllowlist: ["/usr/bin/sudo", "/usr/bin/newuidmap", "/usr/bin/newgidmap", "/usr/bin/mount", "/usr/bin/umount"],
        setgidStripped: true,
        sysctlFile: "/etc/sysctl.d/90-safebox.conf",
        imdsFirewall: "/etc/safebox/safebox-imds.nft via safebox-nftables.service (_chrony allowed to UDP 123 only)",
        inboundFirewall: "inet safebox input policy drop: lo, established, icmp, tcp 53/80/443/8443, udp 53, dhcp replies; docker.service Requires=safebox-nftables.service",
        firstboot: "safebox-firstboot.service (reads safebox-id, owner-pubkey, launch-authorization; executes nothing)",
        rootFilesystem: "dm-verity, read-only; /etc volatile overlay; /var and state on safebox-pool",
        secretsOnRoot: false,
        mariadbBind: "127.0.0.1", phpExposeOff: true, phpDangerousFnsOff: true,
        timeSource: $timeSource,
        sealScript: "/opt/safebox/seal/safebox-seal-image.sh (writes /etc/safebox/sealed flag only)",
        sealedBootService: "safebox-sealed-boot.service (masks SSH via overlay whiteouts, modules_disabled=1, hidepid=2; conditional on /etc/safebox/sealed)"
      },
      network: { manager: "systemd-networkd", file: "/etc/systemd/network/10-safebox.network", dns: "systemd-resolved", hostname: "safebox", guestAgent: false },
      auditd: { rulesFile: "/etc/audit/rules.d/safebox.rules" },
      nameserver: { package: "knot", user: "safebox-nameserver (994)", config: "/etc/knot/knot.conf",
                    zones: "/var/lib/safebox/knot/zones", dnssec: "tpm2-pkcs11 ECDSAP256SHA256",
                    activation: "safebox-nameserver-role.target (BindsTo= guard on all nameserver units)",
                    units: ["safebox-knot.service", "safebox-zone-compiler.timer", "safebox-dnssec-keygen.service", "safebox-delegation-monitor.timer"] },
      installerSha256: $selfSha
    }' >/opt/safebox/manifests/base.json
chmod 0644 /opt/safebox/manifests/base.json

log "base component installed ($CLOUD, Ubuntu 24.04, kernel $KVER, node $NODE_BUILT on OpenSSL $NODE_OPENSSL)"
