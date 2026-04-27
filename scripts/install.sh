#!/bin/bash
# Safebox Infrastructure Installation - Production Edition
# Implements Infrastructure Specification v1.0

set -e

echo "=== Safebox Infrastructure Installation ==="
echo ""

if [ "$EUID" -ne 0 ]; then 
    echo "ERROR: Please run as root"
    exit 1
fi

# Get Safebox UID (default: www-data = 33)
SAFEBOX_UID=${SAFEBOX_UID:-33}
echo "[Config] Safebox UID: $SAFEBOX_UID"

# 1. Create users and groups
echo "[1/6] Creating system users..."

# Create safebox user if needed (usually www-data)
if ! id -u safebox &>/dev/null && [ "$SAFEBOX_UID" -ne 33 ]; then
    useradd -r -u $SAFEBOX_UID -s /bin/false safebox
    echo "✓ Created safebox user (UID $SAFEBOX_UID)"
fi

# Create safebox-api user
if ! id -u safebox-api &>/dev/null; then
    useradd -r -s /usr/sbin/nologin -u 999 safebox-api
    echo "✓ Created safebox-api user (UID 999)"
fi

# Create safebox-hmac group
if ! getent group safebox-hmac &>/dev/null; then
    groupadd -r safebox-hmac
    echo "✓ Created safebox-hmac group"
fi

# Add users to groups
usermod -aG safebox-hmac safebox 2>/dev/null || usermod -aG safebox-hmac www-data
usermod -aG safebox-hmac safebox-api
usermod -aG docker safebox-api

echo "✓ Users and groups configured"

# 2. Create directories
echo "[2/6] Creating directories..."

mkdir -p /etc/safebox
mkdir -p /var/lib/safebox-system-api
mkdir -p /var/log
mkdir -p /opt/safebox-system-api
mkdir -p /run/safebox

chown safebox-api:safebox-api /var/lib/safebox-system-api
chmod 750 /var/lib/safebox-system-api

chown safebox-api:safebox-api /run/safebox
chmod 750 /run/safebox

echo "✓ Directories created"

# 3. Generate secrets
echo "[3/6] Generating secrets..."

# HMAC key
if [ ! -f /etc/safebox/system-api.key ]; then
    openssl rand -hex 64 > /etc/safebox/system-api.key
    chown root:safebox-hmac /etc/safebox/system-api.key
    chmod 0640 /etc/safebox/system-api.key
    echo "✓ Generated HMAC key"
else
    echo "✓ HMAC key already exists"
fi

# Safebox UID file
echo "$SAFEBOX_UID" > /etc/safebox/safebox-uid
chmod 0644 /etc/safebox/safebox-uid
echo "✓ Configured Safebox UID"

# managed-containers.json
if [ ! -f /etc/safebox/managed-containers.json ]; then
    cp config/managed-containers.json /etc/safebox/
    chmod 0644 /etc/safebox/managed-containers.json
    echo "✓ Installed managed-containers.json"
else
    echo "✓ managed-containers.json already exists (not overwriting)"
fi

# system-registry.json (optional governance integration)
if [ ! -f /etc/safebox/system-registry.json ]; then
    if [ -f config/system-registry.json.example ]; then
        cp config/system-registry.json.example /etc/safebox/system-registry.json
        chmod 0644 /etc/safebox/system-registry.json
        echo "✓ Installed system-registry.json (governance template)"
    fi
else
    echo "✓ system-registry.json already exists (not overwriting)"
fi

echo "✓ Secrets configured"

# 4. Install system-protocol-api
echo "[4/6] Installing system-protocol-api..."

cp docker/system-protocol-api.js /opt/safebox-system-api/
chmod +x /opt/safebox-system-api/system-protocol-api.js
chown -R safebox-api:safebox-api /opt/safebox-system-api

# Install dependencies
cd /opt/safebox-system-api
npm install dockerode 2>/dev/null || echo "⚠ npm install failed - install manually"

echo "✓ System API installed"

# 5. Install systemd service
echo "[5/6] Installing systemd service..."

cat > /etc/systemd/system/safebox-system-api.service << 'SERVICE_EOF'
[Unit]
Description=Safebox system protocol API
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=safebox-api
Group=safebox-api
WorkingDirectory=/opt/safebox-system-api
ExecStart=/usr/bin/node /opt/safebox-system-api/system-protocol-api.js
Restart=on-failure
RestartSec=10s

# Environment
Environment="SOCKET_PATH=/run/safebox/system-api.sock"
Environment="CONFIG_DIR=/etc/safebox"
Environment="STATE_DIR=/var/lib/safebox-system-api"
Environment="LOG_FILE=/var/log/safebox-system-api.log"

# Maximum security hardening
# Filesystem
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/safebox-system-api /var/log /run/safebox
ReadOnlyPaths=/etc/safebox

# Privileges
NoNewPrivileges=true
PrivateDevices=true

# Kernel
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true

# System calls
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

# Memory protections
MemoryDenyWriteExecute=true

# System call filtering
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete

# Capabilities (none needed)
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable safebox-system-api

echo "✓ Systemd service installed"

# 6. Start service
echo "[6/6] Starting service..."

systemctl start safebox-system-api

# Wait for socket
sleep 2

if systemctl is-active --quiet safebox-system-api; then
    echo "✓ Service started successfully"
else
    echo "⚠ Service failed to start - check: journalctl -u safebox-system-api"
    exit 1
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Configuration:"
echo "  • Safebox UID: $SAFEBOX_UID"
echo "  • API user: safebox-api (UID 999)"
echo "  • Socket: /run/safebox/system-api.sock"
echo "  • HMAC key: /etc/safebox/system-api.key (mode 0640)"
echo "  • Managed containers: /etc/safebox/managed-containers.json"
echo "  • State: /var/lib/safebox-system-api/"
echo "  • Logs: /var/log/safebox-system-api.log"
echo ""
echo "Test:"
echo "  curl --unix-socket /run/safebox/system-api.sock http://localhost/health"
echo ""
echo "Service management:"
echo "  systemctl status safebox-system-api"
echo "  journalctl -u safebox-system-api -f"
echo "  kill -HUP \$(pgrep -f system-protocol-api)  # Reload managed-containers.json"
echo ""
