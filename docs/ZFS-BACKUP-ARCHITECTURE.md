# ZFS Backup & Replication Architecture

**Key Insight:** One MariaDB server with multiple databases (one per app), all on ZFS. Backups use ZFS snapshots + zfs send/recv instead of MySQL replication.

---

## 🎯 Architecture Overview

### **One MariaDB Server**

```
MariaDB Container
├── /var/lib/mysql → /zpool/mysql-data (ZFS dataset)
│   ├── safebox/ (database)
│   ├── community_x/ (database)
│   ├── business_y/ (database)
│   └── ... (all app databases)
```

**Benefits:**
- ✅ **Single MariaDB instance** - Simpler to manage
- ✅ **ZFS snapshots** - Atomic backup of all databases
- ✅ **No MySQL replication** - File-level replication instead
- ✅ **Fast failover** - `zfs rollback` is instant
- ✅ **Space-efficient** - Incremental snapshots only store deltas

---

## 💾 Backup Process

### **1. Atomic Snapshot (MySQL + App Data)**

```bash
# Script: backup-with-zfs.sh

# Step 1: Flush and lock MySQL tables
docker exec safebox-mariadb mysql -e "FLUSH TABLES WITH READ LOCK"

# Step 2: Create ZFS snapshots (atomic, instant)
zfs snapshot zpool/app-data/safebox@backup-20260427-120000
zfs snapshot zpool/mysql-data@backup-20260427-120000

# Step 3: Unlock tables
docker exec safebox-mariadb mysql -e "UNLOCK TABLES"
```

**Result:** Crash-consistent snapshot of entire app state (files + database)

**Duration:** ~2 seconds (tables locked for snapshot creation only)

---

## 🔄 Replication to Peer Safebox

### **ZFS Send/Recv (Not rsync!)**

**Why zfs send/recv:**
- ✅ **Incremental** - Only changed blocks, not full file scans
- ✅ **Efficient** - Block-level deltas, much faster than rsync
- ✅ **Atomic** - Snapshots are immutable, consistent
- ✅ **Compressed** - Built-in compression over SSH
- ✅ **No MySQL replication** - Just replicate files

**Process:**

```bash
# Script: replicate-to-peer.sh

# First time: Full send
zfs send zpool/app-data/safebox@backup-123 | \
  ssh backup@peer.safebox.com zfs recv backups/safebox/data

# Subsequent: Incremental send (only deltas!)
zfs send -i zpool/app-data/safebox@backup-123 \
         zpool/app-data/safebox@backup-456 | \
  ssh backup@peer.safebox.com zfs recv backups/safebox/data
```

**Example:**
- Full send (first time): 10GB → 10GB transferred
- Incremental send: 10GB → 500MB (only changes) transferred

---

## ⚡ Fast Iteration & Rollback

### **Before/After Snapshots**

```bash
# Before making risky changes
./snapshot-manager.sh create safebox before-upgrade

# Make changes...
docker exec safebox-app-safebox /opt/qbix/platform/scripts/upgrade.sh

# If something breaks:
./restore-from-snapshot.sh safebox before-upgrade

# Instant rollback (zfs rollback)!
```

**Rollback duration:** <1 second

**Use cases:**
- Before platform upgrades
- Before schema migrations
- Before major config changes
- Testing new features

### **Snapshot Types**

```
Hourly snapshots (24h retention):
├── hourly-20260427-080000
├── hourly-20260427-090000
└── hourly-20260427-100000

Daily snapshots (30d retention):
├── daily-20260401-000000
├── daily-20260402-000000
└── daily-20260427-000000

Manual snapshots (kept until deleted):
├── before-upgrade-20260420-143000
└── before-migration-20260425-110000
```

---

## 🏗️ Complete Backup Flow

### **Automated Hourly Backups**

**Cron job (runs every hour):**

```bash
# /etc/cron.d/safebox-backup
0 * * * * root /opt/safebox/scripts/backup-with-zfs.sh safebox
0 * * * * root /opt/safebox/scripts/backup-with-zfs.sh community-x
```

**What happens:**

```
Hour 0 (midnight):
  ├─ FLUSH TABLES WITH READ LOCK
  ├─ zfs snapshot zpool/app-data/safebox@hourly-...
  ├─ zfs snapshot zpool/mysql-data@hourly-...
  ├─ UNLOCK TABLES
  └─ Replicate to peer (incremental)
  
Hour 1:
  ├─ Same process...
  └─ Only changed blocks sent to peer
```

**Retention policy:**
- Hourly: Keep 24 (1 day)
- Daily: Keep 30 (1 month)
- Manual: Keep until deleted

---

## 🌐 Peer Safebox Replication

### **Setup SSH Keys**

```bash
# On host Safebox
ssh-keygen -t ed25519 -f /etc/safebox/backup.key

# Copy to peer
ssh-copy-id -i /etc/safebox/backup.key backup@peer.safebox.com
```

### **Replicate Snapshot**

```bash
# Full workflow
./backup-with-zfs.sh safebox --replicate-to backup@peer.safebox.com:/backups
```

**What gets replicated:**
1. App data: `zpool/app-data/safebox` → `peer:backups/safebox/data`
2. MySQL data: `zpool/mysql-data` → `peer:backups/safebox/mysql`

**Incremental efficiency:**

```
Snapshot 1 (full):     10GB → 10GB transferred
Snapshot 2 (+100MB):   10.1GB → 100MB transferred
Snapshot 3 (+50MB):    10.15GB → 50MB transferred
```

---

## 🔥 Disaster Recovery

### **Scenario 1: App Corruption**

```bash
# Instant rollback to last good snapshot
./restore-from-snapshot.sh safebox latest

# Or specific snapshot
./restore-from-snapshot.sh safebox backup-20260427-080000
```

**Recovery time:** <1 minute

### **Scenario 2: Host Failure**

```bash
# On new host, restore from peer
ssh backup@peer.safebox.com \
  'zfs send backups/safebox/data@backup-latest' | \
  zfs recv zpool/app-data/safebox

ssh backup@peer.safebox.com \
  'zfs send backups/safebox/mysql@backup-latest' | \
  zfs recv zpool/mysql-data
```

**Recovery time:** ~10-30 minutes (depends on data size)

### **Scenario 3: Database Corruption**

```bash
# MySQL data is part of snapshot
./restore-from-snapshot.sh safebox backup-20260427-120000

# This restores both app files AND database
```

---

## 📊 Storage Efficiency

### **Example: 3 Apps with Hourly Snapshots**

```
Apps (base):
├── safebox: 5GB
├── community-x: 3GB  
└── business-y: 2GB
Total: 10GB

After 24 hours (24 hourly snapshots):
├── safebox: 5GB + 500MB deltas = 5.5GB
├── community-x: 3GB + 200MB deltas = 3.2GB
└── business-y: 2GB + 100MB deltas = 2.1GB
Total: 10.8GB (not 10GB × 24 = 240GB!)
```

**ZFS magic:** Only changed blocks are stored.

---

## 🛠️ Scripts Reference

### **backup-with-zfs.sh**

```bash
# Create snapshot + replicate
./backup-with-zfs.sh safebox --replicate-to backup@peer:/backups

# Just snapshot (no replication)
./backup-with-zfs.sh safebox
```

### **restore-from-snapshot.sh**

```bash
# Restore to latest snapshot
./restore-from-snapshot.sh safebox latest

# Restore to specific snapshot
./restore-from-snapshot.sh safebox backup-20260427-120000
```

### **replicate-to-peer.sh**

```bash
# Incremental replication
./replicate-to-peer.sh safebox backup@peer:/backups

# Force full replication
./replicate-to-peer.sh safebox backup@peer:/backups --full
```

### **snapshot-manager.sh**

```bash
# List snapshots
./snapshot-manager.sh list safebox

# Create manual snapshot
./snapshot-manager.sh create safebox before-upgrade

# Cleanup old snapshots (older than 30 days)
./snapshot-manager.sh cleanup safebox 30

# Auto-snapshot (run by cron hourly)
./snapshot-manager.sh auto-snapshot
```

---

## 🔮 Future: SafeCloud Protocol

**Current:** zfs send/recv over SSH (efficient, works now)

**Future:** SafeCloud chunked replication in browsers

```
SafeCloud Protocol:
├── Chunk files into 1MB blocks
├── Store chunks across peer browsers
├── Encrypted with DH tunnels
├── Redundant (3× replication)
└── Self-healing network
```

**But for now:** zfs send/recv is production-ready and efficient!

---

## ✅ Summary

**Architecture:**
- ✅ One MariaDB with multiple databases (all on ZFS)
- ✅ ZFS snapshots = atomic backup (app + MySQL)
- ✅ No MySQL replication needed
- ✅ zfs send/recv for peer replication (not rsync)
- ✅ Incremental snapshots (only deltas)
- ✅ Fast failover (<1 second rollback)

**Operations:**
- ✅ Hourly snapshots (automated)
- ✅ Before/after snapshots (manual)
- ✅ Peer replication (automated or manual)
- ✅ Instant rollback (zfs rollback)
- ✅ Disaster recovery (restore from peer)

**Scripts:**
- `backup-with-zfs.sh` - Create atomic snapshots
- `restore-from-snapshot.sh` - Instant rollback
- `replicate-to-peer.sh` - Peer replication
- `snapshot-manager.sh` - Retention policies

**This is production-ready!** 🚀
