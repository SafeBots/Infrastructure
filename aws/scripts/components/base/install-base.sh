#!/bin/bash
#
# Install Base Component
# Includes: MariaDB, PHP-FPM, nginx, Docker, Node.js, ZFS, 50+ npm packages
#
# Pre-release 1.0.0 — hardened for production launch
#
# This script is reproducible. All system packages are version-pinned,
# all npm packages are installed from a lockfile, and all ZFS datasets
# have explicit keyformat/keylocation so the build can be unattended.
#

set -euo pipefail

echo "Installing base component..."

# ── Required directories ─────────────────────────────────────────────────────
# FIX (Infrastructure Bug 1): create /opt/safebox and /opt/safebox/manifests
# BEFORE anything else tries to write into them. The previous version did
# `cd /opt/safebox` and `cat > /opt/safebox/manifests/base.json` without
# creating either path, so the script failed on a clean install.
mkdir -p /opt/safebox
mkdir -p /opt/safebox/manifests
mkdir -p /opt/safebox/lib
mkdir -p /srv/safebox/runtimes/system
chmod 0755 /opt/safebox /opt/safebox/manifests /opt/safebox/lib
chmod 0750 /srv/safebox/runtimes/system

# ── ZFS pool prerequisite check ──────────────────────────────────────────────
# FIX (Infrastructure Bug 2): the script previously assumed safebox-pool
# existed. On a clean AMI build there is no pool yet. Fail fast with a
# clear message if the pool is missing rather than producing a confusing
# "dataset does not exist" error mid-script.
if ! zpool list safebox-pool >/dev/null 2>&1; then
    echo "ERROR: ZFS pool 'safebox-pool' not found."
    echo ""
    echo "Create the pool before running this installer, e.g.:"
    echo "  zpool create -o ashift=12 -O compression=lz4 -O atime=off \\"
    echo "    safebox-pool /dev/nvme1n1"
    echo ""
    echo "The pool device must be an EBS volume distinct from the root volume."
    echo "See docs/STORAGE-SETUP.md for full pool-creation procedure."
    exit 1
fi

# ── System package installation (pinned versions) ────────────────────────────
# FIX (Infrastructure Bug 3): pin all system package versions for reproducible
# builds. `dnf install -y <pkg>` without a version pulls whatever the mirror
# currently serves, making AMI builds non-reproducible and exposing the build
# to silent upstream changes.
#
# Versions chosen as of May 13, 2026. Update by:
#   1. Running `dnf list available <pkg> | grep <pkg>` on a target mirror
#   2. Updating these pins
#   3. Rebuilding the AMI and verifying SHA256 matches expected
PKG_VERSIONS_FILE="${PKG_VERSIONS_FILE:-/srv/safebox/runtimes/system/package-versions/system.txt}"
mkdir -p "$(dirname "$PKG_VERSIONS_FILE")"

# These pins match the SHA256 manifest cascaded into the AMI attestation.
# If the upstream package changes (e.g. CVE patch), bump the version here
# AND update package-versions/system.txt with the new SHA256.
SYSTEM_PACKAGES=(
    "mariadb105-server-10.5.24"
    "php-fpm-8.3.6"
    "nginx-1.26.2"
    "docker-ce-25.0.5"
    "nodejs-20.18.0"      # FIX (Infrastructure Bug 6): pinned Node.js
    "npm-10.8.2"
    "zfs-2.2.6"
    "iptables-1.8.10"
    "auditd-3.1.5"
    "fail2ban-1.0.2"
)

dnf install -y "${SYSTEM_PACKAGES[@]}"

# Verify all packages are at the pinned versions
for pkg_pinned in "${SYSTEM_PACKAGES[@]}"; do
    pkg_name="${pkg_pinned%-*}"
    pkg_ver="${pkg_pinned##*-}"
    installed_ver=$(rpm -q --queryformat '%{VERSION}' "$pkg_name" 2>/dev/null || echo "MISSING")
    if [[ "$installed_ver" != "$pkg_ver"* ]]; then
        echo "ERROR: ${pkg_name} version mismatch — wanted $pkg_ver, got $installed_ver"
        echo "Cannot proceed with non-reproducible package state."
        exit 1
    fi
done

# ── No-shell-access policy: remove ALL remote-access daemons ─────────────────
# FIX (Infrastructure Bug 5): the SECURITY-HARDENING.md doc claimed telnetd
# was removed via finalize-ami3.sh, but that script isn't in the repo. Without
# this removal, the AMI ships with telnetd present (Amazon Linux base image
# includes the `telnet` client at minimum; some base images include the
# server). But the deeper problem the prior version missed: SSH, the SSM
# Session Manager agent, and any other interactive-shell mechanism ALL
# defeat the attestation model.
#
# The attestation guarantee is: "this is the exact code that booted." It
# says NOTHING about what privileged users can do AFTER boot. The moment
# anyone gets a shell — via SSH, SSM Session Manager, EC2 Serial Console,
# or any other channel — they can:
#   - dd /dev/sda > exfil.img  (read the unencrypted boot partition)
#   - cat /run/safebox/zfs-key (steal the ZFS key from RAM)
#   - nsenter into a container or kexec a new kernel
#   - patch a binary in memory and the next attestation cycle still passes
#     because the on-disk image is unchanged
#
# So we remove ALL of them. The model is: no human is ever inside the box.
# If something goes wrong, terminate the instance and snapshot the encrypted
# ZFS volume for offline forensic analysis. Don't fix in place. The boot
# cycle is the only legitimate change mechanism, and the boot cycle is
# attested by TPM.
#
# CVE-2026-32746 (the telnetd RCE) is one motivator, but the policy is
# broader than any specific CVE: zero interactive access by design.

echo "Removing ALL remote-access and interactive-shell mechanisms..."

# Tier 1: legacy remote-access daemons (CVE-2026-32746 family)
dnf remove -y \
    telnet telnet-server \
    rsh rsh-server rlogin \
    vsftpd proftpd \
    tftp tftp-server \
    cockpit cockpit-ws cockpit-bridge \
    webmin \
    || true  # OK if any aren't installed

# Tier 2: SSH — yes, even SSH. An attested Safebox should not be SSH-able.
# Most ops teams will push back on this. The right response is: you should
# not be operating an attested system if you need to log in to it. If a
# service breaks, the instance is terminated and replaced from an attested
# image. Diagnostics happen against an offline ZFS snapshot, not a live shell.
dnf remove -y \
    openssh-server openssh-clients openssh \
    || true

# Tier 3: AWS SSM Session Manager agent. The SSM agent IS a remote-shell
# mechanism — it accepts shell sessions from anyone with the appropriate
# IAM permission. From the kernel's perspective there's no difference between
# SSH and SSM; both spawn /bin/bash for an authenticated remote user.
#
# Removing this means:
#   - You CANNOT use `aws ssm start-session` to reach the instance.
#   - You CANNOT use `aws ssm send-command` to push commands.
#   - You CAN still attach IAM roles for AWS API access (S3, KMS, etc.) —
#     those go through the instance metadata service, not the SSM agent.
#
# If you need AWS API access from inside the instance (which is reasonable),
# the IAM role attachment on the instance metadata endpoint is the right
# path. The SSM AGENT is what we're removing, not the IAM-role mechanism.
dnf remove -y \
    amazon-ssm-agent \
    || true

# Tier 4: any package providing a getty on a TTY/serial console.
# Without these, even physical console access (which on AWS means EC2
# Serial Console) cannot get a login prompt. The Serial Console itself
# is configured at the AWS account level, separately — operators who want
# to be sure no one can reach the box even via Serial Console should
# disable that account-wide in AWS.
systemctl mask getty@.service          2>/dev/null || true
systemctl mask serial-getty@ttyS0.service 2>/dev/null || true
systemctl mask debug-shell.service     2>/dev/null || true

# Mask socket units for tiers 1-3 to prevent reactivation if a future
# package update pulls them back in
for unit in \
    telnet.socket rsh.socket vsftpd.service cockpit.socket cockpit.service \
    sshd.service sshd.socket ssh.service ssh.socket \
    amazon-ssm-agent.service \
; do
    systemctl mask "$unit" 2>/dev/null || true
done

# Verify telnetd is gone
if command -v telnetd &>/dev/null || rpm -q telnet-server &>/dev/null 2>&1; then
    echo "ERROR: telnetd is still present after removal attempt."
    echo "Cannot ship an AMI exposed to CVE-2026-32746."
    exit 1
fi

# Verify SSH is gone
if command -v sshd &>/dev/null || rpm -q openssh-server &>/dev/null 2>&1; then
    echo "ERROR: sshd is still present after removal attempt."
    echo "An attested Safebox must have zero remote-shell access."
    exit 1
fi

# Verify SSM agent is gone
if rpm -q amazon-ssm-agent &>/dev/null 2>&1; then
    echo "ERROR: amazon-ssm-agent is still present after removal attempt."
    echo "SSM Session Manager defeats attestation — its agent must be uninstalled."
    exit 1
fi

# Verify no process is listening on common remote-shell ports.
# (Some packages register listeners via socket activation; if any of those
# survived masking, this is where it shows up.)
for port in 22 23 513 514 5985 5986; do
    if ss -tnl 2>/dev/null | awk '{print $4}' | grep -q ":${port}$"; then
        echo "ERROR: a service is listening on port $port after hardening."
        echo "Cannot ship an AMI with active remote-shell ports."
        ss -tnlp 2>/dev/null | grep ":${port}"
        exit 1
    fi
done

echo "Confirmed: telnetd, sshd, ssm-agent, and TTY logins removed."
echo "  - No interactive shell access (SSH, SSM, console getty)."
echo "  - AWS API access via IAM-role instance metadata still works."
echo "  - For diagnostics, terminate the instance and analyze the ZFS snapshot offline."

# ── ZFS dataset creation (with proper encryption setup) ──────────────────────
# FIX (Infrastructure Bug 1): `encryption=on` without keyformat/keylocation
# either fails the install OR falls back to interactive prompt mode that
# breaks unattended builds. Pin the key derivation to a TPM-sealed file
# so the build is fully automated AND keys are bound to the platform
# (PCR-sealed via /opt/safebox/lib/tpm-seal-key.sh).
ZFS_KEYFILE="/run/safebox/zfs-key"
if [[ ! -f "$ZFS_KEYFILE" ]]; then
    mkdir -p /run/safebox
    chmod 0700 /run/safebox
    # Generate 32-byte key. In a real build, this is generated by
    # generate-attested-key.sh which seals it to TPM PCRs. Here we
    # only require it to exist before this script runs.
    echo "ERROR: ZFS keyfile not found at $ZFS_KEYFILE"
    echo "Run scripts/generate-attested-key.sh before install-base.sh"
    exit 1
fi
# Ensure key has correct permissions before ZFS uses it
chmod 0400 "$ZFS_KEYFILE"

# Create each dataset with EXPLICIT keyformat, keylocation, and MOUNTPOINT.
# encryption=aes-256-gcm is FIPS-friendly and faster than the
# default aes-256-ccm on modern x86_64 with AES-NI.
#
# MOUNTPOINTS ARE LOAD-BEARING. `zfs create safebox-pool/mariadb` with no
# mountpoint mounts at /safebox-pool/mariadb — but everything that writes data
# uses /safebox/... (the compose bind mounts) or /var/lib/docker. Those paths
# would then be plain directories on the ROOT volume, silently OUTSIDE the
# encrypted datasets: the aes-256-gcm/TPM encryption would be bypassed while
# appearing to work, and the MariaDB dataset tuning below would apply to a
# dataset nothing writes to. Set the mountpoint explicitly, always.
#
#   safebox  -> /safebox          (nginx, models, php, typesense, ... subdirs)
#   mariadb  -> /safebox/mariadb  (nested; own recordsize/primarycache tuning)
#   tenants  -> /safebox/tenants
#   docker   -> /var/lib/docker   (matches storage-opts zfs.fsname below)
dataset_mountpoint() {
    case "$1" in
        safebox) echo /safebox ;;
        mariadb) echo /safebox/mariadb ;;
        tenants) echo /safebox/tenants ;;
        docker)  echo /var/lib/docker ;;
        *)       echo "/safebox/$1" ;;
    esac
}

for dataset in safebox docker mariadb tenants; do
    mp="$(dataset_mountpoint "$dataset")"
    if zfs list "safebox-pool/$dataset" >/dev/null 2>&1; then
        # Pre-existing dataset (idempotent re-run, or one created before this
        # fix landed at the wrong default mountpoint). Correct the mountpoint
        # rather than skipping — a dataset mounted at /safebox-pool/... is the
        # bug this block exists to prevent.
        current_mp="$(zfs get -H -o value mountpoint "safebox-pool/$dataset")"
        if [[ "$current_mp" != "$mp" ]]; then
            echo "Dataset safebox-pool/$dataset mounted at $current_mp; correcting to $mp"
            zfs set mountpoint="$mp" "safebox-pool/$dataset"
        else
            echo "Dataset safebox-pool/$dataset already exists at $mp, skipping."
        fi
        continue
    fi
    zfs create \
        -o compression=lz4 \
        -o atime=off \
        -o encryption=aes-256-gcm \
        -o keyformat=raw \
        -o keylocation=file://"$ZFS_KEYFILE" \
        -o mountpoint="$mp" \
        "safebox-pool/$dataset"
done

# Verify every dataset actually landed where we asked. A silent mountpoint
# mismatch means data written to that path is NOT on the encrypted dataset,
# which is exactly the failure this guards against — so fail the install.
for dataset in safebox docker mariadb tenants; do
    want="$(dataset_mountpoint "$dataset")"
    got="$(zfs get -H -o value mountpoint "safebox-pool/$dataset")"
    if [[ "$got" != "$want" ]]; then
        echo "ERROR: safebox-pool/$dataset mountpoint is '$got', expected '$want'." >&2
        echo "       Data written to $want would land on the unencrypted root volume." >&2
        exit 1
    fi
done

# ── Bind-mount directory structure ───────────────────────────────────────────
# Every path docker-compose bind-mounts must EXIST before the stack starts.
# Docker silently creates a missing bind-mount source as an empty directory on
# whatever filesystem backs it — which, if /safebox weren't a mounted dataset,
# would be the unencrypted root volume. Creating them here, after the datasets
# are mounted, guarantees they land on the encrypted datasets.
#
# Kept in sync with docker/docker-compose.yml. If you add a bind mount there,
# add the directory here.
for d in \
    /safebox/chromium/downloads \
    /safebox/ffmpeg/output \
    /safebox/ffmpeg/temp \
    /safebox/mariadb/conf \
    /safebox/mariadb/data \
    /safebox/models/deepseek-r1 \
    /safebox/nginx/conf.d \
    /safebox/nginx/logs \
    /safebox/nginx/ssl \
    /safebox/nginx/www \
    /safebox/node/cache \
    /safebox/php/sessions \
    /safebox/system-api/state \
    /safebox/typesense/data \
; do
    install -d -m 0755 "$d"
done
# TLS material and the DB are not world-readable.
chmod 0710 /safebox/nginx/ssl
chmod 0700 /safebox/mariadb/data

# Confirm the structure really is on the pool and not on /. If /safebox is not
# a ZFS mount, everything above just created directories on the root volume and
# the encryption story is void — fail rather than ship that silently.
safebox_fstype="$(stat -f -c %T /safebox 2>/dev/null || echo unknown)"
if [[ "$safebox_fstype" != "zfs" ]]; then
    echo "ERROR: /safebox is not a ZFS mount (stat reports '$safebox_fstype')." >&2
    echo "       Container data would land unencrypted on the root volume." >&2
    exit 1
fi

# ── MariaDB dataset tuning (InnoDB ⇄ ZFS alignment) ──────────────────────────
# InnoDB writes fixed 16 KiB pages. With the pool-default 128 KiB recordsize,
# every 16 KiB InnoDB write becomes a 128 KiB read-modify-write on ZFS — 8×
# write amplification. Setting recordsize=16k on the MariaDB dataset makes one
# InnoDB page equal one ZFS record. Child datasets (per-tenant, per-project)
# INHERIT this, so tenant .ibd files get the aligned recordsize automatically.
#
# primarycache=metadata: InnoDB's own buffer pool already caches data pages in
# RAM. Letting the ZFS ARC also cache the same data pages double-buffers —
# the same bytes cached twice, halving effective RAM. We tell ARC to cache
# only metadata and let InnoDB own data-page caching. (Size the InnoDB buffer
# pool per instance in the my.cnf below.)
#
# logbias=throughput: InnoDB's own redo log + O_DIRECT flushing already gives
# durability; we don't want ZFS routing these large sequential writes through
# the ZIL as if they were latency-sensitive small syncs.
#
# These are set AFTER creation (not -o at create) so the settings are explicit
# and visible here rather than buried in the shared loop. Idempotent: re-running
# `zfs set` on an existing value is a no-op.
#
# Compression: lz4 by default (fast, low CPU, good on the repetitive
# publisherId/streamName row shape). Operators with heavy row repetition and
# CPU headroom can set MARIADB_COMPRESSION=zstd (or zstd-3, zstd-6, …) for a
# meaningfully better ratio on structured rows. zstd is native to OpenZFS
# (merged 2020) — no app-layer compression needed; ZFS compresses each page
# transparently BELOW MariaDB and ABOVE the encryption layer, which is the only
# order where both compression and encryption work (encrypted bytes don't
# compress). Child datasets inherit whatever is set here.
MARIADB_COMPRESSION="${MARIADB_COMPRESSION:-lz4}"
case "$MARIADB_COMPRESSION" in
    lz4|zstd|zstd-[0-9]|zstd-1[0-9]|gzip|gzip-[0-9]|off) : ;;
    *) echo "WARN: unrecognized MARIADB_COMPRESSION='$MARIADB_COMPRESSION', falling back to lz4" >&2
       MARIADB_COMPRESSION="lz4" ;;
esac
if zfs list safebox-pool/mariadb >/dev/null 2>&1; then
    zfs set compression="$MARIADB_COMPRESSION" safebox-pool/mariadb
    zfs set recordsize=16k        safebox-pool/mariadb
    zfs set primarycache=metadata safebox-pool/mariadb
    zfs set logbias=throughput    safebox-pool/mariadb
    echo "[install-base] MariaDB dataset: compression=$MARIADB_COMPRESSION recordsize=16k primarycache=metadata"
fi

# ── MariaDB server configuration (InnoDB file-per-table + ZFS-safe flushing) ──
# The architecture depends on innodb_file_per_table so each table's tablespace
# is its own .ibd file, individually snapshot/clone-able via ZFS. 10.5 defaults
# this ON, but we set it explicitly so the invariant is auditable and survives
# a future default change. O_DIRECT stops InnoDB from ALSO going through the OS
# page cache (the ZFS side of the double-buffer fix above). The flush/sync
# settings make FLUSH TABLES WITH READ LOCK snapshots clean rather than merely
# crash-consistent, which is what the cross-Safebox ZFS-send ship path wants.
install -d -m 0755 /etc/my.cnf.d
cat > /etc/my.cnf.d/safebox.cnf <<'MYCNF'
# Managed by Safebox install-base.sh — do not edit by hand.
# InnoDB ⇄ ZFS tuning. See SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md.
[mysqld]
datadir = /srv/mariadb/data

# One tablespace file per table — required for per-table ZFS dataset isolation
# and for the snapshot/clone-as-workspace model.
innodb_file_per_table = 1

# InnoDB page size equals the ZFS recordsize=16k set on safebox-pool/mariadb.
innodb_page_size = 16k

# O_DIRECT: don't double-cache InnoDB data pages in the OS/ZFS ARC — InnoDB's
# buffer pool owns data caching; ARC is set to metadata-only on this dataset.
innodb_flush_method = O_DIRECT

# Clean, consistent on-disk state for FLUSH TABLES WITH READ LOCK snapshots
# (the ZFS-send replication path relies on this rather than SQL replication).
innodb_flush_log_at_trx_commit = 1
sync_binlog = 1

# ZFS already checksums and (optionally) has redundancy; InnoDB's own
# doublewrite buffer is redundant on top of that and just adds writes.
innodb_doublewrite = 0

# Size per instance. Rule of thumb: ~50-70% of RAM on a dedicated DB box,
# but LOWER here because ARC also needs headroom — see STORAGE-SETUP.md.
# innodb_buffer_pool_size = 16G

max_connections   = 500
thread_cache_size = 50
MYCNF
chmod 0644 /etc/my.cnf.d/safebox.cnf

# The tuning above must reach whichever MariaDB actually runs, and right now the
# repo ships BOTH a host package (mariadb105-server) and a container
# (mariadb:10.11) — see inconsistencies.md F3. They read different paths:
#
#   host MariaDB      reads /etc/my.cnf.d/*.cnf
#   container MariaDB reads /etc/mysql/conf.d/*.cnf, bind-mounted from
#                           /safebox/mariadb/conf
#
# Installing to only /etc/my.cnf.d left the tuning INERT for the container that
# actually serves. Install to both from the same source until F3 collapses the
# duplication; then delete the branch that loses.
install -d -m 0755 /safebox/mariadb/conf
install -m 0644 /etc/my.cnf.d/safebox.cnf /safebox/mariadb/conf/safebox.cnf

# Deploy the clean-snapshot helper (FLUSH TABLES WITH READ LOCK → zfs snapshot).
# Lives alongside the Safebox binaries; invoked by operators / the backup path
# to produce clean (not merely crash-consistent) MariaDB snapshots for the
# cross-Safebox zfs-send ship path.
install -d -m 0755 /opt/safebox/bin
if [ -f "$(dirname "$0")/helpers/flush-and-snapshot.sh" ]; then
    install -m 0755 "$(dirname "$0")/helpers/flush-and-snapshot.sh" \
        /opt/safebox/bin/flush-and-snapshot.sh
fi

# Set ZFS quotas (operator-configurable, see docs/STORAGE-SETUP.md)
zfs set quota=20G safebox-pool/safebox  || true  # Binaries + models
zfs set quota=100G safebox-pool/docker  || true  # Container images
# mariadb and tenants are intentionally unquota'd at pool level; per-tenant
# datasets get their own quotas in install-system.sh

# ── npm package installation (from lockfile, not latest) ─────────────────────
# FIX (Infrastructure Bug 3): the previous version ran `npm install --production
# <packages>` which pulls the LATEST version of each. This made the build
# vulnerable to supply chain attacks (e.g. TanStack/Mini Shai-Hulud, May 2025)
# and made the build non-reproducible.
#
# Now: install from a checked-in package-lock.json that pins exact versions
# AND integrity hashes. `npm ci` verifies all SHA-512 integrity hashes
# before unpacking ANY package. If any package's tarball doesn't match
# its locked hash, npm refuses to install — supply chain attack mitigated.
cd /opt/safebox

# Copy the locked manifest (shipped as part of the Infrastructure repo)
SAFEBOX_NPM_DIR="${SAFEBOX_NPM_DIR:-/opt/safebox-base-npm}"
if [[ ! -f "$SAFEBOX_NPM_DIR/package.json" ]] || [[ ! -f "$SAFEBOX_NPM_DIR/package-lock.json" ]]; then
    echo "ERROR: npm lockfile not found at $SAFEBOX_NPM_DIR/package-lock.json"
    echo "The Infrastructure repo must ship a package.json + package-lock.json"
    echo "for the base npm packages. See scripts/components/base/package*.json."
    exit 1
fi
cp "$SAFEBOX_NPM_DIR/package.json"      /opt/safebox/package.json
cp "$SAFEBOX_NPM_DIR/package-lock.json" /opt/safebox/package-lock.json

# npm ci installs ONLY what is in package-lock.json, verifies every integrity
# hash, and FAILS if any package's tarball doesn't match. Refuses to fall
# back to fetching new versions even if lockfile is "outdated".
# --ignore-scripts: prevents lifecycle scripts from running during install
#   (these were the vector for the TanStack attack — postinstall hooks
#   modified .claude/settings.json and .vscode/tasks.json on dev machines).
#   For server-side packages we don't need lifecycle scripts; if a specific
#   package genuinely needs one we can re-enable per-package later.
npm ci --production --ignore-scripts

# Show what got installed, for the attestation log
npm ls --production --depth=0 > /opt/safebox/manifests/base-npm.txt

# ── Docker daemon hardening ──────────────────────────────────────────────────
# FIX (Infrastructure Bug 7): Docker installed with defaults means containers
# run as root and have access to the host user namespace. Configure userns
# remapping so containers get host UIDs starting at 100000, isolating them
# from real users.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'DOCKERJSON'
{
    "userns-remap": "default",
    "live-restore": true,
    "log-driver": "json-file",
    "log-opts": {
        "max-size": "100m",
        "max-file": "5"
    },
    "default-ulimits": {
        "nofile": { "Name": "nofile", "Hard": 64000, "Soft": 64000 }
    },
    "no-new-privileges": true,
    "icc": false,
    "storage-driver": "zfs",
    "storage-opts": [
        "zfs.fsname=safebox-pool/docker"
    ]
}
DOCKERJSON
# Create the dockremap user/group required by userns-remap=default
getent group dockremap >/dev/null 2>&1 || groupadd -r dockremap
getent passwd dockremap >/dev/null 2>&1 || useradd -r -g dockremap -s /sbin/nologin dockremap

# ── PHP-FPM hardening ────────────────────────────────────────────────────────
# FIX (Infrastructure Bug 8): default php-fpm config exposes PHP version in
# headers (Server: PHP/8.3.6) and runs as apache. Harden minimally — full
# pool config goes in install-system.sh.
PHP_INI="/etc/php.ini"
if [[ -f "$PHP_INI" ]]; then
    sed -i 's/^expose_php = On/expose_php = Off/' "$PHP_INI" || true
    sed -i 's/^;allow_url_include = Off/allow_url_include = Off/' "$PHP_INI" || true
    sed -i 's/^allow_url_fopen = On/allow_url_fopen = Off/'      "$PHP_INI" || true
    # Disable dangerous PHP functions at the base layer. Plugin-specific
    # exceptions go in their own .ini files.
    cat >> "$PHP_INI" << 'PHPINI'

; FIX (Infrastructure Bug 8): disable functions never needed in plugin code.
; Plugins that need exec()/shell_exec() should run in their own systemd unit
; with their own PHP config, not via web requests.
disable_functions = exec,passthru,shell_exec,system,proc_open,popen,curl_multi_exec,parse_ini_file,show_source,dl,phpinfo
PHPINI
fi

# ── auditd config ────────────────────────────────────────────────────────────
# Enable auditing for ZFS key access, package installs, and privileged ops.
# This complements the cryptographically-sealed append-only logs that the
# system component writes to /srv/safebox/logs/system/.
cat > /etc/audit/rules.d/safebox.rules << 'AUDITRULES'
## ZFS key access
-w /run/safebox/zfs-key -p rwa -k safebox_zfs_key

## Package manager invocations (defense in depth alongside SHA256 pinning)
-w /usr/bin/dnf -p x -k safebox_pkg
-w /usr/bin/rpm -p x -k safebox_pkg
-w /usr/local/bin/npm -p x -k safebox_pkg
-w /usr/local/bin/composer -p x -k safebox_pkg

## Sensitive config files
-w /etc/docker/daemon.json -p wa -k safebox_config
-w /etc/php.ini -p wa -k safebox_config
-w /etc/nginx/ -p wa -k safebox_config

## Privilege escalation attempts
-a always,exit -F arch=b64 -S setuid -F a0=0 -F auid>=1000 -F auid!=4294967295 -k safebox_priv_esc
AUDITRULES
augenrules --load 2>/dev/null || true

# ── Generate component manifest ──────────────────────────────────────────────
# Includes versions, license info, and a placeholder for the cascading
# SHA256 that the parent build pipeline computes after install completes.
cat > /opt/safebox/manifests/base.json << EOF
{
    "component": {
        "name":    "base",
        "version": "1.0.0-pre",
        "license": ["Apache-2.0", "MIT"],
        "disk":    "8 GB"
    },
    "packages": {
        "system": $(printf '"%s",' "${SYSTEM_PACKAGES[@]}" | sed 's/,$//' | awk '{print "["$0"]"}'),
        "npmLockSha256": "$(sha256sum /opt/safebox/package-lock.json | awk '{print $1}')"
    },
    "security": {
        "telnetdRemoved":     true,
        "sshdRemoved":        true,
        "ssmAgentRemoved":    true,
        "ttyLoginsDisabled":  true,
        "cve_2026_32746":     "mitigated",
        "shellAccessPolicy":  "zero-interactive-access",
        "dockerUsernsRemap":  true,
        "phpExposeOff":       true,
        "phpDangerousFnsOff": true,
        "zfsKeyfile":         "/run/safebox/zfs-key",
        "zfsEncryption":      "aes-256-gcm"
    },
    "auditd": {
        "rulesFile": "/etc/audit/rules.d/safebox.rules",
        "keys":      ["safebox_zfs_key", "safebox_pkg", "safebox_config", "safebox_priv_esc"]
    }
}
EOF

# Set perms on the manifests dir so the system component can read it
chmod 0644 /opt/safebox/manifests/base.json

echo "✅ Base component installed (1.0.0-pre)"
echo ""
echo "Next steps:"
echo "  - Run install-system.sh to enable the Safebox host API on Unix sockets at /run/safebox/"
echo "  - Verify the cascade SHA256 attestation with scripts/verify-build.sh"
