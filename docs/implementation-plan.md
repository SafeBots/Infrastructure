# Safebox Infrastructure — Implementation Plan

**Status:** Implemented v3 — All phases complete
**Scope:** Complete the Infrastructure layer so the measured base is self-defending, unify succession with backup/restore, integrate Safecloud for recovery and distribution, then test and update documentation.

## Architecture Overview

Two layers of Node.js, with PHP between them:

**Layer 0: Infrastructure base (this repo, measured image)**
The Node.js system component runs on the host, outside any container. It is the first thing that starts after boot and the last thing running before shutdown. It manages container lifecycle, handles attestation, does HMAC auth over Unix domain sockets, controls the model supply chain, and (after this plan) verifies OCP governance claims and manages succession.

Files: `server.js`, `auth.js`, `sockets.js`, `secret.js`, `opsContainers.js`, `opsModels.js`, `opsSystem.js`, `nsmClient.js`, `config.js`.

**Layer 1: Application (Qbix + Safebox plugin, inside containers)**
PHP (Qbix Streams) is the application server — user management, governance voting, the M-of-N flow, audit trails, community data. The Safebox plugin's Node.js (Protocol.js, the sandbox runner, Keychain.js) runs alongside PHP inside the same container as an orchestrator — it calls `sendToPHP` for governance, runs tools in V8 sandboxes, and talks to the base via the Unix domain socket with HMAC auth.

The split: PHP handles human-facing things (voting, policy, UI). Node.js handles machine-facing things (tool execution, model calls, credential resolution). The base (Layer 0) handles infrastructure (containers, volumes, attestation, succession).

**Capabilities and protocols** use OCP claims with keys that may be split between two safeboxes (requestor and executor). The requestor's Safebox signs the request, the executor's Safebox verifies the chain. ECIES (P-256 ECDH + AES-256-GCM) encrypts credentials browser-to-executor so the requestor's PHP never sees plaintext.

**Runner types** supported at the base layer: Python (vLLM, SGLab, GGUF), Node.js (U-Omni, embedding), and eventually U language runners. The base doesn't care what language a runner uses — it manages the container, the volume, and the Unix socket. A U runner is just another container type with its own volume.

## What Works Now vs What Needs to Be Added

| Component | Status | Where |
|---|---|---|
| HMAC-SHA256 request auth | ✅ Implemented | `auth.js` |
| Per-container HMAC key derivation | ✅ Implemented | `secret.js` |
| Master secret three-tier fallback | ✅ Implemented | `secret.js` |
| Unix domain socket management | ✅ Implemented | `sockets.js` |
| Container lifecycle | ✅ Implemented | `opsContainers.js` |
| Model supply chain (manifest hash, multi-source download, per-file SHA-256) | ✅ Implemented | `opsModels.js` |
| System tool invocation (8 tools) | ✅ Implemented | `opsSystem.js` |
| NSM attestation client | ✅ Implemented | `nsmClient.js` |
| CBOR encode/decode | ✅ Implemented | `cborDecode.js` |
| SSH removal / hardening | ✅ Implemented | `install-base.sh` |
| Cross-cloud bootstrap (bring-your-own VM) | ❌ Removed for 1.0 | `docs/future/bootstrap-safebox.sh.txt`; registration requires a TPM quote matching a blessed image |
| M-of-N governance (voting, threshold, audit) | ✅ Implemented | Safebox plugin (PHP) |
| OCP verification (ES256, RFC 8785, multi-sig) | ✅ Implemented | Safebox plugin (JS) |
| Credential ECIES encryption | ✅ Implemented | Safebox plugin (JS) |
| Privileged process split | ✅ Implemented | Safebox plugin (Node.js) |
| **OCP verification in the base** | ✅ Implemented | `ocpVerify.js` (Phase 0) |
| **Governance gate on privileged operations** | ✅ Implemented | `server.js` governance gate (Phase 0) |
| **Governance key registry in base** | ✅ Implemented | `governanceKeys.js` (Phase 0) |
| **Generalized volume loader** | ✅ Implemented | `opsVolumes.js` (Phase 1) |
| **Volume blessing (M-of-N)** | ✅ Implemented | `opsVolumes.js` (Phase 1) |
| **Instance identity (self-generated keypair)** | ✅ Implemented | `instanceIdentity.js` (Phase 2) |
| **Attestation claim issuance** | ✅ Implemented | `instanceIdentity.js` (Phase 2) |
| **Transparency log** | ✅ Implemented | `transparency.js` (Phase 2) |
| **Succession / restore** | ✅ Implemented | `succession.js` (Phase 3) |
| **Pre-positioned failover escrow** | ✅ Implemented | `succession.js` (Phase 3) |
| **Governance recovery (Shamir)** | ✅ Implemented | `shamirSplit.js` + `succession.js` (Phase 3) |
| **Safecloud image distribution** | ✅ Implemented | `imageDistribution.js` (Phase 4) |
| **Nix build system** | ✅ Implemented | `flake.nix`, `nix/base.nix` (Phase 5) |
| **Delegation claims** | ✅ Implemented | `delegation.js` (Phase 6) |
| **App-level continuity contract** | ✅ Documented | `docs/APP-CONTINUITY.md` (Phase 7) |
| **Integration tests** | ✅ Implemented | `testIntegration.js` (Phase 8) |
| **Adversarial tests** | ✅ Implemented | `testAdversarial.js` (Phase 8) |
| **Documentation** | ✅ Implemented | `docs/OCP-IN-BASE.md`, `docs/VOLUME-LOADING.md`, `docs/SUCCESSION.md`, `docs/IMAGE-DISTRIBUTION.md`, `docs/TRANSPARENCY.md` (Phase 9) |

## Phase 0: OCP Verification in the Base

**Why first:** Everything else is an OCP claim. Succession is a claim. Volume blessing is a claim. Container creation governance is a claim. Without this, nothing below is enforceable at the base layer.

### 0.1 Port OCP verification to the Infrastructure repo

The Safebox plugin has `Q.Crypto.OpenClaim.js` (263 lines) doing ES256 verification, RFC 8785 canonicalization, and multi-signer support. Port the verification-only subset:

- `canonicalize(claim)` — RFC 8785 JSON Canonicalization Scheme
- `verify(claim)` — verify each `sig[i]` against `key[i]` using ES256 (P-256 + SHA-256), Node.js `crypto.verify` with `spki` format keys
- `verifyThreshold(claim, minSigners, trustedKeys)` — at least `minSigners` distinct valid signatures from keys in the `trustedKeys` set
- No signing capability in the base — the base verifies, never signs on behalf of governance

**Files:**
- `aws/scripts/components/system/ocpVerify.js` (~150 lines)
- `aws/scripts/components/system/testOcpVerify.js`

**Test vectors from the PHP implementation:**
- 2 valid approvals with threshold 2 → pass
- 1 approval with threshold 2 → reject
- Duplicate signer (same key, two signatures) → count as 1
- Expired claim (exp < now) → reject
- Tampered canonical form → signature fails

### 0.2 Add governance gate to server.js

Currently `server.js` line 258 does HMAC verification then routes directly. Insert a governance check for privileged operations:

```
HMAC auth → OCP claim extraction → threshold verification → route
```

The request body gains an `ocpClaim` field. The system component extracts it, verifies signatures against the trusted-keys registry, counts distinct valid signers, compares against per-operation threshold from `container-registry.json`, verifies `stm.sha256` matches the SHA-256 of the operation being requested, checks `nbf <= now <= exp`, then routes.

**HMAC-only (no governance required):**
- `GET /healthz` — read-only status
- `GET /containers` — list (read-only)
- `GET /test/...` — test status queries
- `/embed` — inference requests from containers (already scoped by per-container HMAC)
- `GET /attestation` — public (no auth at all)

**Governance required:**
- `POST /system` — all tool invocations (dnf, docker exec, git, migrate, zfs-*)
- `POST /containers/create` — trust surface expansion
- `POST /containers/destroy` — trust surface modification
- `POST /models/install` — supply chain operation
- `POST /volumes/install` — volume mounting (Phase 1)
- `POST /succession/*` — succession operations (Phase 3)

### 0.3 Trusted-keys registry in the base

**File:** `/etc/safebox/governance-keys.json`
```json
{
  "version": 1,
  "keys": {
    "alice-admin": {
      "publicKey": "data:key/es256;base64,MFkwEwYHKo...",
      "roles": ["admin"],
      "addedBy": "genesis",
      "addedAt": "2026-01-15T00:00:00Z"
    }
  },
  "thresholds": {
    "system": { "m": 3, "n": 5 },
    "containers/create": { "m": 4, "n": 5 },
    "containers/destroy": { "m": 4, "n": 5 },
    "models/install": { "m": 2, "n": 3 },
    "volumes/install": { "m": 2, "n": 3 },
    "succession/initiate": { "m": 4, "n": 5 }
  }
}
```

**Bootstrap:** The genesis key set is baked into the base image at build time. Part of the measured image hash. Changing governance keys requires a new blessed image (correct — changing who controls the base IS a new base).

**Runtime key rotation:** A rotation is itself an OCP claim signed by M-of-N of the current key set. The base verifies this against the current key set before applying. The exponential backoff for key rotation churn (designed in INFRASTRUCTURE-SPEC.md) applies.

**Files:**
- `aws/scripts/components/system/governanceKeys.js` — load, validate, hot-reload on SIGHUP, apply rotation claims (~200 lines)
- `config/governance-keys.json` — genesis key set (build-time)

## Phase 1: Volume Loader

### 1.1 Generalize opsModels.js into opsVolumes.js

`opsModels.js` already does manifest-hash verification, multi-source download, per-file SHA-256, and atomic staging. Generalize it:

- A volume is a directory of files with a manifest: `{ files: { "path": "sha256:...", ... }, meta: { type, version, ... } }`
- The manifest hash (SHA-256 of RFC 8785 canonical JSON) is the volume's identity
- Volume types: `model`, `app`, `config`, `plugin`, `runner` — the loader doesn't care, it verifies files against the manifest
- Mount point determined by volume type, declared in the manifest
- Volumes are read-only after verification (bind-mount with `:ro`)
- U language runners are a volume type like any other — the base mounts the runner binary, the container runs it

### 1.2 M-of-N blessing for volumes

Before a volume can be mounted, its manifest hash must be blessed by M-of-N governance signers via OCP:

```
1. Governance signers review the volume contents
2. Each signer signs an OCP claim: "I approve manifest hash X for volume type Y"
3. Claims collected (can be sequential — OCP supports this)
4. POST /volumes/install { manifest, ocpClaim, sources }
5. Base verifies: OCP claim valid, M-of-N threshold met, claim.stm.sha256 matches manifest hash
6. Base downloads files from sources, verifies each against manifest
7. Atomic staging → final path
8. Bind-mount read-only into target container
```

**Sources** can be: HTTPS URLs (S3, CDN, GitHub Releases), Safecloud CIDs (Phase 4), or local paths (for dev/testing).

### 1.3 Volume registry

The base maintains: `/etc/safebox/volume-registry.json`

```json
{
  "volumes": {
    "sha256:abc123...": {
      "type": "model",
      "name": "qwen-3.6-27b",
      "mountPath": "/srv/safebox/models/qwen-3.6-27b",
      "installedAt": "2026-04-23T...",
      "blessingClaim": { "ocp": 1, "..." : "..." },
      "files": 42,
      "totalBytes": 27000000000
    }
  }
}
```

**Files:**
- `aws/scripts/components/system/opsVolumes.js` — generalized from opsModels.js (~600 lines)
- `aws/scripts/components/system/testOpsVolumes.js`
- Keep `opsModels.js` as a thin wrapper that delegates to opsVolumes for backward compat

## Phase 2: Instance Identity and Transparency

### 2.1 Self-generated instance identity

On first boot, generate a P-256 keypair inside encrypted memory. The private key lives only in RAM (never written to disk, same as masterSecret). The public key IS the instance identity. Attestation binds the public key to hardware measurement (PCR0 + PCR1 + PCR4).

### 2.2 Instance attestation claim

On boot, after ZFS unseal, the base issues an OCP claim:

```json
{
  "ocp": 1,
  "iss": "safebox://<instancePublicKeyHash>",
  "stm": {
    "type": "attestation",
    "instancePublicKey": "<SPKI base64>",
    "measurement": "<PCR0 hex>",
    "cloud": "aws",
    "hardwareRoot": "nitrotpm",
    "parentInstance": "<PCR4-derived>",
    "imageHash": "<blessed image hash>"
  },
  "nbf": "<boot_time>",
  "exp": "<boot_time + 86400>"
}
```

Signed with the instance's private key. Renewed daily.

### 2.3 Attestation and transparency endpoints

- `GET /attestation` — returns the current attestation claim (public, no auth)
- `POST /attestation/challenge` — accepts a nonce, returns attestation claim + signature over the nonce (proves liveness)
- `GET /transparency` — returns the succession chain (all predecessors' attestation claims, chronological), governance key rotation history, and volume blessing log

The transparency endpoint is the base's contribution to the Safebox registry. `safebox.org` aggregates these into a global transparency log.

**Files:**
- `aws/scripts/components/system/instanceIdentity.js` — keypair generation, claim issuance, challenge-response (~250 lines)
- `aws/scripts/components/system/transparency.js` — succession chain, key rotation log, volume log (~200 lines)
- `aws/scripts/components/system/testInstanceIdentity.js`

## Phase 3: Succession and Recovery (Unified)

Succession, failover, and disaster recovery are the same operation: a new safebox boots, attests, proves it's running a blessed image, and receives the master secret. What varies is the source of the master secret.

### 3.1 The three recovery paths

**Path A — Online predecessor (planned upgrade, migration):**
1. Governance signs an OCP claim blessing the new image hash
2. New instance boots with the blessed image, generates ephemeral keypair, attests
3. New instance presents attestation to predecessor via Safenet or localhost
4. Predecessor verifies: attestation chains to hardware root, PCR0 matches blessed hash
5. Predecessor ECIES-encrypts master secret to successor's ephemeral public key
6. Predecessor signs succession claim, governance co-signs (M-of-N)
7. Predecessor writes encrypted blob to shared ZFS volume, destroys own key material
8. Successor decrypts, re-derives per-container keys, issues own attestation claim naming predecessor

**Path B — Pre-positioned failover (predecessor dead, failover alive):**
During normal operation, the primary continuously pre-authorizes the failover. Every N minutes (configurable, default 15), the primary:
1. Reads the failover's current attestation claim (the failover is a live attested safebox)
2. ECIES-encrypts the current master secret to the failover's attested public key
3. Signs a conditional succession claim: "if I am unreachable for T minutes, failover X may succeed me"
4. Writes the encrypted blob + signed claim to the shared ZFS volume (which the failover receives via ZFS send/receive)

The failover checks for the primary's liveness. If the primary is unreachable for T minutes (configurable, default 30):
1. Failover promotes its ZFS dataset to read-write
2. Decrypts the pre-positioned master secret blob using its own private key
3. Re-derives per-container keys
4. Issues its own attestation claim, referencing the conditional succession claim
5. Notifies governance signers (they can revoke if the promotion was premature)

No ceremony needed at failover time. The handoff was done in advance.

**Path C — Disaster recovery (everything gone, Safecloud restore):**
The governance signers hold Shamir shares of a recovery key, generated at provisioning time and split M-of-N. When both primary and failover are gone:
1. A new safebox boots with a blessed image, attests
2. M-of-N governance signers each contribute their Shamir share
3. The recovery key is reconstructed inside the new safebox's encrypted memory
4. The recovery key derives the master secret (HKDF with a fixed info string)
5. The safebox pulls encrypted ZFS snapshots from Safecloud (tier 3 archive)
6. Decrypts using the recovered master secret, mounts, resumes

**Optional Path D — Solo operator escape hatch:**
At provisioning time, the operator may generate a recovery seed (256-bit random, displayed as BIP39 mnemonic). The recovery seed can derive the master secret the same way as Path C. This is for solo operators who ARE the governance quorum, or as a last resort.

### 3.2 PCR4 tension — resolved by all three paths

PCR4 binds the master key to a specific EC2 instance (anti-copy defense). Succession requires a new instance with a different PCR4. All three recovery paths resolve this the same way: the master secret is transferred via ECIES to the new instance's ephemeral key, bypassing PCR4 derivation. The successor can optionally re-seal to its own PCR4 by running a new HKDF derivation and storing the result at `/etc/safebox/system.hmac`.

### 3.3 Succession claim format

```json
{
  "ocp": 1,
  "iss": "safebox://<current_instance_pubkey_hash>",
  "stm": {
    "type": "succession",
    "predecessor": "<current instance pubkey>",
    "predecessorChain": ["<grandparent>", "<parent>", "<current>"],
    "successorImageHash": "<expected PCR0 of successor>",
    "successorRequirements": {
      "hardwareRoot": ["nitrotpm", "sev-snp"],
      "minGovernanceSigners": 3
    },
    "secretTransfer": {
      "method": "ecies-p256",
      "recipientKey": "<successor's ephemeral public key>"
    },
    "reason": "scheduled_upgrade | failover | disaster_recovery",
    "conditional": false
  }
}
```

For Path B, `conditional` is `true` and an additional `conditionTimeout` field specifies the liveness timeout.

### 3.4 Safecloud archive (tier 3)

During normal operation, the primary periodically archives encrypted ZFS snapshots to Safecloud:

1. Take a coordinated flush-and-snapshot (patent §4.13.1)
2. Chunk the snapshot using Safecloud's N-ary Merkle tree
3. Encrypt chunks using HKDF-derived keys from the master secret (the Safecloud HKDF tree structure — per-subtree keys, granular access)
4. Distribute encrypted chunks to Drops via Jets
5. Record the Merkle root in the volume registry

The HKDF tree enables granular access: the primary can grant the failover access to the full tree, or grant a specific community access to only their dataset subtree. For disaster recovery, the recovery key (from Path C or D) is the root that unlocks the full tree.

Media files (images, videos, documents) don't need to be in ZFS snapshots — they already live on Drops, addressable by Merkle root stored in the database. Only the database + config + app state need archiving.

### 3.5 Nix integration with succession

In a Nix world, every base update IS a succession:
- `nix build` produces a new image with a deterministic hash = known PCR0
- Governance signs an OCP claim blessing that hash
- The current instance pre-authorizes that hash as its successor's measurement
- New instance boots, attests (PCR0 matches the blessed hash), takes over via Path A
- No "in-place upgrade" — every update is a clean succession

For dnf-based images: the same succession ceremony applies, but the PCR0 is measured empirically rather than predicted from the build. Governance blesses the specific AMI hash after inspection.

**Files:**
- `aws/scripts/components/system/succession.js` — succession claim creation/verification, ECIES secret transfer, pre-positioned failover escrow, recovery key handling (~500 lines)
- `aws/scripts/components/system/testSuccession.js`
- `aws/scripts/components/system/shamirSplit.js` — Shamir secret sharing over GF(256) for governance recovery (~150 lines)

## Phase 4: Image Distribution

### 4.1 Three distribution channels, one truth

```
Source of truth (Nix derivation OR dnf build)
  → nix build / packer build → raw .img file (hashable, inspectable)
    → aws ec2 import-image → AMI (convenient for AWS)
    → gcloud compute images import → GCP image
    → az image create → Azure image
    → Safecloud chunking → distributed across Drops (decentralized, no egress cost)
```

All four channels serve the same bits. The image's SHA-256 matches the blessed governance claim.

### 4.2 AMI (current path, AWS-specific)

The three-AMI pipeline stays: AMI 1 (package cache) → AMI 2 (complete, SSH on) → AMI 3 (immutable, SSH removed, measured). Production path for AWS.

### 4.3 Raw filesystem images

Publishing the exact filesystem as `.tar.xz` or `.img`:

- Full inspectability: download, mount read-only, audit every byte
- Cross-cloud: same image works on GCP, Azure, OCI, bare metal
- Hash verifiability: `sha256sum safebox-base-v1.2.3.img` matches blessed PCR0
- **Costs:** S3 storage ~$0.023/GB/month, egress ~$0.09/GB. A 110GB image costs ~$2.50/month to store, ~$10/download. Modest.

### 4.4 Safecloud image distribution (BitTorrent-style)

The base image is open source — no encryption needed for the image itself. The image is chunked into Safecloud's Merkle tree structure and distributed across Drops.

**How it works:**
1. The image is chunked (fixed-size, same as Safecloud file chunking)
2. Each chunk gets a CID: `SHA-256(chunk_bytes)`
3. Chunks arrange into an N-ary Merkle tree; the root = image identity
4. Chunks are distributed to Drops via Jets; Drops earn Safebux for serving them
5. A downloading safebox (or any node) requests chunks from multiple Drops in parallel
6. Each chunk is verified against its CID; the tree is verified against the root
7. The root matches the blessed PCR0 — no additional verification needed

**Advantages over S3:**
- No egress costs — the network bears distribution cost via Safebux
- Parallel download from multiple Drops (BitTorrent-style multiplexing)
- No single point of failure for distribution
- Popular images (the standard base) will be on many Drops — high availability
- Self-verifying — the Merkle root IS the measurement

**Bootstrap concern:** A brand-new safebox needs to download the image to boot. For the very first boot, use AMI (AWS) or raw image (S3/CDN). Once a safebox is running, it can seed its own image to Drops and download successor images from the network.

**Costs:** Safebux paid to Drops for serving chunks. The cost is amortized across all downloaders. Much cheaper than S3 egress at scale.

### 4.5 Implementation

Image distribution is a build pipeline and CI concern, not base code:
- CI builds the image (Nix or Packer)
- CI publishes to S3/GitHub Releases with SHA-256
- CI imports to AMI, publishes AMI ID + region mapping
- CI chunks into Safecloud via a Jet (or a standalone uploader tool)
- Governance signs OCP claim over the image hash
- safebox.org publishes the claim

The **volume loader** (Phase 1) handles Safecloud as a download source — it already does multi-source download and per-chunk verification. Adding Safecloud CIDs as a source type is a small extension.

## Phase 5: Nix Build System

### 5.1 Current state

No Nix files exist. The base uses `dnf` with pinned versions in `install-base.sh`. The Node.js code runs on both Nix and dnf images unchanged.

### 5.2 Migration path

Layer Nix on top rather than rewriting overnight:

1. **Nix flake for the base image** — produces a NixOS image with the base components. Replaces AMI 1 → AMI 2 with a single `nix build`.
2. **Component Nix expressions** — each component becomes a Nix package. Composable: `nix build .#safebox-base-media-vision-embed-llm-medium`.
3. **Deterministic hash** — the Nix store hash is the image identity. PCR0 matches the Nix output hash.
4. **Pin everything** — `dnf` pins become `nixpkgs` pins. Exact reproducibility.

### 5.3 What changes in the Nix world

- `install-base.sh` becomes a Nix derivation
- SSH is never present (not installed then removed — just never in the closure)
- ZFS, Docker, Node.js are NixOS module configurations
- The system component is a NixOS systemd service

### 5.4 What stays the same

- The Node.js code (server.js, auth.js, everything in this plan) — unchanged
- The config files (managed-containers.json, container-registry.json, governance-keys.json) — unchanged
- The attestation pipeline — unchanged (Nix just makes the measurement predictable)
- Succession ceremony — unchanged (works the same whether the image was built by Nix or Packer)

### 5.5 Both build systems coexist

The repo ships both `install-base.sh` (dnf, current production) and `flake.nix` (Nix, target). The cutover happens when the Nix build produces an image that passes the same attestation and test suite. No flag day.

**Files:**
- `flake.nix` — top-level Nix flake
- `nix/base.nix` — base image derivation
- `nix/components/*.nix` — per-component expressions
- `nix/tests/` — NixOS VM tests

## Phase 6: Delegation and Cross-Safebox Federation

### 6.1 Delegation claims in the base

The `delegation` keyName in KeyManagement.php is reserved but not implemented. The Node.js base needs to verify delegation chains for cross-Safebox operations:

- Safebox A delegates to Safebox B for a specific scope (e.g., "run LLM.chat on my behalf")
- The delegation is an OCP claim signed by A's attested key
- B presents the delegation + its own attestation to the target (API provider, another Safebox)
- The target verifies: A's attestation → A's delegation → B's attestation → B's request

The base verifies delegation chains the same way it verifies governance claims — using `ocpVerify.js` from Phase 0. The delegation adds a chain-walking step: follow `stm.type === 'delegation'` claims back to a trusted root.

### 6.2 Scoped API access

Replace bearer API keys with OCP delegation chains for providers that support it. For providers that don't (most, today), the base verifies the delegation internally before releasing the API key from the credential vault.

**Files:**
- `aws/scripts/components/system/delegation.js` — delegation chain verification (~150 lines)
- Update `ocpVerify.js` with chain-walking support

## Phase 7: App-Level Continuity (Contract)

The base provides primitives; apps use them. This is a contract, not code.

**What the base guarantees across succession:**
- ZFS volumes survive — the successor mounts the same datasets
- Per-container HMAC keys are re-derived from the transferred master secret (same keys, new base)
- Attestation chain is published — apps can verify the succession chain

**What apps do themselves:**
- Generate their own keypair, store private key on their encrypted ZFS dataset
- Sign attestation claims binding their identity to the base's attestation chain
- Decide what "continuity" means for their domain (database state, sessions, cached models)
- Peers verify: app key + base attestation chain = trusted identity

**What the base does NOT do:**
- Manage app identities
- Coordinate app-level state migration
- Guarantee that an app is the "same" app — it guarantees the ZFS dataset and HMAC key are the same

**Files:**
- `docs/APP-CONTINUITY.md` — the contract between base and apps

## Phase 8: Testing

### 8.1 Unit tests (per module)

| Module | Tests | Priority |
|---|---|---|
| ocpVerify.js | Signature verification, threshold counting, expiry, tampering, edge cases from PHP test suite | P0 |
| governanceKeys.js | Load, validate, rotation claims, exponential backoff | P0 |
| opsVolumes.js | Manifest verification, download, atomic staging, blessing verification, Safecloud source | P0 |
| instanceIdentity.js | Keypair generation, claim issuance, challenge-response | P1 |
| succession.js | Claim creation, ECIES encryption, pre-positioned escrow, Shamir split/reconstruct, ceremony steps | P1 |
| shamirSplit.js | Split, reconstruct, threshold edge cases, tampered shares | P1 |
| delegation.js | Chain verification, scope checking, expiry propagation | P2 |

### 8.2 Integration tests

- **Governance round-trip:** PHP signs OCP claim → forwards to Node.js system → system verifies independently → executes
- **Volume install end-to-end:** Create manifest → governance signs blessing → POST /volumes/install → verify files on disk → verify read-only mount
- **Succession ceremony (Path A):** Mock two instances, run the full ceremony, verify secret transfer and attestation chain
- **Pre-positioned failover (Path B):** Mock primary writing escrow, primary dies, failover promotes, verify secret recovery
- **Disaster recovery (Path C):** Mock Shamir reconstruction, verify master secret recovery, verify Safecloud snapshot pull
- **Denial tests:** Invalid claims rejected, insufficient signers rejected, expired claims rejected, tampered claims rejected

### 8.3 Adversarial tests

- Valid HMAC but no OCP claim → rejected (regression: this works today, must break after Phase 0)
- Valid HMAC + forged OCP claim → rejected
- Valid HMAC + valid OCP claim with insufficient signers → rejected
- Valid HMAC + valid OCP claim for wrong operation → rejected (stm.sha256 mismatch)
- Replay expired OCP claim → rejected
- OCP claim signed by removed governance key → rejected
- Fork attempt: two safeboxes claiming same identity → detected via transparency log
- Pre-positioned failover blob replayed after primary recovers → rejected (primary revokes conditional succession)

## Phase 9: Documentation

### 9.1 Files to update

- **README.md** — architecture section reflecting OCP verification in the base
- **GOVERNANCE-INTEGRATION.md** — replace pseudocode with references to implemented code
- **INFRASTRUCTURE-SPEC.md** — update to match implemented vs designed
- **SAFEBOX-IMPLEMENTATION.md** — protocol flow including base-layer OCP verification

### 9.2 Files to create

- **docs/OCP-IN-BASE.md** — OCP verification at the infrastructure level
- **docs/VOLUME-LOADING.md** — generalized volume loader, blessing flow, registry, Safecloud source
- **docs/SUCCESSION.md** — unified succession/failover/recovery protocol, three paths, security properties
- **docs/APP-CONTINUITY.md** — contract between base and apps
- **docs/IMAGE-DISTRIBUTION.md** — AMI vs raw image vs Safecloud vs Nix, verification steps
- **docs/TRANSPARENCY.md** — succession chain, governance log, volume log

### 9.3 Documentation accuracy audit

Go through every `.md` in the repo and mark each claim as:
- ✅ Implemented and matches code
- ⚠️ Designed but not yet implemented (with phase reference)
- ❌ Inaccurate (with correction)
- 🗑️ Obsolete (with replacement reference)

## Implementation Order

```
Phase 0 (OCP in base) ──────────────────────── Week 1-2
  0.1 Port OCP verification
  0.2 Add governance gate to server.js
  0.3 Trusted-keys registry
     │
     ├── Phase 1 (Volume loader) ──────────── Week 2-3
     │     1.1 Generalize opsModels → opsVolumes
     │     1.2 M-of-N blessing for volumes
     │     1.3 Volume registry
     │
     ├── Phase 2 (Instance identity) ──────── Week 2-3
     │     2.1 Self-generated identity
     │     2.2 Attestation claim
     │     2.3 Transparency endpoints
     │
     └── Phase 3 (Succession/Recovery) ────── Week 3-5
           3.1 Three recovery paths
           3.2 ECIES secret transfer
           3.3 Pre-positioned failover escrow
           3.4 Shamir governance recovery
           3.5 Safecloud archive integration
           3.6 Nix integration
              │
Phase 4 (Image distribution) ─────────────── Week 3-4 (parallel)
  4.1 Raw filesystem image pipeline
  4.2 Safecloud image distribution
Phase 5 (Nix build) ──────────────────────── Week 4-8 (parallel)
Phase 6 (Delegation) ─────────────────────── Week 5-6
Phase 7 (App continuity docs) ────────────── Week 5
Phase 8 (Testing) ─────────────────────────── Continuous
Phase 9 (Documentation) ──────────────────── Week 6-7
```

Phases 1 and 2 run in parallel after Phase 0. Phase 3 depends on Phase 2 (needs instance identity). Phases 4 and 5 are parallel workstreams. Phase 6 depends on Phase 0. Phase 8 is continuous.

## Open Questions

1. **Governance key bootstrap:** Are the infrastructure governance keys the same as the Safebox plugin's M-of-N keys, or a separate set? The plugin uses per-community signing keys derived from HKDF. The infrastructure layer probably needs a fixed set baked into the image — the "infrastructure auditors" who bless images and approve succession, distinct from per-community governance signers.

2. **EIP712 in the base:** Should the base verify EIP712 (Ethereum typed data) signatures alongside ES256? EIP712 support would let governance signers use hardware wallets (Ledger, Trezor). The Safebox plugin already supports both.

3. **Shamir share distribution:** How are the governance recovery shares distributed? Each signer stores their share in their own Safebox? On a hardware wallet? Printed and in a safe? The answer might be "all of the above, operator's choice."

4. **Cross-cloud succession:** Can an AWS Safebox bless a GCP successor? The attestation hardware roots differ (NitroTPM vs SEV-SNP vs TDX). The succession claim format accommodates this, but verification requires understanding multiple attestation formats.

5. **Safecloud archive frequency:** How often should ZFS snapshots be pushed to Safecloud? Every hour? Every day? Configurable per-community? The answer affects recovery point objective (RPO) — how much data you lose in a disaster.

6. **Conditional succession revocation:** When the primary comes back after a failover promoted, what happens? The primary should detect that its conditional succession was exercised and shut down (it no longer holds the identity). The transparency log records which instance is current.
