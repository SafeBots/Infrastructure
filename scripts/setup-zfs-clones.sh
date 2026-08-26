#!/bin/bash
set -euo pipefail

# Setup ZFS base snapshot for Qbix Platform
# This creates the base from which all app clones are made

POOL="${ZFS_POOL:-zpool}"
PLATFORM_DATASET="$POOL/qbix-platform"
PLATFORM_BASE_SNAPSHOT="$PLATFORM_DATASET@base"
PLATFORM_SOURCE="${PLATFORM_SOURCE:-/opt/qbix-platform}"

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

# Check if ZFS is installed
if ! command -v zfs &> /dev/null; then
    error "ZFS not installed. Install: apt install zfsutils-linux"
fi

# Check if pool exists
if ! zpool list "$POOL" &> /dev/null; then
    error "ZFS pool '$POOL' not found. Create with: zpool create $POOL /dev/sdX"
fi

log "=== Setting up ZFS Platform Base ==="
log "Pool: $POOL"
log "Platform dataset: $PLATFORM_DATASET"

# Create platform dataset if doesn't exist
if ! zfs list "$PLATFORM_DATASET" &>/dev/null; then
    log "Creating platform dataset..."
    zfs create "$PLATFORM_DATASET"
    
    # Set compression
    zfs set compression=lz4 "$PLATFORM_DATASET"
    
    # Disable access time updates (performance)
    zfs set atime=off "$PLATFORM_DATASET"
    
    # Set quota (optional)
    # zfs set quota=10G "$PLATFORM_DATASET"
    
    log "✓ Platform dataset created"
else
    log "Platform dataset already exists"
fi

# Get mount point
MOUNT_POINT=$(zfs get -H -o value mountpoint "$PLATFORM_DATASET")
log "Mount point: $MOUNT_POINT"

# Install platform code
if [ ! -d "$MOUNT_POINT/platform" ]; then
    log "Installing Qbix platform..."
    
    if [ -d "$PLATFORM_SOURCE" ]; then
        log "Copying from: $PLATFORM_SOURCE"
        rsync -a "$PLATFORM_SOURCE/" "$MOUNT_POINT/"
    else
        log "Cloning from GitHub..."
        git clone https://github.com/Qbix/Platform.git "$MOUNT_POINT/"
    fi
    
    # Set ownership
    chown -R 1000:1000 "$MOUNT_POINT"
    
    log "✓ Platform code installed"
else
    log "Platform code already exists"
fi

# Check if base snapshot exists
if zfs list "$PLATFORM_BASE_SNAPSHOT" &>/dev/null; then
    log "Base snapshot already exists: $PLATFORM_BASE_SNAPSHOT"
    
    read -p "Do you want to create a new snapshot with timestamp? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        TIMESTAMP=$(date +%Y%m%d-%H%M%S)
        NEW_SNAPSHOT="$PLATFORM_DATASET@$TIMESTAMP"
        log "Creating snapshot: $NEW_SNAPSHOT"
        zfs snapshot "$NEW_SNAPSHOT"
        log "✓ New snapshot created: $NEW_SNAPSHOT"
    fi
else
    log "Creating base snapshot..."
    zfs snapshot "$PLATFORM_BASE_SNAPSHOT"
    log "✓ Base snapshot created: $PLATFORM_BASE_SNAPSHOT"
fi

log ""
log "=== Setup Complete ==="
log "Base snapshot: $PLATFORM_BASE_SNAPSHOT"
log "Mount point: $MOUNT_POINT"
log ""
log "Next steps:"
log "1. Create app clones: ./create-app-clone.sh <app-name>"
log "2. Update docker-compose.yml with ZFS paths"
log "3. Start containers"
