# Safebox Infrastructure Architecture

## Container Network Topology

```
┌─────────────────────────────────────────────────────────────┐
│                     AWS Instance (Public IP)                │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Docker Bridge: safebox-net (172.20.0.0/16)       │    │
│  │                                                     │    │
│  │  ╔═══════════════════════════════════════════╗    │    │
│  │  ║  nginx (172.20.0.10)                      ║    │    │
│  │  ║  • :80  → Public HTTP                     ║────┼────┤ :80
│  │  ║  • :443 → Public HTTPS                    ║────┼────┤ :443
│  │  ╚═══════════════════════════════════════════╝    │    │
│  │         ↓ FastCGI                                  │    │
│  │  ┌─────────────────────────────────────────┐      │    │
│  │  │  php-fpm (172.20.0.30:9000)             │      │    │
│  │  │  • Qbix platform execution              │      │    │
│  │  │  • Read-only codebase                   │      │    │
│  │  └─────────────────────────────────────────┘      │    │
│  │         ↓ MySQL                                    │    │
│  │  ┌─────────────────────────────────────────┐      │    │
│  │  │  mariadb (172.20.0.20:3306)             │      │    │
│  │  │  • ZFS-backed datasets                  │      │    │
│  │  │  • Per-database isolation               │      │    │
│  │  └─────────────────────────────────────────┘      │    │
│  │                                                     │    │
│  │  ┌─────────────────────────────────────────┐      │    │
│  │  │  node-exec (172.20.0.40:3000)           │      │    │
│  │  │  • Safebox capability executor          │      │    │
│  │  │  • Sandbox environment                  │      │    │
│  │  └─────────────────────────────────────────┘      │    │
│  │         ↓ HTTP                                     │    │
│  │  ┌─────────────────────────────────────────┐      │    │
│  │  │  llama-server (172.20.0.50:8001)        │      │    │
│  │  │  • DeepSeek-R1 inference                │      │    │
│  │  │  • Model files on ZFS                   │      │    │
│  │  └─────────────────────────────────────────┘      │    │
│  │                                                     │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │    │
│  │  │  ffmpeg  │  │typesense │  │ chromium │        │    │
│  │  │:8080     │  │:8108     │  │:9222     │        │    │
│  │  └──────────┘  └──────────┘  └──────────┘        │    │
│  │                                                     │    │
│  │  ╔═══════════════════════════════════════════╗    │    │
│  │  ║  system-protocol-api (172.20.0.90:4000)   ║    │    │
│  │  ║  • Docker socket access                   ║────┼────┤ 127.0.0.1:4000
│  │  ║  • M-of-N governance                      ║    │    │ (localhost only)
│  │  ║  • Exponential backoff                    ║    │    │
│  │  ╚═══════════════════════════════════════════╝    │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

Legend:
  ╔═══╗ = Public-accessible or admin-only
  ┌───┐ = Internal-only
```

## ZFS Dataset Hierarchy

```
tank/safebox/                       # Root dataset
├── nginx/                          # Web server
│   ├── conf.d/                     # Nginx configs
│   ├── ssl/
│   │   ├── cloudflare/             # Cloudflare-signed certs
│   │   └── letsencrypt/            # Let's Encrypt certs
│   ├── www/                        # Static files
│   └── logs/                       # Access/error logs
│
├── mariadb/                        # Database
│   ├── data/                       # MySQL data directory
│   │   ├── qbix/                   # Per-database dataset
│   │   ├── streams/
│   │   └── safebox/
│   ├── conf/                       # Custom configs
│   └── backup/                     # ZFS snapshots
│
├── php/                            # PHP runtime
│   └── sessions/                   # Session storage
│
├── node/                           # Node.js executor
│   └── cache/                      # Execution cache
│
├── models/                         # LLM models
│   ├── deepseek-r1/
│   │   └── DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf
│   ├── qwen-32b/
│   └── gemma-4/
│
├── ffmpeg/                         # Media processing
│   ├── temp/                       # Temp files
│   └── output/                     # Processed media
│
├── typesense/                      # Search engine
│   └── data/                       # Search indexes
│
├── chromium/                       # Headless browser
│   └── downloads/                  # Downloaded files
│
└── system-api/                     # Admin API
    └── state/
        └── backoff/                # Exponential backoff state
            ├── safebox-nginx.json
            ├── safebox-mariadb.json
            └── safebox-llama-deepseek.json
```

## Service Dependencies

```
nginx
  ↓ depends_on
php-fpm
  ↓ depends_on
mariadb

node-exec
  ↓ depends_on
mariadb

All services connect to: safebox-net bridge
```

## Port Allocation

| Service | Internal IP | Internal Port | Host Port | Public |
|---------|-------------|---------------|-----------|--------|
| nginx | 172.20.0.10 | 80, 443 | 80, 443 | ✅ Yes |
| mariadb | 172.20.0.20 | 3306 | - | ❌ No |
| php-fpm | 172.20.0.30 | 9000 | - | ❌ No |
| node-exec | 172.20.0.40 | 3000 | - | ❌ No |
| llama-server | 172.20.0.50 | 8001 | - | ❌ No |
| ffmpeg | 172.20.0.60 | 8080 | - | ❌ No |
| typesense | 172.20.0.70 | 8108 | - | ❌ No |
| chromium | 172.20.0.80 | 9222 | - | ❌ No |
| system-api | 172.20.0.90 | 4000 | 127.0.0.1:4000 | ❌ Localhost only |

## Resource Limits

| Container | CPU Cores | RAM | Purpose |
|-----------|-----------|-----|---------|
| nginx | 2 | 2GB | Web serving |
| mariadb | 4 | 16GB | Database |
| php-fpm | 4 | 8GB | PHP execution |
| node-exec | 4 | 8GB | Capability sandbox |
| llama-server | 8 | 32GB | LLM inference |
| ffmpeg | 8 | 16GB | Media processing |
| typesense | 2 | 4GB | Search |
| chromium | 2 | 4GB | Browser |
| system-api | 2 | 2GB | Admin API |

Total: 36 CPU cores, 92GB RAM (fits r6i.16xlarge)

## Security Architecture

### Network Isolation

```
Internet
   ↓
   ✅ Only nginx (80/443)
   ↓
Internal Bridge (safebox-net)
   ├── All services communicate internally
   ├── No direct external access
   └── system-protocol-api: localhost only
```

### Filesystem Isolation

```
/var/www/qbix          → Read-only in all containers
/safebox/*             → Read-write per service
/var/run/docker.sock   → Only system-protocol-api
```

### Privilege Model

| Layer | Privilege Level | Access |
|-------|----------------|--------|
| User capabilities | Read-only | Stream materialization |
| Admin actions | Write (governed) | Action proposals |
| System Protocol | Docker management | M-of-N signatures required |

