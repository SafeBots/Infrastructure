#!/bin/bash
#
# install-safenet.sh — Safenet P2P protocol node, identical on all four clouds.
#
# Chroot-safe (docs/HARDENING-PLAN.md, "Build flow" step 2): installs files
# and enables the unit; never starts anything, never reloads systemd, never
# touches the TPM or the metadata service. Run AFTER install-system.sh,
# which installs this cloud's attestation client and the shared TPM quote
# module into /opt/safebox/system/; they are copied from there so the
# Safenet node can produce and verify OCP claims using whichever cloud
# attestation back-end was installed.
#
# The Safenet modules are cloud-neutral Node.js code — they sit on top of
# the system component's attestation client, which differs by cloud. This
# installer copies them from the canonical source at
# aws/scripts/components/safenet/ (the only place they are maintained) and
# wires them to the cloud-specific attestation stack already in
# /opt/safebox/system/.
#
# Runtime configuration is not produced here. /var/lib/safebox/safenet/
# config.json is written by safebox-firstboot.service from the metadata
# service on the first boot of each instance. The service runs as
# safebox:safebox (uid 991), created by common/base/install-base.sh;
# this installer does not create users.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-safenet.sh must run as root" >&2
    exit 1
fi

HERE="$(dirname "$(readlink -f "$0")")"
# The canonical Safenet source is always under the AWS tree.
SAFENET_SRC="${SAFEBOX_SAFENET_SRC_DIR:-/opt/safebox-src/aws/scripts/components/safenet}"
[[ -f "$SAFENET_SRC/server.js" ]] || { echo "ERROR: cannot find safenet sources at $SAFENET_SRC" >&2; exit 1; }
[[ -f "$SAFENET_SRC/package.json" ]] || { echo "ERROR: $SAFENET_SRC/package.json missing" >&2; exit 1; }

SYSTEM_DIR=/opt/safebox/system
INSTALL_DIR=/opt/safebox/safenet

command -v node >/dev/null || { echo "ERROR: node >=18 required" >&2; exit 1; }
[[ -f "$SYSTEM_DIR/attestationClient.js" ]] || { echo "ERROR: $SYSTEM_DIR/attestationClient.js missing; run install-system.sh first" >&2; exit 1; }
getent passwd safebox >/dev/null                || { echo "ERROR: safebox user missing; run install-base.sh first" >&2; exit 1; }

# ── Install directory ────────────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox
install -d -m 0755 -o root -g root "$INSTALL_DIR"
install -d -m 0755 -o root -g root "$INSTALL_DIR/lib"

# ── Sources ──────────────────────────────────────────────────────────────────
# Top-level files: server, CLI, package manifest.
for f in server.js cli.js package.json; do
    install -m 0644 -o root -g root "$SAFENET_SRC/$f" "$INSTALL_DIR/$f"
done

# Library modules (the 13 protocol modules).
for f in "$SAFENET_SRC"/lib/*.js; do
    install -m 0644 -o root -g root "$f" "$INSTALL_DIR/lib/$(basename "$f")"
done

# Copy the attestation client from the system component so Safenet can
# produce and verify OCP claims with the cloud's attestation back-end.
install -m 0644 -o root -g root "$SYSTEM_DIR/attestationClient.js" "$INSTALL_DIR/attestationClient.js"
if [[ -f "$SYSTEM_DIR/tpmQuote.js" ]]; then
    install -m 0644 -o root -g root "$SYSTEM_DIR/tpmQuote.js" "$INSTALL_DIR/tpmQuote.js"
fi

# Shared OCP claim helper (common/attestation/ocpClaim.js).
ATTEST_DIR="${SAFEBOX_ATTESTATION_SRC_DIR:-$HERE/../attestation}"
[[ -f "$ATTEST_DIR/ocpClaim.js" ]] || ATTEST_DIR=/opt/safebox-src/common/attestation
[[ -f "$ATTEST_DIR/ocpClaim.js" ]] || { echo "ERROR: cannot find common/attestation/ocpClaim.js" >&2; exit 1; }
install -m 0644 -o root -g root "$ATTEST_DIR/ocpClaim.js" "$INSTALL_DIR/ocpClaim.js"

# npm install: package.json has zero runtime deps, but run npm ci anyway so
# peerDependencies and any future additions are handled.
if [[ -f "$INSTALL_DIR/package.json" ]]; then
    (cd "$INSTALL_DIR" && npm ci --omit=dev --ignore-scripts 2>/dev/null) || \
    (cd "$INSTALL_DIR" && npm install --omit=dev --ignore-scripts 2>/dev/null) || \
    echo "WARNING: npm install had non-zero exit (safenet has zero deps; continuing)"
fi

# Syntax-check the entry point.
node --check "$INSTALL_DIR/server.js"

# ── systemd unit ─────────────────────────────────────────────────────────────
cat > /etc/systemd/system/safenet.service <<'UNIT'
[Unit]
Description=Safenet Protocol Node
Documentation=file:///opt/safebox/safenet/PROTOCOL.md
After=network-online.target safebox.service safebox-dnsclient.service
Wants=network-online.target
PartOf=safebox.service

[Service]
Type=simple
User=safebox
Group=safebox
ExecStart=/usr/bin/node /opt/safebox/safenet/server.js
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/safebox/safenet
Environment=NODE_ENV=production
# Config written by safebox-firstboot at first boot.
Environment=SAFENET_CONFIG=/var/lib/safebox/safenet/config.json
# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/safebox/safenet
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/safenet.service

# ── Mountpoint for the pool dataset (empty directory in the image) ───────────
# /var/lib/safebox/safenet itself is created on the dataset by the initramfs
# unseal script on first boot; only the mountpoint is baked into the image.
install -d -m 0755 -o root -g root /var/lib/safebox

# ── PROTOCOL.md for reference ───────────────────────────────────────────────
if [[ -f "$SAFENET_SRC/PROTOCOL.md" ]]; then
    install -m 0644 -o root -g root "$SAFENET_SRC/PROTOCOL.md" "$INSTALL_DIR/PROTOCOL.md"
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
enable_unit safenet.service

echo "safenet installed (enabled, not started)."
echo "  User:     safebox (uid 991)"
echo "  Config:   /var/lib/safebox/safenet/config.json (written by safebox-firstboot at first boot)"
echo "  Logs:     journalctl -u safenet.service -f"
echo "  CLI:      /opt/safebox/safenet/cli.js"
