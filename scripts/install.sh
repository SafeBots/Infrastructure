#!/bin/bash
# Safebox Infrastructure Installation Script

set -e

echo "=== Safebox Infrastructure Installation ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "ERROR: Please run as root"
    exit 1
fi

# 1. Create ZFS datasets
echo "[1/5] Creating ZFS datasets..."
zfs create -o mountpoint=/safebox tank/safebox 2>/dev/null || true

for dataset in nginx mariadb php node models ffmpeg typesense chromium system-api; do
    zfs create tank/safebox/$dataset 2>/dev/null || true
done

# Subdirectories
mkdir -p /safebox/nginx/{conf.d,ssl/cloudflare,ssl/letsencrypt,www,logs}
mkdir -p /safebox/mariadb/{data,conf,backup}
mkdir -p /safebox/php/sessions
mkdir -p /safebox/node/cache
mkdir -p /safebox/models/deepseek-r1
mkdir -p /safebox/ffmpeg/{temp,output}
mkdir -p /safebox/typesense/data
mkdir -p /safebox/chromium/downloads
mkdir -p /safebox/system-api/state/backoff

echo "✓ ZFS datasets created"

# 2. Create config directory
echo "[2/5] Creating config directories..."
mkdir -p /etc/safebox/secrets
cp config/container-registry.json /etc/safebox/

# Generate secrets
if [ ! -f /etc/safebox/secrets/mariadb_root_password.txt ]; then
    openssl rand -base64 32 > /etc/safebox/secrets/mariadb_root_password.txt
    chmod 600 /etc/safebox/secrets/mariadb_root_password.txt
fi

if [ ! -f /etc/safebox/secrets/typesense_api_key.txt ]; then
    openssl rand -base64 32 > /etc/safebox/secrets/typesense_api_key.txt
    chmod 600 /etc/safebox/secrets/typesense_api_key.txt
fi

echo "✓ Config created"

# 3. Install Docker (if needed)
echo "[3/5] Checking Docker..."
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    apt-get update
    apt-get install -y docker.io docker-compose
    systemctl enable docker
    systemctl start docker
fi
echo "✓ Docker ready"

# 4. Copy system-protocol-api
echo "[4/5] Installing system-protocol-api..."
cp docker/system-protocol-api.js /safebox/system-api/server.js
chmod +x /safebox/system-api/server.js
echo "✓ System API installed"

# 5. Start containers
echo "[5/5] Starting Docker containers..."
cd docker
docker-compose up -d

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Containers started:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Next steps:"
echo "1. Install Safebox plugin with Protocol.System (see SAFEBOX-INSTRUCTIONS.md)"
echo "2. Configure admin keys in /etc/safebox/container-registry.json"
echo "3. Test: curl http://localhost:4000/health"
echo ""
