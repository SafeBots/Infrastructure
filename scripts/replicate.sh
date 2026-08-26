#!/bin/bash
set -euo pipefail

# Replicate ZFS snapshots to peer Safebox
# Uses zfs send/recv over SSH for efficient incremental replication
#
# Usage: ./replicate-to-peer.sh <app-name> <peer-url> [--full]

APP_NAME="$1"
PEER_URL="${2:-}"
FORCE_FULL="${3:-}"
POOL="${ZFS_POOL:-zpool}"

if [ -z "$APP_NAME" ] || [ -z "$PEER_URL" ]; then
    echo "Usage: $0 <app-name> <peer-url> [--full]"
    echo ""
    echo "Examples:"
    echo "  $0 safebox backup@peer.safebox.com:/backups"
    echo "  $0 community-x backup@peer.safebox.com:/backups --full"
    echo ""
    echo "Setup SSH key first:"
    echo "  ssh-keygen -t ed25519 -f /etc/safebox/backup.key"
    echo "  ssh-copy-id -i /etc/safebox/backup.key backup@peer.safebox.com"
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

# Parse peer URL
PEER_HOST=$(echo "$PEER_URL" | cut -d':' -f1)
PEER_BASE_PATH=$(echo "$PEER_URL" | cut -d':' -f2)
SSH_KEY="/etc/safebox/backup.key"

APP_DATA_DATASET="$POOL/app-data/$APP_NAME"
MYSQL_DATA_DATASET="$POOL/mysql-data"

log "=== Replicating to Peer ==="
log "App: $APP_NAME"
log "Peer: $PEER_HOST"
log "Destination: $PEER_BASE_PATH/$APP_NAME"

# Check SSH connectivity
if ! ssh -i "$SSH_KEY" -o ConnectTimeout=5 "$PEER_HOST" "echo 'Connected'" &>/dev/null; then
    error "Cannot connect to peer: $PEER_HOST (check SSH key at $SSH_KEY)"
fi

# Get latest snapshot
LATEST_SNAPSHOT=$(zfs list -t snapshot -o name -s creation "$APP_DATA_DATASET" | grep "@backup-" | tail -1)

if [ -z "$LATEST_SNAPSHOT" ]; then
    error "No backup snapshots found. Run: ./backup-with-zfs.sh $APP_NAME"
fi

SNAPSHOT_NAME=$(echo "$LATEST_SNAPSHOT" | cut -d'@' -f2)
log "Latest snapshot: $SNAPSHOT_NAME"

# Function to replicate dataset
replicate_dataset() {
    local DATASET="$1"
    local PEER_DEST="$2"
    local SNAPSHOT="$DATASET@$SNAPSHOT_NAME"
    
    log "Replicating $DATASET..."
    
    # Check if peer has previous snapshot for incremental send
    PREV_SNAPSHOT=""
    if [ "$FORCE_FULL" != "--full" ]; then
        PREV_SNAPSHOT=$(zfs list -t snapshot -o name -s creation "$DATASET" | grep "@backup-" | tail -2 | head -1 || echo "")
    fi
    
    if [ -n "$PREV_SNAPSHOT" ] && [ "$PREV_SNAPSHOT" != "$SNAPSHOT" ]; then
        log "Incremental send from: $PREV_SNAPSHOT"
        
        # Check if peer has the base snapshot
        PREV_NAME=$(echo "$PREV_SNAPSHOT" | cut -d'@' -f2)
        if ssh -i "$SSH_KEY" "$PEER_HOST" "zfs list $PEER_DEST@$PREV_NAME" &>/dev/null; then
            # Incremental send (much faster - only deltas)
            BYTES_SENT=$(zfs send -i "$PREV_SNAPSHOT" "$SNAPSHOT" | \
                pv -s $(zfs send -nP -i "$PREV_SNAPSHOT" "$SNAPSHOT" 2>&1 | grep size | awk '{print $2}') | \
                ssh -i "$SSH_KEY" "$PEER_HOST" "zfs recv -F $PEER_DEST" 2>&1 | \
                grep -oP '\d+(?= bytes)' || echo "0")
            
            log "✓ Sent $(numfmt --to=iec $BYTES_SENT) (incremental)"
        else
            log "Peer missing base snapshot, switching to full send"
            PREV_SNAPSHOT=""
        fi
    fi
    
    if [ -z "$PREV_SNAPSHOT" ] || [ "$PREV_SNAPSHOT" = "$SNAPSHOT" ]; then
        log "Full send"
        
        # Full send
        BYTES_SENT=$(zfs send "$SNAPSHOT" | \
            pv -s $(zfs send -nP "$SNAPSHOT" 2>&1 | grep size | awk '{print $2}') | \
            ssh -i "$SSH_KEY" "$PEER_HOST" "zfs recv -F $PEER_DEST" 2>&1 | \
            grep -oP '\d+(?= bytes)' || echo "0")
        
        log "✓ Sent $(numfmt --to=iec $BYTES_SENT) (full)"
    fi
}

# Replicate app data
replicate_dataset "$APP_DATA_DATASET" "$PEER_BASE_PATH/$APP_NAME/data"

# Replicate MySQL data (contains all databases, but incremental is efficient)
replicate_dataset "$MYSQL_DATA_DATASET" "$PEER_BASE_PATH/$APP_NAME/mysql"

# Verify replication
log "Verifying replication..."
if ssh -i "$SSH_KEY" "$PEER_HOST" "zfs list $PEER_BASE_PATH/$APP_NAME/data@$SNAPSHOT_NAME" &>/dev/null; then
    log "✓ App data verified on peer"
else
    error "Verification failed: App data not found on peer"
fi

if ssh -i "$SSH_KEY" "$PEER_HOST" "zfs list $PEER_BASE_PATH/$APP_NAME/mysql@$SNAPSHOT_NAME" &>/dev/null; then
    log "✓ MySQL data verified on peer"
else
    log "Warning: MySQL data not found on peer"
fi

log ""
log "=== Replication Complete ==="
log "App: $APP_NAME"
log "Snapshot: $SNAPSHOT_NAME"
log "Peer: $PEER_HOST:$PEER_BASE_PATH/$APP_NAME"
log ""
log "To restore from peer:"
log "  ssh $PEER_HOST 'zfs send $PEER_BASE_PATH/$APP_NAME/data@$SNAPSHOT_NAME' | zfs recv -F $APP_DATA_DATASET"
