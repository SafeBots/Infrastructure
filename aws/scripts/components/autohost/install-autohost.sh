#!/bin/bash
#
# install-autohost.sh
#
# Install the Safebox on-demand vhost provisioner. Unlike the old
# install-autovhost.sh, this does NOT ship its own copy of the provisioner —
# it installs the vendored public Autohost (github.com/Safebots/Autohost),
# pinned as a submodule at vendor/autohost/, and supplies Safebox-specific
# config on top. See MIGRATION-autovhost-to-autohost.md.
#
# What comes from where:
#   - provisioner code  : vendor/autohost/ (public Autohost submodule, UNMODIFIED)
#   - Safebox config    : this dir's autohost.safebox.json -> /etc/safebox/autohost.json
#   - (optional) hook   : /etc/safebox/autohost-authorize-hook.js (Safebox governance)
#
# Idempotent. Requires: bash, node (>=18), npm, nginx, systemd, safebox-infra user.

set -euo pipefail

COMP_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
# The vendored Autohost submodule. Resolved relative to the repo root; the AMI
# build runs `git submodule update --init` before this installer, so the source
# is present on disk (see MIGRATION doc for the build-time / attestation model).
AUTOHOST_SRC="${AUTOHOST_SRC:-$COMP_DIR/../../../../vendor/autohost}"
INSTALL_DIR=/opt/safebox/autohost

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-autohost.sh must run as root" >&2
    exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
    echo "ERROR: nginx not found in PATH; install nginx before installing autohost" >&2
    exit 1
fi

# ── Verify the Autohost submodule is present (resolved, not an empty gitlink) ──
if [[ ! -f "$AUTOHOST_SRC/src/autohost.js" ]]; then
    echo "ERROR: vendored Autohost not found at $AUTOHOST_SRC" >&2
    echo "  Run 'git submodule update --init vendor/autohost' before installing." >&2
    echo "  (On the AMI build host this happens automatically before install.)" >&2
    exit 1
fi

# ── Install the Autohost source ──────────────────────────────────────────────
# Copy the vendored source into the install dir. We copy (not symlink) so the
# running service doesn't depend on the repo checkout staying in place, and so
# the installed tree is exactly what the AMI attests.
install -d -m 0755 -o root -g root /opt/safebox
rm -rf "$INSTALL_DIR"
install -d -m 0755 -o root -g root "$INSTALL_DIR"
cp -a "$AUTOHOST_SRC/src"          "$INSTALL_DIR/src"
cp -a "$AUTOHOST_SRC/package.json" "$INSTALL_DIR/package.json"
[[ -f "$AUTOHOST_SRC/package-lock.json" ]] && \
    cp -a "$AUTOHOST_SRC/package-lock.json" "$INSTALL_DIR/package-lock.json"
chown -R root:root "$INSTALL_DIR"

# ── Install node_modules (acme-client, node-forge) ───────────────────────────
cd "$INSTALL_DIR"
if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || {
        echo "ERROR: npm ci failed in $INSTALL_DIR" >&2; exit 1; }
else
    npm install --omit=dev --no-audit --no-fund --no-package-lock >/dev/null 2>&1 || {
        echo "ERROR: npm install failed in $INSTALL_DIR" >&2; exit 1; }
fi
chown -R root:root "$INSTALL_DIR/node_modules"

# ── Safebox config ───────────────────────────────────────────────────────────
# Maps Safebox paths/socket onto Autohost's config surface. Autohost reads it
# from AUTOVHOST_CONFIG (default /etc/autohost/config.json); we point it at the
# Safebox location via the systemd unit's Environment=.
install -d -m 0755 -o root -g root /etc/safebox
install -m 0644 -o root -g root "$COMP_DIR/autohost.safebox.json" /etc/safebox/autohost.json

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$COMP_DIR/units/safebox-autohost.service" \
    /etc/systemd/system/safebox-autohost.service

# ── nginx catch-all config ───────────────────────────────────────────────────
install -m 0644 -o root -g root \
    "$COMP_DIR/nginx-templates/safebox-autohost.conf" \
    /etc/nginx/conf.d/safebox-autohost.conf

# ── Per-host vhost template (Safebox-flavored; Autohost's placeholder syntax) ─
# Shipped as .example each upgrade; the active file is only written if absent so
# operator edits survive upgrades.
install -m 0644 -o root -g root \
    "$COMP_DIR/nginx-templates/vhost-template.conf" \
    /etc/safebox/autohost-vhost-template.conf.example
if [[ ! -f /etc/safebox/autohost-vhost-template.conf ]]; then
    install -m 0644 -o root -g root \
        "$COMP_DIR/nginx-templates/vhost-template.conf" \
        /etc/safebox/autohost-vhost-template.conf
fi

# ── Splash pages (served by nginx while a host provisions) ────────────────────
# Autohost ships its own splash HTML; use it if the Safebox component doesn't
# override with a branded one.
for pair in "splash.html:autohost-splash.html" "splash-https.html:autohost-splash-https.html"; do
    src_name="${pair%%:*}"; dst_name="${pair##*:}"
    if [[ -f "$COMP_DIR/nginx-templates/$dst_name" ]]; then
        install -m 0644 -o root -g root "$COMP_DIR/nginx-templates/$dst_name" "/etc/safebox/$dst_name"
    elif [[ -f "$AUTOHOST_SRC/src/static/$src_name" ]]; then
        install -m 0644 -o root -g root "$AUTOHOST_SRC/src/static/$src_name" "/etc/safebox/$dst_name"
    fi
done

# ── Users ────────────────────────────────────────────────────────────────────
if ! id safebox-infra >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin safebox-infra
fi
if ! id nginx >/dev/null 2>&1 && ! id www-data >/dev/null 2>&1; then
    echo "WARNING: neither 'nginx' nor 'www-data' user exists; socket permissions may fail" >&2
fi

# ── Directories ──────────────────────────────────────────────────────────────
install -d -m 0750 -o safebox-infra -g safebox-infra /var/lib/safebox/autohost
install -d -m 0755 -o safebox-infra -g safebox-infra /var/lib/safebox/autohost/challenges
chmod o+x /var/lib/safebox/autohost                       # nginx traverse for ACME challenges
install -d -m 0755 -o root -g root /etc/nginx/conf.d/auto
install -d -m 0750 -o root -g root /etc/nginx/conf.d/auto-certs
install -d -m 0755 -o safebox-infra -g safebox-infra /run/safebox

# ── Bootstrap self-signed cert for the default_server ────────────────────────
if [[ ! -f /etc/safebox/autohost-bootstrap.crt ]]; then
    openssl req -x509 -newkey rsa:2048 -keyout /etc/safebox/autohost-bootstrap.key \
        -out /etc/safebox/autohost-bootstrap.crt -days 3650 -nodes \
        -subj '/CN=safebox-autohost-bootstrap' >/dev/null 2>&1
    chmod 0640 /etc/safebox/autohost-bootstrap.key
    chmod 0644 /etc/safebox/autohost-bootstrap.crt
fi

# ── Validate nginx config ────────────────────────────────────────────────────
if ! nginx -t >/dev/null 2>&1; then
    echo "WARNING: nginx -t failed after installing autohost config" >&2
    nginx -t || true
fi

# ── Enable ───────────────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable safebox-autohost.service

echo "autohost installed (from vendored Autohost submodule). Start it and reload nginx:"
echo "  systemctl start safebox-autohost.service"
echo "  systemctl reload nginx"
echo "  journalctl -u safebox-autohost.service -f"
