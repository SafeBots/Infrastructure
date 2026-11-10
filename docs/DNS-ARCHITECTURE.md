# Safenet DNS Architecture

## Overview

Safenet DNS maps human-readable domain names to safebox IP addresses using
a fully decentralized, tamper-evident system. The zone is a **pure function**
of public registry state — every nameserver computes the same zone from the
same inputs, with no coordination between them.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Safenet Registry                            │
│  ┌──────────────────┐  ┌───────────────────────────────────┐   │
│  │  box_announce     │  │  name_claim                       │   │
│  │  (safebox → IP)   │  │  (name → safebox, failover)       │   │
│  └────────┬─────────┘  └──────────────┬────────────────────┘   │
│           └─────────────┬─────────────┘                         │
└─────────────────────────┼───────────────────────────────────────┘
                          │
              ┌───────────▼───────────┐
              │    Zone Compiler      │
              │  (pure function)      │
              │  registry → zone file │
              └───────────┬───────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Knot DNS │    │ Knot DNS │    │ Knot DNS │
    │ (NS 1)   │    │ (NS 2)   │    │ (NS N)   │
    │ TPM keys │    │ TPM keys │    │ TPM keys │
    └──────────┘    └──────────┘    └──────────┘
```

## Two-Claim Model

DNS state is composed of two OCP claim types stored in the Safenet registry:

### Box Claim (`safebox_announce`)

Emitted by every safebox on boot and periodically during operation:

```json
{
  "ocp": 1,
  "iss": "safenet:box:<safebox-id>",
  "sub": "safenet:box:<safebox-id>",
  "stm": {
    "type": "safebox_announce",
    "safeboxId": "<safebox-id>",
    "publicIp": "203.0.113.42",
    "attestation": { /* TPM attestation bundle */ },
    "acmeAccountUri": "https://acme-v02.api.letsencrypt.org/acct/123456"
  },
  "nbf": 1700000000,
  "exp": 1700003600,
  "key": ["<ed25519-pubkey-hex>"],
  "sig": ["<signature-hex>"]
}
```

### Name Claim (`name_claim`)

Issued by the hub owner (or future governance keys) to map a domain to a safebox:

```json
{
  "ocp": 1,
  "iss": "safenet:owner:<owner-pubkey>",
  "sub": "safenet:name:mybrand.safenet.org",
  "stm": {
    "type": "name_claim",
    "name": "mybrand.safenet.org",
    "safeboxId": "<primary-safebox-id>",
    "failoverSafeboxId": "<failover-safebox-id>",
    "governancePolicy": null
  },
  "nbf": 1700000000,
  "exp": 1731536000,
  "key": ["<owner-ed25519-pubkey-hex>"],
  "sig": ["<signature-hex>"]
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `name` | Domain name (e.g. `mybrand.safenet.org`) |
| `safeboxId` | Primary safebox serving this name |
| `failoverSafeboxId` | Failover safebox (automatic if primary stops attesting) |
| `governancePolicy` | Reserved for M-of-N governance (initially `null`) |

## Zone Compilation

The zone compiler (`lib/ZoneCompiler.js` in Safenet, invoked by
`common/nameserver/compile-zone.js` in Infrastructure) is a **pure function**:

```
f(registry_state) → zone_file
```

Given the same registry state, every nameserver produces an identical zone file.

### Deterministic SOA Serial

The SOA serial is derived from the registry's Merkle root hash:

```javascript
serial = parseInt(rootHash.slice(0, 8), 16)  // first 8 hex chars → 32-bit uint
```

This ensures all nameservers agree on the serial without coordination.

### Automatic Failover

When the zone compiler runs, it checks each name claim's primary safebox:

1. **Primary fresh** (attested within `attestationMaxAge`): emit A record pointing to primary IP
2. **Primary stale, failover fresh**: emit A record pointing to failover IP (automatic failover)
3. **Both stale**: emit primary IP with STALE comment (last-resort)
4. **No box reachable**: emit OFFLINE comment (no A record)

Failover happens within one TTL (default 300s / 5 minutes) with no human intervention.

## Knot DNS Configuration

Knot DNS runs as a host service in the measured base image, activated only on
boxes designated as nameservers.

### Activation

All nameserver units use `BindsTo=safebox-nameserver-role.target`. The
nameserver role target is enabled at runtime by the role activation service
when `managed-containers.json` designates a box as a nameserver.

### Service Units

| Unit | Purpose |
|------|---------|
| `safebox-knot.service` | Knot DNS authoritative server |
| `safebox-zone-compiler.timer` | Periodic zone recompilation (every 60s) |
| `safebox-zone-compiler.service` | Zone compilation oneshot |
| `safebox-dnssec-keygen.service` | First-boot DNSSEC key generation |
| `safebox-delegation-monitor.timer` | Delegation health checks (every 6h) |
| `safebox-delegation-monitor.service` | DS/NS/serial/CT checks |
| `safebox-nameserver-role.target` | Role activation target |

### Filesystem Layout

```
/etc/knot/knot.conf                    # Knot configuration
/etc/safebox/nameserver.json           # Zone compiler config overlay
/etc/safebox/expected-nameservers.txt  # Expected NS records for monitoring
/opt/safebox/nameserver/
    compile-zone.js                    # Zone compiler integration script
    dnssec-keygen.sh                   # First-boot DNSSEC key generator
    delegation-monitor.sh             # Delegation health monitor
/var/lib/safebox/knot/
    zones/safenet.org.zone             # Compiled zone file
    keys/                              # DNSSEC key metadata
    keys/ds-records.txt                # DS records for parent submission
    pkcs11/                            # tpm2-pkcs11 token store
/run/knot/                             # Knot runtime socket
```

## DNSSEC

### RFC 8901 Multi-Signer

Each nameserver generates its own ZSK and KSK in its TPM via tpm2-pkcs11.
No signing key material is ever shared between boxes.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   NS 1      │  │   NS 2      │  │   NS N      │
│ KSK₁ ZSK₁  │  │ KSK₂ ZSK₂  │  │ KSKₙ ZSKₙ  │
│ (in TPM)    │  │ (in TPM)    │  │ (in TPM)    │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        ▼
              ┌─────────────────┐
              │  Parent (.org)  │
              │  DS₁, DS₂..DSₙ │
              └─────────────────┘
```

The DS records for **all** nameservers' KSKs are registered at PIR (the .org
registry). Resolvers accept signatures from any of the nameservers.

### Key Generation

On first boot of a nameserver-role box:

1. `safebox-dnssec-keygen.service` runs (ConditionPathExists guard: runs once)
2. Initializes a tpm2-pkcs11 token store at `/var/lib/safebox/knot/pkcs11/`
3. Generates KSK and ZSK via `keymgr` (ECDSAP256SHA256, per RFC 8624)
4. Extracts DS records to `/var/lib/safebox/knot/keys/ds-records.txt`
5. DS records must be submitted to PIR (manual step with registry lock)

### Algorithm Choice

- **ZSK and KSK**: ECDSAP256SHA256 (algorithm 13)
- **NSEC3**: enabled (opt-out disabled)
- **ZSK lifetime**: 30 days (automatic rollover by Knot)
- **KSK lifetime**: indefinite (manual rollover with DS update at parent)

## Firewall

Port 53 (TCP and UDP) is open in the host firewall (`safebox-imds.nft`)
unconditionally. This is safe because:

- Knot only binds port 53 when `safebox-nameserver-role.target` is active
- On non-nameserver boxes, nothing listens on port 53
- The `ConditionPathExists` guard prevents Knot from starting without a zone file

## Delegation Monitor

The delegation monitor (`safebox-delegation-monitor.timer`, every 6 hours)
checks:

1. **NS records at parent**: match expected nameservers
2. **DS records at parent**: our KSK key tags are present
3. **Serial consistency**: all nameservers report the same SOA serial
4. **Certificate Transparency**: monitors crt.sh for unexpected certificates

Warnings and critical alerts are logged to syslog with the `delegation-monitor`
tag.

## PIR Registry Lock

The .org registry (PIR) supports registrar-lock and registry-lock for NS and DS
changes. This prevents unauthorized changes to the delegation.

To change NS or DS records:

1. Generate the new records (DS from `keymgr`, NS from config)
2. Submit via the registrar with out-of-band verification
3. Verify propagation with `delegation-monitor.sh`
4. Update `/etc/safebox/expected-nameservers.txt` if NS changed

## Future: Governance Policy

The `governancePolicy` field in name claims is reserved for M-of-N governance:

```json
{
  "governancePolicy": {
    "type": "m-of-n",
    "m": 2,
    "n": 3,
    "keys": ["<pubkey1>", "<pubkey2>", "<pubkey3>"]
  }
}
```

When implemented, name claims will require signatures from M of N governance
keys instead of a single owner key. The zone compiler and registry will
validate the multi-signature before accepting the claim.
