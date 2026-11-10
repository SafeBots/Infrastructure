#!/usr/bin/env bash
# verify-image.sh [--audit] <rootfs-dir> - pre-capture assertions
# (HARDENING-PLAN.md fix 10, build flow step 3). Runs on the build host
# against the chroot and exits 1 at the first failed assertion with
# "verify-image: FAIL: <reason>". On success prints "verify-image: OK" and
# writes an inventory to <rootfs-dir>/../manifests/image-inventory.json so
# the manifest chain records exactly what the captured image contained.
#
# Two modes (matches the two-AMI workflow):
#   --audit     Audit AMI: SSH and safebox-audit user MUST be present,
#               sealed flag must NOT exist. Used before the first capture.
#   (default)   Production AMI: SSH must be gone, safebox-audit removed,
#               sealed flag present. Used after safebox-seal-image.sh.
#
# Uses only what a build host has: bash, find, awk, stat, sha256sum, and
# python3 for JSON assembly when present (a printf fallback otherwise).

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

fail() { printf 'verify-image: FAIL: %s\n' "$*" >&2; exit 1; }
log()  { printf 'verify-image: %s\n' "$*" >&2; }

AUDIT_MODE=""
args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --audit) AUDIT_MODE=1; shift ;;
        *)       args+=("$1"); shift ;;
    esac
done
[[ ${#args[@]} -eq 1 ]] || fail "usage: verify-image.sh [--audit] <rootfs-dir>"
R=$(readlink -f "${args[0]}") || fail "cannot resolve ${args[0]}"
[[ $R != "/" ]] || fail "refusing to operate on /"
[[ -f $R/etc/passwd && -f $R/etc/shadow && -f $R/etc/group ]] || fail "$R is not a root filesystem"

if [[ -n $AUDIT_MODE ]]; then
    log "running in AUDIT mode (SSH and safebox-audit expected)"
fi

# ---------------------------------------------------------------------------
# Package inventory. Prefer querying the chroot's own database with the
# host's tool pointed at it (no chroot needed); fall back to chroot.
# ---------------------------------------------------------------------------
PKG_LIST=$(mktemp)
trap 'rm -f "$PKG_LIST"' EXIT
if [[ -d $R/var/lib/rpm ]]; then
    PKG_FORMAT=rpm
    if command -v rpm >/dev/null; then
        rpm --root "$R" -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\n' | sort >"$PKG_LIST"
    else
        chroot "$R" rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}.%{ARCH}\n' | sort >"$PKG_LIST"
    fi
elif [[ -f $R/var/lib/dpkg/status ]]; then
    PKG_FORMAT=dpkg
    if command -v dpkg-query >/dev/null; then
        dpkg-query --admindir="$R/var/lib/dpkg" -W -f '${Package}\t${Version}\n' | sort >"$PKG_LIST"
    else
        # shellcheck disable=SC2016  # dpkg format string, not shell
        chroot "$R" dpkg-query -W -f '${Package}\t${Version}\n' | sort >"$PKG_LIST"
    fi
else
    fail "no rpm or dpkg database in $R"
fi
[[ -s $PKG_LIST ]] || fail "package list is empty"

pkg_installed() { awk -F'\t' -v p="$1" '$1 == p {found=1} END {exit !found}' "$PKG_LIST"; }

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
log "checking forbidden packages"
# SSH packages are forbidden only in the production (sealed) image.
# In audit mode they must be present.
SSH_PKGS='openssh-server openssh-clients openssh-client openssh-sftp-server ssh'
FORBIDDEN_PKGS='cloud-init cloud-guest-utils cloud-initramfs-growroot
amazon-ssm-agent ec2-instance-connect ec2-hibinit-agent
google-guest-agent google-osconfig-agent google-compute-engine
google-compute-engine-oslogin gce-disk-expand walinuxagent hyperv-daemons
oracle-cloud-agent oci-utils nm-cloud-setup snapd
unattended-upgrades ubuntu-advantage-tools ubuntu-pro-client motd-news-config
initramfs-tools initramfs-tools-core ksplice uptrack
dnf-automatic fail2ban cockpit cockpit-ws telnetd telnet-server rsh-server vsftpd
tftpd-hpa tftp-server xinetd'
if [[ -z $AUDIT_MODE ]]; then
    # Production mode: SSH is forbidden.
    FORBIDDEN_PKGS="$SSH_PKGS $FORBIDDEN_PKGS"
fi
for p in $FORBIDDEN_PKGS; do
    pkg_installed "$p" && fail "forbidden package installed: $p"
done
# Pattern families (linux-cloud-tools-*, cockpit*): any match is a failure.
family=$(awk -F'\t' '$1 ~ /^linux-cloud-tools-/ || $1 ~ /^cockpit/ { print $1 }' "$PKG_LIST" | tr '\n' ' ')
[[ -z $family ]] || fail "forbidden package installed: $family"

if [[ -n $AUDIT_MODE ]]; then
    # Audit mode: SSH must be present, hardened, and the safebox-audit user
    # must exist with a real shell.
    [[ -x $R/usr/sbin/sshd ]] || fail "/usr/sbin/sshd missing (required for audit AMI)"
    [[ -f $R/etc/ssh/sshd_config.d/safebox-audit.conf ]] || fail "safebox-audit.conf SSH hardening config missing"
    grep -q '^PermitRootLogin no$' "$R/etc/ssh/sshd_config.d/safebox-audit.conf" \
        || fail "SSH PermitRootLogin is not 'no'"
    grep -q '^PasswordAuthentication no$' "$R/etc/ssh/sshd_config.d/safebox-audit.conf" \
        || fail "SSH PasswordAuthentication is not 'no'"
    grep -q '^AllowUsers safebox-audit$' "$R/etc/ssh/sshd_config.d/safebox-audit.conf" \
        || fail "SSH AllowUsers does not restrict to safebox-audit"
    # No baked-in host keys (regenerated on first boot).
    compgen -G "$R/etc/ssh/ssh_host_*" >/dev/null && fail "SSH host keys baked into audit AMI (must regenerate on boot)"
else
    # Production mode: no SSH at all.
    [[ ! -e $R/usr/sbin/sshd ]] || fail "/usr/sbin/sshd present"
fi
[[ ! -e $R/usr/sbin/update-initramfs ]] || fail "/usr/sbin/update-initramfs present (initramfs-tools)"
[[ ! -e $R/etc/cloud ]] || fail "/etc/cloud present"
[[ ! -e $R/var/lib/cloud ]] || fail "/var/lib/cloud present"

if [[ $PKG_FORMAT == dpkg ]]; then
    log "checking apt sources"
    # The only apt source in the image is /etc/apt/sources.list as written
    # by the base installer: noble pockets, main and universe, any mirror.
    # Nothing may sit in sources.list.d (the NodeSource repository used for
    # Node 22 goes there and is removed by the installer; a leftover would
    # be a third-party source the box could be pointed at).
    extra=$(find "$R/etc/apt/sources.list.d" -mindepth 1 -type f 2>/dev/null | tr '\n' ' ')
    [[ -z $extra ]] || fail "files in /etc/apt/sources.list.d: $extra"
    [[ -f $R/etc/apt/sources.list ]] || fail "/etc/apt/sources.list missing"
    bad=$(grep -Ev '^\s*(#|$)' "$R/etc/apt/sources.list" \
        | grep -Ev '^deb\s+\S+\s+noble(-updates|-security)?\s+main\s+universe\s*$' || true)
    [[ -z $bad ]] || fail "unexpected apt source line(s): $bad"
    grep -Eiq 'nodesource' "$R/etc/apt/sources.list" && fail "NodeSource in sources.list"
    [[ ! -e $R/etc/apt/keyrings/nodesource.gpg ]] || fail "NodeSource keyring still present"
    compgen -G "$R/var/lib/apt/lists/*nodesource*" >/dev/null && fail "NodeSource apt lists still present"
    # Node is built from source against OpenSSL 3.5 (fix 11); noble's nodejs
    # package must not be on the image, nor the compilers used for the build.
    pkg_installed nodejs && fail "noble's nodejs package installed; node must be the /usr/local build"
    for p in gcc g++ cpp make build-essential dpkg-dev libc6-dev; do
        pkg_installed "$p" && fail "build package $p installed; compilers must not ship in the image"
    done
    pkg_installed python3 || fail "python3 not installed (safebox-confidential-report needs it)"
    pkg_installed apparmor || fail "apparmor not installed"
    pkg_installed chrony || fail "chrony not installed"
    pkg_installed systemd-resolved || fail "systemd-resolved not installed"
    pkg_installed zfsutils-linux || fail "zfsutils-linux not installed"
    pkg_installed zfs-dkms && fail "zfs-dkms installed: a DKMS zfs.ko is unsigned and will not load under Secure Boot"
    pkg_installed dkms && fail "dkms installed: unsigned modules are not allowed on a Secure Boot image"

    log "checking kernel and signed zfs module"
    # Exactly one kernel, and its ZFS module comes from the distro kernel
    # package (signed with the kernel's key), not from updates/dkms.
    mapfile -t kvers < <(find "$R/usr/lib/modules" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)
    [[ ${#kvers[@]} -eq 1 ]] || fail "expected exactly one kernel in /usr/lib/modules, found: ${kvers[*]:-none}"
    kver=${kvers[0]}
    [[ -f $R/boot/vmlinuz-$kver ]] || fail "/boot/vmlinuz-$kver missing"
    [[ -s $R/boot/initramfs-$kver.img ]] || fail "/boot/initramfs-$kver.img missing"
    compgen -G "$R/usr/lib/modules/$kver/kernel/zfs/zfs.ko*" >/dev/null \
        || fail "no distro-signed zfs.ko under /usr/lib/modules/$kver/kernel/zfs (required under Secure Boot)"
    [[ ! -d $R/usr/lib/modules/$kver/updates/dkms ]] || fail "/usr/lib/modules/$kver/updates/dkms present (unsigned modules)"
    [[ ! -d $R/usr/lib/modules/$kver/extra ]] || fail "/usr/lib/modules/$kver/extra present (out-of-tree modules)"

    log "checking service accounts"
    grep -q '^_chrony:' "$R/etc/passwd" || fail "_chrony user missing (safebox-imds.nft refers to it)"
    grep -q '^dockremap:' "$R/etc/passwd" || fail "dockremap user missing"
    grep -q '^dockremap:100000:65536$' "$R/etc/subuid" 2>/dev/null || fail "dockremap subuid range missing or not 100000:65536"
    grep -q '^dockremap:100000:65536$' "$R/etc/subgid" 2>/dev/null || fail "dockremap subgid range missing or not 100000:65536"
    [[ -f $R/etc/docker/daemon.json ]] || fail "/etc/docker/daemon.json missing"
    grep -q '"userns-remap":"default"\|"userns-remap": "default"' "$R/etc/docker/daemon.json" || fail "docker userns-remap not default"
    grep -q '^safebox-app-ns:[^:]*:100991:' "$R/etc/group" || fail "safebox-app-ns group missing or not gid 100991"
    ! grep -E '^safebox-app-ns:[^:]*:100991:.*\bsafebox-infra\b' "$R/etc/group" >/dev/null || fail "safebox-infra is in safebox-app-ns (it would read every tenant's key)"
    for w in safebox-container safebox-test-run; do
        ! grep -q -- '--userns=host' "$R/opt/safebox/bin/$w" 2>/dev/null || fail "$w passes --userns=host (userns remap must stay on)"
    done
fi

log "checking accounts"
while IFS=: read -r name hash _; do
    # In audit mode, safebox-audit is allowed to have a locked-but-valid
    # shadow entry (passwd -l prepends '!' but the field is non-empty).
    # All accounts must still be locked.
    case $hash in
        '!'|'!!'|'*'|'!*') ;;
        *) fail "shadow entry not locked: $name" ;;
    esac
done <"$R/etc/shadow"

while IFS=: read -r name _ _ _ _ _ shell; do
    if [[ -n $AUDIT_MODE && $name == safebox-audit ]]; then
        # safebox-audit needs a real shell for SSH access.
        case $shell in
            /bin/bash|/bin/sh) ;;
            *) fail "safebox-audit shell must be /bin/bash or /bin/sh, got: $shell" ;;
        esac
    else
        case $shell in
            /usr/sbin/nologin|/sbin/nologin|/bin/false|/usr/bin/false) ;;
            *) fail "login shell for $name: $shell" ;;
        esac
    fi
done <"$R/etc/passwd"

if [[ -n $AUDIT_MODE ]]; then
    # safebox-audit must exist with uid 1100 and a home directory.
    grep -q '^safebox-audit:' "$R/etc/passwd" || fail "safebox-audit user missing (required for audit AMI)"
    audit_uid=$(awk -F: '$1 == "safebox-audit" { print $3 }' "$R/etc/passwd")
    [[ $audit_uid == 1100 ]] || fail "safebox-audit uid is $audit_uid, expected 1100"
    [[ -d $R/home/safebox-audit ]] || fail "/home/safebox-audit missing"
    [[ -d $R/home/safebox-audit/.ssh ]] || fail "/home/safebox-audit/.ssh missing"
    [[ -f $R/home/safebox-audit/.ssh/authorized_keys ]] || fail "safebox-audit authorized_keys missing"
    # /home should contain ONLY safebox-audit.
    extra_home=$(find "$R/home" -mindepth 1 -maxdepth 1 ! -name safebox-audit 2>/dev/null | wc -l)
    [[ $extra_home -eq 0 ]] || fail "/home has entries other than safebox-audit ($extra_home extra)"
else
    # Production mode: safebox-audit must NOT exist.
    ! grep -q '^safebox-audit:' "$R/etc/passwd" 2>/dev/null || fail "safebox-audit user present in production image"
    if [[ -d $R/home ]]; then
        n=$(find "$R/home" -mindepth 1 | wc -l)
        [[ $n -eq 0 ]] || fail "/home is not empty ($n entries)"
    fi
    compgen -G "$R/etc/ssh/ssh_host_*" >/dev/null && fail "SSH host keys present"
fi
[[ ! -e $R/root/.ssh ]] || fail "/root/.ssh present"
[[ ! -e $R/root/.bash_history ]] || fail "/root/.bash_history present"

# safebox-infra must exist (uid 990) and must not be in docker.
grep -q '^safebox-infra:x:990:' "$R/etc/passwd" || fail "safebox-infra missing or not uid 990"
if docker_line=$(grep '^docker:' "$R/etc/group"); then
    members=${docker_line##*:}
    case ",$members," in
        *,safebox-infra,*) fail "safebox-infra is in the docker group" ;;
        *,safebox-dns,*) fail "safebox-dns is in the docker group" ;;
    esac
fi
# safebox-dns (uid 992): dnsclient's own uid, with no groups beyond its own
# so it shares no files with safebox-infra (the HMAC key holder).
grep -q '^safebox-dns:x:992:992:' "$R/etc/passwd" || fail "safebox-dns missing or not uid/gid 992"
grep -q '^safebox-dns:x:992:' "$R/etc/group" || fail "safebox-dns group missing or not gid 992"
! grep -E '^[^:]+:[^:]*:[0-9]+:.*\bsafebox-dns\b' "$R/etc/group" | grep -v '^safebox-dns:' | grep -q . \
    || fail "safebox-dns is a member of a supplementary group: $(grep -E '\bsafebox-dns\b' "$R/etc/group" | grep -v '^safebox-dns:' | cut -d: -f1 | tr '\n' ' ')"
grep -q '^User=safebox-dns$' "$R/etc/systemd/system/safebox-dnsclient.service" 2>/dev/null \
    || fail "safebox-dnsclient.service does not run as safebox-dns"
# Per-tenant isolation (docs/HARDENING-PLAN.md, "Per-tenant isolation"):
# the seed goes to safebox-keyd alone; the operator and tenant instances of
# the system component carry no LoadCredential= and never read the seed.
grep -q '^LoadCredential=hmac-seed:/run/safebox/hmac-seed$' "$R/etc/systemd/system/safebox-keyd.service" 2>/dev/null \
    || fail "safebox-keyd.service lacks LoadCredential=hmac-seed:/run/safebox/hmac-seed"
for u in safebox-system.service safebox-system@.service safebox-dnsclient.service safebox-autovhost.service safebox-users.service; do
    f="$R/etc/systemd/system/$u"
    [[ -f $f ]] || continue
    ! grep -q 'LoadCredential=hmac-seed' "$f" || fail "$u carries LoadCredential=hmac-seed; only safebox-keyd may"
    ! grep -q 'hmac-seed' "$f" || fail "$u refers to /run/safebox/hmac-seed"
done
[[ -f $R/etc/systemd/system/safebox-system@.service ]] || fail "safebox-system@.service (tenant instance template) missing"
grep -q '^User=safebox-sys-%i$' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service does not run as safebox-sys-%i"
grep -q '^Group=safebox-sys$' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service group is not safebox-sys"
grep -q '^Environment=SAFEBOX_TENANT=%i$' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service does not set SAFEBOX_TENANT=%i"
grep -Eq '^ReadWritePaths=.*/var/lib/safebox/tenants/%i' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service ReadWritePaths is not tenant-scoped"
! grep -Eq '^ReadWritePaths=.*(/var/lib/safebox |/var/lib/safebox$)' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service may write all of /var/lib/safebox"
! grep -Eq '^SupplementaryGroups=.*\b(docker|safebox-infra|safebox-sys)\b' "$R/etc/systemd/system/safebox-system@.service" || fail "safebox-system@.service has a forbidden supplementary group"
grep -q '^User=safebox-infra$' "$R/etc/systemd/system/safebox-system.service" || fail "safebox-system.service (operator) does not run as safebox-infra"
! grep -Eq '^SupplementaryGroups=.*\b(docker|safebox-sys|safebox-app-ns)\b' "$R/etc/systemd/system/safebox-system.service" || fail "safebox-system.service (operator) has a supplementary group that reaches tenant keys"
grep -q '^User=root$' "$R/etc/systemd/system/safebox-keyd.service" || fail "safebox-keyd.service does not run as root"
for u in safebox-keyd safebox-users; do
    [[ -f $R/etc/systemd/system/$u.service ]] || fail "$u.service missing"
    [[ -L $R/etc/systemd/system/multi-user.target.wants/$u.service ]] || fail "$u.service not enabled"
done
[[ -f $R/opt/safebox/keyd/safebox-keyd.js ]] || fail "/opt/safebox/keyd/safebox-keyd.js missing"
[[ -x $R/opt/safebox/keyd/safebox-users.sh ]] || fail "/opt/safebox/keyd/safebox-users.sh missing or not executable"
grep -q '^safebox-sys:x:993:' "$R/etc/group" || fail "safebox-sys group missing or not gid 993"
! grep -E '^safebox-sys:x:993:.*\bsafebox-infra\b' "$R/etc/group" >/dev/null || fail "safebox-infra is in safebox-sys"
! grep -Eq '^safebox-sys-' "$R/etc/passwd" || fail "a tenant instance user is baked into the image (they are created at boot)"

log "checking sudoers"
[[ -d $R/etc/sudoers.d ]] || fail "/etc/sudoers.d missing"
extra=$(find "$R/etc/sudoers.d" -mindepth 1 ! -name safebox-system)
[[ -z $extra ]] || fail "unexpected entries in sudoers.d: $(echo "$extra" | tr '\n' ' ')"
[[ -f $R/etc/sudoers.d/safebox-system ]] || fail "sudoers.d/safebox-system missing"
mode=$(stat -c '%a %U' "$R/etc/sudoers.d/safebox-system")
[[ $mode == "440 root" ]] || fail "sudoers.d/safebox-system is $mode, want 440 root"
if command -v visudo >/dev/null; then
    visudo -cf "$R/etc/sudoers.d/safebox-system" >/dev/null || fail "visudo rejects sudoers.d/safebox-system"
elif [[ -x $R/usr/sbin/visudo ]]; then
    chroot "$R" visudo -cf /etc/sudoers.d/safebox-system >/dev/null || fail "visudo rejects sudoers.d/safebox-system"
else
    fail "no visudo available to check sudoers"
fi
grep -Eq '^\s*[^#]*\*' "$R/etc/sudoers.d/safebox-system" && fail "sudoers.d/safebox-system contains a wildcard"
grep -Eq '^%safebox-sys\s+ALL=\(root\)\s+NOPASSWD:\s+SAFEBOX_TENANT_WRAPPERS' "$R/etc/sudoers.d/safebox-system" \
    || fail "sudoers.d/safebox-system does not grant the tenant wrappers to %safebox-sys"
grep -Eq '^safebox-infra\s+ALL=\(root\)\s+NOPASSWD:\s+SAFEBOX_OPERATOR_WRAPPERS' "$R/etc/sudoers.d/safebox-system" \
    || fail "sudoers.d/safebox-system does not grant the operator wrappers to safebox-infra"
! grep -Eq '^safebox-infra\s+.*SAFEBOX_TENANT_WRAPPERS' "$R/etc/sudoers.d/safebox-system" \
    || fail "sudoers.d/safebox-system grants the tenant wrappers to safebox-infra"
for w in safebox-test-run safebox-test-stop safebox-test-logs safebox-zfs safebox-container; do
    grep -q 'caller_tenant\|require_operator' "$R/opt/safebox/bin/$w" 2>/dev/null || fail "wrapper $w does not derive the caller from SUDO_UID"
    grep -q '^\. /opt/safebox/bin/safebox-caller.sh$' "$R/opt/safebox/bin/$w" 2>/dev/null || fail "wrapper $w does not source safebox-caller.sh"
done
[[ -f $R/opt/safebox/bin/safebox-caller.sh ]] || fail "/opt/safebox/bin/safebox-caller.sh missing"
[[ $(stat -c '%a %U' "$R/opt/safebox/bin/safebox-caller.sh") == "644 root" ]] || fail "safebox-caller.sh must be 644 root (sourced, never executed)"
! grep -q 'safebox-caller.sh' "$R/etc/sudoers.d/safebox-system" || fail "safebox-caller.sh is listed in sudoers"

log "checking post-quantum TLS build (fix 11)"
for b in gcc cc g++ c++ make; do
    [[ ! -e $R/usr/bin/$b ]] || fail "/usr/bin/$b present; compilers must not ship in the image"
done
[[ -x $R/usr/local/bin/node ]] || fail "/usr/local/bin/node missing (Node must be built from source against OpenSSL 3.5)"
[[ -L $R/usr/bin/node && $(readlink "$R/usr/bin/node") == /usr/local/bin/node ]] \
    || fail "/usr/bin/node is not a symlink to /usr/local/bin/node"
[[ -x $R/usr/local/openssl-3.5/bin/openssl ]] || fail "/usr/local/openssl-3.5/bin/openssl missing"
compgen -G "$R/usr/local/openssl-3.5/lib/libssl.so.3*" >/dev/null || fail "OpenSSL 3.5 libssl.so.3 missing"
[[ ! -e $R/etc/ld.so.conf.d/openssl-3.5.conf ]] || fail "OpenSSL 3.5 is on the default library path; only node (rpath) may use it"
[[ -f $R/etc/ssl/openssl-pq.cnf ]] || fail "/etc/ssl/openssl-pq.cnf missing"
grep -Eq '^Groups = X25519MLKEM768:X25519:P-256$' "$R/etc/ssl/openssl-pq.cnf" \
    || fail "openssl-pq.cnf does not prefer X25519MLKEM768"
grep -Eq '^OPENSSL_CONF=/etc/ssl/openssl-pq.cnf$' "$R/etc/environment" \
    || fail "/etc/environment does not set OPENSSL_CONF=/etc/ssl/openssl-pq.cnf"
for u in safebox-system safebox-dnsclient safebox-autovhost; do
    f="$R/etc/systemd/system/$u.service"
    [[ -f $f ]] || continue
    grep -Eq '^Environment=OPENSSL_CONF=/etc/ssl/openssl-pq.cnf$' "$f" \
        || fail "$u.service does not set Environment=OPENSSL_CONF=/etc/ssl/openssl-pq.cnf"
done
if command -v chroot >/dev/null && [[ $(id -u) -eq 0 ]]; then
    node_ssl=$(chroot "$R" /usr/local/bin/node -e 'process.stdout.write(process.versions.openssl)' 2>/dev/null || true)
    [[ $node_ssl == 3.5.* ]] || fail "node reports OpenSSL '${node_ssl:-?}', expected 3.5.x"
    chroot "$R" /usr/local/openssl-3.5/bin/openssl list -kem-algorithms 2>/dev/null | grep -qi mlkem768 \
        || fail "OpenSSL 3.5 in the image has no ML-KEM-768"
else
    log "note: not root or no chroot; skipping the in-image node/openssl version probe"
fi

log "checking wrappers"
for w in safebox-test-run safebox-test-stop safebox-test-logs safebox-zfs safebox-container safebox-tpm-quote safebox-confidential-report safebox-nginx-reload safebox-instance safebox-keyd-reload; do
    f="$R/opt/safebox/bin/$w"
    [[ -f $f ]] || fail "wrapper missing: $f"
    m=$(stat -c '%a %U' "$f")
    [[ $m == "755 root" ]] || fail "wrapper $w is $m, want 755 root"
    [[ ! -L $f ]] || fail "wrapper $w is a symlink"
done

log "checking masked units"
MASKED_UNITS='getty@.service serial-getty@.service console-getty.service debug-shell.service rescue.service emergency.service'
if [[ -z $AUDIT_MODE ]]; then
    # Production mode: SSH units must also be masked (seal script does this).
    MASKED_UNITS="$MASKED_UNITS ssh.service ssh.socket sshd.service"
fi
for u in $MASKED_UNITS; do
    l="$R/etc/systemd/system/$u"
    [[ -L $l ]] || fail "unit not masked: $u"
    [[ $(readlink "$l") == /dev/null ]] || fail "unit not masked to /dev/null: $u"
done

log "checking initramfs hooks"
[[ -d $R/usr/lib/dracut/modules.d/90safebox ]] || fail "dracut module 90safebox missing"
[[ -f $R/etc/dracut.conf.d/safebox.conf ]] || fail "/etc/dracut.conf.d/safebox.conf missing"

log "checking sysctl"
sysctl_has() {
    # Last occurrence across sysctl.d wins at runtime; require the value to
    # appear and no later file to override it with something else.
    local key=$1 want=$2 found=""
    local f
    while IFS= read -r f; do
        v=$(awk -F= -v k="$key" '$0 !~ /^[[:space:]]*#/ { gsub(/[[:space:]]/, "", $1); if ($1 == k) { gsub(/[[:space:]]/, "", $2); print $2 } }' "$f" | tail -n1)
        [[ -n $v ]] && found=$v
    done < <(find "$R/etc/sysctl.d" -maxdepth 1 -name '*.conf' 2>/dev/null | sort)
    [[ $found == "$want" ]]
}
sysctl_has kernel.sysrq 0 || fail "sysctl kernel.sysrq = 0 not set"
sysctl_has kernel.kptr_restrict 2 || fail "sysctl kernel.kptr_restrict = 2 not set"

log "checking setuid binaries"
# su is removed from the allowlist deliberately: with every account locked
# and no login path, su has no legitimate caller and is only an escalation
# target. sudo is the single elevation path. newuidmap/newgidmap are needed
# for rootless user namespaces; mount/umount for systemd-managed mounts.
SETUID_ALLOW='/usr/bin/sudo /usr/bin/newuidmap /usr/bin/newgidmap /usr/bin/mount /usr/bin/umount /bin/mount /bin/umount'
offenders=""
while IFS= read -r f; do
    rel=${f#"$R"}
    ok=0
    for a in $SETUID_ALLOW; do [[ $rel == "$a" ]] && ok=1; done
    [[ $ok -eq 1 ]] || offenders="$offenders $rel"
done < <(find "$R" -xdev -type f -perm -4000 2>/dev/null | sort)
[[ -z $offenders ]] || fail "setuid binaries outside allowlist:$offenders"
[[ ! -u $R/usr/bin/su ]] || fail "/usr/bin/su is setuid"

log "checking sealed state"
if [[ -n $AUDIT_MODE ]]; then
    [[ ! -f $R/etc/safebox/sealed ]] || fail "/etc/safebox/sealed present in audit AMI (must not be sealed yet)"
    # The seal script must be installed so auditors can inspect it.
    [[ -x $R/opt/safebox/bin/safebox-seal-image.sh ]] || fail "seal script missing from audit AMI"
else
    [[ -f $R/etc/safebox/sealed ]] || fail "/etc/safebox/sealed missing from production image"
fi

log "checking GRUB"
if [[ -f $R/etc/default/grub ]]; then
    grep -Eq '^GRUB_TIMEOUT=0$' "$R/etc/default/grub" || fail "GRUB_TIMEOUT is not 0"
    grep -Eq '^GRUB_DISABLE_RECOVERY="?true"?$' "$R/etc/default/grub" || fail "GRUB_DISABLE_RECOVERY not true"
fi

# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------
log "writing inventory"
MANIFEST_DIR=$(dirname "$R")/manifests
mkdir -p "$MANIFEST_DIR"
OUT="$MANIFEST_DIR/image-inventory.json"

ENABLED=$(mktemp); MASKED=$(mktemp)
trap 'rm -f "$PKG_LIST" "$ENABLED" "$MASKED"' EXIT
if ! chroot "$R" systemctl list-unit-files --state=enabled --no-legend 2>/dev/null | awk '{print $1}' | sort >"$ENABLED" \
   || [[ ! -s $ENABLED ]]; then
    # systemctl refuses to run without a booted systemd; scan the .wants dirs.
    find "$R/etc/systemd/system" -path '*.wants/*' -type l -printf '%f\n' 2>/dev/null | sort -u >"$ENABLED"
fi
find "$R/etc/systemd/system" -maxdepth 1 -type l -lname /dev/null -printf '%f\n' 2>/dev/null | sort >"$MASKED"

GRUB_TMPL_SHA=""
for cand in "$R/etc/safebox/grub.cfg.tmpl" "$R/usr/lib/safebox/grub.cfg.tmpl" "$R/boot/grub2/grub.cfg" "$R/boot/grub/grub.cfg"; do
    if [[ -f $cand ]]; then
        GRUB_TMPL_SHA=$(sha256sum "$cand" | awk '{print $1}')
        GRUB_TMPL_PATH=${cand#"$R"}
        break
    fi
done

if command -v python3 >/dev/null; then
    python3 -I - "$R" "$PKG_FORMAT" "$PKG_LIST" "$ENABLED" "$MASKED" "${GRUB_TMPL_PATH:-}" "$GRUB_TMPL_SHA" "$OUT" <<'PY'
import json, sys, time
R, fmt, pkgs, enabled, masked, grub_path, grub_sha, out = sys.argv[1:9]
def lines(p):
    with open(p) as f:
        return [l.rstrip("\n") for l in f if l.strip()]
packages = [dict(zip(("name", "version"), l.split("\t", 1))) for l in lines(pkgs)]
users = []
with open(R + "/etc/passwd") as f:
    for l in f:
        p = l.rstrip("\n").split(":")
        if len(p) >= 7:
            users.append({"name": p[0], "uid": int(p[2]), "gid": int(p[3]), "home": p[5], "shell": p[6]})
inv = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "packageFormat": fmt,
    "packageCount": len(packages),
    "packages": packages,
    "users": users,
    "shells": sorted({u["shell"] for u in users}),
    "enabledUnits": lines(enabled),
    "maskedUnits": lines(masked),
    "grubConfig": {"path": grub_path, "sha256": grub_sha} if grub_sha else None,
}
with open(out, "w") as f:
    json.dump(inv, f, indent=2, sort_keys=True)
    f.write("\n")
PY
else
    # printf fallback: fields here are package names, unit names and passwd
    # fields, none of which may legally contain a double quote or backslash,
    # but escape them anyway.
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    arr_from_file() { # one JSON string per line
        local first=1 l
        printf '['
        while IFS= read -r l; do
            [[ -n $l ]] || continue
            [[ $first -eq 1 ]] || printf ','
            first=0
            printf '"%s"' "$(esc "$l")"
        done <"$1"
        printf ']'
    }
    {
        printf '{"generatedAt":"%s","packageFormat":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PKG_FORMAT"
        printf '"packages":['
        first=1
        while IFS=$'\t' read -r n v; do
            [[ $first -eq 1 ]] || printf ','
            first=0
            printf '{"name":"%s","version":"%s"}' "$(esc "$n")" "$(esc "$v")"
        done <"$PKG_LIST"
        printf '],"users":['
        first=1
        while IFS=: read -r n _ uid gid _ home shell; do
            [[ $first -eq 1 ]] || printf ','
            first=0
            printf '{"name":"%s","uid":%s,"gid":%s,"home":"%s","shell":"%s"}' \
                "$(esc "$n")" "$uid" "$gid" "$(esc "$home")" "$(esc "$shell")"
        done <"$R/etc/passwd"
        printf '],"shells":%s' "$(awk -F: '{print $7}' "$R/etc/passwd" | sort -u | arr_from_file /dev/stdin)"
        printf ',"enabledUnits":%s' "$(arr_from_file "$ENABLED")"
        printf ',"maskedUnits":%s' "$(arr_from_file "$MASKED")"
        if [[ -n $GRUB_TMPL_SHA ]]; then
            printf ',"grubConfig":{"path":"%s","sha256":"%s"}' "$(esc "${GRUB_TMPL_PATH:-}")" "$GRUB_TMPL_SHA"
        else
            printf ',"grubConfig":null'
        fi
        printf '}\n'
    } >"$OUT"
fi
log "inventory written to $OUT"

printf 'verify-image: OK\n'
