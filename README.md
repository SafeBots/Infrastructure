# Safebox Infrastructure - Production Implementation

**Official implementation of system-protocol-api per Safebox Infrastructure Specification v1.0**

This package provides the infrastructure-side Docker execution layer that pairs with Safebox's `Protocol.System`. All M-of-N governance happens in Safebox; this layer provides secure execution with defense-in-depth.

## Quick Start

```bash
sudo bash scripts/install.sh
systemctl status safebox-system-api
curl --unix-socket /run/safebox/system-api.sock http://localhost/health
```

## Architecture

```
Safebox (UID: safebox or www-data)
    ↓ Unix socket: /run/safebox/system-api.sock
    ↓ Peer UID verification (SO_PEERCRED)
    ↓ HMAC request/response signing
system-protocol-api (UID: safebox-api)
    ↓ Container allowlist check
    ↓ Exponential backoff enforcement
    ↓ JTI replay protection
    ↓ Docker API via /var/run/docker.sock
Docker daemon
```

## Security Layers

1. **Safebox (governance):** M-of-N OpenClaim verification, verifiedOpToken
2. **Peer UID:** Only Safebox UID can connect (via SO_PEERCRED)
3. **HMAC:** Request/response integrity (prevents forgery/replay)
4. **Allowlist:** Only containers in managed-containers.json
5. **Per-action:** exec/pull only when explicitly permitted
6. **Backoff:** Exponential cooldown prevents churn wars
7. **JTI:** Infrastructure-side replay protection

## What This Implements

✅ **Unix domain socket** - `/run/safebox/system-api.sock` with SO_PEERCRED  
✅ **Peer UID verification** - Only configured Safebox UID accepted  
✅ **HMAC mutual auth** - Request/response signing with `/etc/safebox/system-api.key`  
✅ **Container allowlist** - Operator-controlled `/etc/safebox/managed-containers.json`  
✅ **Per-action allowlisting** - exec/pull only when explicitly enabled  
✅ **Exponential backoff** - Persistent state in `/var/lib/safebox-system-api/backoff.json`  
✅ **JTI tracking** - Persistent state in `/var/lib/safebox-system-api/seen-jti.json`  
✅ **Structured logging** - JSON-per-line to `/var/log/safebox-system-api.log`  
✅ **SIGHUP reload** - Update managed-containers.json without restart  
✅ **systemd hardening** - PrivateTmp, ProtectSystem, NoNewPrivileges  

## Supported Actions

| Action | What it does | Backoff |
|--------|--------------|---------|
| start | Start stopped container | Yes |
| stop | Stop running container | Yes |
| restart | Stop then start | Yes |
| status | Inspect state (read-only) | No |
| pull | Pull new image, restart container | Yes |
| exec | Run command in container | Yes |

## Files

```
Infrastructure-Production/
├── README.md                           # This file
├── INFRASTRUCTURE-SPEC.md              # Official specification
├── docker/
│   └── system-protocol-api.js          # Main implementation (600 lines)
├── config/
│   └── managed-containers.json         # Container allowlist template
├── scripts/
│   └── install.sh                      # Bootstrap script
└── docs/
    ├── SAFEBOX-INSTRUCTIONS.md         # Safebox-side implementation guide
    └── OPERATIONAL-RUNBOOK.md          # Operations guide
```

## Installation

### Prerequisites

- Ubuntu 24.04 or similar
- Docker installed and running
- Node.js 20+ installed
- Root access

### Install

```bash
# Optional: set Safebox UID (default: 33 for www-data)
export SAFEBOX_UID=1001

# Run installer
sudo bash scripts/install.sh

# Verify
systemctl status safebox-system-api
curl --unix-socket /run/safebox/system-api.sock http://localhost/health
```

## Configuration

### managed-containers.json

Operator-controlled allowlist:

```json
{
  "safebox-mariadb": {
    "imagePattern": "^mariadb:11\\.[0-9]+$",
    "allowedActions": ["start", "stop", "status", "restart"],
    "exponentialBackoff": true,
    "backoff": {
      "baseInterval": 7200,
      "churnThresholds": { "5": 2, "10": 3, "15": 4 }
    }
  }
}
```

**Fields:**
- `imagePattern` - Regex for pull action validation
- `allowedActions` - Which operations are permitted
- `exponentialBackoff` - Enable cooldown enforcement
- `backoff.baseInterval` - Base cooldown in seconds (default: 3600)
- `backoff.churnThresholds` - Churn multipliers (default: 5→2×, 10→3×, 15→4×)

### Reload without restart

```bash
# Edit config
sudo vim /etc/safebox/managed-containers.json

# Send SIGHUP
sudo kill -HUP $(pgrep -f system-protocol-api)

# Or via systemctl
sudo systemctl reload safebox-system-api
```

## Exponential Backoff Example

```
Op 1: restart → 1h cooldown (3600 × 2^0)
Op 2: (+1h) → 2h cooldown (3600 × 2^1)
Op 3: (+3h) → 4h cooldown (3600 × 2^2)
Op 4: (+7h) → 8h cooldown (3600 × 2^3)
Op 5: (+15h) → 32h cooldown (16h × 2× churn)
Op 10: → 512h cooldown (21 days)
```

**Churn detection:** 5+ ops in 7 days → 2×, 10+ → 3×, 15+ → 4×

## Monitoring

### Service status

```bash
systemctl status safebox-system-api
journalctl -u safebox-system-api -f
```

### Logs

```bash
# Structured JSON logs
tail -f /var/log/safebox-system-api.log | jq .

# Successful operations
jq 'select(.event=="operation_success")' /var/log/safebox-system-api.log

# Backoff events
jq 'select(.event=="backoff_recorded")' /var/log/safebox-system-api.log

# Errors
jq 'select(.event=="operation_error")' /var/log/safebox-system-api.log
```

### State files

```bash
# Backoff state
cat /var/lib/safebox-system-api/backoff.json | jq .

# JTI tracking
cat /var/lib/safebox-system-api/seen-jti.json | jq . | head -20
```

## Troubleshooting

### Service won't start

```bash
# Check logs
journalctl -u safebox-system-api -n 50

# Common issues:
# - HMAC key missing: openssl rand -hex 64 > /etc/safebox/system-api.key
# - managed-containers.json missing
# - safebox-uid file missing
```

### "Peer UID verification failed"

```bash
# Check configured UID
cat /etc/safebox/safebox-uid

# Check actual Safebox process UID
ps aux | grep qbix
```

### "Invalid HMAC signature"

```bash
# HMAC keys must match between Safebox and API
# Both read from /etc/safebox/system-api.key

# Check permissions
ls -l /etc/safebox/system-api.key
# Should be: -rw-r----- root safebox-hmac
```

## Security Notes

✅ **No docker-socket-proxy needed** - `managed-containers.json` provides equivalent protection at application layer  
✅ **Unix socket preferred over TCP** - SO_PEERCRED cleaner than /proc parsing  
✅ **Docker group = root-equivalent** - Acknowledged design constraint  
✅ **Five defense layers** - Governance, UID, HMAC, allowlist, backoff  

See INFRASTRUCTURE-SPEC.md for complete security model.

## Production Checklist

- [ ] Safebox UID configured in `/etc/safebox/safebox-uid`
- [ ] HMAC key generated and readable by both users
- [ ] managed-containers.json populated with actual containers
- [ ] systemd service enabled and running
- [ ] Logs rotating (logrotate config)
- [ ] Monitoring alerts on service failure
- [ ] Backup of /var/lib/safebox-system-api/ state files

🚀 **Production ready!**

### system-registry.json (Governance Integration)

**Optional:** Safebox can control infrastructure dependencies via M-of-N governance.

**Location:** `/etc/safebox/system-registry.json`

```json
{
  "dependencies": {
    "dockerode": {
      "version": "4.0.2",
      "integrity": "sha512-...",
      "approvedBy": ["admin1", "admin2"],
      "approvedAt": 1745880000
    }
  }
}
```

**What Infrastructure Does:**
- ✅ On startup: Verifies installed version matches registry
- ✅ If integrity hash specified: **Exits if mismatch** (supply chain attack protection)
- ✅ On SIGHUP: Re-checks dependencies, logs updates needed

**See:** `docs/GOVERNANCE-INTEGRATION.md` for complete Safebox implementation guide.

