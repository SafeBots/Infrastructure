#!/bin/bash
set -euo pipefail

# Create ZFS clone for a new app
# Usage: ./create-app-clone.sh <app-name>

APP_NAME="$1"
POOL="${ZFS_POOL:-zpool}"
PLATFORM_DATASET="$POOL/qbix-platform"
PLATFORM_BASE_SNAPSHOT="$PLATFORM_DATASET@base"
APP_CLONE="$PLATFORM_DATASET/$APP_NAME"
APP_DATA_DATASET="$POOL/app-data/$APP_NAME"

if [ -z "$APP_NAME" ]; then
    echo "Usage: $0 <app-name>"
    echo ""
    echo "Examples:"
    echo "  $0 safebox"
    echo "  $0 community-x"
    echo "  $0 my-business"
    exit 1
fi

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    log "ERROR: $*" >&2
    exit 1
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    error "This script must be run as root"
fi

# Check if base snapshot exists
if ! zfs list "$PLATFORM_BASE_SNAPSHOT" &>/dev/null; then
    error "Base snapshot not found: $PLATFORM_BASE_SNAPSHOT"
    echo "Run: ./setup-zfs-clones.sh first"
    exit 1
fi

log "=== Creating App Clone ==="
log "App name: $APP_NAME"
log "Base snapshot: $PLATFORM_BASE_SNAPSHOT"

# Create platform clone
if zfs list "$APP_CLONE" &>/dev/null; then
    log "Platform clone already exists: $APP_CLONE"
else
    log "Creating platform clone..."
    zfs clone "$PLATFORM_BASE_SNAPSHOT" "$APP_CLONE"
    
    # Set quota (10GB for platform clone)
    zfs set quota=10G "$APP_CLONE"
    
    log "✓ Platform clone created: $APP_CLONE"
fi

# Get platform mount point
PLATFORM_MOUNT=$(zfs get -H -o value mountpoint "$APP_CLONE")
log "Platform mount: $PLATFORM_MOUNT"

# Create app data dataset
if ! zfs list "$APP_DATA_DATASET" &>/dev/null; then
    log "Creating app data dataset..."
    zfs create -p "$APP_DATA_DATASET"
    
    # Set compression
    zfs set compression=lz4 "$APP_DATA_DATASET"
    
    # Set quota (100GB for app data)
    zfs set quota=100G "$APP_DATA_DATASET"
    
    # Set ownership
    APP_DATA_MOUNT=$(zfs get -H -o value mountpoint "$APP_DATA_DATASET")
    chown -R 1000:1000 "$APP_DATA_MOUNT"
    
    log "✓ App data dataset created: $APP_DATA_DATASET"
else
    log "App data dataset already exists: $APP_DATA_DATASET"
fi

APP_DATA_MOUNT=$(zfs get -H -o value mountpoint "$APP_DATA_DATASET")
log "App data mount: $APP_DATA_MOUNT"

# Create MySQL database
log "Creating MySQL database..."
DB_NAME=$(echo "$APP_NAME" | tr '-' '_')
if mysql -e "USE $DB_NAME" 2>/dev/null; then
    log "Database already exists: $DB_NAME"
else
    mysql -e "CREATE DATABASE $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    log "✓ Database created: $DB_NAME"
fi

log ""
log "=== Clone Ready ==="
log "Platform: $PLATFORM_MOUNT (read-only)"
log "App Data: $APP_DATA_MOUNT (read-write)"
log "Database: $DB_NAME"
log ""
log "Add to docker-compose.yml:"
log ""
cat << EOF
  safebox-app-$APP_NAME:
    image: qbix/app:latest
    container_name: safebox-app-$APP_NAME
    networks:
      - safebox-net
    user: "1000:1000"
    environment:
      APP_NAME: $(echo "$APP_NAME" | sed -E 's/(^|-)([a-z])/\U\2/g')
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
      MYSQL_DB: $DB_NAME
    volumes:
      # Platform: ZFS clone (read-only)
      - $PLATFORM_MOUNT:/opt/qbix/platform:ro
      
      # App data: ZFS dataset (read-write)
      - $APP_DATA_MOUNT:/opt/qbix/app
      
      # Shared sockets
      - safebox-sockets:/run/safebox/services
      
      # Keys
      - /etc/safebox:/etc/safebox:ro
    restart: unless-stopped
EOF
log ""
log "Start with: docker-compose up -d safebox-app-$APP_NAME"
