#!/bin/bash
#
# Install System Component — Safebox Infrastructure host API
#
# Installs:
#   - /opt/safebox/system/         the Node sources (~10 .js files, no npm deps)
#   - /etc/systemd/system/safebox-system.service
#   - /etc/sudoers.d/safebox-system   (validated with visudo -c before installing)
#   - /etc/safebox/managed-containers.json
#   - /etc/safebox/containers/     (per-container HMAC keys, mode 0640)
#   - /run/safebox/{control.sock, containers/<name>.sock}  (created at startup)
#   - users: safebox-infra, safebox-infra-readers group
#
# The system component listens on per-container Unix domain sockets and one
# control socket — no TCP port. Each per-container socket is bind-mounted
# into ONLY that container; the control socket is host-only.

set -euo pipefail

echo "Installing system component..."

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v systemctl >/dev/null || { echo "ERROR: systemd required"; exit 1; }
command -v node      >/dev/null || { echo "ERROR: node ≥20 required"; exit 1; }
command -v visudo    >/dev/null || { echo "ERROR: visudo required";   exit 1; }
command -v sudo      >/dev/null || { echo "ERROR: sudo required";     exit 1; }
node -e 'if (parseInt(process.versions.node) < 20) { console.error("node >=20 required"); process.exit(1); }'

# ── Users and groups ─────────────────────────────────────────────────────────
getent group  safebox-infra         >/dev/null || groupadd --system safebox-infra
getent group  safebox-infra-readers >/dev/null || groupadd --system safebox-infra-readers
getent passwd safebox-infra         >/dev/null || useradd  --system \
    --gid safebox-infra --home-dir /var/empty --shell /sbin/nologin \
    --comment "Safebox system component runtime user" safebox-infra

# safebox-infra must be able to read the HMAC secret
usermod -aG safebox-infra-readers safebox-infra 2>/dev/null || true
# docker is consulted via sudo, but logs/wait spawn detached children that may
# need docker access for the log-follower process
getent group docker >/dev/null && usermod -aG docker safebox-infra 2>/dev/null || true

# ── Directories ──────────────────────────────────────────────────────────────
install -d -m 0755 -o root          -g root          /opt/safebox/system
install -d -m 0755 -o root          -g root          /etc/safebox
install -d -m 0750 -o safebox-infra -g safebox-infra /etc/safebox/containers
install -d -m 0750 -o safebox-infra -g safebox-infra /srv/zfs-clones
# /run/safebox is created by the systemd RuntimeDirectory= directive at start

# ── Source dir ───────────────────────────────────────────────────────────────
SRC_DIR="${SAFEBOX_SRC_DIR:-/opt/safebox-src/system}"
[[ ! -f "$SRC_DIR/server.js" ]] && SRC_DIR="$(dirname "$(readlink -f "$0")")"
[[ ! -f "$SRC_DIR/server.js" ]] && { echo "ERROR: cannot find system component source dir"; exit 1; }

# ── System component source files ─────────────────────────────────────────────────────
for f in server.js auth.js secret.js config.js sockets.js \
         opsSystem.js opsTest.js opsModels.js opsContainers.js \
         opsEmbed.js embeddingsWorker.js \
         nsmClient.js cborDecode.js \
         package.json package-lock.json; do
    if [[ -f "$SRC_DIR/$f" ]]; then
        install -m 0644 -o root -g root "$SRC_DIR/$f" "/opt/safebox/system/$f"
    elif [[ "$f" == "package-lock.json" ]]; then
        # package-lock.json must exist for `npm ci` to work deterministically.
        # If it's missing in the source tree, that's a build error.
        echo "ERROR: package-lock.json missing in $SRC_DIR"
        echo "       Run 'npm install --package-lock-only' in the source dir before AMI build"
        exit 1
    else
        echo "ERROR: required source file missing: $SRC_DIR/$f"
        exit 1
    fi
done

# ── npm ci: deterministic install of pinned dependencies ─────────────────────
# Uses the lockfile only. NO network resolution beyond what npm itself does.
# Audit reads package-lock.json to see exactly what versions and hashes are
# installed.
#
# The --onnxruntime-node-install-cuda=skip flag is required because
# onnxruntime-node's post-install otherwise tries to fetch a ~500MB CUDA
# binary tarball from github.com/microsoft/onnxruntime/releases/... — which
# (a) fails on AMI build hosts that restrict egress to npm registry only,
# and (b) we don't want anyway because Safebox AMIs don't have GPUs and
# embeddings run on CPU. Removing this flag will break the AMI build.
#
# node_modules is owned by safebox-infra so the runtime user can read it
# without sudo. Mode 0755 so reads work; no writes needed at runtime.
echo "Running npm ci against pinned package-lock.json..."
( cd /opt/safebox/system && npm ci --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip )
chown -R safebox-infra:safebox-infra /opt/safebox/system/node_modules
find /opt/safebox/system/node_modules -type d -exec chmod 0755 {} \;
find /opt/safebox/system/node_modules -type f -exec chmod 0644 {} \;
# Native binaries (.node files) need execute permission
find /opt/safebox/system/node_modules -type f -name '*.node' -exec chmod 0755 {} \;

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-system.service" \
    /etc/systemd/system/safebox-system.service

# ── sudoers (validate before installing!) ────────────────────────────────────
SUDOERS_TMP=$(mktemp /tmp/safebox-sudoers.XXXXXX)
trap 'rm -f "$SUDOERS_TMP"' EXIT
cp "$SRC_DIR/sudoers/safebox-system" "$SUDOERS_TMP"
chmod 0440 "$SUDOERS_TMP"
if ! visudo -c -f "$SUDOERS_TMP" >/dev/null; then
    echo "ERROR: sudoers file failed visudo -c validation"
    exit 1
fi
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/safebox-system

# ── AWS Nitro root certificate ───────────────────────────────────────────────
# The system pins the AWS Nitro Enclaves Root-G1 cert by SHA-256. The PEM
# itself must be present on disk; the installer either copies a pre-staged
# copy from the build environment, or fetches it from the canonical URL.
#
# Pinned fingerprint (SHA-256 of the PEM file bytes):
#   641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b
#
# Source URL (AWS-published):
#   https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
#
# Verification path (confirmed against two independent AWS doc pages:
# docs.aws.amazon.com/enclaves/latest/user/verify-root.html and
# docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html):
# the value above is the SHA-256 of the PEM file's bytes.

AWS_ROOT_PINNED_SHA="641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b"
AWS_ROOT_DEST="/etc/safebox/aws-nitro-root.pem"

if [[ ! -f "$AWS_ROOT_DEST" ]]; then
    # Look for a pre-staged copy in the source tree (build-time bundling)
    STAGED_PEM="$SRC_DIR/aws-nitro-root.pem"
    if [[ -f "$STAGED_PEM" ]]; then
        echo "  using pre-staged AWS root cert from build tree"
        install -m 0644 -o root -g root "$STAGED_PEM" "$AWS_ROOT_DEST"
    else
        # Fetch from canonical URL
        echo "  fetching AWS Nitro root cert from aws-nitro-enclaves.amazonaws.com"
        TMP_ZIP=$(mktemp /tmp/aws-nitro-root.XXXXXX.zip)
        TMP_DIR=$(mktemp -d /tmp/aws-nitro-root.XXXXXX)
        trap 'rm -f "$TMP_ZIP"; rm -rf "$TMP_DIR"' EXIT
        if ! curl -fsSL --max-time 30 \
            -o "$TMP_ZIP" \
            'https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip'; then
            echo "ERROR: failed to fetch AWS Nitro root cert"
            echo "       Either: provide a pre-staged copy at $STAGED_PEM"
            echo "           or: ensure outbound HTTPS to aws-nitro-enclaves.amazonaws.com is allowed"
            exit 1
        fi
        unzip -j -o "$TMP_ZIP" -d "$TMP_DIR" >/dev/null
        # The PEM filename inside the zip is AWS_NitroEnclaves_Root-G1.pem
        FETCHED_PEM=$(find "$TMP_DIR" -name '*.pem' -print -quit)
        if [[ -z "$FETCHED_PEM" ]]; then
            echo "ERROR: no .pem found inside the downloaded zip"
            exit 1
        fi
        install -m 0644 -o root -g root "$FETCHED_PEM" "$AWS_ROOT_DEST"
    fi
fi

# Verify the SHA-256 regardless of source. This is the load-bearing check —
# if the bytes on disk don't match the pinned fingerprint, the install aborts
# rather than letting the system service boot against an unverified root.
ACTUAL_SHA=$(sha256sum "$AWS_ROOT_DEST" | awk '{print $1}')
if [[ "$ACTUAL_SHA" != "$AWS_ROOT_PINNED_SHA" ]]; then
    echo "ERROR: AWS Nitro root cert fingerprint mismatch"
    echo "  expected: $AWS_ROOT_PINNED_SHA"
    echo "  actual:   $ACTUAL_SHA"
    echo ""
    echo "  This means either:"
    echo "    (a) the cert at $AWS_ROOT_DEST is corrupted or tampered"
    echo "    (b) AWS rotated the root cert and we need to update the pin"
    echo ""
    echo "  Do not proceed until this is resolved. Refusing to install."
    exit 1
fi
echo "  AWS Nitro root cert verified: $AWS_ROOT_PINNED_SHA"

# ── managed-containers.json (copy from repo config if available) ─────────────
if [[ ! -f /etc/safebox/managed-containers.json ]]; then
    if [[ -f "$SRC_DIR/../../../config/managed-containers.json" ]]; then
        install -m 0644 -o root -g root \
            "$SRC_DIR/../../../config/managed-containers.json" \
            /etc/safebox/managed-containers.json
        echo "  copied managed-containers.json from repo defaults"
    else
        echo "WARN /etc/safebox/managed-containers.json not present; system will deny all requests until you provide one"
    fi
fi

# ── HMAC secret directory (file generated on first boot by the system) ─────
install -d -m 0750 -o root -g safebox-infra-readers /etc/safebox

# ── daemon-reload, enable ────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable safebox-system.service

# ── Manifest ─────────────────────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox/manifests
COMPONENT_SHA=$(
    find /opt/safebox/system \
         /etc/systemd/system/safebox-system.service \
         /etc/sudoers.d/safebox-system \
         -type f 2>/dev/null -exec sha256sum {} \; | sort | sha256sum | awk '{print $1}'
)

cat > /opt/safebox/manifests/system.json << EOF
{
    "component": {
        "name": "system",
        "version": "1.0.0",
        "license": ["Apache-2.0"]
    },
    "transport":           "Unix domain sockets under /run/safebox/",
    "controlSocket":       "/run/safebox/control.sock (host-only)",
    "perContainerSockets": "/run/safebox/containers/<name>.sock (bind-mounted into each managed container)",
    "auth":                "HMAC-SHA-256 over canonical envelope; per-container keys HKDF-derived from master",
    "config":              "/etc/safebox/managed-containers.json (reload on SIGHUP, mutated via /containers/create|destroy)",
    "masterSecret":        "/etc/safebox/system.hmac (TPM-derived if available, else random)",
    "containerKeys":       "/etc/safebox/containers/<name>.hmac (one per managed container)",
    "audit":               "journalctl -t safebox-system",
    "privilegedSurface":   "/etc/sudoers.d/safebox-system",
    "sourceSha256":        "$COMPONENT_SHA"
}
EOF
chmod 0644 /opt/safebox/manifests/system.json

echo ""
echo "✅ System component installed"
echo "   Source:           /opt/safebox/system/"
echo "   Unit:             /etc/systemd/system/safebox-system.service"
echo "   Sudoers:          /etc/sudoers.d/safebox-system"
echo "   Config:           /etc/safebox/managed-containers.json"
echo "   Master HMAC key:  /etc/safebox/system.hmac (derived on first start)"
echo "   Per-container keys: /etc/safebox/containers/<name>.hmac"
echo "   Sockets:          /run/safebox/control.sock + /run/safebox/containers/<name>.sock"
echo "   Audit:            journalctl -t safebox-system"
echo ""
echo "Start with: systemctl start safebox-system"
