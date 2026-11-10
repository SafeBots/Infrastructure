#!/bin/bash
#
# Install System Component — Safebox Infrastructure host API (AWS)
#
# Chroot-safe: runs inside the image build chroot (docs/HARDENING-PLAN.md,
# "Build flow" step 2). It installs files, writes static configuration and
# enables units. It never starts a service, never reloads systemd, never
# touches the TPM, never talks to the metadata service and never runs zpool.
# Everything that needs the running box happens at first boot.
#
# Installs:
#   - /opt/safebox/system/            the Node sources + attestationClient.js
#   - /opt/safebox/bin/               root-owned sudo wrappers (common/sudo/bin)
#   - /etc/sudoers.d/safebox-system   from common/sudo/safebox-system (visudo -cf)
#   - /etc/systemd/system/safebox-system.service      the operator instance
#   - /etc/systemd/system/safebox-system@.service     one tenant instance per
#                                                     managed container
#   - /etc/systemd/system/safebox-keyd.service        the key daemon (holds
#                                                     the HMAC master)
#   - /etc/systemd/system/safebox-users.service       per-boot tenant users
#   - /opt/safebox/keyd/                              keyd and the users script
#                                                     (common/keyd)
#   - /usr/lib/safebox/managed-containers.seed.json
#       copied to /var/lib/safebox/managed-containers.json by the unit's
#       ExecStartPre at FIRST BOOT; /var/lib/safebox is on the pool and does
#       not exist at build time.
#   - users: safebox-infra (uid/gid 990), safebox-app (uid/gid 991); group
#     safebox-sys (gid 993) for the per-tenant instance users, which are
#     created at boot (safebox-users) because /etc is a tmpfs overlay
#
# Runtime state (not created here): /var/lib/safebox (pool), /run/safebox
# (initramfs), per-container keys inside /srv/safebox/tenants/<name>/.
# The per-module state directories under /var/lib/safebox (containers/,
# transparency/, volumes/, succession/, governance/) are created by the
# unit's ExecStartPre at first boot. /etc/safebox holds only static files
# written here at build time; /etc is a tmpfs overlay at runtime.
#
# AWS: NitroTPM at /dev/tpmrm0 (nitroTpmClient.js). The enclave-only /dev/nsm
# client is gone.

set -euo pipefail

echo "Installing system component (AWS)..."

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-system.sh must run as root" >&2
    exit 1
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v node   >/dev/null || { echo "ERROR: node >=20 required"; exit 1; }
command -v npm    >/dev/null || { echo "ERROR: npm required";       exit 1; }
command -v visudo >/dev/null || { echo "ERROR: visudo required";    exit 1; }
command -v sudo   >/dev/null || { echo "ERROR: sudo required";      exit 1; }
node -e 'if (parseInt(process.versions.node) < 20) { console.error("node >=20 required"); process.exit(1); }'

# ── Source locations ─────────────────────────────────────────────────────────
# The build bind-mounts the repository at /opt/safebox-src and chroots. The
# canonical system component sources live in aws/scripts/components/system
# on every cloud; only the attestation client differs.
HERE="$(dirname "$(readlink -f "$0")")"
REPO_ROOT=""
for candidate in "${SAFEBOX_SRC:-}" "${SAFEBOX_REPO_ROOT:-}" /opt/safebox-src "$HERE/../../../.."; do
    [[ -n "$candidate" && -f "$candidate/common/sudo/safebox-system" ]] && { REPO_ROOT="$(cd "$candidate" && pwd)"; break; }
done
[[ -n "$REPO_ROOT" ]] || { echo "ERROR: cannot locate repository root (common/sudo/safebox-system not found)"; exit 1; }

SRC_DIR="${SAFEBOX_SRC_DIR:-$REPO_ROOT/aws/scripts/components/system}"
[[ -f "$SRC_DIR/server.js" ]] || SRC_DIR="/opt/safebox-src/system"
[[ -f "$SRC_DIR/server.js" ]] || { echo "ERROR: cannot find system component source dir"; exit 1; }
ATTESTATION_CLIENT="$SRC_DIR/nitroTpmClient.js"
[[ -f "$ATTESTATION_CLIENT" ]] || { echo "ERROR: attestation client missing: $ATTESTATION_CLIENT"; exit 1; }
TPM_QUOTE="$REPO_ROOT/common/attestation/tpmQuote.js"
[[ -f "$TPM_QUOTE" ]] || { echo "ERROR: $TPM_QUOTE missing"; exit 1; }
SUDOERS_SRC="$REPO_ROOT/common/sudo/safebox-system"
WRAPPERS_SRC="$REPO_ROOT/common/sudo/bin"

# ── Users and groups (fixed ids; the initramfs chowns the seed to 990) ──────
NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
getent group  safebox-infra >/dev/null || groupadd --system --gid 990 safebox-infra
getent group  safebox-app   >/dev/null || groupadd --system --gid 991 safebox-app
getent passwd safebox-infra >/dev/null || useradd --system --uid 990 --gid 990 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox system component runtime user" safebox-infra
getent passwd safebox-app   >/dev/null || useradd --system --uid 991 --gid 991 \
    --no-create-home --home-dir /var/empty --shell "$NOLOGIN" \
    --comment "Safebox tenant container app user" safebox-app
[[ "$(id -u safebox-infra)" == 990 ]] || { echo "ERROR: safebox-infra must be uid 990"; exit 1; }
[[ "$(id -u safebox-app)"   == 991 ]] || { echo "ERROR: safebox-app must be uid 991";   exit 1; }
# Membership in safebox-app lets the system component group-own the key it
# writes into a tenant workspace. It is deliberately NOT in docker (root-equivalent).
usermod -aG safebox-app safebox-infra
# safebox-sys (gid 993): the primary group of every tenant instance user
# (safebox-sys-<name>, uid 20000..29999, created each boot by safebox-users)
# and the identity sudoers grants the tenant-side wrappers to. install-base.sh
# creates it too; the two must stay identical. safebox-infra is NOT a member.
getent group safebox-sys >/dev/null || groupadd --system --gid 993 safebox-sys
[[ "$(getent group safebox-sys | cut -d: -f3)" == 993 ]] || { echo "ERROR: safebox-sys must be gid 993"; exit 1; }
if id -nG safebox-infra | tr ' ' '\n' | grep -qx safebox-sys; then
    gpasswd -d safebox-infra safebox-sys
fi
# safebox-app-ns (gid 100991 = dockremap base + 991) is the host gid the
# container's app user maps to under userns-remap; created by install-base.sh.
# The tenant instances get it through SupplementaryGroups= in their unit.
# The operator (safebox-infra) must NOT be a member: the per-container key
# files are group-readable by that gid.
if getent group safebox-app-ns >/dev/null && id -nG safebox-infra | tr ' ' '\n' | grep -qx safebox-app-ns; then
    gpasswd -d safebox-infra safebox-app-ns >/dev/null
fi
if id -nG safebox-infra | tr ' ' '\n' | grep -qx docker; then
    gpasswd -d safebox-infra docker
fi

# ── Directories ──────────────────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox
install -d -m 0755 -o root -g root /opt/safebox/system
install -d -m 0755 -o root -g root /opt/safebox/bin
install -d -m 0755 -o root -g root /opt/safebox/manifests
install -d -m 0755 -o root -g root /usr/lib/safebox
install -d -m 0755 -o root -g root /etc/safebox
# Mountpoints for the pool datasets (empty directories in the image).
install -d -m 0755 -o root -g root /srv/safebox
install -d -m 0755 -o root -g root /srv/safebox/tenants
install -d -m 0755 -o root -g root /srv/zfs-clones
# Mountpoint for dataset safebox-pool/models (fstab), referenced by the unit
# (RequiresMountsFor, ReadWritePaths) and written by opsModels.js; it must
# exist in the hashed tree or the mount and the unit's namespace setup fail.
install -d -m 0755 -o root -g root /srv/safebox/models
install -d -m 0755 -o root -g root /var/lib/safebox

# ── System component source files ────────────────────────────────────────────
# Every top-level module in the canonical tree, so a new require() in
# server.js cannot be missed by a hand-maintained list. Tests are excluded.
for f in "$SRC_DIR"/*.js; do
    base="$(basename "$f")"
    case "$base" in
        test*.js|nitroTpmClient.js) continue ;;
    esac
    install -m 0644 -o root -g root "$f" "/opt/safebox/system/$base"
done
for f in package.json package-lock.json; do
    [[ -f "$SRC_DIR/$f" ]] || { echo "ERROR: $SRC_DIR/$f missing (run 'npm install --package-lock-only' in the source dir before the image build)"; exit 1; }
    install -m 0644 -o root -g root "$SRC_DIR/$f" "/opt/safebox/system/$f"
done
# Attestation: the shared TPM quote module plus this cloud's client, installed
# under the fixed name every consumer requires. A real copy, not a symlink.
install -m 0644 -o root -g root "$TPM_QUOTE" /opt/safebox/system/tpmQuote.js
install -m 0644 -o root -g root "$ATTESTATION_CLIENT" /opt/safebox/system/attestationClient.js
rm -f /opt/safebox/system/nsmClient.js

# ── npm ci: deterministic install of pinned dependencies ─────────────────────
# Uses the lockfile only. The --onnxruntime-node-install-cuda=skip flag stops
# onnxruntime-node's post-install from fetching a ~500MB CUDA tarball that the
# CPU-only image does not want. node_modules is readable by safebox-infra.
echo "Running npm ci against pinned package-lock.json..."
( cd /opt/safebox/system && npm ci --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip )
chown -R root:root /opt/safebox/system/node_modules
find /opt/safebox/system/node_modules -type d -exec chmod 0755 {} \;
find /opt/safebox/system/node_modules -type f -exec chmod 0644 {} \;
find /opt/safebox/system/node_modules -type f -name '*.node' -exec chmod 0755 {} \;

# ── Wrappers: the whole privileged surface ───────────────────────────────────
for w in safebox-test-run safebox-test-stop safebox-test-logs safebox-zfs safebox-container safebox-tpm-quote safebox-confidential-report safebox-nginx-reload safebox-instance safebox-keyd-reload; do
    if [[ -f "$WRAPPERS_SRC/$w" ]]; then
        install -m 0755 -o root -g root "$WRAPPERS_SRC/$w" "/opt/safebox/bin/$w"
    else
        echo "WARN: wrapper $w not present in $WRAPPERS_SRC; the sudoers entry will refer to a missing path" >&2
    fi
done

# ── sudoers (validate before installing!) ────────────────────────────────────
SUDOERS_TMP=$(mktemp /tmp/safebox-sudoers.XXXXXX)
trap 'rm -f "$SUDOERS_TMP"' EXIT
cp "$SUDOERS_SRC" "$SUDOERS_TMP"
chmod 0440 "$SUDOERS_TMP"
if ! visudo -cf "$SUDOERS_TMP" >/dev/null; then
    echo "ERROR: sudoers file failed visudo -cf validation"
    exit 1
fi
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/safebox-system

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-system.service" \
    /etc/systemd/system/safebox-system.service
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-system@.service" \
    /etc/systemd/system/safebox-system@.service

# ── Key daemon and per-boot tenant users (common/keyd) ───────────────────────
# safebox-keyd is the only process that holds the HMAC master: it reads the
# seed through LoadCredential= and writes one derived key per tenant (and the
# operator's control key) to /run/safebox/keys. safebox-users recreates the
# safebox-sys-<name> accounts from managed-containers.json every boot. Both
# are root units; see docs/HARDENING-PLAN.md, "Per-tenant isolation".
KEYD_SRC="$REPO_ROOT/common/keyd"
for f in safebox-keyd.js safebox-users.sh safebox-keyd.service safebox-users.service; do
    [[ -f "$KEYD_SRC/$f" ]] || { echo "ERROR: $KEYD_SRC/$f missing"; exit 1; }
done
install -d -m 0755 -o root -g root /opt/safebox/keyd
install -m 0644 -o root -g root "$KEYD_SRC/safebox-keyd.js" /opt/safebox/keyd/safebox-keyd.js
install -m 0755 -o root -g root "$KEYD_SRC/safebox-users.sh" /opt/safebox/keyd/safebox-users.sh
install -m 0644 -o root -g root "$KEYD_SRC/safebox-keyd.service" /etc/systemd/system/safebox-keyd.service
install -m 0644 -o root -g root "$KEYD_SRC/safebox-users.service" /etc/systemd/system/safebox-users.service
# The library the wrappers source to derive the calling tenant from SUDO_UID.
# Not a wrapper: not executable, not in sudoers.
[[ -f "$WRAPPERS_SRC/safebox-caller.sh" ]] || { echo "ERROR: $WRAPPERS_SRC/safebox-caller.sh missing"; exit 1; }
install -m 0644 -o root -g root "$WRAPPERS_SRC/safebox-caller.sh" /opt/safebox/bin/safebox-caller.sh

# ── AWS Nitro root certificate ───────────────────────────────────────────────
# nitroTpmClient.js pins the AWS Nitro root (the same root that signs NitroTPM
# EK certificates and Nitro Enclave attestation documents) by SHA-256 of the
# PEM file bytes. Verified against two independent AWS doc pages:
#   docs.aws.amazon.com/enclaves/latest/user/verify-root.html
#   docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html
# A pre-staged copy in the source tree is preferred; otherwise it is fetched
# from the canonical AWS URL (ordinary HTTPS egress, not the metadata service).
AWS_ROOT_PINNED_SHA="641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b"
AWS_ROOT_DEST="/etc/safebox/aws-nitro-root.pem"

if [[ ! -f "$AWS_ROOT_DEST" ]]; then
    STAGED_PEM="$SRC_DIR/aws-nitro-root.pem"
    if [[ -f "$STAGED_PEM" ]]; then
        echo "  using pre-staged AWS root cert from build tree"
        install -m 0644 -o root -g root "$STAGED_PEM" "$AWS_ROOT_DEST"
    else
        echo "  fetching AWS Nitro root cert from aws-nitro-enclaves.amazonaws.com"
        TMP_ZIP=$(mktemp /tmp/aws-nitro-root.XXXXXX.zip)
        TMP_DIR=$(mktemp -d /tmp/aws-nitro-root.XXXXXX)
        trap 'rm -f "$SUDOERS_TMP" "$TMP_ZIP"; rm -rf "$TMP_DIR"' EXIT
        if ! curl -fsSL --max-time 30 -o "$TMP_ZIP" \
            'https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip'; then
            echo "ERROR: failed to fetch AWS Nitro root cert; provide a pre-staged copy at $STAGED_PEM"
            exit 1
        fi
        # The image has no unzip; python3 is present (apparmor-utils depends
        # on it). Extract only the .pem members, flattened.
        python3 -I - "$TMP_ZIP" "$TMP_DIR" <<'PY'
import sys, zipfile, os
zpath, out = sys.argv[1:3]
with zipfile.ZipFile(zpath) as z:
    for name in z.namelist():
        if name.endswith('.pem'):
            with open(os.path.join(out, os.path.basename(name)), 'wb') as f:
                f.write(z.read(name))
PY
        FETCHED_PEM=$(find "$TMP_DIR" -name '*.pem' -print -quit)
        [[ -n "$FETCHED_PEM" ]] || { echo "ERROR: no .pem found inside the downloaded zip"; exit 1; }
        install -m 0644 -o root -g root "$FETCHED_PEM" "$AWS_ROOT_DEST"
    fi
fi

ACTUAL_SHA=$(sha256sum "$AWS_ROOT_DEST" | awk '{print $1}')
if [[ "$ACTUAL_SHA" != "$AWS_ROOT_PINNED_SHA" ]]; then
    echo "ERROR: AWS Nitro root cert fingerprint mismatch (expected $AWS_ROOT_PINNED_SHA, got $ACTUAL_SHA). Refusing to install."
    exit 1
fi
echo "  AWS Nitro root cert verified: $AWS_ROOT_PINNED_SHA"

# ── managed-containers seed (consumed at first boot by ExecStartPre) ─────────
if [[ -f "$REPO_ROOT/config/managed-containers.json" ]]; then
    install -m 0644 -o root -g root "$REPO_ROOT/config/managed-containers.json" \
        /usr/lib/safebox/managed-containers.seed.json
    echo "  staged managed-containers.seed.json from repo defaults"
else
    echo "WARN: config/managed-containers.json not in repo; the system will deny all requests until /var/lib/safebox/managed-containers.json exists"
fi

# ── governance-keys seed (consumed at first boot by ExecStartPre) ────────────
# governanceKeys.js reads /var/lib/safebox/governance/governance-keys.json.
# A deployment that ships its quorum keys in the image puts them in
# config/governance-keys.json; without one the system component rejects
# every governance claim until the file is written on the pool.
if [[ -f "$REPO_ROOT/config/governance-keys.json" ]]; then
    install -m 0644 -o root -g root "$REPO_ROOT/config/governance-keys.json" \
        /usr/lib/safebox/governance-keys.seed.json
    echo "  staged governance-keys.seed.json from repo defaults"
else
    echo "WARN: config/governance-keys.json not in repo; governance claims are rejected until /var/lib/safebox/governance/governance-keys.json exists"
fi

# ── enable (symlinks only; nothing starts in the chroot) ─────────────────────
enable_unit() {
    local unit=$1
    if command -v systemctl >/dev/null 2>&1; then
        if [[ -n "${ROOT:-}" ]]; then
            systemctl --root="$ROOT" enable "$unit" && return 0
        else
            systemctl enable "$unit" 2>/dev/null && return 0
        fi
    fi
    install -d -m 0755 /etc/systemd/system/multi-user.target.wants
    ln -sf "/etc/systemd/system/$unit" "/etc/systemd/system/multi-user.target.wants/$unit"
}
enable_unit safebox-users.service
enable_unit safebox-keyd.service
enable_unit safebox-system.service
# safebox-system@.service is a template: instances are started by the
# operator through safebox-instance, never enabled.

# ── Manifest ─────────────────────────────────────────────────────────────────
COMPONENT_SHA=$(
    find /opt/safebox/system /opt/safebox/bin \
         /etc/systemd/system/safebox-system.service \
         /etc/systemd/system/safebox-system@.service \
         /etc/systemd/system/safebox-keyd.service \
         /etc/systemd/system/safebox-users.service \
         /opt/safebox/keyd \
         /etc/sudoers.d/safebox-system \
         -type f -not -path '*/node_modules/*' 2>/dev/null -exec sha256sum {} \; | sort | sha256sum | awk '{print $1}'
)

cat > /opt/safebox/manifests/system.json << EOF
{
    "component": {
        "name": "system",
        "version": "2.0.0",
        "cloud": "aws",
        "license": ["Apache-2.0"]
    },
    "transport":           "Unix domain sockets under /run/safebox/",
    "controlSocket":       "/run/safebox/control.sock (host-only)",
    "perContainerSockets": "/run/safebox/containers/<name>.sock (bind-mounted into each managed container)",
    "auth":                "HMAC-SHA-256 over canonical envelope; per-container keys HKDF-derived from master",
    "config":              "/var/lib/safebox/managed-containers.json (seeded at first boot from /usr/lib/safebox/managed-containers.seed.json; reload on SIGHUP)",
    "masterSecret":        "held by safebox-keyd only (root); HKDF of /run/safebox/hmac-seed via LoadCredential=; the system component instances never see it",
    "containerKeys":       "/run/safebox/keys/<name>/{system,instance}.hmac written by safebox-keyd (tmpfs; system.hmac bind-mounted read-only into the container at /run/safebox/keys/system.hmac, instance.hmac 0400 for the tenant instance uid)",
    "attestation":         "nitroTpmClient.js: NitroTPM quote via safebox-tpm-quote; EK chain to pinned AWS Nitro root",
    "pcrPolicy":           "sha256:0,2,4,7,8,9,14,15",
    "audit":               "journalctl -t safebox-system",
    "privilegedSurface":   "/etc/sudoers.d/safebox-system -> tenant instances (%safebox-sys): safebox-{test-run,test-stop,test-logs,zfs,container}; operator (safebox-infra): safebox-{container,instance,keyd-reload,nginx-reload,tpm-quote,confidential-report}; wrappers derive the caller from SUDO_UID",
    "isolation":           "one safebox-system@<name> instance per tenant (uid safebox-sys-<name>, 20000..29999) serving only that tenant's socket; operator instance serves control.sock only; HMAC master held by safebox-keyd alone",
    "sourceSha256":        "$COMPONENT_SHA"
}
EOF
chmod 0644 /opt/safebox/manifests/system.json

echo ""
echo "System component installed (AWS)"
echo "   Source:             /opt/safebox/system/ (attestationClient.js = $(basename "$ATTESTATION_CLIENT"))"
echo "   Wrappers:           /opt/safebox/bin/"
echo "   Units:              safebox-users, safebox-keyd, safebox-system (enabled, not started); safebox-system@<name> (template, started per tenant)"
echo "   Sudoers:            /etc/sudoers.d/safebox-system"
echo "   Config seed:        /usr/lib/safebox/managed-containers.seed.json -> /var/lib/safebox/ at first boot"
echo "   Master HMAC key:    safebox-keyd only, derived in memory from /run/safebox/hmac-seed"
echo "   Per-container keys: /run/safebox/keys/<name>/{system,instance}.hmac (tmpfs, written by keyd; system.hmac read-only in the container)"
echo "   Sockets:            /run/safebox/control.sock (operator) + /run/safebox/containers/<name>.sock (one per tenant instance)"
