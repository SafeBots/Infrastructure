# ZFS Integration for Safebox: Complete Guide

## MariaDB + ZFS Optimization

### **InnoDB Settings for ZFS**

ZFS works best with specific InnoDB configurations to avoid double-buffering and optimize I/O:

```ini
# /etc/my.cnf.d/safebox-mariadb-zfs.cnf

[mysqld]
# === ZFS-OPTIMIZED SETTINGS ===

# File per table (CRITICAL for ZFS snapshots)
innodb_file_per_table = 1

# Disable double-write buffer (ZFS handles consistency via CoW)
innodb_doublewrite = 0

# Use O_DIRECT (bypass OS cache, let ZFS ARC handle caching)
innodb_flush_method = O_DIRECT

# Page size matches ZFS recordsize (16K default)
innodb_page_size = 16K

# Disable adaptive flushing (ZFS handles flush timing better)
innodb_adaptive_flushing = 0

# Flush log at transaction commit (for snapshot consistency)
innodb_flush_log_at_trx_commit = 1

# Sync binary log on commit (for point-in-time recovery)
sync_binlog = 1

# === BUFFER POOL (Smaller than without ZFS) ===
# ZFS ARC handles most caching, so MariaDB needs less RAM
innodb_buffer_pool_size = 4G
# (vs 8G without ZFS - ZFS ARC uses the other 12G)

# === REDO LOGS ===
innodb_log_file_size = 512M
innodb_log_files_in_group = 2

# === BINARY LOGS (For PITR) ===
log_bin = /srv/encrypted/mysql/binlog/mariadb-bin
binlog_format = ROW
expire_logs_days = 7

# === GENERAL ===
datadir = /srv/encrypted/mysql
socket = /var/lib/mysql/mysql.sock
max_connections = 500
```

### **Why These Settings?**

**1. `innodb_doublewrite = 0`** (CRITICAL)
```
Without ZFS:
- InnoDB writes page twice (doublewrite buffer + data file)
- Protects against partial page writes
- Overhead: 2x write amplification

With ZFS:
- ZFS Copy-on-Write guarantees atomic writes
- Never have partial page writes
- Disable doublewrite → 2x faster writes!
```

**2. `innodb_flush_method = O_DIRECT`**
```
Without ZFS:
- InnoDB → OS page cache → disk
- Double buffering (InnoDB buffer pool + OS cache)

With ZFS:
- InnoDB → ZFS ARC → disk
- Single buffering (ZFS ARC is smarter than OS cache)
- O_DIRECT bypasses OS cache
```

**3. `innodb_file_per_table = 1`** (REQUIRED)
```
With innodb_file_per_table=1:
├── acme_web/
│   ├── users.ibd (one table)
│   ├── posts.ibd (one table)
│   └── comments.ibd (one table)

Benefits for ZFS:
- Snapshot individual tables
- ZFS dedup works better (similar tables share blocks)
- Compression works better (per-table)
- Can move individual tables between datasets
```

**4. `innodb_page_size = 16K`**
```
ZFS recordsize: 16K default (or 128K)
InnoDB page size: 16K default

Match these for optimal I/O:
- One InnoDB page = one ZFS record
- No wasted space
- Better compression
```

---

## ZFS Snapshot with FLUSH TABLES

### **Safe Snapshot Procedure**

```bash
#!/bin/bash
# /srv/safebox/bin/zfs-snapshot-db.sh
#
# Create consistent ZFS snapshot of MariaDB
#

DATASET=$1  # e.g., safebox-pool/mysql/acme_web
SNAPSHOT_NAME=$2  # e.g., before-migration

# Connect to MariaDB
mysql -e "FLUSH TABLES WITH READ LOCK; SYSTEM zfs snapshot ${DATASET}@${SNAPSHOT_NAME}; UNLOCK TABLES;"

echo "Created snapshot: ${DATASET}@${SNAPSHOT_NAME}"
```

### **Why FLUSH TABLES?**

```
FLUSH TABLES WITH READ LOCK:
1. Flushes all dirty pages to disk
2. Closes all open tables
3. Acquires global read lock
4. Filesystem is now consistent
5. Take ZFS snapshot (instant, <1 second)
6. Release lock
7. Total lock time: ~1-2 seconds
```

### **Alternative: InnoDB-Only (No Lock)**

If **all tables are InnoDB** (no MyISAM), you don't need FLUSH TABLES:

```bash
#!/bin/bash
# ZFS snapshot without locks (InnoDB crash recovery)

DATASET=$1
SNAPSHOT_NAME=$2

# Just snapshot (InnoDB will recover on restore)
zfs snapshot ${DATASET}@${SNAPSHOT_NAME}

echo "Created snapshot: ${DATASET}@${SNAPSHOT_NAME}"
echo "InnoDB will auto-recover on restore (crash-consistent)"
```

**This works because:**
- InnoDB is crash-consistent (redo logs)
- ZFS snapshot is atomic (CoW)
- On restore, InnoDB replays redo logs
- Same as XtraBackup or server crash

**RECOMMENDATION:** Use FLUSH TABLES for important snapshots (migrations, backups), use no-lock for frequent snapshots (hourly)

---

## ZFS Pool Basics

### **What is a ZFS Pool?**

```
ZFS Pool (zpool) = Storage Pool
├── Made from one or more physical devices (disks, partitions, EBS volumes)
├── Provides storage capacity
├── Handles RAID, redundancy, checksums
└── Contains datasets (filesystems)

Dataset = Filesystem or Volume
├── Like a directory that can be mounted
├── Has its own properties (compression, encryption, quota)
├── Can be snapshotted independently
└── Can have child datasets (nested)
```

### **Example: Safebox Pool Structure**

```
Physical Layer:
└── /dev/xvdf (100GB encrypted EBS volume)

ZFS Pool Layer:
└── safebox-pool (pool created from /dev/xvdf)
    
Dataset Layer:
├── safebox-pool/mysql (dataset)
│   ├── safebox-pool/mysql/acme_web (child dataset)
│   ├── safebox-pool/mysql/acme_blog (child dataset)
│   └── safebox-pool/mysql/beta_app (child dataset)
│
├── safebox-pool/apps (dataset)
│   ├── safebox-pool/apps/acme (child dataset)
│   │   ├── safebox-pool/apps/acme/website (child dataset)
│   │   └── safebox-pool/apps/acme/blog (child dataset)
│   └── safebox-pool/apps/beta (child dataset)
│
└── safebox-pool/models (dataset)
```

### **Key Concepts**

**1. Pool** = Storage container
- Created from physical devices
- Can span multiple devices
- Handles redundancy (mirrors, RAID-Z)

**2. Dataset** = Filesystem
- Lives inside pool
- Can be mounted (like `/srv/encrypted/mysql`)
- Has properties (compression, quota, etc.)

**3. Snapshot** = Point-in-time copy
- Read-only
- Zero space initially (copy-on-write)
- Named with `@`: `safebox-pool/mysql/acme_web@snapshot1`

**4. Clone** = Writable snapshot
- Can be modified
- Shares blocks with parent snapshot
- Named normally: `safebox-pool/mysql/acme_web_test`

---

## ZFS Pool Initialization

### **Step-by-Step Setup**

#### **Step 1: Prepare EBS Volume**

```bash
# Create encrypted EBS volume (via AWS Console or CLI)
aws ec2 create-volume \
    --size 100 \
    --availability-zone us-east-1a \
    --volume-type gp3 \
    --encrypted \
    --kms-key-id alias/safebox-key

# Attach to instance
aws ec2 attach-volume \
    --volume-id vol-xxxxx \
    --instance-id i-xxxxx \
    --device /dev/xvdf

# Wait for attachment
sleep 5

# Verify device exists
lsblk | grep xvdf
# Should show: xvdf  202:80   0  100G  0 disk
```

#### **Step 2: Load ZFS Module**

```bash
# Load ZFS kernel module
modprobe zfs

# Verify loaded
lsmod | grep zfs
# Should show: zfs, zcommon, znvpair, etc.

# Auto-load on boot
echo "zfs" > /etc/modules-load.d/zfs.conf
```

#### **Step 3: Create ZFS Pool**

```bash
#!/bin/bash
# /srv/safebox/bin/initialize-zfs-pool.sh

set -euo pipefail

EBS_DEVICE=/dev/xvdf
POOL_NAME=safebox-pool

echo "Creating ZFS pool: $POOL_NAME on $EBS_DEVICE"

# Create pool with optimal settings
zpool create \
    -o ashift=12 \
    -O atime=off \
    -O compression=lz4 \
    -O recordsize=16K \
    -O sync=standard \
    -O xattr=sa \
    -O dnodesize=auto \
    -O encryption=aes-256-gcm \
    -O keyformat=passphrase \
    -O keylocation=file:///srv/safebox/config/zfs-key.txt \
    $POOL_NAME \
    $EBS_DEVICE

echo "Pool created successfully"

# Verify
zpool status $POOL_NAME
```

**Flag Explanations:**

**`-o ashift=12`**
- Sector size = 2^12 = 4096 bytes (4K)
- Modern drives use 4K sectors
- Critical for performance!

**`-O atime=off`**
- Don't update access time on file reads
- Huge performance boost (avoids writes on reads)
- Use `relatime` if you need access times

**`-O compression=lz4`**
- Enable LZ4 compression (fast, ~3x speedup)
- Transparent to applications
- Alternative: `zstd` (better ratio, more CPU)

**`-O recordsize=16K`**
- Match InnoDB page size (16K)
- One InnoDB page = one ZFS record
- Better compression and I/O

**`-O sync=standard`**
- Respect sync requests (like fsync)
- Important for database consistency
- Alternative: `disabled` (faster but dangerous)

**`-O xattr=sa`**
- Store extended attributes in system attribute (SA)
- Better performance than separate files

**`-O dnodesize=auto`**
- Automatically choose dnode size
- Optimizes for small/large files

**`-O encryption=aes-256-gcm`**
- Enable native ZFS encryption (on top of EBS encryption)
- AES-256 in GCM mode
- Each dataset can have own key

**`-O keyformat=passphrase`** + **`-O keylocation=file:///...`**
- Key stored in file (TPM-sealed in production)
- Can be per-dataset or pool-wide

#### **Step 4: Create Dataset Hierarchy**

```bash
#!/bin/bash
# /srv/safebox/bin/create-zfs-datasets.sh

POOL=safebox-pool

# === MYSQL DATASETS ===
echo "Creating MySQL datasets..."

# Parent dataset for all MySQL data
zfs create \
    -o mountpoint=/srv/encrypted/mysql \
    -o recordsize=16K \
    -o compression=lz4 \
    $POOL/mysql

# Per-database datasets (created by add-tenant script)
# Example:
# zfs create $POOL/mysql/acme_web
# zfs create $POOL/mysql/acme_blog

# Binary logs (larger recordsize for sequential writes)
zfs create \
    -o mountpoint=/srv/encrypted/mysql/binlog \
    -o recordsize=128K \
    -o compression=lz4 \
    $POOL/mysql/binlog

# === APPLICATION DATASETS ===
echo "Creating application datasets..."

zfs create \
    -o mountpoint=/srv/encrypted/apps \
    -o recordsize=128K \
    -o compression=lz4 \
    $POOL/apps

# Per-tenant datasets (created by add-tenant script)
# Example:
# zfs create $POOL/apps/acme
# zfs create $POOL/apps/acme/website

# === MODEL DATASETS ===
echo "Creating model datasets..."

zfs create \
    -o mountpoint=/srv/encrypted/models \
    -o recordsize=1M \
    -o compression=zstd \
    -o primarycache=metadata \
    $POOL/models

# Subdatasets for model types
zfs create $POOL/models/llm
zfs create $POOL/models/vision  
zfs create $POOL/models/audio

# === BACKUP DATASETS ===
echo "Creating backup staging dataset..."

zfs create \
    -o mountpoint=/srv/encrypted/backups \
    -o recordsize=1M \
    -o compression=zstd \
    $POOL/backups

echo "Dataset hierarchy created"
zfs list -r $POOL
```

#### **Step 5: Set Permissions**

```bash
# MySQL data directory
chown -R mysql:mysql /srv/encrypted/mysql
chmod 750 /srv/encrypted/mysql

# Application directories (will be set per-tenant)
chmod 755 /srv/encrypted/apps

# Model directory
chmod 755 /srv/encrypted/models

# Backup directory
chmod 700 /srv/encrypted/backups
```

#### **Step 6: Enable Auto-Mount**

```bash
# Enable ZFS to auto-mount datasets on boot
zfs set canmount=on safebox-pool/mysql
zfs set canmount=on safebox-pool/apps
zfs set canmount=on safebox-pool/models

# Set mountpoint inheritance
zfs inherit mountpoint safebox-pool/mysql
zfs inherit mountpoint safebox-pool/apps
zfs inherit mountpoint safebox-pool/models

# Enable ZFS import on boot
systemctl enable zfs-import-cache
systemctl enable zfs-mount
systemctl enable zfs.target
```

---

## Essential ZFS Commands

### **Pool Management**

```bash
# List all pools
zpool list

# Pool status (health, errors)
zpool status

# Pool I/O statistics
zpool iostat 1

# Pool history (commands run)
zpool history

# Import existing pool
zpool import safebox-pool

# Export pool (unmount, prepare for move)
zpool export safebox-pool

# Scrub pool (verify all data, check for corruption)
zpool scrub safebox-pool

# Check scrub progress
zpool status safebox-pool
```

### **Dataset Management**

```bash
# List all datasets
zfs list

# List recursively (show children)
zfs list -r safebox-pool

# List with all properties
zfs get all safebox-pool/mysql

# Create dataset
zfs create safebox-pool/mysql/acme_web

# Destroy dataset (DANGEROUS!)
zfs destroy safebox-pool/mysql/acme_web

# Set property
zfs set compression=zstd safebox-pool/mysql/acme_web

# Get property
zfs get compression safebox-pool/mysql/acme_web

# Set quota (limit size)
zfs set quota=50G safebox-pool/mysql/acme_web

# Set reservation (guarantee space)
zfs set reservation=10G safebox-pool/mysql/acme_web
```

### **Snapshot Management**

```bash
# Create snapshot
zfs snapshot safebox-pool/mysql/acme_web@backup1

# List snapshots
zfs list -t snapshot

# List snapshots for specific dataset
zfs list -t snapshot -r safebox-pool/mysql/acme_web

# Rollback to snapshot (DESTROYS newer data!)
zfs rollback safebox-pool/mysql/acme_web@backup1

# Rollback to older snapshot (requires -r flag)
zfs rollback -r safebox-pool/mysql/acme_web@backup1

# Destroy snapshot
zfs destroy safebox-pool/mysql/acme_web@backup1

# Rename snapshot
zfs rename safebox-pool/mysql/acme_web@backup1 \
            safebox-pool/mysql/acme_web@before-migration

# Destroy all snapshots matching pattern
zfs list -t snapshot -o name | grep hourly | xargs -n1 zfs destroy
```

### **Clone Management**

```bash
# Create clone from snapshot
zfs snapshot safebox-pool/mysql/acme_web@prod
zfs clone safebox-pool/mysql/acme_web@prod \
          safebox-pool/mysql/acme_web_test

# List clones
zfs list -t all | grep clone

# Promote clone (make it independent)
zfs promote safebox-pool/mysql/acme_web_test

# Destroy clone
zfs destroy safebox-pool/mysql/acme_web_test
```

### **Send/Receive (Replication)**

```bash
# Send snapshot to another pool/server (full)
zfs send safebox-pool/mysql/acme_web@backup1 \
| zfs receive backup-pool/mysql/acme_web

# Send to remote server
zfs send safebox-pool/mysql/acme_web@backup1 \
| ssh user@remote "zfs receive backup-pool/mysql/acme_web"

# Incremental send (only changes since @backup1)
zfs send -i @backup1 @backup2 \
| zfs receive backup-pool/mysql/acme_web

# Resume interrupted send
zfs send -t <token> | zfs receive ...

# Estimate send size
zfs send -nv safebox-pool/mysql/acme_web@backup1
```

### **Monitoring**

```bash
# Space usage
zfs list -o name,used,avail,refer,mountpoint

# Compression ratio
zfs get compressratio safebox-pool/mysql

# All I/O stats
zpool iostat -v 1

# ARC stats (cache)
arc_summary

# Detailed property list
zfs get all safebox-pool/mysql/acme_web
```

---

## Production Workflow Examples

### **1. Hourly Automated Snapshots**

```bash
#!/bin/bash
# /srv/safebox/bin/zfs-auto-snapshot.sh
# Cron: 0 * * * *

DATASETS=(
    "safebox-pool/mysql/acme_web"
    "safebox-pool/mysql/acme_blog"
    "safebox-pool/apps/acme/website"
)

KEEP_HOURLY=24  # Keep 24 hourly snapshots

for DATASET in "${DATASETS[@]}"; do
    # Create snapshot
    SNAPSHOT="${DATASET}@hourly-$(date +%Y%m%d-%H%M)"
    
    echo "Creating snapshot: $SNAPSHOT"
    zfs snapshot "$SNAPSHOT"
    
    # Clean old snapshots (keep last $KEEP_HOURLY)
    zfs list -t snapshot -o name -s creation -r "$DATASET" | \
        grep "@hourly-" | \
        head -n -$KEEP_HOURLY | \
        while read snap; do
            echo "Removing old snapshot: $snap"
            zfs destroy "$snap"
        done
done
```

### **2. Pre-Migration Safe Snapshot**

```bash
#!/bin/bash
# /srv/safebox/bin/zfs-snapshot-safe.sh
# Use before risky operations

DATABASE=$1
LABEL=${2:-migration}

if [[ -z "$DATABASE" ]]; then
    echo "Usage: $0 <database> [label]"
    exit 1
fi

DATASET="safebox-pool/mysql/$DATABASE"
SNAPSHOT="${DATASET}@before-${LABEL}-$(date +%s)"

echo "Creating safe snapshot: $SNAPSHOT"

# FLUSH TABLES for perfect consistency
mysql -e "FLUSH TABLES WITH READ LOCK; \
          SYSTEM zfs snapshot $SNAPSHOT; \
          UNLOCK TABLES;"

echo "✓ Snapshot created: $SNAPSHOT"
echo ""
echo "To rollback:"
echo "  sudo systemctl stop mariadb"
echo "  sudo zfs rollback $SNAPSHOT"
echo "  sudo systemctl start mariadb"
```

### **3. Clone Database for Testing**

```bash
#!/bin/bash
# /srv/safebox/bin/zfs-clone-database.sh

SOURCE_DB=$1
CLONE_DB=$2

if [[ -z "$SOURCE_DB" ]] || [[ -z "$CLONE_DB" ]]; then
    echo "Usage: $0 <source_db> <clone_db>"
    exit 1
fi

SOURCE_DATASET="safebox-pool/mysql/$SOURCE_DB"
CLONE_DATASET="safebox-pool/mysql/$CLONE_DB"

# Create snapshot if doesn't exist
SNAPSHOT="${SOURCE_DATASET}@clone-$(date +%s)"
zfs snapshot "$SNAPSHOT"

# Clone
zfs clone "$SNAPSHOT" "$CLONE_DATASET"

# Set permissions
chown -R mysql:mysql "/srv/encrypted/mysql/$CLONE_DB"

# Create database entry in MariaDB
mysql -e "CREATE DATABASE IF NOT EXISTS $CLONE_DB;"

echo "✓ Cloned: $SOURCE_DB → $CLONE_DB"
echo "  Path: /srv/encrypted/mysql/$CLONE_DB"
echo "  Storage: Copy-on-write (shares blocks with $SOURCE_DB)"
echo ""
echo "To destroy clone:"
echo "  mysql -e 'DROP DATABASE $CLONE_DB;'"
echo "  zfs destroy $CLONE_DATASET"
```

### **4. Daily Replication to Replica**

```bash
#!/bin/bash
# /srv/safebox/bin/zfs-replicate-daily.sh
# Cron: 0 3 * * *

DATASETS=(
    "safebox-pool/mysql/acme_web"
    "safebox-pool/mysql/acme_blog"
)

REMOTE="replica-safebox.example.com"
REMOTE_POOL="safebox-pool"

for DATASET in "${DATASETS[@]}"; do
    echo "Replicating: $DATASET"
    
    # Get last replicated snapshot
    LAST=$(zfs list -t snapshot -o name -s creation -r "$DATASET" | \
           grep "@daily-" | tail -1)
    
    # Create new snapshot
    NEW="${DATASET}@daily-$(date +%Y%m%d)"
    zfs snapshot "$NEW"
    
    # Send incremental or full
    if [[ -n "$LAST" ]]; then
        echo "  Incremental: $LAST → $NEW"
        zfs send -i "$LAST" "$NEW" | \
            ssh "$REMOTE" "zfs receive -F $REMOTE_POOL/${DATASET#safebox-pool/}"
    else
        echo "  Full send: $NEW"
        zfs send "$NEW" | \
            ssh "$REMOTE" "zfs receive $REMOTE_POOL/${DATASET#safebox-pool/}"
    fi
    
    echo "  ✓ Replicated"
done
```

---

## Quick Reference Card

```bash
# === POOL ===
zpool create -o ashift=12 pool /dev/xvdf    # Create pool
zpool status                                 # Check health
zpool scrub pool                            # Verify data
zpool iostat -v 1                           # I/O stats

# === DATASET ===
zfs create pool/dataset                     # Create dataset
zfs set compression=lz4 pool/dataset        # Enable compression
zfs set quota=50G pool/dataset              # Set quota
zfs list -r pool                            # List datasets

# === SNAPSHOT ===
zfs snapshot pool/dataset@name              # Create snapshot
zfs rollback pool/dataset@name              # Rollback
zfs destroy pool/dataset@name               # Delete snapshot
zfs list -t snapshot                        # List snapshots

# === CLONE ===
zfs clone pool/dataset@snap pool/clone      # Create clone
zfs promote pool/clone                      # Make independent
zfs destroy pool/clone                      # Delete clone

# === SEND/RECEIVE ===
zfs send pool/dataset@snap | zfs receive backup-pool/dataset     # Local
zfs send pool/dataset@snap | ssh remote "zfs receive pool/dataset"  # Remote
zfs send -i @old @new | ...                 # Incremental

# === MONITORING ===
zfs get compressratio pool/dataset          # Compression ratio
zfs get all pool/dataset                    # All properties
arc_summary                                 # ARC cache stats
```

---

## Summary

### **MariaDB Settings for ZFS**
```ini
innodb_file_per_table = 1        # REQUIRED (one file per table)
innodb_doublewrite = 0           # CRITICAL (ZFS CoW replaces this)
innodb_flush_method = O_DIRECT   # Bypass OS cache (use ZFS ARC)
innodb_page_size = 16K           # Match ZFS recordsize
```

### **ZFS Pool Initialization**
```bash
# 1. Load module
modprobe zfs

# 2. Create pool
zpool create -o ashift=12 -O compression=lz4 -O recordsize=16K safebox-pool /dev/xvdf

# 3. Create datasets
zfs create -o mountpoint=/srv/encrypted/mysql safebox-pool/mysql
zfs create safebox-pool/apps
zfs create safebox-pool/models

# 4. Set permissions
chown -R mysql:mysql /srv/encrypted/mysql
```

### **Essential Commands**
```bash
# Snapshot (instant)
zfs snapshot safebox-pool/mysql/acme_web@name

# Rollback (instant)  
zfs rollback safebox-pool/mysql/acme_web@name

# Clone (instant, 0 bytes)
zfs clone safebox-pool/mysql/acme_web@prod safebox-pool/mysql/acme_web_test

# Replicate (incremental)
zfs send -i @old @new | ssh remote "zfs receive pool/mysql/acme_web"
```

ZFS + MariaDB = **Instant snapshots, zero-cost clones, atomic rollbacks!** 🚀
