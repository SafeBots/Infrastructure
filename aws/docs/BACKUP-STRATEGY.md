# Safebox Backup Strategy: Percona XtraBackup + Prolly Trees

## Overview

Safebox implements a sophisticated backup strategy combining:
1. **Percona XtraBackup** for consistent MySQL/MariaDB snapshots
2. **Prolly Trees** for content-addressable chunking
3. **Merkle Trees** for efficient discovery and verification
4. **Distributed storage** for global redundancy

## Why This Configuration Works

### MariaDB Settings for Consistent Snapshots

```ini
innodb_flush_log_at_trx_commit=1    # CRITICAL: Every commit flushed to disk
innodb_flush_method=O_DIRECT         # Bypass OS cache
sync_binlog=1                         # Binary log synced on commit
innodb_doublewrite=1                  # Crash-safe writes
innodb_file_per_table=1               # Easier incremental backups
```

**Why these settings matter:**
- `innodb_flush_log_at_trx_commit=1` ensures **durability** - no committed transaction can be lost
- `sync_binlog=1` enables **point-in-time recovery** - you can restore to any moment
- Together with `FLUSH TABLES WITH READ LOCK`, they guarantee **consistent file-level snapshots**

### Two Methods for Consistent Snapshots

#### Method 1: Percona XtraBackup (Hot Backup - Recommended)

XtraBackup works by:
1. **Copying InnoDB files** while database is running
2. **Recording LSN** (Log Sequence Number) at start
3. **Capturing redo log** changes during copy
4. **Applying changes** to create point-in-time consistent backup

**Advantages:**
- No downtime
- No locks
- Automatic consistency

**Use for:** Full database backups, base snapshots

#### Method 2: FLUSH TABLES WITH READ LOCK (File-Level Snapshot)

For our **borg-like chunker** that operates on raw files:

```sql
-- Ensure durability settings
SET GLOBAL innodb_flush_log_at_trx_commit=1;
SET GLOBAL sync_binlog=1;

-- Flush all tables and acquire global read lock
FLUSH TABLES WITH READ LOCK;

-- At this point, all data is on disk and no writes can occur
-- Now take filesystem snapshot using borg-like chunker
```

```bash
#!/bin/bash
# Take consistent file-level snapshot

# 1. Acquire global read lock
mysql -u root -e "
    SET GLOBAL innodb_flush_log_at_trx_commit=1;
    SET GLOBAL sync_binlog=1;
    FLUSH TABLES WITH READ LOCK;
    SELECT SLEEP(1);
" &

MYSQL_PID=$!

# Wait for lock to be acquired
sleep 2

# 2. Snapshot files with borg-like chunker
/srv/safebox/bin/borg-chunk.py \
    --source /srv/encrypted/mysql/ \
    --output /srv/encrypted/backups/chunks-$(date +%Y%m%d-%H%M%S) \
    --chunk-size 4194304

# 3. Release lock
mysql -u root -e "UNLOCK TABLES;"

# Kill background process
kill $MYSQL_PID 2>/dev/null || true

echo "Snapshot complete"
```

**Advantages:**
- Works with custom chunker
- Can snapshot individual database directories
- Faster than XtraBackup for small databases
- Deduplication at chunk level

**Disadvantages:**
- Brief read lock (writes blocked during snapshot)
- Typically 1-5 seconds for lock duration

**Use for:** 
- Incremental file-level backups
- Database replication via chunked snapshots
- Cross-Safebox app migration

### Percona XtraBackup Process

XtraBackup works by:
1. **Copying InnoDB files** while database is running
2. **Recording LSN** (Log Sequence Number) at start
3. **Capturing redo log** changes during copy
4. **Applying changes** to create point-in-time consistent backup

With our MariaDB config:
- All changes are **durably written** (flush_log_at_trx_commit=1)
- Binary logs are **synchronized** (sync_binlog=1)
- XtraBackup can **guarantee consistency** without locks

## Backup Architecture with InnoDB Crash Consistency

### Understanding InnoDB Crash Recovery

**InnoDB is crash-consistent** - meaning you can copy files at any random moment and InnoDB will recover to a consistent state on startup using redo logs.

**Why this works:**
- InnoDB maintains **redo logs** (WAL - Write-Ahead Logging)
- All committed transactions are in redo logs before data files
- On crash/restore, InnoDB replays redo logs to recover
- **No locks needed** for consistent backup

**When you DON'T need FLUSH TABLES WITH READ LOCK:**
- ✅ InnoDB-only databases
- ✅ `innodb_file_per_table=1` (separate .ibd files)
- ✅ Using XtraBackup
- ✅ Using LVM/EBS snapshots
- ✅ Using crash-consistent file copies

**When you DO need FLUSH TABLES WITH READ LOCK:**
- ❌ MyISAM tables
- ❌ Mixed storage engines
- ❌ Logical backups (mysqldump coordination)
- ❌ Non-InnoDB metadata

### Safebox Backup Strategy

**Primary Method: Percona XtraBackup** (Recommended)
```
No locks ✅
No downtime ✅
Crash-consistent ✅
Built-in redo log handling ✅
Works during heavy writes ✅
```

**Fallback Method: FLUSH TABLES WITH READ LOCK**
```
Only if XtraBackup unavailable
Brief lock (1-5 seconds) ⚠️
Guaranteed consistency ✅
Works with any engine ✅
```

### Method 1: XtraBackup with Borg-Like Chunker (PRIMARY)

```bash
#!/bin/bash
# Backup with XtraBackup → Chunking

# XtraBackup streams consistent backup (no locks!)
xtrabackup --backup \
    --databases=acme_web \
    --stream=xbstream \
    --target-dir=/tmp \
| \
# Pipe directly to borg-like chunker
python3 /srv/safebox/bin/chunk-xtrabackup-stream.py \
    --database acme_web \
    --output /srv/encrypted/backups/chunks

# Result:
# - No database locks
# - Crash-consistent snapshot
# - Content-defined chunks
# - 95% deduplication
```

**How XtraBackup ensures consistency:**
1. Copies InnoDB data files (`.ibd`) while DB runs
2. **Records LSN** (Log Sequence Number) at start
3. **Captures redo log** changes during copy
4. On restore, applies redo logs to reach consistent state

**No FLUSH TABLES needed!**

### Method 2: Direct File Snapshot (InnoDB Crash Consistency)

For ultra-fast snapshots without XtraBackup overhead:

```python
# chunk-innodb-files.py

def snapshot_innodb_crash_consistent(database):
    """
    Snapshot InnoDB files directly - crash-consistent
    No locks, InnoDB recovers on restore
    """
    mysql_datadir = Path("/srv/encrypted/mysql")
    db_path = mysql_datadir / database
    
    chunks = []
    
    # 1. Snapshot all .ibd files (table data)
    for ibd_file in db_path.glob("*.ibd"):
        chunks.extend(chunk_file(ibd_file))
    
    # 2. Snapshot .frm files (table definitions)
    for frm_file in db_path.glob("*.frm"):
        chunks.extend(chunk_file(frm_file))
    
    # 3. CRITICAL: Snapshot redo logs
    redo_dir = mysql_datadir / "binlog"
    for redo_file in redo_dir.glob("ib_logfile*"):
        chunks.extend(chunk_file(redo_file))
    
    # 4. Snapshot binary logs (for point-in-time recovery)
    for binlog in redo_dir.glob("mariadb-bin.*"):
        chunks.extend(chunk_file(binlog))
    
    # On restore, InnoDB will:
    # - Open .ibd files
    # - Replay redo logs (ib_logfile*)
    # - Reach consistent state automatically
    
    return chunks
```

**This works because:**
- InnoDB data files + redo logs = crash-consistent
- No coordination needed
- No locks needed
- InnoDB's crash recovery handles everything

### Method 3: FLUSH TABLES (Fallback Only)

Only use if:
- XtraBackup not available
- Mixed storage engines (MyISAM + InnoDB)
- Extra paranoia needed

```sql
SET GLOBAL innodb_flush_log_at_trx_commit=1;
SET GLOBAL sync_binlog=1;
FLUSH TABLES WITH READ LOCK;
-- snapshot files
UNLOCK TABLES;
```

## Comparison Matrix

| Method | Locks | Speed | Consistency | Engine Support | Overhead |
|--------|-------|-------|-------------|----------------|----------|
| **XtraBackup** | None | Medium | Crash-consistent | InnoDB | Low |
| **Direct snapshot** | None | Fast | Crash-consistent | InnoDB only | Minimal |
| **FLUSH TABLES** | 1-5s | Fast | Perfect | All engines | Brief lock |
| **LVM snapshot** | None | Instant | Crash-consistent | All (filesystem) | Setup |
| **EBS snapshot** | None | Instant | Crash-consistent | All (block) | AWS-specific |

## Recommended Architecture

```
Primary: XtraBackup + Borg Chunker
  ↓ (streams backup while DB runs)
Content-Defined Chunking (4MB avg)
  ↓
Deduplication (95%+ savings)
  ↓
Compression (zstd)
  ↓
Encryption (AES-256-GCM per chunk)
  ↓
Distributed Storage (IPFS/Filecoin)
  ↓
Merkle Root on Blockchain

Fallback: FLUSH TABLES (if XtraBackup unavailable)
```

## Prolly Tree Implementation

### What is a Prolly Tree?

A **Probabilistic B-Tree** (Prolly Tree) is a content-defined tree structure where:
- **Chunk boundaries** determined by content hashing (not fixed size)
- **Internal nodes** created probabilistically based on hash values
- **Changes** only affect chunks containing modified data
- **Deduplication** automatic via content addressing

### Why Prolly Trees for Backups?

Traditional backups:
```
Backup v1: [Block 1][Block 2][Block 3][Block 4][Block 5]
Backup v2: [Block 1][Block 2][CHANGED][Block 4][Block 5]
           └─────────── All blocks re-uploaded ──────────┘
```

Prolly tree backups:
```
Backup v1: [Chunk A][Chunk B][Chunk C][Chunk D]
                      ↓
Backup v2: [Chunk A][Chunk B'][Chunk C][Chunk D]
                      ↑
              Only new chunk uploaded!
```

**Benefits:**
- **Incremental by design** - only modified chunks uploaded
- **Deduplication** - identical chunks stored once
- **Efficient verification** - compare merkle roots
- **No metadata** - tree structure derived from content

### Chunking Algorithm

```python
def chunk_xtrabackup_stream(stream, target_chunk_size=4*1024*1024):
    """
    Content-defined chunking using rolling hash
    Similar to rsync's algorithm
    """
    window = RollingHash(window_size=64)
    current_chunk = bytearray()
    
    for byte in stream:
        current_chunk.append(byte)
        window.roll(byte)
        
        # Chunk boundary condition (probabilistic)
        if (window.hash() & (target_chunk_size - 1)) == 0:
            yield bytes(current_chunk)
            current_chunk = bytearray()
    
    if current_chunk:
        yield bytes(current_chunk)
```

**Key property:** Chunk boundaries determined by **content**, not position
- Insert 1 byte at start → only first chunk changes
- Fixed-size chunking → all chunks shift, all hashes change

## Backup Workflow

### Daily Incremental Backup

**Method 1: XtraBackup with Chunking (PRIMARY - NO LOCKS)**

```bash
#!/bin/bash
# /srv/safebox/bin/backup-incremental.sh

set -euo pipefail

BACKUP_DIR="/srv/encrypted/backups"
DATE=$(date +%Y%m%d-%H%M%S)

# Check if XtraBackup is available
if command -v xtrabackup &> /dev/null; then
    echo "Using XtraBackup (no locks, crash-consistent)"
    
    # XtraBackup streams backup while database runs (NO LOCKS!)
    xtrabackup --backup \
        --stream=xbstream \
        --target-dir=/tmp \
        2> "$BACKUP_DIR/xtrabackup-$DATE.log" \
    | python3 /srv/safebox/bin/chunk-xtrabackup-stream.py \
        --output "$BACKUP_DIR/chunks-$DATE"
    
else
    echo "XtraBackup not available, falling back to FLUSH TABLES method"
    
    # Fallback: Use FLUSH TABLES WITH READ LOCK
    python3 /srv/safebox/bin/borg-chunk.py snapshot-db \
        --database all \
        --method flush-tables
fi

# Get snapshot ID
SNAPSHOT_ID=$(python3 /srv/safebox/bin/borg-chunk.py list | head -1 | awk '{print $1}')

# Upload unique chunks to distributed storage
python3 /srv/safebox/bin/upload-distributed.py \
    --snapshot "$SNAPSHOT_ID" \
    --backends intercoin,ipfs,filecoin

# Record merkle root on blockchain
python3 /srv/safebox/bin/record-backup.py \
    --snapshot "$SNAPSHOT_ID" \
    --timestamp "$DATE"

echo "Backup complete: $SNAPSHOT_ID"
```

**XtraBackup Advantages:**
- ✅ **No locks** - database keeps running
- ✅ **No write blocking** - transactions continue
- ✅ **Crash-consistent** - InnoDB recovery on restore
- ✅ **Built-in LSN tracking** - automatic consistency
- ✅ **Production-safe** - zero downtime

**Method 2: Direct File Snapshot (InnoDB Crash Consistency)**

For maximum speed when XtraBackup overhead not needed:

```python
#!/usr/bin/env python3
# chunk-innodb-direct.py

def snapshot_innodb_files(database):
    """
    Direct file snapshot - relies on InnoDB crash recovery
    NO LOCKS - InnoDB is crash-consistent!
    """
    mysql_dir = Path("/srv/encrypted/mysql")
    db_path = mysql_dir / database
    
    chunks = []
    
    # Snapshot data files (.ibd)
    for ibd_file in db_path.glob("*.ibd"):
        print(f"Chunking: {ibd_file.name}")
        chunks.extend(chunk_file_content_defined(ibd_file))
    
    # Snapshot redo logs (CRITICAL for crash recovery)
    for redo in mysql_dir.glob("ib_logfile*"):
        chunks.extend(chunk_file_content_defined(redo))
    
    # Snapshot binary logs (for point-in-time recovery)
    binlog_dir = mysql_dir / "binlog"
    for binlog in binlog_dir.glob("mariadb-bin.*"):
        chunks.extend(chunk_file_content_defined(binlog))
    
    return chunks

# On restore:
# 1. Copy .ibd files
# 2. Copy ib_logfile* (redo logs)
# 3. Start MariaDB
# 4. InnoDB automatically recovers to consistent state!
```

**This works because:**
```
InnoDB Files at Random Moment:
  users.ibd (partial writes, inconsistent)
  posts.ibd (partial writes, inconsistent)
  ib_logfile0 (redo log)
  ib_logfile1 (redo log)

On Restore:
  MariaDB starts
  ↓
  InnoDB reads redo logs
  ↓
  Replays committed transactions
  ↓
  Rolls back uncommitted transactions
  ↓
  Database is now consistent!
```

**Method 3: FLUSH TABLES (Fallback Only)**

Only use if XtraBackup unavailable or mixed storage engines:

```bash
# Fallback method with brief lock
python3 /srv/safebox/bin/borg-chunk.py snapshot-db \
    --database all \
    --method flush-tables  # 1-5 second lock
```

### Comparison

| Feature | XtraBackup | Direct Snapshot | FLUSH TABLES |
|---------|------------|-----------------|--------------|
| **Database locks** | None | None | 1-5 seconds |
| **Write blocking** | None | None | Yes (brief) |
| **Consistency** | Crash-safe | Crash-safe | Perfect |
| **Speed** | Medium | Fast | Fast |
| **InnoDB only** | Yes | Yes | No (all engines) |
| **Overhead** | Low | Minimal | Brief lock |
| **Use when** | Production | High-speed | Fallback |

### Production Recommendation

```bash
# Primary: XtraBackup (no locks)
if command -v xtrabackup; then
    method="xtrabackup"  # ← RECOMMENDED
    
# Secondary: Direct snapshot (no locks, faster)
elif [[ "$INNODB_ONLY" == "true" ]]; then
    method="direct-snapshot"
    
# Fallback: FLUSH TABLES (brief lock)
else
    method="flush-tables"
fi
```

### Restore Process

```bash
#!/bin/bash
# /srv/safebox/bin/restore-from-merkle.sh

set -euo pipefail

MERKLE_ROOT=$1
RESTORE_DIR=$2

# 1. Fetch merkle tree from blockchain
python3 /srv/safebox/bin/fetch-backup-manifest.py \
    --merkle-root "$MERKLE_ROOT" \
    --output /tmp/manifest.json

# 2. Download chunks from distributed network
python3 /srv/safebox/bin/download-chunks.py \
    --manifest /tmp/manifest.json \
    --output /tmp/encrypted-chunks

# 3. Decrypt chunks
python3 /srv/safebox/bin/decrypt-chunks.py \
    --input /tmp/encrypted-chunks \
    --key-source tpm \
    --output /tmp/decrypted-chunks

# 4. Reassemble XtraBackup stream
cat /tmp/decrypted-chunks/* | \
xbstream -x -C "$RESTORE_DIR"

# 5. Prepare backup for restore
xtrabackup --prepare --target-dir="$RESTORE_DIR"

echo "Backup restored to: $RESTORE_DIR"
echo "To restore database:"
echo "  systemctl stop mariadb"
echo "  rm -rf /srv/encrypted/mysql/*"
echo "  xtrabackup --copy-back --target-dir=$RESTORE_DIR"
echo "  chown -R mysql:mysql /srv/encrypted/mysql"
echo "  systemctl start mariadb"
```

## Merkle Tree Structure

```
Root Hash (Backup Identifier)
├── Level 1: Database Metadata
│   ├── LSN: 123456789
│   ├── Timestamp: 2026-03-02T12:00:00Z
│   └── Size: 10GB
├── Level 2: Chunk Hashes
│   ├── Chunk 0: sha256(encrypted_chunk_0)
│   ├── Chunk 1: sha256(encrypted_chunk_1)
│   ├── Chunk 2: sha256(encrypted_chunk_2)
│   └── ...
└── Level 3: Prolly Tree Structure
    ├── Internal Node 1
    │   ├── Leaf: Chunk 0-99
    │   └── Leaf: Chunk 100-199
    └── Internal Node 2
        ├── Leaf: Chunk 200-299
        └── Leaf: Chunk 300-399
```

## Incremental Backup Comparison

```bash
# Compare two backups
python3 /srv/safebox/bin/diff-backups.py \
    --old-merkle "$MERKLE_ROOT_V1" \
    --new-merkle "$MERKLE_ROOT_V2"

# Output:
# Unchanged chunks: 950 (95%)
# New chunks: 30 (3%)
# Modified chunks: 20 (2%)
# Total data uploaded: 200MB (instead of 10GB)
```

## Distributed Storage Integration

### Intercoin Blockchain

- **Transaction log** of all backups
- **Merkle roots** recorded on-chain
- **Timestamping** for compliance
- **Proof of backup** without revealing data

```javascript
// Record backup on Intercoin
await intercoin.recordBackup({
    merkleRoot: 'abc123...',
    timestamp: Date.now(),
    tenantId: 'tenant1',
    appId: 'default',
    chunkCount: 1000,
    totalSize: 10737418240
});
```

### IPFS/Filecoin

- **Content-addressed** storage
- **Encrypted chunks** as IPFS blocks
- **Filecoin deals** for long-term storage
- **Geographic redundancy**

```python
# Upload chunks to IPFS
for chunk_hash, chunk_data in encrypted_chunks:
    cid = ipfs.add(chunk_data, pin=True)
    merkle_tree.add_chunk(cid, chunk_hash)

# Create Filecoin storage deal
filecoin.store(
    cids=list(merkle_tree.chunk_cids()),
    duration_epochs=2880 * 365,  # 1 year
    price_per_epoch=0.00001
)
```

## Database Replication via Chunked Snapshots

### Why Not MariaDB Replication?

Traditional MariaDB replication has limitations:
- Requires constant connection between primary/replica
- Binary log position tracking complexity
- Replication lag issues
- Difficult to replicate to multiple Safeboxes
- Doesn't work well across regions/networks

### Borg-Like Chunk Replication (Recommended)

Instead, we use **snapshot-based replication** via content-defined chunks:

```
Primary Safebox
  ↓ (every 5 minutes or on change)
FLUSH TABLES WITH READ LOCK
  ↓
Content-Defined Chunking
  ↓
Upload New Chunks to Distributed Storage
  ↓
Replica Safebox(es) Download New Chunks
  ↓
Restore to Replica Database
```

**Advantages:**
- Works across any network (even intermittent)
- Multiple replicas easily (just download chunks)
- Cross-region replication
- Automatic deduplication (only changed chunks)
- Blockchain-verified consistency (merkle roots)
- No replication lag tracking needed

### Replication Workflow

#### 1. Continuous Sync (Primary → Replica)

```bash
#!/bin/bash
# /srv/safebox/bin/replicate-to-replica.sh
# Runs every 5 minutes on primary

set -euo pipefail

APP_NAME=$1
REPLICA_SAFEBOX=$2  # IP or hostname

# Take snapshot (FLUSH TABLES method)
SNAPSHOT_ID=$(python3 /srv/safebox/bin/borg-chunk.py snapshot-db \
    --database "$APP_NAME" | \
    grep "Snapshot ID:" | awk '{print $3}')

# Upload new chunks to distributed storage
python3 /srv/safebox/bin/upload-distributed.py \
    --snapshot "$SNAPSHOT_ID" \
    --backends ipfs,filecoin

# Notify replica of new snapshot
ssh "$REPLICA_SAFEBOX" "/srv/safebox/bin/pull-snapshot.sh $APP_NAME $SNAPSHOT_ID"

echo "Replication complete: $SNAPSHOT_ID"
```

#### 2. Pull Snapshot (Replica)

```bash
#!/bin/bash
# /srv/safebox/bin/pull-snapshot.sh
# Runs on replica when notified

set -euo pipefail

APP_NAME=$1
SNAPSHOT_ID=$2

# Download new chunks from distributed storage
python3 /srv/safebox/bin/download-chunks.py \
    --snapshot "$SNAPSHOT_ID" \
    --output "/tmp/chunks-$SNAPSHOT_ID"

# Stop app container temporarily
docker stop "${APP_NAME}_container"

# Apply snapshot to database
python3 /srv/safebox/bin/borg-chunk.py restore \
    --snapshot "$SNAPSHOT_ID" \
    --target "/srv/encrypted/mysql/$APP_NAME"

# Restart app container
docker start "${APP_NAME}_container"

echo "Snapshot applied: $SNAPSHOT_ID"
```

#### 3. Deduplication Benefits

```
Primary database changes:
- Day 1: 10GB (baseline)
- Day 2: 50MB changed → 50MB uploaded
- Day 3: 30MB changed → 30MB uploaded
- Day 4: 80MB changed → 80MB uploaded

Total uploaded over 4 days: 10.16GB
vs. traditional replication: 40GB+ (full replication stream)

Savings: 75%+
```

### Advanced: Multi-Replica Fanout

```
Primary Safebox
  ↓
Distributed Storage (IPFS/Filecoin)
  ↓ ↓ ↓
Replica 1  Replica 2  Replica 3
(us-east)  (us-west)  (eu-west)
```

All replicas pull from same distributed storage:
- No need for primary to push to each replica
- Replicas can sync at different times
- Automatic load balancing via IPFS
- Geographic distribution

### Consistency Guarantees

**FLUSH TABLES WITH READ LOCK ensures:**
1. All dirty pages flushed to disk
2. All transactions committed or rolled back
3. Filesystem state is perfectly consistent
4. Snapshot represents exact point-in-time

**Merkle tree verification:**
```python
# Verify snapshot integrity before applying
def verify_snapshot(snapshot_id):
    # Download merkle tree from blockchain
    merkle_root = intercoin.get_merkle_root(snapshot_id)
    
    # Recalculate merkle root from downloaded chunks
    calculated_root = build_merkle_tree(downloaded_chunks)
    
    # Verify match
    assert calculated_root == merkle_root, "Snapshot corrupted!"
    
    return True
```

### Failover with Snapshot Replication

```bash
# Replica is always within 5 minutes of primary

# On primary failure:
1. Orchestrator detects failure
2. Checks replica freshness (last snapshot timestamp)
3. If <5 min old: Promote replica immediately
4. Update DNS to point to replica
5. Downtime: <1 minute

# No binary log position tracking
# No replication lag calculation  
# Just verify latest snapshot applied
```

### Scenario 1: Single Database Restore
```bash
# Restore specific app database from latest backup
./restore-from-merkle.sh $(get-latest-merkle tenant1_app1) /tmp/restore
```

### Scenario 2: Point-in-Time Recovery
```bash
# Restore to specific timestamp using binary logs
./restore-from-merkle.sh $(get-merkle-at-time "2026-03-01 14:30:00") /tmp/restore
# Apply binary logs from 14:30 to desired point
```

### Scenario 3: Cross-Region Disaster Recovery
```bash
# Fetch backup from distributed network (any region)
./restore-from-merkle.sh $MERKLE_ROOT /mnt/restore
# Even if primary instance destroyed, backup accessible globally
```

## Monitoring & Verification

### Daily Backup Verification
```bash
#!/bin/bash
# Verify latest backup integrity

LATEST_MERKLE=$(get-latest-merkle)

# 1. Verify merkle tree on blockchain
verify-blockchain-record "$LATEST_MERKLE"

# 2. Random chunk verification (10% sample)
verify-random-chunks "$LATEST_MERKLE" --sample-rate 0.1

# 3. Test restore to temporary location
test-restore "$LATEST_MERKLE" --dry-run

# Alert if any verification fails
if [[ $? -ne 0 ]]; then
    alert-ops "Backup verification failed for $LATEST_MERKLE"
fi
```

## Cost Optimization

### Deduplication Benefits

```
Without prolly trees:
- 10 daily backups × 10GB each = 100GB stored
- Monthly cost: $10 (storage) + $50 (egress)

With prolly trees (5% daily change):
- Initial: 10GB
- 9 incrementals: 9 × 500MB = 4.5GB
- Total: 14.5GB stored
- Monthly cost: $1.45 (storage) + $7.25 (egress)
- Savings: 85%
```

### Retention Policy

```python
# Intelligent retention with exponential backup spacing
RETENTION = {
    'hourly': 24,      # Last 24 hours
    'daily': 30,       # Last 30 days
    'weekly': 12,      # Last 12 weeks
    'monthly': 12,     # Last 12 months
    'yearly': 7        # Last 7 years
}

# Only unique chunks retained
# Shared chunks referenced by multiple backups
```

## Security Properties

1. **Encryption**: AES-256-GCM per chunk
2. **Key Management**: TPM-sealed, never in backup
3. **Integrity**: Merkle proofs verify any chunk
4. **Immutability**: Content-addressed storage
5. **Auditability**: Blockchain transaction log

## Implementation Timeline

**Phase 1** (Current): MariaDB configuration for consistent snapshots ✅
**Phase 2**: XtraBackup streaming integration
**Phase 3**: Prolly tree chunking implementation
**Phase 4**: Distributed storage connectors
**Phase 5**: Intercoin blockchain integration
**Phase 6**: Automated verification and monitoring

## References

- Percona XtraBackup: https://docs.percona.com/percona-xtrabackup/
- Prolly Trees: https://github.com/attic-labs/noms/blob/master/doc/intro.md#prolly-trees-probabilistic-b-trees
- Content-Defined Chunking: https://en.wikipedia.org/wiki/Rolling_hash
- Merkle Trees: https://en.wikipedia.org/wiki/Merkle_tree
- IPFS: https://docs.ipfs.tech/
- Filecoin: https://docs.filecoin.io/

---

**Key Takeaway**: The combination of `innodb_flush_log_at_trx_commit=1` and `sync_binlog=1` ensures Percona XtraBackup can create consistent snapshots without stopping the database, which are then chunked into prolly trees for efficient incremental backups to distributed storage.
