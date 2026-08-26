#!/bin/bash
set -euo pipefail

# Restore app from ZFS snapshot (instant rollback)
#
# Usage: ./restore-from-snapshot.sh <app-name> <snapshot-name>

APP_NAME="$1"
SNAPSHOT_NAME="${2:-latest}"
POOL="${ZFS_POOL:-zpool}"
MYSQL_CONTAINER="safebox-mariadb"

if [ -z "$APP_NAME" ]; then
    echo "Usage: $0 <app-name> [snapshot-name]"
    echo ""
    echo "Examples:"
    echo "  $0 safebox latest"
    echo "  $0 community-x backup-20260427-120000"
    echo ""
    echo "Available snapshots:"
    zfs list -t snapshot | grep "$APP_NAME@" || echo "  (none)"
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

APP_DATA_DATASET="$POOL/app-data/$APP_NAME"
MYSQL_DATA_DATASET="$POOL/mysql-data"
APP_CONTAINER="safebox-app-$APP_NAME"

log "=== Restoring App: $APP_NAME ==="

# Find snapshot
if [ "$SNAPSHOT_NAME" = "latest" ]; then
    APP_SNAPSHOT=$(zfs list -t snapshot -o name -s creation "$APP_DATA_DATASET" | grep "@backup-" | tail -1)
    
    if [ -z "$APP_SNAPSHOT" ]; then
        error "No backup snapshots found for $APP_NAME"
    fi
    
    SNAPSHOT_NAME=$(echo "$APP_SNAPSHOT" | cut -d'@' -f2)
    log "Using latest snapshot: $SNAPSHOT_NAME"
else
    APP_SNAPSHOT="$APP_DATA_DATASET@$SNAPSHOT_NAME"
    
    if ! zfs list "$APP_SNAPSHOT" &>/dev/null; then
        error "Snapshot not found: $APP_SNAPSHOT"
    fi
fi

MYSQL_SNAPSHOT="$MYSQL_DATA_DATASET@$SNAPSHOT_NAME"

log "App snapshot: $APP_SNAPSHOT"
log "MySQL snapshot: $MYSQL_SNAPSHOT"

# Confirmation prompt
echo ""
echo "⚠️  WARNING: This will restore $APP_NAME to snapshot $SNAPSHOT_NAME"
echo "All changes since this snapshot will be LOST."
echo ""
read -p "Are you sure you want to continue? [y/N] " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log "Restore cancelled"
    exit 0
fi

# Step 1: Stop app container
log "Stopping app container..."
if docker ps --filter "name=$APP_CONTAINER" --format '{{.Names}}' | grep -q "$APP_CONTAINER"; then
    docker stop "$APP_CONTAINER" || log "Warning: Failed to stop container"
fi

# Step 2: Stop MySQL (to rollback database)
log "Stopping MySQL..."
docker stop "$MYSQL_CONTAINER"

# Step 3: Rollback app data (instant)
log "Rolling back app data..."
if zfs rollback -r "$APP_SNAPSHOT"; then
    log "✓ App data restored"
else
    error "Failed to rollback app data"
fi

# Step 4: Rollback MySQL data (instant)
log "Rolling back MySQL data..."
if zfs list "$MYSQL_SNAPSHOT" &>/dev/null; then
    if zfs rollback -r "$MYSQL_SNAPSHOT"; then
        log "✓ MySQL data restored"
    else
        log "Warning: Failed to rollback MySQL (might not have snapshot from same time)"
    fi
else
    log "Warning: MySQL snapshot not found (skipping database restore)"
fi

# Step 5: Start MySQL
log "Starting MySQL..."
docker start "$MYSQL_CONTAINER"

# Wait for MySQL to be ready
log "Waiting for MySQL to be ready..."
for i in {1..30}; do
    if docker exec "$MYSQL_CONTAINER" mysqladmin ping --silent 2>/dev/null; then
        log "✓ MySQL ready"
        break
    fi
    sleep 1
done

# Step 6: Start app container
log "Starting app container..."
docker start "$APP_CONTAINER"

log ""
log "=== Restore Complete ==="
log "App: $APP_NAME"
log "Snapshot: $SNAPSHOT_NAME"
log "Container: $APP_CONTAINER"
log ""
log "Verify the restore:"
log "  docker logs $APP_CONTAINER"
log "  https://$APP_NAME.example.com"
