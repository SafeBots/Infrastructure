# Safecloud and Safenet: Roles, Boundaries, and Integration

## The Two Primitives

Safecloud protects data at rest and in transit through encryption and content addressing. The infrastructure holding the data is untrusted — a browser tab, a random server, a competitor's cloud. Policy is enforced by who has the decryption keys, not by who operates the storage.

Safebox protects data in use through attestation and confidential compute. The infrastructure is trusted but verified — the TPM proves the code is what it claims to be, and the measurement chain is in the transparency log.

The boundary question for any piece of the system: can the data protect itself (Safecloud), or does the computation need a guardian (Safebox)?

## What Lives Where

### Safecloud Is Authoritative For

**Packages.** Software packages are content-addressed and distributed via JetSwarm (Hyperswarm-based swarming). Every Drop that holds a chunk can serve it. Popular packages get faster to fetch as more nodes hold them. Integrity is guaranteed by CID — a tampered chunk fails hash verification regardless of who served it.

**Registry state.** The Safenet registry (name claims, box announces, all OCP claims) is replicated as content-addressed encrypted chunks in the Drop network. Any participant — including browser tabs — can hold and serve registry data. Safenet nodes assemble chunks into the full registry; the Merkle root ensures consistency. Safecloud is the authoritative store; everything else is a cache.

**Media and files.** Encrypted chunks stored across Drops. Media doesn't need to live in ZFS snapshots — it's already on Drops, addressable by the Merkle root stored in the database.

**Encrypted backups.** ZFS snapshots of Safebox state, encrypted and distributed across the Drop network. Any new Safebox anywhere can pull and restore from these.

**Key derivation trees.** HKDF-based hierarchical key management. The tree structure is the access control — revoking a subtree doesn't touch sibling branches. Keys are derived, not stored, so there's no key database to steal.

### Safeboxes Cache and Compute

**DNS nameserver.** Knot DNS runs on attested Safebox instances. The zone is compiled from registry state (which comes from Safecloud) as a pure function. The nameserver is a cache of the registry rendered as DNS — not the source of truth. Multiple independent nameservers produce identical zones from identical registry state.

**Registry replicas.** Each Safebox running a Safenet node holds a local registry replica, synced from Safecloud. This is a working cache for fast lookups and zone compilation. If the replica is lost, it's rebuilt from the authoritative Safecloud data.

**Package caches.** Safeboxes cache packages locally for the containers they run. The cache is expendable — packages are re-fetched from JetSwarm on cache miss. AMI snapshots can pre-warm the cache for faster cloning.

**Model inference.** LLMs and other models run inside attested Safeboxes. The model must see plaintext to operate on it. TPM attestation proves the environment hasn't been tampered with. This is the thing Safecloud cannot do — compute over unencrypted data requires a trusted environment.

**Governance and signing.** M-of-N claim signing, DNSSEC key operations, credential management, blockchain transaction signing. The private key exists unencrypted in TPM-protected memory for the moment of signing. This requires attestation.

**External service integration.** Anything with network egress to third-party APIs (SMTP, payment rails, OAuth flows). The Safebox holds credentials and makes authenticated calls. Safecloud can store the credentials encrypted, but using them requires a Safebox.

**Code auditing.** The onboard LLM that vets submitted apps for the Safe Store. The audit requires running or analyzing untrusted code in a measured environment.

## When to Use Which

| Property | Safecloud | Safebox |
|----------|-----------|---------|
| Trust model | Data protects itself via encryption | Computation is attested via TPM |
| Hosting | Untrusted (browser tabs, any server) | Trusted and verified |
| Failure mode | Lose availability, not integrity | Lose the running environment |
| Scaling | Crowd-sourced (Drops earn Safebux) | Provisioned (cloud instances) |
| Cost | Approaches zero at scale | Per-instance compute cost |
| Confidentiality | Encryption enforces policy | Attestation enforces policy |
| Resilience | No single point of failure | Failover via ZFS replication + DNS |

**Use Safecloud when:**
- The data is encrypted and content-addressed
- Any untrusted party can hold it without risk
- Policy is enforced by key distribution, not by host behavior
- You need resilience without operational overhead
- The computation is deterministic and re-runnable (WASM with public inputs)

**Use Safebox when:**
- The computation touches plaintext secrets
- You need to interact with external services using credentials
- The code itself must be measured and attested
- Real-time serving is required (DNS, HTTP, model inference)
- Governance decisions require TPM-held signing keys

## Data Flow

```
Safecloud (authoritative)
    │
    ├── Registry chunks ──→ Safenet nodes ──→ Registry replica
    │                                              │
    │                                              ├──→ Zone compiler ──→ Knot DNS
    │                                              │
    │                                              └──→ Name resolution (direct)
    │
    ├── Package chunks ──→ JetSwarm ──→ Safebox package cache
    │
    ├── Media chunks ──→ Drops ──→ Client (decrypt locally)
    │
    ├── Encrypted backups ──→ Drops ──→ New Safebox (restore)
    │
    └── Key trees ──→ Client / Safebox (derive on demand)
```

## Cloning and Provisioning

A new Safebox can be brought online through several paths, from fastest to most independent:

1. **AMI snapshot** (fastest). An EC2 Safebox creates periodic AMI snapshots with pre-warmed package caches and a recent registry replica. A new instance launched from this AMI boots with most data already local. The registry replica and package cache are stale by the snapshot age but functional — they catch up from Safecloud on first sync.

2. **EBS volume mount.** Pre-built EBS volumes containing package sets or registry snapshots, with content hashes whitelisted in the Safe Store. A new Safebox mounts the volume and verifies the hash before trusting the contents. Faster than fetching everything from Safecloud, still verified.

3. **Safecloud restore** (most resilient). A new Safebox on any cloud provider pulls encrypted ZFS snapshots from the Drop network, decrypts them with its HKDF-derived key, and imports the pool. No dependency on any specific cloud provider's snapshot infrastructure. Slowest, but works anywhere.

All three paths end in the same state: an attested Safebox with a local registry replica, package cache, and application data, syncing ongoing updates from Safecloud. The AMI and EBS paths are optimizations for speed; Safecloud is the fallback that never depends on a single provider.

## DNS as a Cache Layer

The DNS nameserver is a rendering cache. The authority chain is:

1. **Safecloud** holds the authoritative registry chunks (name claims, box announces)
2. **Safenet nodes** assemble these into registry state (Merkle-rooted, auditable)
3. **Zone compiler** renders registry state as a DNS zone file (pure function, deterministic)
4. **Knot DNS** serves the zone with a 300-second TTL

A traditional browser queries step 4. A browser with a Safenet extension queries step 1 directly — pulls registry chunks from Drops, verifies against the Merkle root, resolves the name locally. Same data, same answer, no DNS infrastructure in the path.

Two coherence clocks govern freshness: the attestation window (600 seconds — is this box still alive and attesting?) and the DNS TTL (300 seconds — when does the resolver re-query?). The TTL is shorter than the attestation window so DNS never serves a record for a box the registry has already marked stale.

## Research Boundary

Every operation that can be moved from Safebox to Safecloud removes a trusted server from the system. Techniques that push this boundary:

- **Homomorphic encryption**: compute on encrypted data without decrypting. Removes the Safebox from query paths where the computation is simple enough (aggregations, filters).
- **Secure multi-party computation**: split a computation across multiple parties, none of whom sees the full input. Governance signing without any single key holder.
- **Verifiable WASM**: ship the function and its inputs as a content-addressed bundle. Anyone can re-execute to verify the output. Moves deterministic compute from Safebox to Safecloud.
- **Zero-knowledge proofs**: prove a property of data without revealing the data. A box can prove it's attesting correctly without revealing its attestation details to every verifier.

Each of these trades compute cost for trust reduction. The practical question is always whether the overhead is worth removing the dependency on an attested host.
