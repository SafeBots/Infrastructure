#!/bin/bash
set -euo pipefail

# Backup app using ZFS snapshots
# This captures both MySQL database and app files in one atomic snapshot
#
# Usage: ./backup-with-zfs.sh <app-name> [--replicate-to <peer-url>]

APP_NAME="$1"
REPLICATE_TO="${3:-}"
POOL="${ZFS_POOL:-zpool}"
MYSQL_CONTAINER="safebox-mariadb"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_NAME="backup-${TIMESTAMP}"

if [ -z "$APP_NAME" ]; then
    echo "Usage: $0 <app-name> [--replicate-to <peer-url>]"
    echo ""
    echo "Examples:"
    echo "  $0 safebox"
    echo "  $0 community-x --replicate-to backup@peer.safebox.com"
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
DB_NAME=$(echo "$APP_NAME" | tr '-' '_')

log "=== Backing Up App: $APP_NAME ==="
log "App data dataset: $APP_DATA_DATASET"
log "MySQL dataset: $MYSQL_DATA_DATASET"
log "Database: $DB_NAME"

# Check if datasets exist
if ! zfs list "$APP_DATA_DATASET" &>/dev/null; then
    error "App data dataset not found: $APP_DATA_DATASET"
fi

if ! zfs list "$MYSQL_DATA_DATASET" &>/dev/null; then
    error "MySQL data dataset not found: $MYSQL_DATA_DATASET"
fi

# Step 1: Flush and lock MySQL tables
log "Flushing MySQL tables..."
docker exec "$MYSQL_CONTAINER" mysql -e "FLUSH TABLES WITH READ LOCK; SYSTEM sleep 2" &
MYSQL_PID=$!

# Give MySQL time to flush
sleep 1

# Step 2: Create ZFS snapshots (while tables are locked)
log "Creating ZFS snapshots..."

# Snapshot app data
APP_SNAPSHOT="$APP_DATA_DATASET@$SNAPSHOT_NAME"
if zfs snapshot "$APP_SNAPSHOT"; then
    log "✓ App data snapshot: $APP_SNAPSHOT"
else
    error "Failed to create app data snapshot"
fi

# Snapshot MySQL data (contains all databases)
MYSQL_SNAPSHOT="$MYSQL_DATA_DATASET@$SNAPSHOT_NAME"
if zfs snapshot "$MYSQL_SNAPSHOT"; then
    log "✓ MySQL snapshot: $MYSQL_SNAPSHOT"
else
    error "Failed to create MySQL snapshot"
fi

# Step 3: Unlock MySQL tables
log "Unlocking MySQL tables..."
docker exec "$MYSQL_CONTAINER" mysql -e "UNLOCK TABLES" || true
wait $MYSQL_PID || true

log "✓ Backup snapshots created"

# Step 4: Replicate to peer (if specified)
if [ -n "$REPLICATE_TO" ]; then
    log "Replicating to peer: $REPLICATE_TO"
    
    # Extract peer host and path
    PEER_HOST=$(echo "$REPLICATE_TO" | cut -d':' -f1)
    PEER_BASE_PATH=$(echo "$REPLICATE_TO" | cut -d':' -f2)
    
    # Find previous snapshot for incremental send
    PREV_SNAPSHOT=$(zfs list -t snapshot -o name -s creation "$APP_DATA_DATASET" | grep "@backup-" | tail -2 | head -1 || echo "")
    
    if [ -n "$PREV_SNAPSHOT" ] && [ "$PREV_SNAPSHOT" != "$APP_SNAPSHOT" ]; then
        log "Incremental send from: $PREV_SNAPSHOT"
        
        # Incremental send (only deltas)
        zfs send -i "$PREV_SNAPSHOT" "$APP_SNAPSHOT" | \
            ssh "$PEER_HOST" "zfs recv -F $PEER_BASE_PATH/$APP_NAME"
    else
        log "Full send (no previous snapshot)"
        
        # Full send
        zfs send "$APP_SNAPSHOT" | \
            ssh "$PEER_HOST" "zfs recv -F $PEER_BASE_PATH/$APP_NAME"
    fi
    
    log "✓ Replicated app data to peer"
    
    # Also replicate MySQL snapshot (contains app's database)
    PREV_MYSQL=$(zfs list -t snapshot -o name -s creation "$MYSQL_DATA_DATASET" | grep "@backup-" | tail -2 | head -1 || echo "")
    
    if [ -n "$PREV_MYSQL" ] && [ "$PREV_MYSQL" != "$MYSQL_SNAPSHOT" ]; then
        zfs send -i "$PREV_MYSQL" "$MYSQL_SNAPSHOT" | \
            ssh "$PEER_HOST" "zfs recv -F $PEER_BASE_PATH/mysql"
    else
        zfs send "$MYSQL_SNAPSHOT" | \
            ssh "$PEER_HOST" "zfs recv -F $PEER_BASE_PATH/mysql"
    fi
    
    log "✓ Replicated MySQL data to peer"
fi

# Step 5: Cleanup old snapshots (keep last 7 days)
log "Cleaning up old snapshots..."
RETENTION_DAYS=7
CUTOFF_DATE=$(date -d "$RETENTION_DAYS days ago" +%Y%m%d)

for snapshot in $(zfs list -t snapshot -o name "$APP_DATA_DATASET" | grep "@backup-"); do
    SNAP_DATE=$(echo "$snapshot" | grep -oP '\d{8}' | head -1)
    
    if [ "$SNAP_DATE" -lt "$CUTOFF_DATE" ]; then
        log "Deleting old snapshot: $snapshot"
        zfs destroy "$snapshot" || log "Warning: Failed to delete $snapshot"
    fi
done

log ""
log "=== Backup Complete ==="
log "App snapshot: $APP_SNAPSHOT"
log "MySQL snapshot: $MYSQL_SNAPSHOT"

if [ -n "$REPLICATE_TO" ]; then
    log "Replicated to: $REPLICATE_TO"
fi

log ""
log "To restore this backup:"
log "  ./restore-from-snapshot.sh $APP_NAME $SNAPSHOT_NAME"
