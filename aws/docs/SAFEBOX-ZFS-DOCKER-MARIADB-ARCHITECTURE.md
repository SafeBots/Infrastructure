# Safebox: ZFS + Docker + MariaDB Architecture

**Decision Document: Storage, Containerization, and Database Strategy**

---

## 🎯 Your Questions Answered

### Q1: Do we have ZFS and Docker?
**YES.** Both are core components in the base AMI.

### Q2: Should Docker overlay be over ZFS?
**YES.** Docker's overlay2 storage driver runs on top of ZFS datasets.

### Q3: Should main drive be mounted on ZFS?
**YES.** The entire `/srv` directory hierarchy is on ZFS with per-dataset encryption.

### Q4: MariaDB file-per-table + ZFS snapshots for experiments?
**YES.** This is the CORE ARCHITECTURE for multi-tenant isolation and workspace management.

### Q5: Should PHP/Node/MariaDB be in separate Docker containers?
**NO.** Better approach: Native processes with ZFS dataset isolation (explained below).

---

## 📊 Final Architecture Decision

### **Storage Layer: ZFS**

**Root filesystem:** ext4 (AWS default, for /boot, /var/log)  
**Data filesystem:** ZFS (for /srv, tenant data, Docker, MariaDB)

```
/ (ext4, root volume)
├── /boot
├── /var/log
├── /etc
└── /srv (ZFS pool: safebox-pool)
    ├── /srv/safebox         → ZFS dataset: safebox-pool/safebox
    ├── /srv/docker          → ZFS dataset: safebox-pool/docker
    ├── /srv/mariadb         → ZFS dataset: safebox-pool/mariadb
    ├── /srv/tenants         → ZFS dataset: safebox-pool/tenants
    └── /srv/projects        → ZFS dataset: safebox-pool/projects
```

**Why ZFS for /srv only (not root)?**
- AWS boot requirements: Needs ext4 for /boot
- Flexibility: Easy to expand ZFS pool on additional EBS volumes
- Safety: Root filesystem corruption doesn't affect data
- Performance: Separate I/O channels for system vs data

---

## 🐳 Docker Architecture

### **Docker Storage Driver:** overlay2 on ZFS

```bash
# /etc/docker/daemon.json
{
  "storage-driver": "overlay2",
  "data-root": "/srv/docker",
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

**ZFS dataset configuration:**
```bash
zfs create -o mountpoint=/srv/docker \
    -o compression=lz4 \
    -o encryption=on \
    -o keylocation=prompt \
    -o keyformat=passphrase \
    safebox-pool/docker

# Docker overlay2 directories
/srv/docker/
├── overlay2/          # Container layers
├── image/             # Image metadata
├── volumes/           # Named volumes
└── containers/        # Container configs
```

**Benefits:**
- ✅ Compression: LZ4 on Docker layers (20-30% space savings)
- ✅ Encryption: Per-dataset AES-256-GCM
- ✅ Snapshots: Instant point-in-time backups
- ✅ Clones: Fast container image cloning

---

## 🗄️ MariaDB Architecture

### **Decision: Native Process (NOT Docker)**

**Why native MariaDB, not Docker?**

| Aspect | Native | Docker |
|--------|--------|--------|
| **Performance** | ✅ Direct filesystem access | ❌ Overlay overhead |
| **ZFS Integration** | ✅ Native dataset per table | ❌ Additional abstraction |
| **Snapshots** | ✅ Instant ZFS snapshots | ⚠️ Need to snapshot volume |
| **File-per-table** | ✅ Direct ZFS dataset mapping | ❌ Harder to isolate |
| **Backup** | ✅ XtraBackup + ZFS snapshots | ⚠️ Volume complexity |
| **Multi-tenant** | ✅ Unix user + ZFS quota | ⚠️ Container sprawl |

**Verdict:** Native MariaDB with ZFS datasets per project/tenant

### **MariaDB + ZFS Configuration**

**File-per-table enabled:**
```ini
# /etc/my.cnf.d/safebox.cnf
[mysqld]
datadir = /srv/mariadb/data
socket = /var/lib/mysql/mysql.sock

# File-per-table (CRITICAL)
innodb_file_per_table = 1

# Use ZFS recordsize
innodb_page_size = 16k  # Matches ZFS recordsize

# Safebox-specific
innodb_flush_method = O_DIRECT
innodb_buffer_pool_size = 16G  # Adjust per instance
innodb_log_file_size = 2G

# Multi-tenant
max_connections = 500
thread_cache_size = 50
```

**ZFS dataset structure:**
```
safebox-pool/mariadb (parent dataset)
├── data/               → MySQL system tables
├── tenants/
│   ├── tenant_alice/   → ZFS dataset (quota, compression, snapshot)
│   ├── tenant_bob/     → ZFS dataset
│   └── tenant_charlie/ → ZFS dataset
└── projects/
    ├── project_001/    → ZFS dataset (for experiments/workspaces)
    ├── project_002/    → ZFS dataset
    └── project_003/    → ZFS dataset
```

**Create tenant database:**
```bash
# Create ZFS dataset for tenant
zfs create -o compression=lz4 \
    -o encryption=on \
    -o quota=10G \
    -o recordsize=16k \
    safebox-pool/mariadb/tenants/tenant_alice

# Create database directory
mkdir -p /srv/mariadb/tenants/tenant_alice

# MariaDB creates tables here
mysql -e "CREATE DATABASE alice_db;"
mysql -e "CREATE TABLE alice_db.my_table (...) DATA DIRECTORY='/srv/mariadb/tenants/tenant_alice';"
```

---

## 🔬 Workspace/Experiment Architecture

### **The Key Insight: ZFS Clone = Instant Workspace**

**Scenario:** User wants to run 10 different experiments on the same project without affecting the main database.

**Solution:** ZFS snapshots + clones

**Step-by-step:**

```bash
# 1. Create base project dataset
zfs create safebox-pool/projects/project_001
zfs set compression=lz4 safebox-pool/projects/project_001
zfs set quota=50G safebox-pool/projects/project_001

# 2. Populate with data
mysql -e "CREATE DATABASE project_001;"
# ... load data via file-per-table into /srv/projects/project_001 ...

# 3. Take snapshot (instant, zero space)
zfs snapshot safebox-pool/projects/project_001@baseline

# 4. Create workspace clones (instant, copy-on-write)
zfs clone safebox-pool/projects/project_001@baseline \
    safebox-pool/projects/project_001_experiment_a

zfs clone safebox-pool/projects/project_001@baseline \
    safebox-pool/projects/project_001_experiment_b

zfs clone safebox-pool/projects/project_001@baseline \
    safebox-pool/projects/project_001_experiment_c

# Now you have 3 independent workspaces, each using ZERO additional space initially
# They diverge only as writes occur (copy-on-write)
```

**MariaDB perspective:**
```sql
-- Base database
CREATE DATABASE project_001;
CREATE TABLE project_001.data (...) DATA DIRECTORY='/srv/projects/project_001';

-- Experiment A (points to clone)
CREATE DATABASE project_001_exp_a;
CREATE TABLE project_001_exp_a.data (...) DATA DIRECTORY='/srv/projects/project_001_experiment_a';

-- Experiment B (points to clone)
CREATE DATABASE project_001_exp_b;
CREATE TABLE project_001_exp_b.data (...) DATA DIRECTORY='/srv/projects/project_001_experiment_b';
```

**Benefits:**
- ✅ Instant workspace creation (milliseconds)
- ✅ Zero initial space overhead (copy-on-write)
- ✅ Full isolation (writes don't affect baseline)
- ✅ Can delete experiments without touching baseline
- ✅ All running in ONE MariaDB server

**Space usage:**
```bash
# Check space used by clones
zfs list -r safebox-pool/projects

NAME                                  USED   AVAIL
safebox-pool/projects/project_001     10G    40G
  @baseline                           0      -
project_001_experiment_a              250M   40G    # Only divergent data
project_001_experiment_b              180M   40G    # Only divergent data
project_001_experiment_c              320M   40G    # Only divergent data
```

---

## 🏗️ PHP + Node Architecture

### **Decision: Native Processes (NOT Docker)**

**Why native PHP-FPM and Node.js?**

| Aspect | Native | Docker |
|--------|--------|--------|
| **Performance** | ✅ No virtualization overhead | ❌ Network, I/O overhead |
| **Multi-tenant** | ✅ Unix users + systemd slices | ⚠️ Container per tenant? |
| **ZFS Access** | ✅ Direct filesystem access | ⚠️ Bind mounts |
| **Complexity** | ✅ Simple systemd units | ❌ Orchestration needed |
| **Resource Isolation** | ✅ cgroups v2 (systemd) | ✅ cgroups v2 (Docker) |

**Verdict:** Native PHP-FPM and Node.js with systemd-based isolation

### **PHP-FPM Multi-Tenant Architecture**

**Per-tenant PHP-FPM pools:**
```ini
# /etc/php-fpm.d/tenant_alice.conf
[tenant_alice]
user = alice
group = alice
listen = /run/php-fpm/alice.sock
listen.owner = nginx
listen.group = nginx
listen.mode = 0660

pm = ondemand
pm.max_children = 5
pm.process_idle_timeout = 300s

# Chroot isolation
chroot = /srv/tenants/alice
chdir = /

# PHP settings
php_admin_value[open_basedir] = /srv/tenants/alice:/tmp
php_admin_value[upload_tmp_dir] = /srv/tenants/alice/tmp
php_admin_value[session.save_path] = /srv/tenants/alice/sessions
```

**ZFS dataset per tenant:**
```bash
zfs create -o compression=lz4 \
    -o encryption=on \
    -o quota=20G \
    -o mountpoint=/srv/tenants/alice \
    safebox-pool/tenants/alice
```

### **Node.js Multi-Tenant Architecture**

**Per-tenant Node.js service:**
```ini
# /etc/systemd/system/node-alice.service
[Unit]
Description=Node.js service for tenant alice
After=network.target

[Service]
Type=simple
User=alice
Group=alice
WorkingDirectory=/srv/tenants/alice/node
ExecStart=/usr/bin/node server.js

# Resource limits (cgroups v2)
CPUQuota=100%           # 1 full CPU
MemoryMax=2G
TasksMax=200

# Filesystem isolation
ReadOnlyPaths=/usr /lib /lib64
ReadWritePaths=/srv/tenants/alice

Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Benefits:**
- ✅ Per-tenant resource limits (CPU, memory, tasks)
- ✅ Filesystem isolation via systemd
- ✅ ZFS quotas per tenant
- ✅ Simple restart/status via systemctl

---

## 📁 Complete Directory Structure

```
/ (ext4, root volume)
├── /boot                           # ext4 (required for AWS boot)
├── /var/log                        # ext4 (system logs)
├── /etc                            # ext4 (configuration)
└── /srv (ZFS pool: safebox-pool)   # All data on ZFS
    │
    ├── /srv/safebox                # ZFS dataset: safebox-pool/safebox
    │   ├── bin/                    # Safebox executables
    │   ├── lib/                    # Libraries (libsafebox_deterministic.so)
    │   ├── manifests/              # Component manifests
    │   ├── node_modules/           # NPM packages
    │   ├── runtimes/               # AI runtimes (llama.cpp, ONNX, etc.)
    │   └── models/                 # AI models
    │
    ├── /srv/docker                 # ZFS dataset: safebox-pool/docker
    │   ├── overlay2/               # Docker overlay2 storage
    │   ├── image/                  # Image layers
    │   ├── volumes/                # Named volumes
    │   └── containers/             # Container metadata
    │
    ├── /srv/mariadb                # ZFS dataset: safebox-pool/mariadb
    │   ├── data/                   # MySQL system tables
    │   │   ├── mysql/
    │   │   ├── performance_schema/
    │   │   └── sys/
    │   ├── tenants/                # Per-tenant databases
    │   │   ├── tenant_alice/       # ZFS dataset (quota, snapshot-able)
    │   │   ├── tenant_bob/         # ZFS dataset
    │   │   └── tenant_charlie/     # ZFS dataset
    │   └── projects/               # Projects/experiments
    │       ├── project_001/        # ZFS dataset
    │       │   @baseline           # ZFS snapshot
    │       ├── project_001_exp_a/  # ZFS clone (workspace)
    │       ├── project_001_exp_b/  # ZFS clone (workspace)
    │       └── project_002/        # ZFS dataset
    │
    └── /srv/tenants                # ZFS dataset: safebox-pool/tenants
        ├── alice/                  # ZFS dataset (quota, encrypted)
        │   ├── public/             # Web root
        │   ├── node/               # Node.js app
        │   ├── tmp/                # PHP uploads
        │   └── sessions/           # PHP sessions
        ├── bob/                    # ZFS dataset
        └── charlie/                # ZFS dataset
```

---

## 🔄 Backup & Sync Strategy

### **Scenario 1: Flush + Sync Files to Another Safebox**

```bash
# On Source Safebox (flush tables)
mysql -e "FLUSH TABLES WITH READ LOCK;"

# ZFS send to remote Safebox
zfs send safebox-pool/projects/project_001@snapshot | \
    ssh remote-safebox "zfs receive safebox-pool/projects/project_001"

# Release lock
mysql -e "UNLOCK TABLES;"
```

### **Scenario 2: ZFS Snapshot + Clone (Same Server)**

```bash
# Snapshot project (instant, zero space)
zfs snapshot safebox-pool/projects/project_001@experiment_start

# Clone for experiment (instant, copy-on-write)
zfs clone safebox-pool/projects/project_001@experiment_start \
    safebox-pool/projects/project_001_experiment

# Run experiment in isolated workspace
mysql -e "CREATE DATABASE experiment_db;"
mysql -e "CREATE TABLE experiment_db.data (...) \
    DATA DIRECTORY='/srv/projects/project_001_experiment';"

# Experiment done? Delete clone (instant)
zfs destroy safebox-pool/projects/project_001_experiment
```

### **Scenario 3: XtraBackup for Incremental Backups**

```bash
# Full backup
xtrabackup --backup \
    --target-dir=/srv/backups/full \
    --datadir=/srv/mariadb/data

# ZFS snapshot the backup (instant, compressed, encrypted)
zfs snapshot safebox-pool/backups@full_$(date +%Y%m%d)

# Incremental backup (next day)
xtrabackup --backup \
    --target-dir=/srv/backups/inc1 \
    --incremental-basedir=/srv/backups/full \
    --datadir=/srv/mariadb/data

# ZFS snapshot incremental
zfs snapshot safebox-pool/backups@inc1_$(date +%Y%m%d)
```

---

## 🎯 Why This Architecture?

### **ZFS Benefits**

1. **Instant Snapshots**
   - Point-in-time copies in milliseconds
   - Zero initial space overhead

2. **Instant Clones**
   - Copy-on-write experiments
   - 10 workspaces from 1 baseline = 10x productivity

3. **Compression**
   - LZ4: 20-30% space savings, minimal CPU
   - Transparent to applications

4. **Encryption**
   - Per-dataset AES-256-GCM
   - Key management via TPM

5. **Quotas**
   - Hard limits per tenant/project
   - Prevent one tenant from filling disk

6. **Checksums**
   - Silent corruption detection
   - Automatic repair (if redundancy exists)

### **Native Processes (Not Docker) Benefits**

1. **Performance**
   - No overlay network overhead
   - Direct filesystem access
   - No layer abstraction

2. **Simplicity**
   - systemd units vs Docker Compose
   - Standard Unix tools
   - Less complexity

3. **ZFS Integration**
   - Direct dataset access
   - No bind mount complexity
   - Native snapshot/clone

4. **Multi-Tenancy**
   - Unix users + cgroups
   - Per-tenant PHP-FPM pools
   - Per-tenant Node.js services
   - Simple and battle-tested

### **When to Use Docker**

Docker IS used, but for specific workloads:

1. **AI Model Serving**
   - vLLM containers (GPU isolation)
   - Isolated Python environments

2. **Third-Party Services**
   - Redis (cache)
   - Elasticsearch (search)
   - Any non-core services

3. **Sandboxed Execution**
   - User-uploaded code
   - Untrusted workloads

**NOT for:**
- PHP-FPM (native is faster)
- Node.js services (native is simpler)
- MariaDB (ZFS integration critical)
- nginx (performance-critical)

---

## 🚀 Example Workflow: Create Experiment

```bash
#!/bin/bash
# create-experiment.sh project_001 experiment_a

PROJECT=$1
EXPERIMENT=$2

# 1. Flush MariaDB (ensure consistency)
mysql -e "FLUSH TABLES WITH READ LOCK; SELECT SLEEP(1); UNLOCK TABLES;"

# 2. Snapshot project dataset
zfs snapshot safebox-pool/projects/${PROJECT}@${EXPERIMENT}_baseline

# 3. Clone for experiment (instant, zero space initially)
zfs clone safebox-pool/projects/${PROJECT}@${EXPERIMENT}_baseline \
    safebox-pool/projects/${PROJECT}_${EXPERIMENT}

# 4. Create database pointing to clone
mysql << EOF
CREATE DATABASE ${PROJECT}_${EXPERIMENT};
CREATE TABLE ${PROJECT}_${EXPERIMENT}.data (...) 
    DATA DIRECTORY='/srv/projects/${PROJECT}_${EXPERIMENT}';
EOF

# 5. Experiment ready!
echo "Experiment workspace ready at: /srv/projects/${PROJECT}_${EXPERIMENT}"
echo "Database: ${PROJECT}_${EXPERIMENT}"
```

**Result:** Instant workspace, zero initial space, full isolation, all in one MariaDB server!

---

## 📊 Resource Allocation

### **Medium-tier Instance (r6i.8xlarge)**

| Component | Dataset | Quota | Compression | Encryption |
|-----------|---------|-------|-------------|------------|
| Safebox binaries | safebox-pool/safebox | 50 GB | lz4 | ✅ |
| Docker overlay | safebox-pool/docker | 100 GB | lz4 | ✅ |
| MariaDB data | safebox-pool/mariadb | 200 GB | lz4 | ✅ |
| Tenants (10) | safebox-pool/tenants/* | 20 GB each | lz4 | ✅ |
| Projects (5) | safebox-pool/projects/* | 50 GB each | lz4 | ✅ |

**Total ZFS pool:** ~850 GB (compressed to ~600 GB with LZ4)

---

## ✅ Final Recommendations

1. **✅ Use ZFS** for /srv (data) only, not root filesystem
2. **✅ Docker overlay2** on ZFS dataset (safebox-pool/docker)
3. **✅ Native MariaDB** with file-per-table on ZFS datasets
4. **✅ Native PHP-FPM** with per-tenant pools and ZFS datasets
5. **✅ Native Node.js** with systemd units and ZFS datasets
6. **✅ Docker for AI models**, third-party services, sandboxed execution only
7. **✅ ZFS snapshots + clones** for instant workspaces/experiments
8. **✅ XtraBackup + ZFS snapshots** for backups
9. **✅ One MariaDB server** serving all tenants/projects with dataset isolation

**This gives you:**
- Instant experiment creation (ZFS clone)
- Zero space overhead initially (copy-on-write)
- Full isolation (separate datasets)
- Simple management (one MariaDB, systemd units)
- Maximum performance (native processes, direct filesystem)

🎉 **Production-ready multi-tenant architecture!**
