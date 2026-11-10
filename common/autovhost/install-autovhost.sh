#!/bin/bash
#
# install-autovhost.sh
#
# Install the Safebox autovhost component. Idempotent, identical on all four
# clouds, and chroot-safe (docs/HARDENING-PLAN.md, "Build flow" step 2): it
# installs files and enables the unit; it never starts or reloads anything.
# Generated vhosts and certificates go to /var/lib/safebox/nginx/ on the
# encrypted pool (created at first boot by the unit's ExecStartPre), because
# /etc is a read-only overlay that resets every boot.
#
# Requirements: bash, node (>=18), npm, nginx, an existing safebox-infra
# user (created by install-system.sh, which runs first).

set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
[[ -f "$SRC_DIR/autovhost.js" ]] || SRC_DIR=/opt/safebox-src/common/autovhost
[[ -f "$SRC_DIR/autovhost.js" ]] || { echo "ERROR: cannot find autovhost sources" >&2; exit 1; }
INSTALL_DIR=/opt/safebox/autovhost

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install-autovhost.sh must run as root" >&2
    exit 1
fi

# ── Sanity: nginx must be installed ──────────────────────────────────────────
if ! command -v nginx >/dev/null 2>&1; then
    echo "ERROR: nginx not found in PATH; install nginx before installing autovhost" >&2
    exit 1
fi

# ── Create install directory ─────────────────────────────────────────────────
install -d -m 0755 -o root -g root /opt/safebox
install -d -m 0755 -o root -g root "$INSTALL_DIR"

# ── Copy source files ────────────────────────────────────────────────────────
for f in autovhost.js config.js package.json package-lock.json; do
    if [[ ! -f "$SRC_DIR/$f" ]]; then
        echo "ERROR: required source file missing: $SRC_DIR/$f" >&2
        exit 1
    fi
    install -m 0644 -o root -g root "$SRC_DIR/$f" "$INSTALL_DIR/$f"
done

# ── Install node_modules (acme-client) ───────────────────────────────────────
# `npm ci` against the pinned lockfile pulls acme-client and its small
# dependency tree into /opt/safebox/autovhost/node_modules.
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || {
    echo "ERROR: npm ci failed in $INSTALL_DIR" >&2
    exit 1
}
chown -R root:root "$INSTALL_DIR/node_modules"

# ── systemd unit ─────────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SRC_DIR/units/safebox-autovhost.service" \
    /etc/systemd/system/safebox-autovhost.service

# ── nginx template ───────────────────────────────────────────────────────────
# We install our config into /etc/nginx/conf.d/safebox-autovhost.conf.
# This requires the main nginx.conf to `include /etc/nginx/conf.d/*.conf`
# from within http {} — which is the default on every distro nginx package.
install -m 0644 -o root -g root \
    "$SRC_DIR/nginx-templates/safebox-autovhost.conf" \
    /etc/nginx/conf.d/safebox-autovhost.conf

# ── Splash HTML ──────────────────────────────────────────────────────────────
# The static splash page served while a customer hostname is being set up.
# Two files:
#   autovhost-splash.html       — beautiful HTTP-first landing page
#                                 (the design surface; serves over plain HTTP,
#                                 no TLS warning, where real first visits land)
#   autovhost-splash-https.html — minimal fallback for HTTPS to unknown hosts
#                                 (browser warning unavoidable; explains the
#                                 situation and points back to HTTP)
install -d -m 0755 -o root -g root /etc/safebox
install -m 0644 -o root -g root \
    "$SRC_DIR/nginx-templates/safebox-autovhost-splash.html" \
    /etc/safebox/autovhost-splash.html
install -m 0644 -o root -g root \
    "$SRC_DIR/nginx-templates/safebox-autovhost-splash-https.html" \
    /etc/safebox/autovhost-splash-https.html

# ── Per-host vhost template ──────────────────────────────────────────────────
# This is the template autovhost substitutes for each provisioned hostname.
# Operators can edit /etc/safebox/autovhost-vhost-template.conf to customize
# what generated per-host vhosts look like — location blocks, try_files,
# per-hostname document roots, custom headers, anything nginx config can
# express. After editing, restart safebox-autovhost.
#
# We always ship the latest version as .example so operators can diff
# against upgrades. We only install the active file if it doesn't exist
# yet — operator edits survive package upgrades.
install -m 0644 -o root -g root \
    "$SRC_DIR/nginx-templates/vhost-template.conf" \
    /etc/safebox/autovhost-vhost-template.conf.example
if [[ ! -f /etc/safebox/autovhost-vhost-template.conf ]]; then
    install -m 0644 -o root -g root \
        "$SRC_DIR/nginx-templates/vhost-template.conf" \
        /etc/safebox/autovhost-vhost-template.conf
fi

# ── Ensure safebox-infra user exists (install-system.sh creates it as 990) ───
if ! id safebox-infra >/dev/null 2>&1; then
    echo "ERROR: safebox-infra user missing; run install-system.sh first" >&2
    exit 1
fi
# nginx user must exist too — package install creates it; check just in case
if ! id nginx >/dev/null 2>&1 && ! id www-data >/dev/null 2>&1; then
    echo "WARNING: neither 'nginx' nor 'www-data' user exists; socket permissions may fail" >&2
fi

# ── Directories ──────────────────────────────────────────────────────────────
# Only the pool mountpoint is created here. /var/lib/safebox/{autovhost,nginx}
# are on the pool and are created by the unit's ExecStartPre at first boot;
# /run/safebox is created by the initramfs and safebox-system.
install -d -m 0755 -o root -g root /var/lib/safebox

# ── Bootstrap self-signed cert for the default_server ────────────────────────
# nginx needs a valid cert/key pair just to start listening on 443 with TLS,
# even for the catch-all server block that serves the "preparing..." splash.
# Generate one if it doesn't exist.
if [[ ! -f /etc/safebox/autovhost-bootstrap.crt ]]; then
    install -d -m 0755 -o root -g root /etc/safebox
    openssl req -x509 -newkey rsa:2048 -keyout /etc/safebox/autovhost-bootstrap.key \
        -out /etc/safebox/autovhost-bootstrap.crt -days 3650 -nodes \
        -subj '/CN=safebox-autovhost-bootstrap' >/dev/null 2>&1
    chmod 0640 /etc/safebox/autovhost-bootstrap.key
    chmod 0644 /etc/safebox/autovhost-bootstrap.crt
fi

# ── Validate nginx config (parse only; may warn inside a chroot) ─────────────
if ! nginx -t >/dev/null 2>&1; then
    echo "WARNING: nginx -t failed after installing autovhost config (expected to pass on the booted box; check if it fails there)" >&2
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
enable_unit safebox-autovhost.service

echo "autovhost installed (enabled, not started)."
echo "  Vhosts/certs: /var/lib/safebox/nginx/{vhosts,certs}/ (created at first boot)"
echo "  Logs:         journalctl -u safebox-autovhost.service -f"
