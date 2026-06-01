#!/bin/bash
#
# install-dnsclient.sh
#
# Install the Safebox DNS client component on a host. Idempotent.
#
# Required: bash, node (>=18), systemd, an existing safebox-infra user
# (typically already created by the System component installer).
#
# Required environment or arguments at runtime (in /etc/safebox/dnsclient.json):
#   - safeboxId:    sbx_... (provisioned by the Safebots control plane)
#   - accountToken: tok_... (per-account secret)
#   - dnsApiUrl:    https URL of the DNS API
#
# This installer does not produce /etc/safebox/dnsclient.json. That file is
# written by cloud-init at boot time from the EC2 user-data field; see
# bootstrap-safebox.sh for the cloud-init template that does it.

set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
INSTALL_DIR=/opt/safebox/dnsclient

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-dnsclient.sh must run as root" >&2
    exit 1
fi

# ── Create install directory ─────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox
install -d -m 0755 -o root -g root "$INSTALL_DIR"

# ── Copy source files ────────────────────────────────────────────────────────
for f in dnsclient.js config.js nsmClient.js cborDecode.js; do
    if [[ ! -f "$SRC_DIR/$f" ]]; then
        echo "ERROR: required source file missing: $SRC_DIR/$f" >&2
        exit 1
    fi
    install -m 0644 -o root -g root "$SRC_DIR/$f" "$INSTALL_DIR/$f"
done

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-dnsclient.service" \
    /etc/systemd/system/safebox-dnsclient.service

# ── Ensure safebox-infra user exists ─────────────────────────────────────────
# We expect the System component installer to have already created this user.
# If it didn't (dnsclient running standalone), create it now.
if ! id safebox-infra >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin safebox-infra
fi

# ── State directory ──────────────────────────────────────────────────────────
install -d -m 0750 -o safebox-infra -g safebox-infra /var/lib/safebox/dnsclient

# ── /etc/safebox must exist (config file lives here) ─────────────────────────
install -d -m 0755 -o root -g safebox-infra /etc/safebox

# ── Reload systemd, enable (but don't start yet — config may not be ready) ──
systemctl daemon-reload
systemctl enable safebox-dnsclient.service

echo "dnsclient installed. Start it after writing /etc/safebox/dnsclient.json:"
echo "  systemctl start safebox-dnsclient.service"
echo "  journalctl -u safebox-dnsclient.service -f"
