# Safebox Infrastructure - Docker + ZFS

**Qbix-independent infrastructure** for Safebox platform. All services run in Docker containers governed by `Safebox.Protocol.System`.

## Quick Start

```bash
# 1. Install infrastructure
sudo bash scripts/install.sh

# 2. Verify
curl http://localhost:4000/health
docker ps

# 3. Install Safebox.Protocol.System (see SAFEBOX-INSTRUCTIONS.md)
```

---

## Architecture

### Container Network

```
Public (80/443) → nginx (172.20.0.10)
                    ↓
Internal Bridge: safebox-net (172.20.0.0/16)
├── mariadb (172.20.0.20:3306)
├── php-fpm (172.20.0.30:9000)
├── node-exec (172.20.0.40:3000)
├── llama-server-deepseek (172.20.0.50:8001)
├── ffmpeg (172.20.0.60:8080)
├── typesense (172.20.0.70:8108)
├── chromium (172.20.0.80:9222)
└── system-protocol-api (172.20.0.90) → localhost:4000
```

**Security:**
- ✅ Public: Only nginx (80/443)
- ✅ Internal: All services on private bridge
- ✅ Admin: system-protocol-api localhost only
- ✅ No SSH - all management via Protocol.System

### ZFS Layout

```
/safebox/
├── nginx/ (configs, TLS certs, static files)
├── mariadb/ (data, per-DB datasets, backups)
├── php/ (sessions)
├── node/ (cache)
├── models/ (LLM model files)
├── ffmpeg/ (temp, output)
├── typesense/ (search indexes)
├── chromium/ (downloads)
└── system-api/ (rate limit state)
```

---

## Governance System

### M-of-N Signatures Per Container

From `/etc/safebox/container-registry.json`:

| Container | Scope | M | N | Backoff |
|-----------|-------|---|---|---------|
| mariadb | database.mariadb | 4 | 5 | ✅ Yes |
| llama-deepseek | models.deepseek | 2 | 3 | ✅ Yes |
| nginx | web.nginx | 3 | 5 | ❌ No |
| system-api | system.admin | 5 | 7 | ✅ Yes |

### Exponential Backoff (Churn Wars)

**Prevents rapid container manipulation:**

```
Op 1: Restart → 1h cooldown
Op 2: (+1h) → 2h cooldown (2^1)
Op 3: (+3h) → 4h cooldown (2^2)
Op 4: (+7h) → 8h cooldown (2^3)
```

**Churn multiplier:**
- 5+ ops/7d → 2× multiplier
- 10+ ops/7d → 3× multiplier
- 15+ ops/7d → 4× multiplier

---

## Usage (via Safebox.Protocol.System)

**NOTE:** Implementation in Safebox plugin (see SAFEBOX-INSTRUCTIONS.md)

### Start Container

```php
<?php
$claim = [
    'ocp' => 1,
    'stm' => [
        'action' => 'start',
        'container' => 'safebox-llama-deepseek',
        'scope' => 'models.deepseek',
        'issuedAt' => time()
    ],
    'key' => ['admin1', 'admin2'],  // M=2
    'sig' => ['...', '...']
];

$result = Safebox::Protocol($claim);
// → Verifies M-of-N in PHP
// → Calls localhost:4000
// → Node.js checks exponential backoff
// → Executes docker start
```

### Query Status

```php
$claim = [
    'ocp' => 1,
    'stm' => [
        'action' => 'status',
        'container' => 'safebox-mariadb'
    ],
    'key' => ['admin1'],
    'sig' => ['...']
];

$result = Safebox::Protocol($claim);
// → Returns: { state: "running", status: "Up 5h" }
```

---

## Files

```
Infrastructure-Final/
├── README.md                        # This file
├── SAFEBOX-INSTRUCTIONS.md          # How to implement Protocol.System
├── docker/
│   ├── docker-compose.yml           # All 9 services
│   └── system-protocol-api.js       # Node.js governance middleware
├── config/
│   └── container-registry.json      # Container governance config
├── scripts/
│   └── install.sh                   # One-command install
└── docs/
    ├── ARCHITECTURE.md              # Detailed architecture
    └── GOVERNANCE.md                # M-of-N + backoff guide
```

---

## Container Details

### Core Services (M=3-4 of N=5)
- **nginx** - Web server, HTTPS termination
- **mariadb** - Database (M=4, highly critical)
- **php-fpm** - PHP runtime for Qbix
- **node-exec** - Safebox capability executor

### Model Services (M=2 of N=3, exponential backoff)
- **llama-server-deepseek** - DeepSeek-R1 inference

### Utility Services (M=2 of N=3)
- **ffmpeg** - Media processing
- **typesense** - Search engine
- **chromium** - Headless browser

### Admin Service (M=5 of N=7, highest security)
- **system-protocol-api** - Container management API

---

## Security

✅ **No SSH** - All management via Safebox.Protocol.System  
✅ **Network isolation** - Only nginx exposed publicly  
✅ **M-of-N governance** - Per-container signatures  
✅ **Rate limiting** - Exponential backoff  
✅ **Audit logging** - All operations logged  
✅ **Read-only code** - Qbix mounted read-only  
✅ **Resource limits** - CPU/RAM caps  

---

## Installation

### Prerequisites

- Ubuntu 24.04
- ZFS installed (`zfsutils-linux`)
- Root access

### Install

```bash
# Clone this repo
cd Infrastructure-Final

# Run installer
sudo bash scripts/install.sh

# Verify
curl http://localhost:4000/health
docker ps
```

### Manual Setup

```bash
# 1. Create ZFS pool
sudo zpool create tank /dev/nvme1n1
sudo zfs create tank/safebox

# 2. Run install script
sudo bash scripts/install.sh

# 3. Install Safebox plugin
# (See SAFEBOX-INSTRUCTIONS.md)
```

---

## Next Steps

1. ✅ Install Infrastructure (this package)
2. ⏭ Install Safebox.Protocol.System (see SAFEBOX-INSTRUCTIONS.md)
3. ⏭ Configure admin keys in container-registry.json
4. ⏭ Test container governance
5. ⏭ Add model files to /safebox/models/

---

## Support

- Docker: `docker/README.md`
- ZFS: `docs/ZFS.md`
- Governance: `docs/GOVERNANCE.md`
- Safebox integration: `SAFEBOX-INSTRUCTIONS.md`

🚀 **Infrastructure ready!**
