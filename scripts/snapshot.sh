#!/bin/bash
set -euo pipefail

# Manage ZFS snapshots with retention policies
#
# Usage: ./snapshot-manager.sh <command> [options]
#
# Commands:
#   list <app-name>              - List all snapshots
#   create <app-name> [tag]      - Create snapshot (before/after changes)
#   cleanup <app-name> [days]    - Delete snapshots older than N days
#   auto-snapshot                - Create hourly/daily snapshots for all apps

COMMAND="${1:-}"
APP_NAME="${2:-}"
POOL="${ZFS_POOL:-zpool}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    log "ERROR: $*" >&2
    exit 1
}

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  list <app-name>              List all snapshots"
    echo "  create <app-name> [tag]      Create snapshot (before/after changes)"
    echo "  cleanup <app-name> [days]    Delete snapshots older than N days"
    echo "  auto-snapshot                Create hourly/daily snapshots for all apps"
    echo ""
    echo "Examples:"
    echo "  $0 list safebox"
    echo "  $0 create safebox before-upgrade"
    echo "  $0 cleanup safebox 30"
    echo "  $0 auto-snapshot"
    exit 1
}

# List snapshots
cmd_list() {
    local APP="$1"
    local DATASET="$POOL/app-data/$APP"
    
    if ! zfs list "$DATASET" &>/dev/null; then
        error "App not found: $APP"
    fi
    
    echo "Snapshots for $APP:"
    echo ""
    
    zfs list -t snapshot -o name,creation,used "$DATASET" | grep "@" || echo "  (none)"
}

# Create snapshot
cmd_create() {
    local APP="$1"
    local TAG="${2:-manual}"
    local TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    local SNAPSHOT_NAME="${TAG}-${TIMESTAMP}"
    
    local APP_DATASET="$POOL/app-data/$APP"
    
    if ! zfs list "$APP_DATASET" &>/dev/null; then
        error "App not found: $APP"
    fi
    
    log "Creating snapshot: $SNAPSHOT_NAME"
    
    # Snapshot app data
    if zfs snapshot "$APP_DATASET@$SNAPSHOT_NAME"; then
        log "✓ Created: $APP_DATASET@$SNAPSHOT_NAME"
    else
        error "Failed to create snapshot"
    fi
    
    # Also snapshot MySQL if this is a backup
    if [ "$TAG" = "backup" ] || [ "$TAG" = "before-upgrade" ]; then
        local MYSQL_DATASET="$POOL/mysql-data"
        if zfs snapshot "$MYSQL_DATASET@$APP-$SNAPSHOT_NAME"; then
            log "✓ Created: $MYSQL_DATASET@$APP-$SNAPSHOT_NAME"
        fi
    fi
}

# Cleanup old snapshots
cmd_cleanup() {
    local APP="$1"
    local RETENTION_DAYS="${2:-7}"
    local DATASET="$POOL/app-data/$APP"
    
    if ! zfs list "$DATASET" &>/dev/null; then
        error "App not found: $APP"
    fi
    
    log "Cleaning up snapshots older than $RETENTION_DAYS days for $APP"
    
    local CUTOFF_DATE=$(date -d "$RETENTION_DAYS days ago" +%Y%m%d)
    local DELETED=0
    
    for snapshot in $(zfs list -t snapshot -o name "$DATASET" | grep "@"); do
        # Extract date from snapshot name (format: @tag-YYYYMMDD-HHMMSS)
        SNAP_DATE=$(echo "$snapshot" | grep -oP '\d{8}' | head -1 || echo "")
        
        if [ -n "$SNAP_DATE" ] && [ "$SNAP_DATE" -lt "$CUTOFF_DATE" ]; then
            log "Deleting: $snapshot"
            if zfs destroy "$snapshot"; then
                ((DELETED++))
            else
                log "Warning: Failed to delete $snapshot"
            fi
        fi
    done
    
    log "✓ Deleted $DELETED snapshots"
}

# Auto-snapshot (called by cron)
cmd_auto_snapshot() {
    log "Running auto-snapshot for all apps"
    
    # Get all apps
    local APPS=$(zfs list -o name "$POOL/app-data" | grep "$POOL/app-data/" | cut -d'/' -f3 | sort -u)
    
    if [ -z "$APPS" ]; then
        log "No apps found"
        return
    fi
    
    local HOUR=$(date +%H)
    
    for APP in $APPS; do
        # Hourly snapshots
        cmd_create "$APP" "hourly"
        
        # Daily snapshot at midnight
        if [ "$HOUR" = "00" ]; then
            cmd_create "$APP" "daily"
        fi
        
        # Cleanup: keep hourly for 24h, daily for 30d
        log "Cleaning up hourly snapshots (24h retention)"
        for snapshot in $(zfs list -t snapshot -o name,creation "$POOL/app-data/$APP" | grep "@hourly-" | awk '{print $1}'); do
            SNAP_TIME=$(zfs get -H -o value creation "$snapshot" | date -f - +%s)
            NOW=$(date +%s)
            AGE_HOURS=$(( ($NOW - $SNAP_TIME) / 3600 ))
            
            if [ $AGE_HOURS -gt 24 ]; then
                log "Deleting hourly snapshot: $snapshot (age: ${AGE_HOURS}h)"
                zfs destroy "$snapshot" || true
            fi
        done
        
        log "Cleaning up daily snapshots (30d retention)"
        cmd_cleanup "$APP" 30
    done
    
    log "✓ Auto-snapshot complete"
}

# Main
case "$COMMAND" in
    list)
        [ -z "$APP_NAME" ] && usage
        cmd_list "$APP_NAME"
        ;;
    create)
        [ -z "$APP_NAME" ] && usage
        TAG="${3:-manual}"
        cmd_create "$APP_NAME" "$TAG"
        ;;
    cleanup)
        [ -z "$APP_NAME" ] && usage
        DAYS="${3:-7}"
        cmd_cleanup "$APP_NAME" "$DAYS"
        ;;
    auto-snapshot)
        cmd_auto_snapshot
        ;;
    *)
        usage
        ;;
esac
