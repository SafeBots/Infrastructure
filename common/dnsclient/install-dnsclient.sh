#!/bin/bash
#
# install-dnsclient.sh — Safebox DNS client, identical on all four clouds.
#
# Chroot-safe (docs/HARDENING-PLAN.md, "Build flow" step 2): installs files
# and enables the unit; never starts anything, never reloads systemd, never
# touches the TPM or the metadata service. Run AFTER install-system.sh,
# which installs this cloud's attestation client and the shared TPM quote
# module into /opt/safebox/system/; they are copied from there.
#
# Runtime configuration is not produced here. /var/lib/safebox/dns/dnsclient.json
# is written by safebox-firstboot.service from the metadata service on the
# first boot of each instance; identity.key and last-announce.json by
# dnsclient itself. The service runs as safebox-dns (uid 992),
# created by common/base/install-base.sh; this installer does not create
# users.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-dnsclient.sh must run as root" >&2
    exit 1
fi

HERE="$(dirname "$(readlink -f "$0")")"
SRC_DIR="${SAFEBOX_DNSCLIENT_SRC_DIR:-$HERE}"
[[ -f "$SRC_DIR/dnsclient.js" ]] || SRC_DIR="/opt/safebox-src/common/dnsclient"
[[ -f "$SRC_DIR/dnsclient.js" ]] || { echo "ERROR: cannot find dnsclient sources" >&2; exit 1; }
SYSTEM_DIR=/opt/safebox/system
INSTALL_DIR=/opt/safebox/dnsclient

command -v node >/dev/null || { echo "ERROR: node >=20 required" >&2; exit 1; }
[[ -f "$SYSTEM_DIR/attestationClient.js" ]] || { echo "ERROR: $SYSTEM_DIR/attestationClient.js missing; run install-system.sh first" >&2; exit 1; }
[[ -f "$SYSTEM_DIR/tpmQuote.js" ]]          || { echo "ERROR: $SYSTEM_DIR/tpmQuote.js missing; run install-system.sh first" >&2; exit 1; }
getent passwd safebox-dns >/dev/null         || { echo "ERROR: safebox-dns user missing; run install-base.sh first" >&2; exit 1; }
[[ "$(id -u safebox-dns)" == 992 ]]          || { echo "ERROR: safebox-dns must be uid 992" >&2; exit 1; }

# ── Install directory ────────────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox
install -d -m 0755 -o root -g root "$INSTALL_DIR"

# ── Sources ──────────────────────────────────────────────────────────────────
for f in dnsclient.js config.js; do
    install -m 0644 -o root -g root "$SRC_DIR/$f" "$INSTALL_DIR/$f"
done
# Shared OCP claim helper (common/attestation/ocpClaim.js): sign the announce
# here, verified by relying parties with verifyAnnounce.js from the same dir.
ATTEST_DIR="${SAFEBOX_ATTESTATION_SRC_DIR:-$SRC_DIR/../attestation}"
[[ -f "$ATTEST_DIR/ocpClaim.js" ]] || ATTEST_DIR=/opt/safebox-src/common/attestation
[[ -f "$ATTEST_DIR/ocpClaim.js" ]] || { echo "ERROR: cannot find common/attestation/ocpClaim.js" >&2; exit 1; }
install -m 0644 -o root -g root "$ATTEST_DIR/ocpClaim.js" "$INSTALL_DIR/ocpClaim.js"
# Real copies of the attestation modules installed by install-system.sh
install -m 0644 -o root -g root "$SYSTEM_DIR/attestationClient.js" "$INSTALL_DIR/attestationClient.js"
install -m 0644 -o root -g root "$SYSTEM_DIR/tpmQuote.js"          "$INSTALL_DIR/tpmQuote.js"
rm -f "$INSTALL_DIR/nsmClient.js" "$INSTALL_DIR/cborDecode.js"
node --check "$INSTALL_DIR/dnsclient.js"

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-dnsclient.service" \
    /etc/systemd/system/safebox-dnsclient.service

# ── Mountpoint for the pool dataset (empty directory in the image) ───────────
# /var/lib/safebox/dns itself is created on the dataset by the initramfs
# unseal script on first boot (0750 safebox-dns); only the mountpoint is
# baked into the image.
install -d -m 0755 -o root -g root /var/lib/safebox

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
enable_unit safebox-dnsclient.service

echo "dnsclient installed (enabled, not started)."
echo "  User:     safebox-dns (uid 992)"
echo "  Config:   /var/lib/safebox/dns/dnsclient.json (written by safebox-firstboot at first boot)"
echo "  Identity: /var/lib/safebox/dns/identity.key, last-announce.json, announced (written by dnsclient)"
echo "  Logs:     journalctl -u safebox-dnsclient.service -f"
