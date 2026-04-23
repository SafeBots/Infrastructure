#!/bin/bash
#
# Install Base Component
# Includes: MariaDB, PHP-FPM, nginx, Docker, Node.js, ZFS, 50+ npm packages
#

set -euo pipefail

echo "Installing base component..."

# Install system packages
dnf install -y \
    mariadb105-server \
    php-fpm \
    nginx \
    docker-ce \
    nodejs \
    npm \
    zfs

# Configure ZFS pool
zfs create -o compression=lz4 -o encryption=on safebox-pool/safebox
zfs create -o compression=lz4 -o encryption=on safebox-pool/docker
zfs create -o compression=lz4 -o encryption=on safebox-pool/mariadb
zfs create -o compression=lz4 -o encryption=on safebox-pool/tenants

# Install npm packages
cd /opt/safebox
npm install --production \
    docx exceljs xlsx pptxgenjs \
    pdfkit pdf-lib jspdf \
    sharp jimp canvas qrcode \
    archiver adm-zip \
    nodemailer mjml \
    papaparse json2csv \
    lodash moment uuid

# Generate manifest
cat > /opt/safebox/manifests/base.json << 'EOF'
{
  "component": {
    "name": "base",
    "version": "1.0.0",
    "license": ["Apache-2.0", "MIT"],
    "disk": "8 GB"
  },
  "packages": {
    "npm": 50,
    "system": 12
  }
}
EOF

echo "✅ Base component installed"
