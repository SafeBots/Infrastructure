# Safebox Implementation Guide

**Complete guide for implementing Infrastructure governance in Safebox**

---

## 🎯 Architecture Overview

### Per-App Containers with ZFS Clones

**Key insight:** Each Qbix app runs in its own isolated container with a ZFS clone of the Platform.

```
ZFS Base Snapshot:
    zpool/qbix-platform@base (Qbix Platform core)
        ↓ (instant clone)
    ┌─────────────────┬─────────────────┬─────────────────┐
    │                 │                 │                 │
safebox-app-safebox  safebox-app-intercoin  safebox-app-groups
    │                     │                     │
/opt/qbix/platform   /opt/qbix/platform   /opt/qbix/platform
/opt/qbix/app        /opt/qbix/app        /opt/qbix/app
    ↓                     ↓                     ↓
web/index.php        web/index.php        web/index.php
```

**Benefits:**
- ✅ Each app isolated (crash in one ≠ crash in all)
- ✅ Platform is copy-on-write (instant clone, minimal disk)
- ✅ Independent updates per app
- ✅ Instant rollback per app via ZFS snapshots

---

## 📂 Directory Structure

### Inside Each App Container

```
/opt/qbix/
├── platform/           ← ZFS clone of base Platform
│   ├── platform/
│   │   ├── classes/
│   │   ├── handlers/
│   │   └── plugins/
│   │       ├── Streams/     ← Git submodule
│   │       ├── Safebox/     ← Git submodule
│   │       ├── Users/       ← Git submodule
│   │       └── Assets/      ← Git submodule
│   └── composer.json
│
└── app/                ← App-specific code
    ├── web/            ← Document root (nginx proxies here)
    │   └── index.php
    ├── config/
    │   └── app.json
    └── local/
        └── app.json
```

**Key points:**
- `/opt/qbix/platform` = Shared Platform core (ZFS cloned from base)
- `/opt/qbix/app` = App-specific code (Safebox, Intercoin, or Groups)
- `/opt/qbix/app/web` = Document root for nginx

---

## 🔧 Available Actions

| Action | Purpose | Verification |
|--------|---------|--------------|
| **git** | Clone/update repos | Commit hash via `git rev-parse HEAD` |
| **npm** | Update Node packages | Built-in integrity hash |
| **composer** | Update PHP packages | SHA-256 from composer.lock |
| **zfs-snapshot** | Create ZFS snapshot | `zfs list -t snapshot` |
| **zfs-rollback** | Rollback to snapshot | ZFS rollback with `-r` |
| **nginx-config** | Configure app site | `nginx -t` config test |
| **nginx-cert** | Update SSL cert | Certificate file check |

---

## 🚀 Implementation (Node.js Only)

**Your Node.js already handles everything!** The PHP handler is just a thin wrapper.

### Protocol.System Flow

```javascript
// In Safebox Protocol.System (Node.js)

async function execute(claim) {
    // 1. Verify M-of-N signatures
    const verification = await verifySignatures(claim);
    if (!verification.valid) {
        throw new Error('Insufficient signatures');
    }
    
    // 2. Create verifiedOpToken (Safebox signs the operation)
    const opToken = await signOpToken(claim);
    
    // 3. Call Infrastructure API via Unix socket
    const result = await callInfrastructure(claim, opToken);
    
    // 4. Log to audit
    await Safebox_System_Log.record({
        action: claim.stm.action,
        container: claim.stm.container,
        details: getActionDetails(claim.stm),
        verified: result.verified,
        signers: verification.signers
    });
    
    return result;
}

async function callInfrastructure(claim, opToken) {
    const hmacKey = fs.readFileSync('/etc/safebox/system-api.key', 'utf8');
    
    // Sign request with HMAC
    const signature = crypto.createHmac('sha256', hmacKey)
        .update(JSON.stringify(claim))
        .digest('hex');
    
    // POST to Infrastructure API
    const response = await fetch('http://localhost/container/' + claim.stm.action, {
        socketPath: '/run/safebox/system-api.sock',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Safebox-Signature': signature  // HMAC
        },
        body: JSON.stringify(claim)
    });
    
    const result = await response.json();
    
    // Verify response HMAC
    const responseSig = response.headers.get('X-Safebox-Signature');
    const expectedSig = crypto.createHmac('sha256', hmacKey)
        .update(JSON.stringify(result))
        .digest('hex');
    
    if (responseSig !== expectedSig) {
        throw new Error('Invalid response HMAC - Infrastructure may be compromised');
    }
    
    return result;
}
```

### Thin PHP Handler (Optional)

**Only needed if you want web requests to trigger governance:**

```php
<?php
// Safebox/handlers/Safebox/system/action/post.php

function Safebox_system_action_post()
{
    // Just forward to Node.js Protocol.System
    $claim = $_REQUEST['claim'];
    
    // Protocol.System does:
    // - M-of-N verification
    // - verifiedOpToken signing
    // - HMAC signing
    // - Call to Infrastructure
    // - Response verification
    // - Audit logging
    
    $result = Q_Utils::executeNode('Protocol.System', $claim);
    Q_Response::setSlot('result', $result);
}
```

**That's it!** Node.js handles everything else.

---

## 📦 Action Examples

### 1. Git Clone Platform (Initial Setup)

```javascript
const claim = {
    ocp: 1,
    stm: {
        action: 'git',
        container: 'safebox-app-safebox',
        url: 'https://github.com/Qbix/Platform.git',
        dest: '/opt/qbix/platform',
        commit: 'a1b2c3d4e5f6789012345678901234567890abcd',
        submodules: true,
        zfsSnapshot: 'after'  // Snapshot after successful clone
    },
    jti: crypto.randomBytes(16).toString('hex'),
    key: ['admin1', 'admin2', 'admin3'],
    sig: [/* M-of-N signatures */]
};

const result = await Protocol.System.execute(claim);
// Result: { verified: true, commit: 'a1b2c3d4...', snapshot: '@after-clone' }
```

**Infrastructure does:**
```bash
cd /opt/qbix/platform
git clone https://github.com/Qbix/Platform.git .
git checkout a1b2c3d4e5f6789012345678901234567890abcd
git submodule init && git submodule update
git rev-parse HEAD  # Verify: a1b2c3d4...
zfs snapshot zpool/app-safebox-platform@after-clone
```

### 2. Git Update Platform with Rollback Protection

```javascript
const claim = {
    ocp: 1,
    stm: {
        action: 'git',
        container: 'safebox-app-safebox',
        repo: '/opt/qbix/platform',
        ref: 'origin/master',
        commit: 'b2c3d4e5f6789012345678901234567890abcdef',
        submodules: true,
        zfsSnapshot: 'before'  // Snapshot BEFORE update for rollback
    },
    jti: '...',
    key: ['admin1', 'admin2'],
    sig: [...]
};

const result = await Protocol.System.execute(claim);
// Result: { verified: true, snapshot: '@before-update-1745880000' }
```

**Infrastructure does:**
```bash
# Snapshot BEFORE update
zfs snapshot zpool/app-safebox-platform@before-update-1745880000

# Update
cd /opt/qbix/platform
git fetch origin
git checkout b2c3d4e5f6789012345678901234567890abcdef
git submodule update --init --recursive
git rev-parse HEAD  # Verify: b2c3d4e5...
```

### 3. Rollback After Bad Update

```javascript
const claim = {
    ocp: 1,
    stm: {
        action: 'zfs-rollback',
        container: 'safebox-app-safebox',
        dataset: 'zpool/app-safebox-platform',
        snapshot: '@before-update-1745880000'
    },
    jti: '...',
    key: ['admin1', 'admin2'],
    sig: [...]
};

const result = await Protocol.System.execute(claim);
// Result: { verified: true, dataset: 'zpool/app-safebox-platform', snapshot: '@before-update-1745880000' }
```

**Infrastructure does:**
```bash
zfs rollback -r zpool/app-safebox-platform@before-update-1745880000

# Platform is instantly back to pre-update state
# All changes since snapshot are discarded
```

### 4. Update Single Plugin

```javascript
const claim = {
    ocp: 1,
    stm: {
        action: 'git',
        container: 'safebox-app-safebox',
        repo: '/opt/qbix/platform',
        submodules: ['platform/plugins/Streams'],
        commits: {
            'platform/plugins/Streams': 'def456789012345678901234567890abcdefgh'
        },
        zfsSnapshot: 'before'
    },
    jti: '...',
    key: ['admin1', 'admin2'],
    sig: [...]
};
```

**Infrastructure does:**
```bash
zfs snapshot zpool/app-safebox-platform@before-plugin-update
cd /opt/qbix/platform
git submodule update --init platform/plugins/Streams
cd platform/plugins/Streams
git checkout def456789012345678901234567890abcdefgh
git rev-parse HEAD  # Verify: def456...
```

### 5. Enable Nginx Site

```javascript
const claim = {
    ocp: 1,
    stm: {
        action: 'nginx-config',
        container: 'safebox-nginx',
        app: 'safebox',
        domain: 'safebox.example.com',
        upstreamHost: 'safebox-app-safebox',
        upstreamPort: 9000,
        sslProvider: 'letsencrypt'
    },
    jti: '...',
    key: ['admin1', 'admin2'],
    sig: [...]
};
```

**Infrastructure generates:**
```nginx
upstream safebox_backend {
    server safebox-app-safebox:9000;
}

server {
    listen 443 ssl http2;
    server_name safebox.example.com;
    
    ssl_certificate /etc/letsencrypt/live/safebox.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/safebox.example.com/privkey.pem;
    
    location / {
        fastcgi_pass safebox_backend;
        fastcgi_param SCRIPT_FILENAME /opt/qbix/app/web/index.php;
        # ... fastcgi params
    }
}
```

---

## 🔄 Complete Deployment Workflow

### Phase 1: ZFS Setup (Once)

```bash
# Create base Platform dataset
zfs create zpool/qbix-platform
cd /zpool/qbix-platform
git clone https://github.com/Qbix/Platform.git .
git submodule update --init --recursive

# Snapshot the base
zfs snapshot zpool/qbix-platform@base

# Clone for each app
zfs clone zpool/qbix-platform@base zpool/app-safebox-platform
zfs clone zpool/qbix-platform@base zpool/app-intercoin-platform
zfs clone zpool/qbix-platform@base zpool/app-groups-platform
```

### Phase 2: Deploy Apps (Governed)

```javascript
// 1. Clone Safebox app
await Protocol.System.execute({
    stm: {
        action: 'git',
        container: 'safebox-app-safebox',
        url: 'https://github.com/Qbix/Safebox-app.git',
        dest: '/opt/qbix/app',
        commit: 'xyz789...'
    },
    // ... M-of-N signatures
});

// 2. Enable Safebox site
await Protocol.System.execute({
    stm: {
        action: 'nginx-config',
        container: 'safebox-nginx',
        app: 'safebox',
        domain: 'safebox.example.com',
        upstreamHost: 'safebox-app-safebox'
    },
    // ... M-of-N signatures
});

// 3. Start Safebox app
await Protocol.System.execute({
    stm: {
        action: 'start',
        container: 'safebox-app-safebox'
    },
    // ... M-of-N signatures
});
```

### Phase 3: Updates (With Rollback)

```javascript
// Get latest Platform commit
const latestCommit = await getLatestPlatformCommit();

// Propose update with automatic snapshot
await Protocol.System.execute({
    stm: {
        action: 'git',
        container: 'safebox-app-safebox',
        repo: '/opt/qbix/platform',
        commit: latestCommit,
        submodules: true,
        zfsSnapshot: 'before'  // Auto-snapshot before update
    },
    // ... M-of-N signatures
});

// If update breaks something, rollback instantly
await Protocol.System.execute({
    stm: {
        action: 'zfs-rollback',
        container: 'safebox-app-safebox',
        dataset: 'zpool/app-safebox-platform',
        snapshot: '@before-update-1745880000'
    },
    // ... M-of-N signatures
});
```

---

## 🔐 Security: One-Time Grant (OTG) Pattern

**Your Protocol.System already implements this!**

### JTI (Nonce) Prevents Replay

```javascript
const claim = {
    ocp: 1,
    stm: { action: 'git', ... },
    jti: crypto.randomBytes(16).toString('hex'),  // ← Unique nonce
    key: ['admin1', 'admin2'],
    sig: [...]
};

// Infrastructure tracks JTI
// Same JTI twice = rejected
```

### Infrastructure-Side JTI Tracking

```javascript
// In system-protocol-api.js (already implemented)
class JTITracker {
    constructor() {
        this.seen = new Set();
        this.load();  // Load from /var/lib/safebox-system-api/seen-jti.json
    }
    
    has(jti) {
        return this.seen.has(jti);
    }
    
    add(jti) {
        this.seen.add(jti);
        this.save();  // Persist to disk
    }
}

// Usage:
if (jtiTracker.has(claim.jti)) {
    return res.status(409).json({ error: 'JTI already seen (replay attack?)' });
}
jtiTracker.add(claim.jti);
```

**Result:** Each OpenClaim can only be executed ONCE, even with valid M-of-N signatures.

---

## ✅ Implementation Checklist

**For Safebox team:**

### Node.js (Protocol.System)

- [ ] Add `Protocol.System.execute(claim)` function
- [ ] Implement M-of-N signature verification
- [ ] Implement `signOpToken(claim)` 
- [ ] Implement HMAC request signing
- [ ] Implement HMAC response verification
- [ ] Implement audit logging
- [ ] Test: Clone Platform
- [ ] Test: Update Platform with snapshot
- [ ] Test: Rollback to snapshot
- [ ] Test: Update single plugin
- [ ] Test: Enable nginx site

### PHP (Optional Web Interface)

- [ ] Create thin handler: `Safebox/system/action/post.php`
- [ ] Just forward to `Q_Utils::executeNode('Protocol.System', $claim)`

### ZFS Setup

- [ ] Create base Platform snapshot
- [ ] Clone for each app (Safebox, Intercoin, Groups)
- [ ] Mount clones in Docker containers

### Testing

- [ ] Test M-of-N governance workflow
- [ ] Test JTI replay protection
- [ ] Test ZFS snapshot/rollback
- [ ] Test nginx configuration
- [ ] Test SSL certificate renewal

---

## 📊 Summary

**Infrastructure provides:**
✅ Per-app container isolation  
✅ ZFS clone support (copy-on-write Platform)  
✅ Instant rollback via ZFS snapshots  
✅ Git operations with commit verification  
✅ Nginx site configuration  
✅ SSL certificate management  
✅ JTI replay protection  

**Your Node.js implements:**
❌ `Protocol.System.execute(claim)` - Main entry point  
❌ M-of-N signature verification  
❌ `signOpToken(claim)` - Safebox signs the operation  
❌ HMAC request/response signing  
❌ Audit logging  

**Result:**
- One-time grant (OTG) pattern via JTI
- M-of-N governance for all operations
- Instant rollback per app
- Isolated apps with shared Platform (ZFS)

🎉 **Production-grade governance for your entire Qbix stack!**

---

## 🔌 How Apps Access Services

### Architecture: Service Containers + App Containers

```
                    Docker Network: safebox-net
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
safebox-mariadb      safebox-redis         safebox-nginx
    │                       │                       │
    ├─ Port: 3306          ├─ Port: 6379          ├─ Port: 80/443
    └─ Hostname:           └─ Hostname:           └─ Hostname:
       safebox-mariadb        safebox-redis          safebox-nginx
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
safebox-app-safebox  safebox-app-intercoin  safebox-app-groups
    │                       │                       │
    ├─ /opt/qbix/platform  ├─ /opt/qbix/platform  ├─ /opt/qbix/platform
    ├─ /opt/qbix/app       ├─ /opt/qbix/app       ├─ /opt/qbix/app
    │                       │                       │
    └─ Connects to:        └─ Connects to:        └─ Connects to:
       - safebox-mariadb      - safebox-mariadb      - safebox-mariadb
       - safebox-redis         - safebox-redis         - safebox-redis
       - ffmpeg (local)        - ffmpeg (local)        - ffmpeg (local)
```

### How Apps Connect to Services

**Key insight:** Docker DNS resolves container names to IPs automatically.

#### 1. MariaDB Connection

**In app's `local/app.json`:**

```json
{
  "Q": {
    "db": {
      "connections": {
        "main": {
          "driver": "mysql",
          "host": "safebox-mariadb",
          "port": 3306,
          "username": "qbix",
          "password": "...",
          "dbname": "safebox_app"
        }
      }
    }
  }
}
```

**How it works:**
1. App container calls `mysqli_connect('safebox-mariadb', ...)`
2. Docker DNS resolves `safebox-mariadb` → `172.20.0.2` (example)
3. Connection established to MariaDB container

**No exposed ports to host!** All communication via Docker network.

#### 2. Redis Connection

**In app's config:**

```json
{
  "Q": {
    "cache": {
      "redis": {
        "host": "safebox-redis",
        "port": 6379
      }
    }
  }
}
```

**From app's PHP:**
```php
$redis = new Redis();
$redis->connect('safebox-redis', 6379);
```

#### 3. FFmpeg (Local in Each App Container)

**FFmpeg is installed INSIDE each app container:**

```dockerfile
# In app container's Dockerfile
FROM php:8.2-fpm

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Install other tools
RUN apt-get install -y imagemagick ghostscript
```

**App calls FFmpeg directly:**
```php
// In Qbix app code
$cmd = "ffmpeg -i {$inputVideo} -vf scale=1280:720 {$outputVideo}";
exec($cmd, $output, $returnCode);
```

**Why local?** Each app might need different FFmpeg versions or configurations.

---

## 📦 Complete Container Setup

### Docker Compose Structure

**File:** `docker-compose.yml`

```yaml
version: '3.8'

networks:
  safebox-net:
    driver: bridge

services:
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
  
  safebox-app-safebox:
    image: qbix/app:latest
    container_name: safebox-app-safebox
    networks:
      - safebox-net
    environment:
      APP_NAME: Safebox
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
    volumes:
      - type: volume
        source: app-safebox-platform
        target: /opt/qbix/platform
        volume:
          driver: local
          driver_opts:
            type: zfs
            device: zpool/app-safebox-platform
      - type: volume
        source: app-safebox-data
        target: /opt/qbix/app
        volume:
          driver: local
          driver_opts:
            type: zfs
            device: zpool/app-safebox-data
    restart: unless-stopped
  
  safebox-app-intercoin:
    image: qbix/app:latest
    container_name: safebox-app-intercoin
    networks:
      - safebox-net
    environment:
      APP_NAME: Intercoin
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
    volumes:
      - type: volume
        source: app-intercoin-platform
        target: /opt/qbix/platform
        volume:
          driver: local
          driver_opts:
            type: zfs
            device: zpool/app-intercoin-platform
      - type: volume
        source: app-intercoin-data
        target: /opt/qbix/app
    restart: unless-stopped
  
  safebox-app-groups:
    image: qbix/app:latest
    container_name: safebox-app-groups
    networks:
      - safebox-net
    environment:
      APP_NAME: Groups
      MYSQL_HOST: safebox-mariadb
      REDIS_HOST: safebox-redis
    volumes:
      - type: volume
        source: app-groups-platform
        target: /opt/qbix/platform
        volume:
          driver: local
          driver_opts:
            type: zfs
            device: zpool/app-groups-platform
      - type: volume
        source: app-groups-data
        target: /opt/qbix/app
    restart: unless-stopped

volumes:
  mariadb-data:
  redis-data:
  app-safebox-platform:
    external: true
  app-safebox-data:
    external: true
  app-intercoin-platform:
    external: true
  app-intercoin-data:
    external: true
  app-groups-platform:
    external: true
  app-groups-data:
    external: true
```

---

## 🐳 App Container Dockerfile

**File:** `Dockerfile` (for qbix/app image)

```dockerfile
FROM php:8.2-fpm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    libpng-dev \
    libonig-dev \
    libxml2-dev \
    zip \
    unzip \
    ffmpeg \
    imagemagick \
    ghostscript

# Install PHP extensions
RUN docker-php-ext-install \
    pdo_mysql \
    mbstring \
    exif \
    pcntl \
    bcmath \
    gd

# Install Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# Install Node.js (for Protocol.System)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Create Qbix directories
RUN mkdir -p /opt/qbix/platform /opt/qbix/app

# Configure PHP-FPM
RUN sed -i 's/listen = .*/listen = 0.0.0.0:9000/' /usr/local/etc/php-fpm.d/www.conf

WORKDIR /opt/qbix/app

EXPOSE 9000

CMD ["php-fpm"]
```

---

## 🔧 Service Access Patterns

### Pattern 1: Database Access (MariaDB)

**App connects via hostname:**

```php
<?php
// In /opt/qbix/app/config/app.json
$config = Q::config('Q/db/connections/main');

// Result:
// host: "safebox-mariadb"
// port: 3306
// Docker DNS resolves to MariaDB container IP

$db = new PDO(
    "mysql:host={$config['host']};dbname={$config['dbname']}",
    $config['username'],
    $config['password']
);
```

### Pattern 2: Cache Access (Redis)

```php
<?php
$redis = new Redis();
$redis->connect('safebox-redis', 6379);  // Docker DNS resolves
$redis->set('key', 'value');
```

### Pattern 3: Media Processing (FFmpeg - Local)

```php
<?php
// FFmpeg is installed IN the app container
$inputFile = '/opt/qbix/app/files/uploads/video.mp4';
$outputFile = '/opt/qbix/app/files/processed/video-720p.mp4';

// Execute ffmpeg locally
exec("ffmpeg -i {$inputFile} -vf scale=1280:720 {$outputFile}", $output, $returnCode);

if ($returnCode === 0) {
    // Success
}
```

### Pattern 4: Image Processing (ImageMagick - Local)

```php
<?php
// ImageMagick is installed IN the app container
$input = '/opt/qbix/app/files/uploads/photo.jpg';
$output = '/opt/qbix/app/files/thumbnails/photo-thumb.jpg';

exec("convert {$input} -resize 200x200 {$output}");
```

---

## 🌐 Nginx Proxying to Apps

**Nginx sits in front, proxies to app containers:**

```nginx
# /etc/nginx/sites-enabled/safebox

upstream safebox_backend {
    server safebox-app-safebox:9000;  # Docker DNS resolves
}

server {
    listen 443 ssl http2;
    server_name safebox.example.com;
    
    ssl_certificate /etc/letsencrypt/live/safebox.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/safebox.example.com/privkey.pem;
    
    location / {
        # Proxy to PHP-FPM in app container
        fastcgi_pass safebox_backend;
        fastcgi_param SCRIPT_FILENAME /opt/qbix/app/web/index.php;
        fastcgi_param SCRIPT_NAME /index.php;
        # ... other fastcgi params
    }
}
```

**Flow:**
1. Browser → `https://safebox.example.com/Users/login`
2. Nginx receives request
3. Nginx proxies to `safebox-app-safebox:9000` (FastCGI)
4. App container's PHP-FPM executes `/opt/qbix/app/web/index.php`
5. App connects to `safebox-mariadb:3306` and `safebox-redis:6379`
6. Response flows back through Nginx to browser

---

## 🔒 Security Isolation

### Network Isolation

```yaml
# Only Nginx exposes ports to host
safebox-nginx:
  ports:
    - "80:80"
    - "443:443"

# Everything else is isolated
safebox-mariadb:
  # No exposed ports - only accessible via safebox-net

safebox-app-safebox:
  # No exposed ports - nginx proxies via network
```

**Benefits:**
- ✅ MariaDB only accessible from app containers
- ✅ Redis only accessible from app containers
- ✅ Apps only accessible via nginx proxy
- ✅ No direct external access to services

### Per-App Databases

**Each app can have its own database:**

```sql
-- On safebox-mariadb container

CREATE DATABASE safebox_app;
CREATE DATABASE intercoin_app;
CREATE DATABASE groups_app;

GRANT ALL ON safebox_app.* TO 'safebox_user'@'%';
GRANT ALL ON intercoin_app.* TO 'intercoin_user'@'%';
GRANT ALL ON groups_app.* TO 'groups_user'@'%';
```

**App configs reference their own database:**

```json
// safebox-app-safebox config
{
  "Q": {
    "db": {
      "connections": {
        "main": {
          "host": "safebox-mariadb",
          "dbname": "safebox_app"
        }
      }
    }
  }
}
```

---

## 🚀 Protocol.System Implementation Details

### How Protocol.System Calls Infrastructure

**Your Node.js code in app container:**

```javascript
// /opt/qbix/platform/platform/plugins/Q/handlers/Q/request.js

const Protocol = {
    System: {
        async execute(claim) {
            // 1. Verify M-of-N signatures
            const verification = await this.verifySignatures(claim);
            if (!verification.valid) {
                throw new Error('Insufficient signatures');
            }
            
            // 2. Sign operation with Safebox key
            const opToken = await this.signOpToken(claim);
            
            // 3. Call Infrastructure API via Unix socket
            // Note: Unix socket is mounted into container
            const hmacKey = fs.readFileSync('/etc/safebox/system-api.key', 'utf8');
            const signature = crypto.createHmac('sha256', hmacKey)
                .update(JSON.stringify(claim))
                .digest('hex');
            
            const response = await fetch('http://localhost/container/action', {
                socketPath: '/run/safebox/system-api.sock',  // Mounted from host
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Safebox-Signature': signature
                },
                body: JSON.stringify(claim)
            });
            
            const result = await response.json();
            
            // 4. Verify response HMAC
            const responseSig = response.headers.get('X-Safebox-Signature');
            const expectedSig = crypto.createHmac('sha256', hmacKey)
                .update(JSON.stringify(result))
                .digest('hex');
            
            if (responseSig !== expectedSig) {
                throw new Error('Invalid response HMAC - Infrastructure may be compromised');
            }
            
            // 5. Log to audit (MariaDB)
            await this.logAudit(claim, result);
            
            return result;
        },
        
        async verifySignatures(claim) {
            // Your existing M-of-N verification code
            // Reads public keys from Safebox/keys stream
            // Verifies claim.sig matches claim.key
        },
        
        async signOpToken(claim) {
            // Sign with Safebox's private key
            const privateKey = fs.readFileSync('/etc/safebox/signing.key', 'utf8');
            return Q.Crypto.sign(claim, privateKey);
        },
        
        async logAudit(claim, result) {
            // Log to MariaDB
            await Q.Streams.create({
                type: 'Safebox/audit',
                content: JSON.stringify({
                    action: claim.stm.action,
                    container: claim.stm.container,
                    details: this.getActionDetails(claim.stm),
                    verified: result.verified,
                    signers: claim.key,
                    timestamp: Date.now()
                })
            });
        },
        
        getActionDetails(stm) {
            switch (stm.action) {
                case 'git':
                    if (stm.url) return `clone ${stm.url} → ${stm.dest}`;
                    if (stm.submodules) return `update plugins: ${stm.submodules.join(', ')}`;
                    return `checkout ${stm.commit}`;
                case 'npm':
                    return `${stm.package}@${stm.version}`;
                case 'zfs-snapshot':
                    return `snapshot ${stm.dataset}${stm.snapshot}`;
                case 'zfs-rollback':
                    return `rollback ${stm.dataset} → ${stm.snapshot}`;
                case 'nginx-config':
                    return `${stm.app} @ ${stm.domain}`;
                default:
                    return JSON.stringify(stm);
            }
        }
    }
};

module.exports = Protocol;
```

### Docker Compose Mounts for Infrastructure Access

```yaml
safebox-app-safebox:
  volumes:
    # ZFS volumes
    - app-safebox-platform:/opt/qbix/platform
    - app-safebox-data:/opt/qbix/app
    
    # Infrastructure access
    - /run/safebox/system-api.sock:/run/safebox/system-api.sock  # Unix socket
    - /etc/safebox/system-api.key:/etc/safebox/system-api.key:ro  # HMAC key
    - /etc/safebox/signing.key:/etc/safebox/signing.key:ro        # Safebox private key
```

**Security:**
- ✅ Unix socket restricts access to containers with mount
- ✅ HMAC key mounted read-only
- ✅ Signing key mounted read-only
- ✅ SO_PEERCRED verifies caller UID

---

## 📊 Complete Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          Host System                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Docker Network                         │  │
│  │                                                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │  │
│  │  │   MariaDB    │  │    Redis     │  │    Nginx     │   │  │
│  │  │              │  │              │  │              │   │  │
│  │  │ Port: 3306   │  │ Port: 6379   │  │ Port: 80/443 │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │  │
│  │         │                 │                 │            │  │
│  │  ┌──────┴─────────────────┴─────────────────┴────────┐  │  │
│  │  │          safebox-app-safebox                      │  │  │
│  │  │                                                    │  │  │
│  │  │  /opt/qbix/platform (ZFS clone)                   │  │  │
│  │  │  /opt/qbix/app                                    │  │  │
│  │  │                                                    │  │  │
│  │  │  ┌──────────────────────────────────────┐        │  │  │
│  │  │  │     Protocol.System (Node.js)        │        │  │  │
│  │  │  │                                       │        │  │  │
│  │  │  │  - Verifies M-of-N signatures        │        │  │  │
│  │  │  │  - Signs with Safebox key            │        │  │  │
│  │  │  │  - Calls Infrastructure via socket   │────────┼──┼──┼──┐
│  │  │  │  - Logs to MariaDB                   │        │  │  │  │
│  │  │  └──────────────────────────────────────┘        │  │  │  │
│  │  │                                                    │  │  │  │
│  │  │  ┌──────────────────────────────────────┐        │  │  │  │
│  │  │  │     Qbix Platform (PHP)              │        │  │  │  │
│  │  │  │                                       │        │  │  │  │
│  │  │  │  - Handles web requests               │        │  │  │  │
│  │  │  │  - Connects to MariaDB                │────────┼──┼──┘  │
│  │  │  │  - Connects to Redis                  │────────┼──┘     │
│  │  │  │  - Executes FFmpeg locally            │        │        │
│  │  │  └──────────────────────────────────────┘        │        │
│  │  └────────────────────────────────────────────────────┘       │
│  └───────────────────────────────────────────────────────────────┘
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Infrastructure API (Node.js)                   │  │
│  │                                                           │  │
│  │  /run/safebox/system-api.sock (Unix socket) ←────────────┼──┘
│  │                                                           │
│  │  - Receives claims via Unix socket                       │
│  │  - Verifies HMAC                                         │
│  │  - Executes git/npm/zfs/nginx actions                    │
│  │  - Returns results with HMAC signature                   │
│  └──────────────────────────────────────────────────────────┘
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            ZFS Datasets                                   │  │
│  │                                                           │  │
│  │  zpool/qbix-platform@base (snapshot)                     │  │
│  │    ├─ zpool/app-safebox-platform (clone)                 │  │
│  │    ├─ zpool/app-intercoin-platform (clone)               │  │
│  │    └─ zpool/app-groups-platform (clone)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Summary: How Services Connect

| Service | Location | How Apps Access It |
|---------|----------|-------------------|
| **MariaDB** | `safebox-mariadb:3306` | Docker DNS hostname |
| **Redis** | `safebox-redis:6379` | Docker DNS hostname |
| **FFmpeg** | Inside app container | Local `exec('ffmpeg ...')` |
| **ImageMagick** | Inside app container | Local `exec('convert ...')` |
| **Infrastructure API** | Unix socket | Mounted `/run/safebox/system-api.sock` |
| **Other Apps** | Docker network | Not allowed (isolated) |

**Key Architecture Points:**
1. ✅ Services use Docker DNS (container names as hostnames)
2. ✅ Only nginx exposes ports to host (80/443)
3. ✅ Apps isolated from each other
4. ✅ Infrastructure API accessed via Unix socket
5. ✅ FFmpeg/ImageMagick installed in each app container
6. ✅ ZFS clones provide instant Platform snapshots
7. ✅ Protocol.System (Node.js) manages all governance

🎉 **Complete production architecture with service isolation!**

---

## 🤖 How Apps Call Model Runners (AI/ML Services)

### Architecture: Model Runners as Separate Containers

**Key insight:** AI/ML models run in dedicated containers, apps call them via HTTP API.

```
                    Docker Network: safebox-net
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
safebox-model-llm     safebox-model-vision    safebox-model-audio
    │                       │                       │
    ├─ LLaMA/Mistral       ├─ Stable Diffusion    ├─ Whisper
    ├─ Port: 8080          ├─ Port: 8081          ├─ Port: 8082
    ├─ GPU: 0              ├─ GPU: 1              ├─ GPU: 2
    └─ Hostname:           └─ Hostname:           └─ Hostname:
       safebox-model-llm      safebox-model-vision   safebox-model-audio
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
safebox-app-safebox  safebox-app-intercoin  safebox-app-groups
    │                       │                       │
    └─ Calls via HTTP:     └─ Calls via HTTP:     └─ Calls via HTTP:
       POST http://safebox-model-llm:8080/v1/chat
       POST http://safebox-model-vision:8081/v1/generate
       POST http://safebox-model-audio:8082/v1/transcribe
```

---

## 🎯 Model Runner Containers

### 1. LLM Runner (Text Generation)

**Container:** `safebox-model-llm`

**Image:** Uses vLLM, TGI, or Ollama

```dockerfile
# Dockerfile for LLM runner
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

# Install vLLM
RUN pip install vllm

# Download model (or mount from host)
RUN huggingface-cli download meta-llama/Llama-3.1-8B-Instruct

# Start vLLM server
CMD ["vllm", "serve", "meta-llama/Llama-3.1-8B-Instruct", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--gpu-memory-utilization", "0.9"]
```

**Docker Compose:**

```yaml
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
            device_ids: ['0']  # GPU 0
            capabilities: [gpu]
  environment:
    MODEL_NAME: "meta-llama/Llama-3.1-8B-Instruct"
    MAX_MODEL_LEN: 8192
  volumes:
    - model-cache:/root/.cache/huggingface
  restart: unless-stopped
```

### 2. Vision Runner (Image Generation)

**Container:** `safebox-model-vision`

**Image:** ComfyUI or Automatic1111

```dockerfile
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

# Install ComfyUI
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /opt/comfyui
WORKDIR /opt/comfyui
RUN pip install -r requirements.txt

# Download Stable Diffusion models
RUN wget -O models/checkpoints/sd_xl_base_1.0.safetensors \
    https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors

# Start ComfyUI server
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8081"]
```

### 3. Audio Runner (Speech/Transcription)

**Container:** `safebox-model-audio`

**Image:** Whisper or faster-whisper

```dockerfile
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

# Install faster-whisper
RUN pip install faster-whisper flask

# API server
COPY whisper-server.py /opt/
WORKDIR /opt

# Start whisper API server
CMD ["python", "whisper-server.py"]
```

**whisper-server.py:**

```python
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

app = Flask(__name__)
model = WhisperModel("large-v3", device="cuda", compute_type="float16")

@app.route('/v1/transcribe', methods=['POST'])
def transcribe():
    audio_file = request.files['audio']
    segments, info = model.transcribe(audio_file, beam_size=5)
    
    result = {
        "text": " ".join([segment.text for segment in segments]),
        "language": info.language,
        "duration": info.duration
    }
    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8082)
```

---

## 📞 How Apps Call Model Runners

### Pattern 1: LLM Chat Completion

**From Qbix app (PHP):**

```php
<?php
// In /opt/qbix/app/handlers/Safebox/ai/chat/post.php

function Safebox_ai_chat_post() {
    $messages = Q_Request::slotNames('messages');
    
    // Call LLM runner via Docker DNS
    $ch = curl_init('http://safebox-model-llm:8080/v1/chat/completions');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'model' => 'meta-llama/Llama-3.1-8B-Instruct',
        'messages' => $messages,
        'max_tokens' => 2048,
        'temperature' => 0.7
    ]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    
    $response = curl_exec($ch);
    $result = json_decode($response, true);
    
    Q_Response::setSlot('response', $result['choices'][0]['message']['content']);
}
```

**From Protocol.System (Node.js):**

```javascript
// In /opt/qbix/platform/platform/plugins/Q/handlers/Q/ai.js

const Q = {
    AI: {
        async chat(messages) {
            const response = await fetch('http://safebox-model-llm:8080/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'meta-llama/Llama-3.1-8B-Instruct',
                    messages,
                    max_tokens: 2048,
                    temperature: 0.7
                })
            });
            
            const result = await response.json();
            return result.choices[0].message.content;
        }
    }
};
```

### Pattern 2: Image Generation

**From app:**

```php
<?php
// Generate image via ComfyUI API

$ch = curl_init('http://safebox-model-vision:8081/api/prompt');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    'prompt' => [
        '1' => [
            'class_type' => 'CheckpointLoaderSimple',
            'inputs' => ['ckpt_name' => 'sd_xl_base_1.0.safetensors']
        ],
        '2' => [
            'class_type' => 'CLIPTextEncode',
            'inputs' => ['text' => 'A beautiful sunset over mountains']
        ],
        '3' => [
            'class_type' => 'KSampler',
            'inputs' => [
                'seed' => rand(),
                'steps' => 20,
                'cfg' => 7.0
            ]
        ]
    ]
]));

$response = curl_exec($ch);
$result = json_decode($response, true);

// Poll for completion
$promptId = $result['prompt_id'];
// ... polling logic
```

### Pattern 3: Audio Transcription

**From app:**

```php
<?php
// Transcribe audio via Whisper

$audioFile = $_FILES['audio'];

$ch = curl_init('http://safebox-model-audio:8082/v1/transcribe');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, [
    'audio' => new CURLFile($audioFile['tmp_name'], $audioFile['type'], $audioFile['name'])
]);

$response = curl_exec($ch);
$result = json_decode($response, true);

Q_Response::setSlot('transcript', $result['text']);
Q_Response::setSlot('language', $result['language']);
```

---

## 🔧 Model Runner Management via Governance

### New Actions for Model Runners

**Add to managed-containers.json:**

```json
{
  "safebox-model-llm": {
    "imagePattern": "^safebox/vllm:.*$",
    "allowedActions": ["start", "stop", "status", "restart", "model-load", "model-update"],
    "exponentialBackoff": true,
    "defaultCommands": {
      "model-load-llama": {
        "action": "model-load",
        "model": "meta-llama/Llama-3.1-8B-Instruct",
        "format": "huggingface",
        "gpuMemory": 0.9,
        "description": "Load LLaMA 3.1 8B Instruct model"
      },
      "model-load-mistral": {
        "action": "model-load",
        "model": "mistralai/Mistral-7B-Instruct-v0.3",
        "format": "huggingface",
        "gpuMemory": 0.9,
        "description": "Load Mistral 7B Instruct model"
      }
    }
  },
  
  "safebox-model-vision": {
    "imagePattern": "^safebox/comfyui:.*$",
    "allowedActions": ["start", "stop", "status", "restart", "model-load"],
    "exponentialBackoff": true,
    "defaultCommands": {
      "model-load-sdxl": {
        "action": "model-load",
        "model": "stabilityai/stable-diffusion-xl-base-1.0",
        "format": "safetensors",
        "destination": "/opt/comfyui/models/checkpoints/",
        "description": "Load Stable Diffusion XL"
      }
    }
  }
}
```

### model-load Action Implementation

**In system-protocol-api.js:**

```javascript
case 'model-load':
    return await executeModelLoad(dockerContainer, stm);

async function executeModelLoad(container, stm) {
    const { model, format, gpuMemory, destination } = stm;
    
    if (!model || !format) {
        throw new Error('model-load requires: model, format');
    }
    
    let cmd;
    
    if (format === 'huggingface') {
        // Download from HuggingFace
        cmd = [
            'sh', '-c',
            `huggingface-cli download ${model} && ` +
            `echo "Model downloaded: ${model}"`
        ];
    } else if (format === 'safetensors') {
        // Download safetensors file
        cmd = [
            'sh', '-c',
            `wget -O ${destination}/${model.split('/')[1]}.safetensors ` +
            `https://huggingface.co/${model}/resolve/main/sd_xl_base_1.0.safetensors`
        ];
    }
    
    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });
    
    const stream = await exec.start();
    
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', async () => {
            const inspectResult = await exec.inspect();
            if (inspectResult.ExitCode !== 0) {
                reject(new Error(`model load failed: ${output.slice(0, 500)}`));
            } else {
                resolve({
                    model,
                    format,
                    verified: true,
                    output: output.slice(0, 1000)
                });
            }
        });
        stream.on('error', reject);
    });
}
```

### Governed Model Updates

**Via Protocol.System:**

```javascript
// Load new LLM model
await Protocol.System.execute({
    ocp: 1,
    stm: {
        action: 'model-load',
        container: 'safebox-model-llm',
        model: 'meta-llama/Llama-3.1-70B-Instruct',
        format: 'huggingface',
        gpuMemory: 0.9
    },
    jti: crypto.randomBytes(16).toString('hex'),
    key: ['admin1', 'admin2', 'admin3'],
    sig: [/* M-of-N signatures */]
});

// Restart model runner to load new model
await Protocol.System.execute({
    stm: {
        action: 'restart',
        container: 'safebox-model-llm'
    },
    // ... M-of-N
});
```

---

## 🎮 GPU Management

### GPU Allocation via Docker Compose

```yaml
services:
  safebox-model-llm:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['0']  # GPU 0 for LLM
              capabilities: [gpu]
  
  safebox-model-vision:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['1']  # GPU 1 for vision
              capabilities: [gpu]
  
  safebox-model-audio:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['2']  # GPU 2 for audio
              capabilities: [gpu]
```

### Monitoring GPU Usage

**From app (via nvidia-smi in model container):**

```php
<?php
// Check GPU usage on LLM runner

$ch = curl_init('http://safebox-model-llm:8080/v1/health');
$response = curl_exec($ch);
$health = json_decode($response, true);

// Response includes:
// {
//   "status": "ok",
//   "model": "meta-llama/Llama-3.1-8B-Instruct",
//   "gpu_memory_used": 7.2,
//   "gpu_memory_total": 24.0,
//   "gpu_utilization": 45
// }
```

---

## 🔐 Model Runner Security

### Network Isolation

**Model runners are NOT exposed to host:**

```yaml
safebox-model-llm:
  networks:
    - safebox-net
  # No ports exposed to host
  # Only accessible from other containers on safebox-net
```

**Only apps in safebox-net can call model runners:**

```
✅ safebox-app-safebox → safebox-model-llm (allowed)
✅ safebox-app-intercoin → safebox-model-vision (allowed)
❌ Internet → safebox-model-llm (blocked, no exposed ports)
❌ Other Docker networks → safebox-model-llm (blocked)
```

### Rate Limiting and Quotas

**Optional: Add nginx reverse proxy in front of models:**

```nginx
# /etc/nginx/sites-enabled/model-proxy

upstream llm_backend {
    server safebox-model-llm:8080;
}

server {
    listen 8090;  # Internal only
    
    location /v1/ {
        # Rate limiting
        limit_req zone=model_limit burst=10 nodelay;
        
        # Quota tracking (via auth_request)
        auth_request /auth/quota;
        
        proxy_pass http://llm_backend;
    }
}
```

---

## 📊 Complete Architecture with Model Runners

```
┌─────────────────────────────────────────────────────────────────┐
│                          Host System                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Docker Network                         │  │
│  │                                                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │  │
│  │  │   MariaDB    │  │    Redis     │  │    Nginx     │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │  │
│  │         │                 │                 │            │  │
│  │  ┌──────┴─────────────────┴─────────────────┴────────┐  │  │
│  │  │          safebox-app-safebox                      │  │  │
│  │  │                                                    │  │  │
│  │  │  Protocol.System calls:                           │  │  │
│  │  │  - http://safebox-model-llm:8080 (chat)          │  │  │
│  │  │  - http://safebox-model-vision:8081 (image)      │  │  │
│  │  │  - http://safebox-model-audio:8082 (audio)       │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │         │                 │                 │            │  │
│  │  ┌──────┴──────┐  ┌───────┴──────┐  ┌──────┴─────┐     │  │
│  │  │ Model-LLM   │  │ Model-Vision │  │Model-Audio │     │  │
│  │  │             │  │              │  │            │     │  │
│  │  │ LLaMA/      │  │ Stable       │  │ Whisper    │     │  │
│  │  │ Mistral     │  │ Diffusion    │  │ Large-v3   │     │  │
│  │  │ GPU 0       │  │ GPU 1        │  │ GPU 2      │     │  │
│  │  │ Port: 8080  │  │ Port: 8081   │  │ Port: 8082 │     │  │
│  │  └─────────────┘  └──────────────┘  └────────────┘     │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Infrastructure API (Node.js)                   │  │
│  │  - Manages model containers (start/stop/model-load)      │  │
│  │  - Governed by M-of-N via Protocol.System                │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Summary: Model Runner Access

| Model Type | Container | Port | GPU | How Apps Call |
|------------|-----------|------|-----|---------------|
| **LLM (Text)** | `safebox-model-llm` | 8080 | 0 | `http://safebox-model-llm:8080/v1/chat` |
| **Vision (Image)** | `safebox-model-vision` | 8081 | 1 | `http://safebox-model-vision:8081/api/prompt` |
| **Audio (Speech)** | `safebox-model-audio` | 8082 | 2 | `http://safebox-model-audio:8082/v1/transcribe` |

**Key Points:**
1. ✅ Model runners are separate containers with dedicated GPUs
2. ✅ Apps call via Docker DNS (container name → IP)
3. ✅ No ports exposed to host (network isolated)
4. ✅ Model loading governed by M-of-N via `model-load` action
5. ✅ GPU allocation managed via Docker Compose
6. ✅ Each model runner has its own HTTP API
7. ✅ Apps use standard HTTP/curl to call models

🎉 **Complete AI/ML model runner integration with governance!**
