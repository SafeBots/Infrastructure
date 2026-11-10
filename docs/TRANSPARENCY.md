# Transparency Log and Instance Identity

## Instance Identity

### Ephemeral P-256 Keypair

On first boot, the base generates a P-256 (secp256r1) keypair using `crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`. The private key lives only in RAM -- it is stored in a module-scoped variable in `instanceIdentity.js`, never written to disk, never serialized, never exported. When the process exits, the private key is gone.

The public key IS the instance identity. It is exported in SPKI (SubjectPublicKeyInfo) format, the same format used for governance keys in `governance-keys.json` and for signer keys in OCP claims. The public key's SHA-256 hash serves as the instance's short identifier:

```
instanceId = SHA-256(SPKI-encoded public key bytes)
```

This identifier appears in attestation claims, succession chains, and transparency log entries as `safebox://<instanceId hex>`.

### Why Ephemeral

The keypair is ephemeral by design. A safebox that reboots generates a new identity. This is correct because:

- A reboot may indicate a compromise. A fresh identity forces re-attestation rather than silently resuming with a potentially compromised key.
- The private key in RAM cannot be extracted by an attacker who gains disk access but not memory access (the threat model for encrypted-at-rest volumes).
- Succession already handles identity continuity -- the successor's identity is linked to the predecessor's by the succession chain, not by key reuse.

The identity survives across the process lifetime (the system component is a long-running Node.js process managed by systemd) but not across reboots. A restart of the Node.js process (e.g., due to a crash or SIGHUP reload) generates a new keypair and issues a new attestation claim.

### Relationship to Master Secret

The instance identity keypair is independent of the master secret (`secret.js`). The master secret is derived from hardware attestation (PCR0 + PCR1 + PCR4 via HKDF) and is deterministic -- the same hardware with the same image produces the same master secret. The instance identity is random -- every boot produces a different keypair.

The master secret authenticates containers (HMAC keys derived from it). The instance identity authenticates the base itself to the outside world (attestation claims signed with it). They serve different purposes and are never mixed.

## Attestation Claims

### Boot-Time Attestation

After the system component starts, loads the master secret, and unseals ZFS, it issues a self-signed OCP claim:

```json
{
  "ocp": 1,
  "iss": "safebox://a1b2c3d4e5f6...",
  "stm": {
    "type": "attestation",
    "instancePublicKey": "data:key/es256;base64,MFkwEwYHKo...",
    "measurement": "0xaabb...48-byte-PCR0-hex",
    "cloud": "aws",
    "hardwareRoot": "nitrotpm",
    "parentInstance": "0xccdd...PCR4-derived-hex",
    "imageHash": "sha256:eeff..."
  },
  "nbf": "2026-04-23T14:00:00.000Z",
  "exp": "2026-04-24T14:00:00.000Z"
}
```

The claim is signed with the instance's ephemeral private key using ES256 (ECDSA P-256 + SHA-256), the same algorithm used by governance signers. The claim asserts:

- **`instancePublicKey`**: This is my public key. Anyone can verify my signatures with it.
- **`measurement`**: My PCR0 value. This is the hash of the filesystem image running on this host. It was measured by the Nitro hypervisor, verified by `nsmClient.js` against the AWS root certificate.
- **`cloud`**: Which cloud provider's attestation hardware I am using.
- **`hardwareRoot`**: The type of hardware root of trust (`nitrotpm` for AWS Nitro, `sev-snp` for AMD SEV-SNP, `tdx` for Intel TDX).
- **`parentInstance`**: Derived from PCR4, which encodes the EC2 instance identity. This binds the attestation to a specific physical (virtual) machine.
- **`imageHash`**: The blessed image hash from the governance claim that authorized this image. Allows verifiers to check that the running image was governance-approved.

### Claim Renewal

The attestation claim has a 24-hour validity window (`nbf` to `exp`). The system component renews it daily by generating a fresh claim with updated timestamps. The old claim is kept in the transparency log; the new claim becomes the current attestation.

If the Nitro attestation document changes (e.g., the leaf certificate rotates, which happens every few hours), the PCR values remain stable (they are tied to the image, not the certificate). The attestation claim's `measurement` field stays the same until the image changes.

### Challenge-Response

The `POST /attestation/challenge` endpoint accepts a nonce from a verifier and returns:

1. The current attestation claim
2. A signature over `SHA-256(nonce || attestation_claim_canonical)` using the instance's private key

This proves liveness -- the instance is running right now, not replaying a cached attestation. The nonce prevents replay: a verifier generates a fresh random nonce for each challenge, and the response is only valid for that nonce.

The challenge-response flow:

```
Verifier                          Safebox Base
   |                                    |
   |--- POST /attestation/challenge --->|
   |    { "nonce": "random-hex" }       |
   |                                    |
   |<-- 200 OK -------------------------|
   |    { "claim": {...},               |
   |      "challengeSignature": "..." } |
   |                                    |
   Verify:                              |
   1. claim.key[0] matches instancePublicKey
   2. claim signature is valid (ES256)
   3. challengeSignature over nonce+claim is valid
   4. claim.stm.measurement matches blessed PCR0
   5. claim has not expired (nbf <= now <= exp)
```

No authentication is required for the challenge endpoint. Attestation is public -- anyone can verify that this safebox is running a blessed image on genuine hardware. The HMAC layer protects privileged operations; attestation protects identity.

## The Transparency Log

### File: `/var/lib/safebox/transparency/transparency.json`

The transparency log is an append-only JSON file maintained by the base. It records three types of events: succession chain entries, governance key rotation events, and volume blessing events. Each entry is timestamped and includes the relevant OCP claim.

```json
{
  "version": 1,
  "instanceId": "a1b2c3d4e5f6...",
  "entries": [
    {
      "seq": 1,
      "type": "attestation",
      "timestamp": "2026-04-23T14:00:00.000Z",
      "claim": { "ocp": 1, "iss": "safebox://...", "stm": {...}, "key": [...], "sig": [...] }
    },
    {
      "seq": 2,
      "type": "succession",
      "timestamp": "2026-04-23T14:05:00.000Z",
      "claim": { "ocp": 1, "stm": { "type": "succession", "predecessor": "...", ... } }
    },
    {
      "seq": 3,
      "type": "keyRotation",
      "timestamp": "2026-04-23T15:00:00.000Z",
      "claim": { "ocp": 1, "stm": { "type": "keyRotation", "action": "addKey", ... } }
    },
    {
      "seq": 4,
      "type": "volumeBlessing",
      "timestamp": "2026-04-23T16:00:00.000Z",
      "claim": { "ocp": 1, "stm": { "type": "volumeBlessing", "manifestHash": "sha256:...", ... } }
    }
  ]
}
```

### Append-Only Semantics

The log is append-only. Entries are never modified or deleted. Each entry has a monotonically increasing sequence number (`seq`). The `transparency.js` module enforces this:

- New entries are appended to the `entries` array
- The `seq` value of a new entry must be exactly `last_seq + 1`
- The file is written atomically (write to temp, rename) after each append
- On startup, the module reads the existing log and validates sequence continuity

If an attacker modifies or deletes entries, the sequence gap is detectable by any verifier who previously read the log. This is the same principle as certificate transparency logs -- you cannot silently rewrite history if anyone has a copy of the previous state.

### Three Log Types

#### Succession Chain

Every attestation claim and succession claim is logged. The succession chain records the full lineage of the instance:

```
Instance A boots, attests (seq 1)
Instance A issues succession claim to B (seq 2)
Instance B boots, attests, references A as predecessor (seq 3)
Instance B issues succession claim to C (seq 4)
Instance C boots, attests, references B as predecessor (seq 5)
```

A verifier can walk the chain from the current instance back to the genesis instance. Each link is cryptographically signed: the predecessor signed the succession claim, and the successor's attestation references the predecessor. A gap or fork in the chain indicates either a disaster recovery (Path C, documented in the succession claim) or an attack.

#### Governance Key Rotation

Every key rotation event is logged with the complete OCP claim that authorized the rotation. This provides an audit trail:

- Who was added or removed
- Which governance signers approved the rotation (the claim's `key[]` and `sig[]` arrays)
- When the rotation happened
- The version number before and after

An auditor can reconstruct the full governance key set at any point in time by replaying the rotation events from the genesis key set. If the current `governance-keys.json` does not match the result of replaying the log, something is wrong.

#### Volume Blessings

Every volume installation is logged with the blessing claim. This records:

- Which volumes were installed (manifest hash, volume type, volume name)
- Which governance signers blessed the installation
- When the installation happened

An auditor can verify that every installed volume was properly blessed -- the volume registry (`/var/lib/safebox/volumes/volume-registry.json`) should contain exactly the volumes that appear in the transparency log as blessed, and no others.

## Public Endpoints

### `GET /attestation`

Returns the current attestation claim. No authentication required. This is a public endpoint -- anyone can read the safebox's attestation to verify it is running a blessed image on genuine hardware.

Response:

```json
{
  "status": "ok",
  "data": {
    "claim": {
      "ocp": 1,
      "iss": "safebox://a1b2c3d4...",
      "stm": {
        "type": "attestation",
        "instancePublicKey": "data:key/es256;base64,...",
        "measurement": "0xaabb...",
        "cloud": "aws",
        "hardwareRoot": "nitrotpm"
      },
      "nbf": "2026-04-23T14:00:00.000Z",
      "exp": "2026-04-24T14:00:00.000Z",
      "key": ["data:key/es256;base64,..."],
      "sig": ["base64..."]
    }
  }
}
```

### `POST /attestation/challenge`

Accepts a nonce, returns the attestation claim plus a signature over the nonce. No authentication required. Proves liveness.

Request:

```json
{
  "nonce": "a1b2c3d4e5f6..."
}
```

Response:

```json
{
  "status": "ok",
  "data": {
    "claim": { ... },
    "challengeSignature": "base64..."
  }
}
```

The `challengeSignature` is `ES256(SHA-256(nonce_bytes || canonical_claim_bytes))` using the instance's private key. The verifier checks that the signing key matches `claim.stm.instancePublicKey`.

### `GET /transparency`

Returns the transparency log. No authentication required. This is the base's contribution to the public audit trail.

Response:

```json
{
  "status": "ok",
  "data": {
    "instanceId": "a1b2c3d4...",
    "entries": [ ... ],
    "totalEntries": 42
  }
}
```

For large logs, the endpoint supports pagination via `?after=<seq>` to return entries after a given sequence number, and `?limit=<n>` to limit the number of entries returned.

## safebox.org Aggregation

The `safebox.org` registry aggregates transparency logs from all known safeboxes into a global view. Each safebox periodically pushes its transparency log to the registry (or the registry pulls via `GET /transparency`).

### What safebox.org Provides

- **Global succession chain.** The registry knows every safebox's lineage. If two safeboxes claim the same predecessor (a fork), the registry detects it.
- **Governance audit.** The registry can verify that every governance key rotation across all safeboxes follows the proper M-of-N threshold, the exponential backoff for key rotation churn is respected, and no safebox has silently added unauthorized keys.
- **Volume provenance.** The registry can verify that every installed volume was blessed by governance, and that the same manifest hash produces the same volume across all safeboxes that install it.
- **Liveness monitoring.** If a safebox's attestation claim expires and no renewal appears, the registry can flag it as potentially offline or compromised.

### Fork Detection

A fork occurs when two safeboxes both claim to be the current instance in a succession chain. This can happen if:

1. A failover promotes (Path B) while the primary is still alive (network partition, not actual failure)
2. An attacker clones a disk image and boots it on a different machine
3. A disaster recovery (Path C) creates a new instance while the old one is still running

The transparency log detects forks because:

- Each succession claim names its predecessor
- The predecessor's attestation claim includes a unique `instancePublicKey` (random ephemeral key)
- If two different instances name the same predecessor, and neither has a valid revocation from the predecessor, the registry flags a fork

Fork resolution is a governance decision. The signers inspect both instances' attestation claims, determine which is legitimate (e.g., the one whose PCR4 matches the expected hardware), and sign a revocation for the illegitimate one.

## Relationship to the Safebox Registry

The Safebox registry (managed by the Safebox plugin's PHP layer) tracks communities, users, governance policies, and application state. The transparency log at the infrastructure level tracks a different set of concerns:

| Concern | Safebox Registry (PHP) | Transparency Log (Base) |
|---|---|---|
| Scope | Per-community | Per-instance |
| Managed by | Application layer | Infrastructure base |
| Contents | Users, policies, votes, audit trails | Attestation, succession, key rotation, volumes |
| Authentication | User credentials (PHP sessions) | None (public endpoints) |
| Storage | Database (MySQL/PostgreSQL on ZFS) | Append-only JSON file |
| Aggregation | safebox.org pulls from each community | safebox.org pulls from each instance |

The two registries are complementary. The Safebox registry answers "what happened in this community?" The transparency log answers "is this infrastructure trustworthy?" A community member can verify that their safebox is running a blessed image (transparency log), that the image was approved by governance (governance key rotation log), and that the models loaded are the ones governance blessed (volume blessing log) -- all without trusting the application layer.

## Security Properties

**The base never signs governance claims.** The instance identity key signs attestation claims and challenge responses. It never signs governance claims, key rotation claims, or volume blessing claims. Those are signed by governance signers (humans or their hardware wallets) and verified by the base. The base is a verifier and an attester, never a governance authority.

**Attestation is hardware-bound.** The `measurement` field in the attestation claim comes from `nsmClient.js`, which verifies the Nitro attestation document's COSE_Sign1 signature against the pinned AWS root certificate (fingerprint `641a0321a3...`). A software-only attacker cannot forge a PCR0 value.

**The transparency log is tamper-evident, not tamper-proof.** An attacker with root access to the host can modify `transparency.json`. But any verifier who previously read the log will detect the modification (missing or changed entries). The safebox.org aggregator serves as a witness -- once an entry is aggregated, it cannot be silently removed from the global view.

**Challenge-response prevents replay.** A verifier who obtains a cached attestation claim cannot prove the instance is currently alive. The nonce-based challenge-response ensures that the response was generated after the challenge was issued.

**Ephemeral keys limit blast radius.** If an attacker extracts the instance's private key from memory, they can forge attestation claims and challenge responses -- but only until the process restarts and generates a new keypair. They cannot forge governance claims (different keys), they cannot derive HMAC secrets (different key material), and they cannot survive a reboot.
