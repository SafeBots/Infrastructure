# Safenet

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-yellow.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-210%20passing-brightgreen.svg)](test/)

**Trust network protocol for Safebox-to-Safebox communication, distributed package management, and payment settlement.**

Safenet is the protocol layer that lets Safeboxes trust each other, distribute software securely, and settle payments — without any central authority. Authors publish packages via standard `git push`, the registry replicates across attested Safeboxes using content-addressed data structures, and payments settle off-chain with optional on-chain redemption via the OpenClaiming EVM contract.

> **Status**: Reference implementation (v0.1.0). Protocol spec is stable; implementation is pre-production.

---

## Table of Contents

- [How Safenet Fits In](#how-safenet-fits-in)
- [What Safenet Does](#what-safenet-does)
- [Architecture](#architecture)
- [Safecloud Integration](#safecloud-integration)
- [DNS Nameserver](#dns-nameserver)
- [Interfaces](#interfaces)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Protocol Highlights](#protocol-highlights)
- [Cryptographic Foundations](#cryptographic-foundations)
- [Auditable Images](#auditable-images)
- [Development](#development)
- [License](#license)

---

## How Safenet Fits In

The Safebots ecosystem is four repos, each with a single job:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Safebots Ecosystem                           │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Safecloud   │  │   Safenet    │  │   Safebox    │              │
│  │              │  │  (this repo) │  │              │              │
│  │  Encrypted   │  │  Trust &     │  │  Governed    │              │
│  │  chunk       │  │  registry &  │  │  AI workflow │              │
│  │  storage     │  │  package     │  │  engine      │              │
│  │              │  │  distribution│  │              │              │
│  │  Jets, Drops │  │  Attestation │  │  Sandbox,    │              │
│  │  Clouds      │  │  Git/Hg     │  │  governance, │              │
│  │              │  │  Safebux     │  │  executors   │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│         └─────────────────┼─────────────────┘                       │
│                           │                                         │
│                  ┌────────┴────────┐                                │
│                  │ Infrastructure  │                                │
│                  │                 │                                │
│                  │ Host-level      │                                │
│                  │ provisioning &  │                                │
│                  │ hardening       │                                │
│                  │ (AWS AMI)       │                                │
│                  └─────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

| Repo | What it does | Runtime | Depends on |
|------|-------------|---------|------------|
| [**Safecloud**](https://github.com/Safebots/Safecloud) | Encrypted chunk storage. Content-agnostic. Jets route, Drops store, Clouds (browser clients) read/write. | Qbix plugin (browser + Node.js) | — |
| **Safenet** (this repo) | Trust, registry, package distribution. Mutual attestation, OCP-signed publications, Safebux payments, transparency log. | Standalone Node.js | Q.Crypto, Q.Data (peer deps) |
| [**Safebox**](https://github.com/Safebots/Safebox) | Governed AI workflow infrastructure. Sandboxed code execution, M-of-N governance, credential management, executor nodes. | Qbix plugin | Safecloud, Safenet |
| [**Infrastructure**](https://github.com/Safebots/Infrastructure) | Host-level provisioning and hardening. AWS Nitro attestation, ZFS encryption, Docker isolation, system component. | Bash + Node.js | — |

**Key boundary:** Safecloud stores opaque encrypted chunks and knows nothing about trust or packages. Safenet distributes trust and keys and knows nothing about chunk storage. The two meet when a Safebox runs a Safecloud client (as a Node.js process, not a browser) to store and retrieve package content that Safenet has authorized.

---

## What Safenet Does

1. **Mutual attestation** — Safeboxes verify each other's PCR measurements and identity claims before exchanging sensitive material. A three-step handshake (attest → challenge → verify) over TLS 1.3.

2. **Distributed package registry** — A Prolly-tree-backed registry where package metadata replicates across attested Safeboxes. Synchronization is O(diff × log n) — peers exchange only the subtrees that differ.

3. **Git-native publishing** — Authors publish by `git push` to a Safenet remote. The protocol implements Git Smart HTTP, so standard git tooling works without plugins. Mercurial is also supported.

4. **Safebux payments** — Off-chain micropayments for proprietary software. Payment claims accumulate as OCP claims and can optionally settle on any EVM chain via the OpenClaiming Payments contract.

5. **Transparency log** — Every publication is recorded in an append-only Merkle log with RFC 6962 consistency proofs. Anyone can audit the history.

6. **Revocation** — Keys, packages, and Safebox trust can be revoked. Revocations are priority-gossiped (all peers, higher TTL) and processed before any pending claims.

---

## Architecture

### Module Structure

```
safenet/
├── lib/
│   ├── SafenetNode.js      # Main orchestrator — HTTP router for 16 route prefixes
│   ├── Identity.js          # Safebox/Author identity via Q.Crypto keypairs
│   ├── Registry.js          # Prolly-tree-backed distributed package registry
│   ├── Publisher.js         # Manifest validation, Merkle root, AES-256-GCM encryption
│   ├── GitReceiver.js       # Git Smart HTTP protocol with OCP authentication
│   ├── Discovery.js         # Peer gossip (fanout 6, TTL 8), Bloom filter sync
│   ├── Payments.js          # Safebux ledger, license grants, EIP-712 settlement
│   ├── TransparencyLog.js   # Append-only chained Merkle log with consistency proofs
│   ├── Verify.js            # Client-side claim verification (isomorphic Node+browser)
│   ├── Claims.js            # Factory for all 17 OCP claim types (includes name_claim, safebox_announce)
│   ├── ZoneCompiler.js      # Pure-function DNS zone compiler (registry → zone file)
│   └── utils.js             # SHA-256, RFC 8785 canonicalization, semver validation
├── cli.js                   # 13 CLI commands
├── server.js                # Standalone HTTP/HTTPS server
├── package.json             # @safenet/protocol v0.1.0
├── PROTOCOL.md              # Full protocol specification (939 lines)
└── test/
    ├── testSafenet.js       # 159 TAP tests (154 run + 5 Q-dependent skipped)
    └── testVerify.js        # 51 TAP tests for Verify library (end-to-end crypto)
```

### Claim Types

Everything in Safenet is an OCP claim — a signed JSON envelope with the wire format `{ocp:1, iss, sub, stm, key:[], sig:[]}`. The protocol defines 17 claim types:

| Claim Type | Issuer | Purpose |
|------------|--------|---------|
| `safebox_identity` | Safebox | Declare identity + PCR attestation |
| `author_identity` | Author | Declare author keys + metadata |
| `org_identity` | Org members | Declare org membership + governance thresholds |
| `namespace_claim` | Author/Org | Claim ownership of a namespace |
| `publication` | Author/Org | Publish a package version with Merkle root |
| `license_grant` | Author/Org | Grant a Safebox install permission |
| `payment` | Safebox | Pay for a proprietary package installation |
| `key_revocation` | Author/Org | Revoke a compromised signing key |
| `package_revocation` | Author/Org | Withdraw a package version |
| `safebox_revocation` | Governance | Revoke a Safebox's trust status |
| `image_blessing` | Governance | Approve a disk image hash |
| `peer_announce` | Safebox | Announce network presence and endpoints |
| `trust` | Safebox | Establish a peer trust relationship |
| `namespace_transfer` | Author/Org | Transfer namespace to a new owner |
| `audit_attestation` | Auditor | Attest a package meets per-topic audit requirements |
| `safebox_announce` | Safebox (Ed25519) | Announce box ID, IP, attestation status on boot |
| `name_claim` | Owner/governance (ES256) | Map a DNS name to a primary + failover box |

Supports ES256 (P-256) and EIP-712 (secp256k1) signing schemes with M-of-N multisignature.

### Identity Model

Identity is cryptographic, not username/password. Three identity types:

- **Safebox** — P-256 keypair bound to hardware attestation (PCR values). URI: `safebox://<spki-hash>`. Stable across IP changes and reboots.
- **Author** — One or more signing keys with optional WebAuthn 2FA. URI: `safenet:author:<name>`. Name rules: lowercase alphanumeric + hyphens.
- **Organization** — Multi-key identity with governance thresholds (M-of-N for publish, namespace changes, membership changes). URI: `safenet:org:<name>`.

### Trust Levels

| Level | Meaning | Requires |
|-------|---------|----------|
| `untrusted` | No attestation | Default |
| `attested` | Mutual attestation passed | Valid identity + PCR match |
| `endorsed` | Governance quorum approval | Attested + governance claim |
| `delegated` | Valid delegation chain from trusted root | Attested + chain verification |

---

## Safecloud Integration

Safenet uses Safecloud for content storage — the same infrastructure that powers browser-based encrypted storage also stores package content. Here's how they connect.

### Jets Swarm Around Packages

When a package is published to Safenet, the content is encrypted and distributed via Safecloud. Safecloud Jets — attested Safeboxes running the Safecloud routing server — can swarm around popular packages using the `JetSwarm` protocol (Hyperswarm-based peer discovery with Noise-encrypted connections):

```
Author pushes v1.2.3              Safenet peer (Git Receiver)
     │                                    │
     │  git push safenet main             │
     │────────────────────────────────────>│
     │                                    │
     │                    [verify author, namespace, manifest]
     │                    [compute Merkle root]
     │                    [sign publication claim]
     │                    [encrypt chunks with AES-256-GCM]
     │                                    │
     │                           Safecloud Client (Node.js)
     │                                    │
     │                    [store encrypted chunks via Jet]
     │                                    │
     │                              ┌─────┴─────┐
     │                              │           │
     │                           Jet A       Jet B
     │                              │           │
     │                    ┌────┬────┤     ┌────┬────┐
     │                    │    │    │     │    │    │
     │                  Drop  Drop Drop Drop Drop Drop
     │                   1     2    3    4    5    6
```

Key points:

- **Safeboxes run Safecloud Node.js clients** — not browser clients. The Safecloud SDK already supports Node.js; a Safebox uses it exactly like a browser Cloud instance, just without the DOM.
- **Drops are content-agnostic** — they store opaque encrypted chunks and need no attestation. A single Drop can host chunks for multiple Jets and multiple packages.
- **Chunks are deduplicated** — a Drop storing chunk `bafy2...` doesn't care which package or which Jet it came from. One chunk, one CID, one copy.
- **Jets can swarm** — `JetSwarm` uses Hyperswarm with topic key `SHA-256(noisePublicKey ∥ networkId)`. Jets interested in the same packages naturally find each other.

### Client Discovery

Safeboxes that want to install a package find content through a tiered discovery model:

1. **Local cache** — Chunks already fetched are reused.
2. **Known Jets** — The Safenet registry gossips Jet endpoints alongside peer announcements.
3. **JetSwarm** — Discover new Jets via Hyperswarm for specific package topics.
4. **Direct Safebox** — Ask a known attested Safebox that has the package.

### Content Encryption

Package content is encrypted with keys derived from the Merkle root:

- **Open source** (`safeboxOnly: false`): `packageSecret = HKDF-SHA256(merkleRoot, salt="safenet", info="safenet-package-key-v1")`. Anyone with the publication claim (which contains the Merkle root) can derive the key.
- **Proprietary** (`safeboxOnly: true`): The `packageSecret` is distributed only to attested Safeboxes that hold a valid `license_grant` claim from the author.

Chunks use per-index keys: `HKDF-SHA256(packageSecret, salt=chunkIndex, info="safenet-chunk-v1")` → AES-256-GCM.

### No Changes Needed to Safecloud

Safecloud's protocol doesn't need modification for Safenet integration. Safecloud already provides everything Safenet needs:

- Encrypted chunk storage (Drops)
- Content routing (Jets)
- Deduplication (CID-based)
- Node.js client SDK
- Peer discovery (JetSwarm)

Safenet adds the layer that Safecloud doesn't have: trust (who can publish), authorization (who can install), and payments (what it costs).

---

## DNS Nameserver

Safenet includes a built-in authoritative DNS nameserver so that names claimed through the registry resolve to the boxes that serve them — with automatic failover and hardware-rooted DNSSEC.

### How It Works

The nameserver architecture has two halves:

1. **Zone Compiler (Safenet)** — A pure function (`lib/ZoneCompiler.js`) that takes the current registry state (name claims + box announces) and produces a standard DNS zone file. Given the same inputs, every nameserver computes the same zone.

2. **Knot DNS (Infrastructure)** — The authoritative nameserver that serves the compiled zone. Runs as a host service on boxes designated with the `safebox-nameserver-role.target`. DNSSEC keys live in the TPM via `tpm2-pkcs11`.

```
Registry state (Prolly tree)
  │
  │  name_claims: "myapp" → box-abc, failover box-xyz
  │  box_announces: box-abc → 203.0.113.10, attested 30s ago
  │                 box-xyz → 198.51.100.20, attested 45s ago
  │
  ▼
ZoneCompiler.compile(registry, config)
  │
  │  Pure function: same inputs → same zone file
  │  SOA serial from Prolly tree root hash
  │
  ▼
safenet.org.zone
  │
  │  myapp  IN  A  203.0.113.10  ; box-abc
  │
  ▼
Knot DNS (knotc zone-reload)
  │
  │  DNSSEC signed with TPM-held keys
  │
  ▼
DNS queries → authoritative answers
```

### Two-Claim Model

DNS resolution uses two OCP claim types:

| Claim | Issuer | Purpose |
|-------|--------|---------|
| `safebox_announce` | Safebox (Ed25519) | "I'm box X at IP Y, attested at time T" — published on every boot and periodically |
| `name_claim` | Owner/governance (ES256) | "Map `myapp.safenet.org` to box X (failover: box Y)" — signed by the name owner |

Both propagate through the standard gossip protocol. Any party with the registry state can compile the zone independently.

### Automatic Failover

When a box stops attesting (no fresh `safebox_announce` within `attestationMaxAge`, default 600 seconds), the zone compiler automatically switches to the failover box:

- **Primary fresh** → A record points to primary box IP
- **Primary stale, failover fresh** → A record points to failover box IP
- **Both stale** → A record points to primary with STALE warning
- **No box reachable** → OFFLINE comment, no A record

Failover happens within one TTL cycle (default 300s / 5 min). No manual intervention required.

### DNSSEC (RFC 8901 Multi-Signer)

Each nameserver generates its own ZSK and KSK inside its TPM — no shared key material. DS records for all nameservers are registered at the parent (.org registry via PIR). This follows RFC 8901 multi-signer DNSSEC:

- **Algorithm:** ECDSAP256SHA256
- **KSK lifetime:** Indefinite (TPM-held, rolled manually)
- **ZSK lifetime:** 30 days (automatic rollover by Knot)
- **NSEC3:** Enabled (prevents zone walking)
- **Key storage:** PKCS#11 via `tpm2-pkcs11` — keys never leave the hardware

### CAA Records

The zone includes Certificate Authority Authorization records restricting certificate issuance to configured CAs (default: Let's Encrypt):

```dns
@  IN  CAA  0 issue "letsencrypt.org"
@  IN  CAA  0 issuewild "letsencrypt.org"
@  IN  CAA  0 iodef "mailto:caa@safenet.org"
```

### Delegation Monitor

A systemd timer (`safebox-delegation-monitor.timer`, every 6 hours) verifies delegation health:

1. NS records at the parent (.org) match expected nameservers
2. DS records at the parent include all local KSK key tags
3. All nameservers respond and serve the same serial
4. Certificate Transparency logs for unexpected certificate issuance

### Independent Verification

Because the zone is a pure function of public registry state, anyone can verify the DNS by:

1. Syncing the registry (Prolly tree)
2. Running `ZoneCompiler.compile()` with the same config
3. Comparing the output against what the nameservers actually serve

This makes DNS a transparent, auditable layer — not a trusted authority.

---

## Interfaces

Safenet exposes multiple interfaces to serve different integration scenarios.

### 1. Git / Mercurial Smart HTTP

Authors publish by pushing to a Safenet remote — standard git tooling, no plugins:

```bash
# Add the Safenet remote
git remote add safenet https://safebox.example.com/safenet/v1/git/alice/my-library

# Push to publish
git push safenet main
```

The receiver verifies identity, namespace ownership, validates the `safenet.json` manifest, computes the content Merkle root, signs the publication claim, and gossips it to peers. Mercurial uses the same flow over its wire protocol.

Push authentication uses OCP claims in the `Authorization: OCP <base64>` header, or SSH-style public key authentication. WebAuthn 2FA is supported via a browser-based challenge flow.

### 2. REST API

All endpoints are under `/safenet/v1/`. Content type is `application/json`.

**Registry (public read):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/registry/namespace/<name>` | Get namespace claim |
| `GET` | `/registry/package/<ns>/<name>` | Get package metadata |
| `GET` | `/registry/package/<ns>/<name>/versions` | List all versions |
| `GET` | `/registry/package/<ns>/<name>/<version>` | Get publication claim |
| `GET` | `/registry/search?q=<query>&lang=<lang>` | Search packages |
| `GET` | `/registry/root` | Get Prolly tree root hash |

**Publication (authenticated):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/publish` | Submit a signed publication claim |
| `POST` | `/namespace/claim` | Claim a namespace |
| `POST` | `/namespace/transfer` | Transfer namespace ownership |

**Peer-to-peer:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/attest` | Exchange identity claims |
| `POST` | `/challenge` | Attestation challenge-response |
| `POST` | `/verify` | Complete attestation |
| `POST` | `/gossip` | Receive gossiped claims |
| `POST` | `/sync/bloom` | Bloom filter exchange |
| `POST` | `/sync/prolly` | Prolly tree reconciliation |
| `GET` | `/peers` | List known peers |

**Payments:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/pay` | Submit a payment claim |
| `GET` | `/balance/<author>` | Get Safebux balance |
| `GET` | `/payments/<author>` | List payment claims for an author |

**Audit Attestation:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/audit` | Submit a signed audit attestation claim |
| `GET` | `/audit/<topic>` | List all attestations for a topic |
| `GET` | `/audit/<topic>/<ns>/<pkg>` | Get attestations for a specific package + topic |

**Transparency:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/transparency/root` | Current log root hash + entry count |
| `GET` | `/transparency/entry/<n>` | Entry N with inclusion proof |
| `GET` | `/transparency/consistency/<from>/<to>` | Consistency proof (RFC 6962) |

**Content:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/content/<merkleRoot>/<chunkIndex>` | Download an encrypted content chunk |
| `GET` | `/content/<merkleRoot>/proof/<fileIndex>` | Merkle inclusion proof for a file |

### 3. MCP Endpoints (Planned)

For AI agent integration, Safenet will expose [Model Context Protocol](https://modelcontextprotocol.io/) endpoints so that AI assistants can query the registry, inspect packages, and trigger installations on behalf of governed Safebox workflows.

### 4. OpenAPI / Swagger (Planned)

Machine-readable API documentation for third-party integrations and CI/CD pipelines.

### 5. Optional GitLab/Gitea Container (Planned)

For organizations that want a familiar web UI, Safenet can optionally run a GitLab or Gitea container alongside the protocol implementation. The container provides a browsable frontend, merge requests, and issue tracking, while Safenet handles the trust, signing, and distribution underneath.

---

## Quick Start

### Prerequisites

- Node.js ≥ 18.0.0
- Optional: [Qbix Platform](https://github.com/ArtexSoftworks/Platform) (for full Q.Crypto / Q.Data; the core implementation works without it using built-in fallbacks)

### Install

```bash
git clone https://github.com/Safebots/Safenet.git
cd Safenet
npm install
```

### Initialize a Safenet Node

```bash
# Generate identity and create data directory
npx safenet init

# Or specify a custom data directory
npx safenet init --data-dir /var/lib/safenet
```

This creates:
- `identity.json` — Public identity (safe to share)
- `identity-secret.json` — Private key material (owner-read-only, mode 0600)
- `repos/` — Git repository storage
- `log/` — Transparency log entries

### Start the Server

```bash
# Start on default port 8443
npx safenet start

# Or with options
npx safenet start --port 9443 --data-dir /var/lib/safenet

# With TLS
npx safenet start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem

# With bootstrap peers
npx safenet start --bootstrap https://peer1.example.com:8443,https://peer2.example.com:8443
```

### Publish a Package

```bash
# 1. Register as an author
npx safenet author register alice --display-name "Alice Chen"

# 2. Claim a namespace
npx safenet namespace claim alice

# 3. Add safenet.json to your project
cat > safenet.json << 'EOF'
{
  "name": "alice/my-library",
  "version": "1.0.0",
  "description": "My library",
  "languages": {
    "nodejs": { "entry": "index.js", "engines": { "node": ">=18" } }
  },
  "license": "MIT",
  "safeboxOnly": false,
  "pricing": { "model": "free" }
}
EOF

# 4. Push to Safenet
git remote add safenet https://safebox.example.com/safenet/v1/git/alice/my-library
git push safenet main
```

### Query the Registry

```bash
# Search for packages
npx safenet registry search --query "my-library" --lang nodejs

# Get package info
npx safenet registry info alice/my-library

# List versions
npx safenet registry versions alice/my-library
```

---

## CLI Reference

```
safenet <command> [options]

Commands:
  init                          Initialize a new Safenet node
  start                         Start the Safenet server
  identity show                 Display node identity
  author register <name>        Register an author identity
  namespace claim <name>        Claim a namespace
  namespace transfer <ns> <to>  Transfer namespace ownership
  registry search               Search the package registry
  registry info <pkg>           Get package metadata
  registry versions <pkg>       List package versions
  peer list                     List known peers
  peer add <endpoint>           Add a bootstrap peer
  transparency audit            Audit the transparency log
  help                          Show help

Global options:
  --data-dir <path>     Data directory (default: ~/.safenet)
  --port <port>         Server port (default: 8443)
  --bootstrap <peers>   Comma-separated bootstrap peer URLs
  --tls-cert <path>     TLS certificate file
  --tls-key <path>      TLS private key file
```

---

## Protocol Highlights

The full protocol specification is in [PROTOCOL.md](PROTOCOL.md) (939 lines, 13 sections + 4 appendices). Here are the key design decisions.

### Git-Native Publishing

Authors don't learn a new tool. They `git push` to a Safenet remote. The Git Smart HTTP receiver handles:

1. **Pre-receive** — Verify author identity + namespace ownership
2. **Update** — Parse `safenet.json`, validate version bump, check manifest schema
3. **Post-receive** — Compute Merkle root, sign publication claim, encrypt + distribute chunks, gossip to peers

### Prolly Tree Registry

The registry is a Prolly tree (probabilistic B-tree, built on `Q.Data.Prolly`) with six key prefixes:

```
namespace:<name>                → NamespaceClaim
package:<namespace>/<name>      → PackageMetadata
version:<namespace>/<name>@<v>  → PublicationClaim
author:<name>                   → AuthorIdentityClaim
revocation:<hash>               → RevocationClaim
audit:<topic>:<auditor>:<ns>/<pkg> → AuditAttestationClaim
```

Peers compare Prolly root hashes to detect divergence, then exchange only the subtrees that differ. Sync cost is O(diff × log n), not O(n).

### Gossip Protocol

Claims propagate via epidemic gossip with fanout 6 and TTL 8. Deduplication is by claim hash (`SHA-256(canonicalize(stm))`). Revocations are priority-gossiped (all peers, TTL 16).

### Bloom-Accelerated Cold Start

When a peer reconnects after a partition (or joins for the first time), it sends a Bloom filter of its known claim hashes. The remote peer tests its own claims against the filter and sends back the ones that are probably missing. False positives are harmless — the receiver ignores duplicates. Uses `Q.Data.Bloom` with p = 0.001.

### Safebux Payments

Four pricing models: `free`, `per-install`, `subscription`, and `metered`. Payments are OCP claims that accumulate off-chain. Authors can optionally redeem them on any EVM chain via the OpenClaiming Payments contract (ERC-20 on BNB Chain / BSC, eip155:56, 6 decimals).

### Transparency Log

An append-only Merkle log where each entry is: `SHA-256(prev_hash ∥ claim_hash ∥ timestamp)`. Provides auditability, non-equivocation (peers can't present different histories), and consistency proofs per RFC 6962.

---

## Cryptographic Foundations

Safenet builds on three cryptographic layers from the Qbix Platform:

### OpenClaiming Protocol (OCP)

The wire format for all signed assertions. Every claim follows the structure:

```json
{
  "ocp": 1,
  "iss": "<issuer-uri>",
  "sub": "<subject-uri>",
  "stm": { "type": "...", ... },
  "key": ["data:key/<algorithm>;base64,<value>"],
  "sig": ["<base64-signature>"],
  "nbf": "<not-before>",
  "exp": "<expiration>"
}
```

Two signing schemes: ES256 (P-256, for Safebox identity and access control) and EIP-712 (secp256k1, for blockchain settlement). M-of-N multisignature is native.

### Q.Crypto

- **`Q.Crypto.internalKeypair()`** — Deterministic keypair generation
- **`Q.Crypto.sign()` / `Q.Crypto.verify()`** — Typed-message signing (P-256/ES256)
- **`Q.Crypto.delegate()` / `Q.Crypto.verifyDelegated()`** — Delegation ceremonies
- **`Q.Crypto.OpenClaim`** — OCP claim construction and verification
- **`Q.Crypto.OpenClaim.EVM`** — EIP-712 signing for blockchain settlement

### Q.Data

- **`Q.Data.canonicalize()`** — RFC 8785 JSON Canonicalization Scheme
- **`Q.Data.Merkle`** — Content integrity trees (SHA-256, 0x00/0x01 domain separation)
- **`Q.Data.Prolly`** — Probabilistic B-trees for O(diff × log n) state reconciliation
- **`Q.Data.Bloom`** — Bloom filters for efficient cold-start sync
- **HKDF-SHA256** — Key derivation for identity, content encryption, and per-chunk keys
- **AES-256-GCM** — Content encryption

### HKDF Key Derivation Tree

```
rootSecret (per Safebox)
  ├── HKDF(info="safebox-identity-v1")     → Safebox identity keypair
  ├── HKDF(info="safebox-gateway-hmac-v1") → Gateway HMAC key (Infrastructure)
  ├── HKDF(info="safenet-peer-v1")         → Peer-to-peer TLS key
  └── HKDF(info="safenet-content-v1")      → Content encryption master key
       ├── HKDF(info="pkg:<ns>/<name>@<v>") → Package-specific key
       │    ├── HKDF(info="chunk:0")         → Chunk 0 key
       │    ├── HKDF(info="chunk:1")         → Chunk 1 key
       │    └── ...
       └── ...
```

### Cryptographic Agility

New algorithms can be added without protocol changes. The OCP key URI scheme (`data:key/<algorithm>;base64,<value>`) is extensible. Planned: `data:key/ml-dsa65;base64,<pk>` for post-quantum signatures (ML-DSA / Dilithium), `data:key/ml-kem768;base64,<pk>` for post-quantum key exchange (ML-KEM / Kyber).

---

## Auditable Images

Both Safenet and [Infrastructure](https://github.com/Safebots/Infrastructure) are open-source. Together they produce auditable disk images with a verifiable chain:

```
Source code                    Disk image                     Attestation
────────────                   ──────────                     ───────────
Infrastructure @ commit X  ─┐
                            ├→ AMI (SHA-256 hash H)  ───→  PCR0 = measure(image)
Safenet        @ commit Y  ─┘                              PCR1 = measure(kernel)
                                                           PCR4 = measure(instance)
                                                                      │
                                                           HKDF(PCR0 ∥ PCR1 ∥ PCR4)
                                                                      │
                                                                master HMAC key
```

An auditor can:

1. Clone both repos at the tagged commits
2. Run the deterministic build
3. Verify the resulting image hash matches the published hash
4. Verify that running Safeboxes attest to that image hash
5. Verify the Safenet `image_blessing` claim signed by the governance quorum

The governance quorum publishes `image_blessing` claims that approve specific image hashes. Safeboxes verify peers against this approved set during mutual attestation.

---

## Security Considerations

| Threat | Mitigation |
|--------|------------|
| Compromised Safebox | Mutual attestation + PCR verification. Governance revocation. |
| Author key compromise | M-of-N recovery quorum. Key revocation with retroactive invalidation. WebAuthn 2FA. |
| Supply chain attack | Content Merkle tree. Signed publication claims. Transparency log. |
| Eclipse attack | Prolly root comparison across multiple peers. Consistency proofs. |
| Payment replay | Unique `installId` per payment. Timestamp bounds (`nbf`/`exp`). |
| MITM | TLS 1.3 with pinned Safebox certificates. OCP verification independent of transport. |
| Quantum | AES-256-GCM and HKDF-SHA256 are quantum-safe. P-256 → ML-KEM/ML-DSA upgrade path via OCP key URI extensibility. |

### Rate Limits

- Publications: 10 versions per package per hour
- Gossip: 100 claims per peer per minute
- Full sync: 1 per peer per hour (incremental unlimited)
- Git push: 5 per author per hour per package

---

## Client-Side Verification

The `Verify` module (`lib/Verify.js`) is a standalone, isomorphic verification library that works in both Node.js (16+) and browsers with **zero Q platform dependency**. It uses the Web Crypto API (SubtleCrypto) for all cryptographic operations.

### Usage

```javascript
// Node.js
const Verify = require('@safenet/protocol/verify');

// Browser (ESM)
import Verify from '@safenet/protocol/lib/Verify.js';

// Verify any signed OCP claim
const result = await Verify.claim(signedClaim);
// → { valid: true, errors: [], keyId: 'key-0' }

// Verify a safebox attestation against trusted images
const attestation = await Verify.safeboxAttestation(claim, {
  trustedImages: ['abcd1234...'],  // accepted image hashes
  trustedPCR0: ['ef567890...'],    // accepted PCR0 values
  maxAgeSec: 3600                  // reject claims older than 1 hour
});
// → { valid: true, safeboxUri: 'safebox://...', pcr0, pcr1, pcr4, imageHash, endpoints, capabilities }

// Verify a publication with Merkle root check
const pub = await Verify.publication(signedPubClaim, {
  files: [{ path: 'index.js', content: '...' }, ...]
});
// → { valid: true, merkleVerified: true, package: 'ns/pkg@1.0.0' }

// Fetch and verify a live safebox
const live = await Verify.fetchAndVerify('https://safebox.example.com:8443', {
  trustedImages: ['abcd1234...']
});

// Check revocation
const revoked = await Verify.isRevoked(claim, revokedHashSet);

// Verify transparency log inclusion proof
const ok = await Verify.inclusionProof(entryHash, proof, rootHash);
```

### API

| Method | Description |
|--------|-------------|
| `Verify.claim(claim, opts?)` | Verify ES256 signature on any OCP claim |
| `Verify.safeboxAttestation(claim, opts?)` | Verify safebox identity (signature + PCR + image trust) |
| `Verify.publication(claim, opts?)` | Verify publication claim (signature + optional Merkle root) |
| `Verify.auditAttestation(claim, opts?)` | Verify audit attestation (signature + expiry + auditor trust) |
| `Verify.fetchAndVerify(endpoint, opts?)` | Fetch + verify a live safebox's identity endpoint |
| `Verify.inclusionProof(hash, proof, root)` | Verify a Merkle inclusion proof |
| `Verify.merkleRoot(hashes)` | Compute Merkle root from leaf hashes |
| `Verify.isRevoked(claim, revokedSet)` | Check if a claim hash is in a revocation set |
| `Verify.claimHash(claim)` | Compute SHA-256 of canonicalJSON(claim.stm) |
| `Verify.validateStructure(claim)` | Validate OCP envelope structure (no crypto) |
| `Verify.canonicalJSON(value)` | RFC 8785 / JCS canonical JSON serialization |
| `Verify.sha256hex(data)` | SHA-256 hex digest via SubtleCrypto |

---

## Development

### Run Tests

```bash
npm test
```

210 TAP tests across two suites:

- **testSafenet.js** (159 tests) — identity, registry (Prolly tree), publication (manifests + Merkle), discovery (gossip + Bloom), payments (ledger + settlement), transparency log (append + consistency proofs), claims (all 15 types), git receiver, CLI, and HTTP routing. 154 run with built-in crypto fallbacks; 5 require Q.Crypto / Q.Data and skip gracefully.
- **testVerify.js** (51 tests) — end-to-end cryptographic verification: real P-256 keypair generation → OCP claim signing → signature verification, safebox attestation, publication Merkle root, audit attestation expiry, DER/P1363 signature conversion, revocation checking, Merkle proof verification, cross-compatibility with utils.js canonicalJSON/claimHash. Uses only Web Crypto API (no Q dependency).

### Project Structure

| File | Lines | Description |
|------|-------|-------------|
| `lib/SafenetNode.js` | 1,465 | Main orchestrator with HTTP routing |
| `cli.js` | 953 | CLI with 13 commands |
| `lib/Payments.js` | 799 | Safebux ledger + EVM settlement |
| `lib/GitReceiver.js` | 621 | Git Smart HTTP protocol |
| `lib/Discovery.js` | 620 | Gossip + Bloom sync |
| `lib/Registry.js` | 750+ | Prolly-tree-backed registry (NAME/BOX_ANNOUNCE prefixes) |
| `lib/TransparencyLog.js` | 491 | Append-only Merkle log |
| `lib/Claims.js` | 567 | 17 OCP claim type factories (includes name_claim, safebox_announce) |
| `lib/ZoneCompiler.js` | 271 | Pure-function DNS zone compiler |
| `lib/Verify.js` | 530 | Client-side verification (isomorphic Node+browser) |
| `lib/Publisher.js` | 402 | Manifest validation + encryption |
| `lib/Identity.js` | 373 | Identity generation + verification |
| `lib/utils.js` | 163 | SHA-256, canonicalization, semver |
| `test/testSafenet.js` | 1,730 | 159 TAP tests |
| `test/testVerify.js` | 490 | 51 TAP tests (end-to-end crypto) |
| **Total** | **~10,600** | |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SAFENET_DATA_DIR` | `~/.safenet` | Data directory |
| `SAFENET_PORT` | `8443` | Server port |

---

## Related

- [PROTOCOL.md](PROTOCOL.md) — Full protocol specification (939 lines)
- [Infrastructure](https://github.com/Safebots/Infrastructure) — Host-level AMI provisioning
- [Safecloud](https://github.com/Safebots/Safecloud) — Encrypted chunk storage protocol
- [Safebox](https://github.com/Safebots/Safebox) — Governed AI workflow plugin
- [Qbix Platform](https://github.com/ArtexSoftworks/Platform) — Q.Crypto and Q.Data foundations

---

## License

MIT. See [LICENSE](LICENSE).
