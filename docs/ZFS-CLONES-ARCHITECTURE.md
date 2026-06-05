# Safebox Multi-App Architecture with ZFS Clones

**Architecture:** Each app runs in its own isolated Docker container with its own ZFS clone of the platform.

---

## 🎯 Why This Architecture?

### **Problem with Shared Platform**
```
Single Qbix Platform Container
├── App: Safebox
├── App: CommunityX  
├── App: CommunityY
└── App: BusinessZ
```

❌ One app's bug crashes all apps  
❌ Can't update one app independently  
❌ Shared filesystem = security risk  
❌ Resource contention  
❌ Complex multi-tenancy logic  

### **Solution: ZFS Clones Per App**
```
ZFS Pool
├── qbix-platform@base (snapshot)
│   ├── qbix-platform/safebox (clone)      → Docker: safebox-app-safebox
│   ├── qbix-platform/community-x (clone)  → Docker: safebox-app-community-x
│   └── qbix-platform/community-y (clone)  → Docker: safebox-app-community-y
```

✅ **Isolation:** Each app in separate container + filesystem  
✅ **Efficiency:** ZFS clones = copy-on-write (nearly free)  
✅ **Updates:** Update base, clone gets changes  
✅ **Rollback:** Snapshot per app, instant rollback  
✅ **Security:** No shared filesystem between apps  

---

## 📊 How ZFS Clones Work

### **1. Create Base Snapshot**
```bash
# Install Qbix platform to base dataset
zfs create zpool/qbix-platform

# Install platform code
rsync -a /opt/qbix-platform/ /zpool/qbix-platform/

# Create base snapshot (read-only)
zfs snapshot zpool/qbix-platform@base
```

### **2. Clone Per App (Copy-on-Write)**
```bash
# Create clone for Safebox app
zfs clone zpool/qbix-platform@base zpool/qbix-platform/safebox

# Clone is initially zero bytes (just pointers)
# Writes create new blocks (copy-on-write)
```

### **3. Mount in Docker**
```yaml
safebox-app-safebox:
  volumes:
    - /zpool/qbix-platform/safebox:/opt/qbix/platform:ro
    - safebox-data:/opt/qbix/app
```

### **4. Space Efficiency**
```bash
# Base snapshot: 500MB
# 10 app clones: 500MB + (only changed files)
# Instead of: 10 × 500MB = 5GB
```

---

## 🏗️ Implementation

### **1. ZFS Setup Script**

**File:** `scripts/setup-zfs-clones.sh`

```bash
#!/bin/bash
set -euo pipefail

POOL="zpool"
PLATFORM_DATASET="$POOL/qbix-platform"
PLATFORM_BASE_SNAPSHOT="$PLATFORM_DATASET@base"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Create platform dataset if doesn't exist
if ! zfs list "$PLATFORM_DATASET" &>/dev/null; then
    log "Creating platform dataset..."
    zfs create "$PLATFORM_DATASET"
    zfs set compression=lz4 "$PLATFORM_DATASET"
    zfs set atime=off "$PLATFORM_DATASET"
fi

# Install platform code
log "Installing Qbix platform to $PLATFORM_DATASET..."
MOUNT_POINT=$(zfs get -H -o value mountpoint "$PLATFORM_DATASET")

# Clone platform repo or copy existing installation
if [ -d "/opt/qbix-platform" ]; then
    rsync -a /opt/qbix-platform/ "$MOUNT_POINT/"
else
    git clone https://github.com/Qbix/Platform.git "$MOUNT_POINT/"
fi

# Create base snapshot
log "Creating base snapshot..."
zfs snapshot "$PLATFORM_BASE_SNAPSHOT"

log "✓ Platform base ready: $PLATFORM_BASE_SNAPSHOT"
```

### **2. Create App Clone**

**File:** `scripts/create-app-clone.sh`

```bash
#!/bin/bash
set -euo pipefail

APP_NAME="$1"
POOL="zpool"
PLATFORM_DATASET="$POOL/qbix-platform"
PLATFORM_BASE_SNAPSHOT="$PLATFORM_DATASET@base"
APP_CLONE="$PLATFORM_DATASET/$APP_NAME"

if [ -z "$APP_NAME" ]; then
    echo "Usage: $0 <app-name>"
    echo "Example: $0 safebox"
    exit 1
fi

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Check if base snapshot exists
if ! zfs list "$PLATFORM_BASE_SNAPSHOT" &>/dev/null; then
    echo "ERROR: Base snapshot not found: $PLATFORM_BASE_SNAPSHOT"
    echo "Run: scripts/setup-zfs-clones.sh first"
    exit 1
fi

# Create clone
if zfs list "$APP_CLONE" &>/dev/null; then
    log "Clone already exists: $APP_CLONE"
else
    log "Creating clone for app: $APP_NAME"
    zfs clone "$PLATFORM_BASE_SNAPSHOT" "$APP_CLONE"
    
    # Set quota (optional)
    zfs set quota=10G "$APP_CLONE"
    
    log "✓ Clone created: $APP_CLONE"
fi

# Get mount point
MOUNT_POINT=$(zfs get -H -o value mountpoint "$APP_CLONE")
log "Mount point: $MOUNT_POINT"

# Create app-specific data dataset
APP_DATA="$POOL/app-data/$APP_NAME"
if ! zfs list "$APP_DATA" &>/dev/null; then
    log "Creating app data dataset: $APP_DATA"
    zfs create -p "$APP_DATA"
    zfs set quota=100G "$APP_DATA"
fi

APP_DATA_MOUNT=$(zfs get -H -o value mountpoint "$APP_DATA")
log "App data mount: $APP_DATA_MOUNT"

echo ""
echo "=== Clone Ready ==="
echo "Platform: $MOUNT_POINT"
echo "App Data: $APP_DATA_MOUNT"
echo ""
echo "Add to docker-compose.yml:"
echo "  safebox-app-$APP_NAME:"
echo "    volumes:"
echo "      - $MOUNT_POINT:/opt/qbix/platform:ro"
echo "      - $APP_DATA_MOUNT:/opt/qbix/app"
```

### **3. Docker Compose with Clones**

**File:** `docker-compose-zfs.yml`

```yaml
version: '3.8'

networks:
  safebox-net:
    driver: bridge

volumes:
  safebox-sockets:
    driver: local
  mariadb-data:
  redis-data:

services:
  # =========================================================================
  # INFRASTRUCTURE
  # =========================================================================
  
  safebox-mariadb:
    image: mariadb:11.2
    container_name: safebox-mariadb
    networks:
      - safebox-net
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    volumes:
      - mariadb-data:/var/lib/mysql
    restart: unless-stopped
  
  safebox-redis:
    image: redis:7.2
    container_name: safebox-redis
    networks:
      - safebox-net
    volumes:
      - redis-data:/data
    restart: unless-stopped
  
  safebox-nginx:
    image: nginx:1.25
    container_name: safebox-nginx
    networks:
      - safebox-net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /etc/nginx/sites-enabled:/etc/nginx/sites-enabled
      - /etc/letsencrypt:/etc/letsencrypt
    restart: unless-stopped
  
  # =========================================================================
  # APP CONTAINERS (Each with ZFS Clone)
  # =========================================================================
  
  safebox-app-safebox:
    image: qbix/app:latest
    container_name: safebox-app-safebox
    networks:
      - safebox-net
    user: "1000:1000"
    environment:
      APP_NAME: Safebox
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
      MYSQL_DB: safebox
    volumes:
      # Platform: ZFS clone (read-only)
      - /zpool/qbix-platform/safebox:/opt/qbix/platform:ro
      
      # App data: ZFS dataset (read-write)
      - /zpool/app-data/safebox:/opt/qbix/app
      
      # Shared sockets
      - safebox-sockets:/run/safebox/services
      
      # Keys
      - /etc/safebox:/etc/safebox:ro
    restart: unless-stopped
  
  safebox-app-community-x:
    image: qbix/app:latest
    container_name: safebox-app-community-x
    networks:
      - safebox-net
    user: "1000:1000"
    environment:
      APP_NAME: CommunityX
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
      MYSQL_DB: community_x
    volumes:
      # Platform: ZFS clone (read-only)
      - /zpool/qbix-platform/community-x:/opt/qbix/platform:ro
      
      # App data: ZFS dataset (read-write)
      - /zpool/app-data/community-x:/opt/qbix/app
      
      # Shared sockets
      - safebox-sockets:/run/safebox/services
      
      # Keys
      - /etc/safebox:/etc/safebox:ro
    restart: unless-stopped
  
  safebox-app-community-y:
    image: qbix/app:latest
    container_name: safebox-app-community-y
    networks:
      - safebox-net
    user: "1000:1000"
    environment:
      APP_NAME: CommunityY
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
      MYSQL_DB: community_y
    volumes:
      # Platform: ZFS clone (read-only)
      - /zpool/qbix-platform/community-y:/opt/qbix/platform:ro
      
      # App data: ZFS dataset (read-write)
      - /zpool/app-data/community-y:/opt/qbix/app
      
      # Shared sockets
      - safebox-sockets:/run/safebox/services
      
      # Keys
      - /etc/safebox:/etc/safebox:ro
    restart: unless-stopped
  
  # =========================================================================
  # MODEL RUNNERS (Shared by all apps)
  # =========================================================================
  
  safebox-model-llm:
    image: safebox/vllm:latest
    container_name: safebox-model-llm
    networks:
      - safebox-net
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['0']
              capabilities: [gpu]
    environment:
      SERVICE_ID: model-llm-1
      ENABLE_UNIX_SOCKET: "true"
      SAFEBOX_SOCKET_PATH: /run/safebox/services/model-llm-1.sock
    volumes:
      - safebox-sockets:/run/safebox/services
      - /models/cache:/models/cache
      - /etc/safebox:/etc/safebox:ro
    restart: unless-stopped
```

---

## 🔄 App Lifecycle Operations

### **Create New App**

```bash
# 1. Create ZFS clone
./scripts/create-app-clone.sh my-new-app

# 2. Add to docker-compose.yml
# (copy safebox-app-safebox, change APP_NAME and volumes)

# 3. Create database
mysql -e "CREATE DATABASE my_new_app"

# 4. Start container
docker-compose up -d safebox-app-my-new-app
```

### **Update Platform (All Apps)**

```bash
# 1. Update base
cd /zpool/qbix-platform
git pull

# 2. Create new snapshot
zfs snapshot zpool/qbix-platform@$(date +%Y%m%d-%H%M%S)

# 3. Promote clones (optional - makes clone independent)
zfs promote zpool/qbix-platform/safebox

# 4. Restart apps
docker-compose restart safebox-app-safebox
```

### **Update Single App**

```bash
# Only that app's clone gets changes
cd /zpool/qbix-platform/safebox
# Make changes...

# Restart just that app
docker-compose restart safebox-app-safebox
```

### **Rollback App**

```bash
# Snapshot before risky change
zfs snapshot zpool/qbix-platform/safebox@before-upgrade

# Try upgrade
# ...

# Rollback if failed
zfs rollback zpool/qbix-platform/safebox@before-upgrade
docker-compose restart safebox-app-safebox
```

### **Delete App**

```bash
# 1. Stop container
docker-compose stop safebox-app-my-app

# 2. Destroy clone
zfs destroy zpool/qbix-platform/my-app

# 3. Destroy app data (careful!)
zfs destroy zpool/app-data/my-app

# 4. Drop database
mysql -e "DROP DATABASE my_app"
```

---

## 📊 Monitoring ZFS Usage

```bash
# List all clones
zfs list -t all | grep qbix-platform

# Show space used by each app
zfs list -o name,used,refer,mountpoint | grep qbix-platform

# Example output:
# NAME                          USED  REFER  MOUNTPOINT
# zpool/qbix-platform          500M   500M  /zpool/qbix-platform
# zpool/qbix-platform@base       0B      -  -
# zpool/qbix-platform/safebox   5M   500M  /zpool/qbix-platform/safebox
# zpool/qbix-platform/community-x  2M   500M  /zpool/qbix-platform/community-x
```

**Explanation:**
- `USED`: Actual disk space (only changed blocks)
- `REFER`: Logical size (includes base)
- Clone overhead: 5MB (only files changed from base)

---

## 🎯 Benefits Summary

### **Isolation**
- ✅ Each app = separate container + filesystem
- ✅ One app crash doesn't affect others
- ✅ Independent restarts/updates

### **Efficiency**
- ✅ ZFS clones = copy-on-write (nearly free)
- ✅ 10 apps ≈ 1 app disk usage (until divergence)
- ✅ Snapshots are instant

### **Operations**
- ✅ Update base → all apps get changes
- ✅ Update one app → others unaffected
- ✅ Instant rollback per app
- ✅ Easy to add/remove apps

### **Security**
- ✅ No shared writeable filesystem
- ✅ Each app isolated from others
- ✅ Platform mounted read-only

---

## ✅ Production Checklist

- [ ] ZFS pool created with compression
- [ ] Base platform snapshot created
- [ ] Clone per app created
- [ ] App data datasets created with quotas
- [ ] Docker compose updated with ZFS paths
- [ ] Nginx routing configured per app
- [ ] Database per app created
- [ ] Monitoring ZFS usage

---

## 🚀 Quick Start

```bash
# 1. Setup ZFS base
./scripts/setup-zfs-clones.sh

# 2. Create app clones
./scripts/create-app-clone.sh safebox
./scripts/create-app-clone.sh community-x
./scripts/create-app-clone.sh community-y

# 3. Start all apps
docker-compose -f docker-compose-zfs.yml up -d

# 4. Verify
zfs list | grep qbix-platform
docker ps | grep safebox-app
```

**Result:** 3 isolated apps sharing the same platform code efficiently!
