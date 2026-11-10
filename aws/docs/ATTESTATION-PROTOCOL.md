# Attestation Protocol — v1.0

> Wire spec for `Safebox.Protocol.Attestation`. This is what Safecloud JS (and any other in-container code) calls when it needs to prove the Safebox is genuine, sign data with an attested key, or derive a stable secret from the hardware root of trust.

> **Transport**: same as [SYSTEM-PROTOCOL.md](SYSTEM-PROTOCOL.md) — per-container Unix domain sockets at `/run/safebox/system.sock`, HMAC-SHA-256 authenticated, served by the Infrastructure System component. The attestation endpoints are additional paths on the same HTTP server; no separate daemon or port.

---

## TL;DR

Three operations, modeled after Apple's App Attest framework but with a third operation Apple doesn't offer:

| Operation | Purpose | Analogy |
|-----------|---------|---------|
| **attest** | Produce a fresh TPM quote + EK chain proving this is a real Safebox running blessed code | iOS `attestKey` |
| **assert** | Sign caller-supplied data with the box's Ed25519 key, bundled with a fresh TPM quote | iOS `generateAssertion` |
| **derive** | Deterministic PRF: derive a stable secret from the TPM-sealed root key + a caller label | *(no iOS equivalent)* |

Plus one pure-crypto operation that runs anywhere (no hardware needed):

| Operation | Purpose |
|-----------|---------|
| **verify** | Validate an attestation or assertion against blessed images and the TPM certificate chain |

The System component handles the privileged TPM access (`/dev/tpmrm0` is root-only) and the EK certificate chain verification. Containers never touch the TPM directly — they speak HMAC-signed JSON over the Unix socket, same as every other System protocol call.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Container: safebox-app-foo  (or a Safecloud Jet)                       │
│                                                                        │
│  Safecloud JS / Safebox Node                                           │
│    │                                                                   │
│    │  POST /attest, /assert, /derive — HMAC-signed JSON                │
│    ▼                                                                   │
│  /run/safebox/system.sock (bind-mounted from host)                     │
└────────────────────────────────────────────────────────────────────────┘
                              │ (per-container Unix socket)
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Infrastructure System component (same Node process as /system, /test)  │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ attestationClient.js (cloud-specific: nitroTpmClient,           │  │
│   │   gceAttestationClient, azureAttestationClient, ociAttestation) │  │
│   │                                                                 │  │
│   │   → sudo /opt/safebox/bin/safebox-tpm-quote <nonce-hex>         │  │
│   │   → tpmQuote.js: parse TPMS_ATTEST, verify AK signature        │  │
│   │   → verify EK cert chain to pinned cloud root                   │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Key material (in-memory, TPM-sealed at rest)                    │  │
│   │                                                                 │  │
│   │   boxKeyPair    — Ed25519, generated at first boot,             │  │
│   │                   sealed to TPM PCR policy                      │  │
│   │   hmacSeed      — HKDF root for per-container HMAC keys        │  │
│   │   prfRootKey    — HKDF root for stable PRF derivations,        │  │
│   │                   sealed to same TPM PCR policy                 │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ ocpClaim.js — Ed25519 OCP claim signing (RFC 8785 canonical)    │  │
│   │ verifyAnnounce.js — relying-party verification (pure crypto)    │  │
│   └─────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  /dev/tpmrm0  (NitroTPM / vTPM)
                  /etc/safebox/aws-nitro-root.pem  (pinned cloud root cert)
                  /run/safebox/keys/box.key  (sealed Ed25519 private key)
                  /run/safebox/keys/prf-root.key  (sealed PRF root)
```

---

## Authentication

Identical to SYSTEM-PROTOCOL.md. Every request carries HMAC-SHA-256 headers (`Authorization: SafeboxHMAC v1`, `X-Safebox-Timestamp`, `X-Safebox-Nonce`, `X-Safebox-Signature`) over the canonical envelope:

```
<timestamp>\n<nonce>\n<method>\n<path>\n<body-sha256-hex>
```

Per-container secret at `/run/safebox/keys/system.hmac`, derived via HKDF from the TPM-unsealed master seed. See SYSTEM-PROTOCOL.md "Authentication" for the full spec and Node signing example.

---

## Attestation trust chain

Understanding the full chain helps when integrating these APIs:

```
Hardware root of trust (TPM EK cert → cloud vendor root CA)
    │
    ├── TPM PCR measurements (sha256: 0,2,4,7,8,9,14,15)
    │     Firmware, bootloader, kernel, initrd, systemd, safebox code
    │
    ├── TPM quote: signed {PCR digest + nonce} by Attestation Key (AK)
    │     AK is certified by EK cert → chains to cloud root
    │
    ├── OCP safebox_announce claim (Ed25519, box key)
    │     wraps: quote, launchAuthorization, imageRootHash, prev
    │     nonce = sha256(canonical(launchAuthorization) + prevAnnounceHash)
    │     exp = issuedAt + 600  (10-minute attestation window)
    │
    └── Relying party (Safecloud JS, DNS compiler, Jet client)
          verifyAnnounce.js: pure crypto, no hardware needed
          checks: signature, authorization, freshness, PCRs vs blessed, confidential report
```

The `attest` and `assert` endpoints produce the building blocks of this chain. The `verify` operation (which can run anywhere) validates the assembled chain.

---

## POST /attest — produce attestation document

Generate a fresh TPM quote bound to a caller-supplied nonce, verify the EK certificate chain to the pinned cloud root, and return the full attestation bundle. This is the "registration" operation — call it once when establishing identity, or periodically to refresh the attestation (the `safebox_announce` cycle calls this every 600 seconds).

### Request

```json
{
    "op": "attest",
    "managedContainer": "safebox-app-safebox",
    "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "userData": "optional-application-data-hex",
    "includeConfidential": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `op` | string | yes | `"attest"` |
| `managedContainer` | string | yes | Caller's managed container name |
| `nonce` | string | yes | 32 hex chars (16 bytes). Caller-supplied freshness nonce. The TPM quote's `extraData` will be `sha256(nonce + userData)` so both are bound |
| `userData` | string | no | Arbitrary hex string, max 1024 chars. Application-specific data to bind into the quote (e.g., a session token hash, a content CID). Default: empty string |
| `includeConfidential` | boolean | no | Include SEV-SNP/TDX confidential computing evidence when available. Default: `true` |

### Response

```json
{
    "status": "ok",
    "data": {
        "quote": {
            "message": "<base64 TPMS_ATTEST>",
            "signature": "<base64 TPMT_SIGNATURE>",
            "pcrs": {
                "0": "<64 hex chars>",
                "2": "<64 hex chars>",
                "4": "<64 hex chars>",
                "7": "<64 hex chars>",
                "8": "<64 hex chars>",
                "9": "<64 hex chars>",
                "14": "<64 hex chars>",
                "15": "<64 hex chars>"
            },
            "akPublicPem": "-----BEGIN PUBLIC KEY-----\n...",
            "nonce": "<echo of request nonce>"
        },
        "ekCertPem": "-----BEGIN CERTIFICATE-----\n...",
        "ekVerified": true,
        "cloud": "aws",
        "boxPubkey": "<64 hex chars, Ed25519 public key>",
        "confidential": {
            "type": "sev-snp",
            "report": "<base64 attestation report>",
            "reportData": "<128 hex chars>"
        },
        "pcrPolicyList": [0, 2, 4, 7, 8, 9, 14, 15],
        "timestamp": 1747850000
    }
}
```

| Response field | Description |
|----------------|-------------|
| `quote.message` | Raw TPMS_ATTEST structure (base64). Contains the PCR digest, the nonce (as `extraData`), clock info, and firmware version |
| `quote.signature` | AK signature over `message` (base64). Verifiable with `akPublicPem` |
| `quote.pcrs` | Policy PCR values (sha256 bank). Keys are PCR indices as strings |
| `quote.akPublicPem` | Attestation Key public key in PEM format. The AK is certified by the EK cert |
| `ekCertPem` | Endorsement Key certificate (PEM). Chains to the cloud vendor's root CA |
| `ekVerified` | `true` if the System component verified the EK chain to the pinned root |
| `cloud` | Cloud provider: `"aws"`, `"gcp"`, `"azure"`, `"oci"` |
| `boxPubkey` | This Safebox's Ed25519 public key (64 hex chars). Stable across reboots as long as the PCR policy is unchanged |
| `confidential` | SEV-SNP or TDX report binding the quote to encrypted memory. `null` when memory encryption is not enabled |
| `pcrPolicyList` | Which PCR indices are covered by the quote |
| `timestamp` | Unix seconds when the quote was generated |

### Failure codes

| Code | Meaning |
|------|---------|
| `TPM_UNAVAILABLE` | `/dev/tpmrm0` not accessible (vTPM not enabled on this instance) |
| `ROOT_PEM_MISSING` | Cloud root certificate not installed at the expected path |
| `ROOT_PEM_FINGERPRINT_MISMATCH` | Root cert file doesn't match the pinned SHA-256 fingerprint |
| `CHAIN_BROKEN` | EK certificate doesn't chain to the pinned root |
| `CHAIN_EXPIRED` | A certificate in the chain has expired |
| `QUOTE_FAILED` | TPM quote command failed (safebox-tpm-quote returned non-zero) |
| `BAD_REQUEST` | Invalid nonce format or missing required field |

---

## POST /assert — sign data with attested key

Sign arbitrary data with the box's Ed25519 key and include a fresh TPM quote proving the key is held by a genuine Safebox. This is the "per-request proof" operation — use it when a relying party (e.g., a Safecloud Jet client requesting a decryption key fragment) needs to verify not just identity but current attestation state.

The response is a complete OCP `safebox_announce`-shaped claim that the relying party can verify with `verifyAnnounce.js`.

### Request

```json
{
    "op": "assert",
    "managedContainer": "safebox-app-safebox",
    "data": "<hex-encoded data to sign>",
    "launchAuthorization": { "...OCP claim..." },
    "prev": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `op` | string | yes | `"assert"` |
| `managedContainer` | string | yes | Caller's managed container name |
| `data` | string | yes | Hex-encoded data to include in the signed claim's `stm`. Max 2048 hex chars (1024 bytes). This is the application payload the relying party will read |
| `launchAuthorization` | object | yes | The current launch authorization OCP claim (owner-signed, ≤24h window). The System component verifies it before signing |
| `prev` | string \| null | yes | Hash of the previous announce claim (64 hex chars), or `null` for a launch announce. Used to compute the deterministic TPM nonce: `sha256(canonical(launchAuthorization) + prev)` |

### Response

```json
{
    "status": "ok",
    "data": {
        "claim": {
            "ocp": 1,
            "iss": "safebox:key:<boxPubkey>",
            "sub": "safebox:<safeboxId>",
            "stm": {
                "type": "safebox_announce",
                "safeboxId": "my-safebox-01",
                "boxPubkey": "<64 hex>",
                "ownerPubkey": "<64 hex>",
                "launchAuthorization": { "...OCP claim..." },
                "imageRootHash": "<64 hex>",
                "cloud": "aws",
                "publicIp": "54.23.100.42",
                "quote": {
                    "message": "<base64>",
                    "signature": "<base64>",
                    "pcrs": { "0": "...", "2": "...", "..." : "..." },
                    "akPublicPem": "-----BEGIN PUBLIC KEY-----\n..."
                },
                "confidential": { "type": "sev-snp", "report": "...", "reportData": "..." },
                "data": "<caller's hex data>",
                "issuedAt": 1747850000,
                "prev": "<64 hex or null>"
            },
            "nbf": 1747850000,
            "exp": 1747850600,
            "key": ["<boxPubkey hex>"],
            "sig": ["<base64 Ed25519 signature>"]
        },
        "claimHash": "<64 hex, sha256 of canonical(claim)>"
    }
}
```

The returned `claim` is a fully-formed OCP v1 envelope, Ed25519-signed by the box key. The relying party passes it to `verifyAnnounce()` with their set of blessed images.

The `exp` field is `issuedAt + 600` (10-minute attestation window). The relying party enforces this — an assertion older than 10 minutes should be rejected and a fresh one requested.

### Failure codes

| Code | Meaning |
|------|---------|
| `BAD_REQUEST` | Invalid data format, missing fields |
| `AUTHORIZATION_INVALID` | Launch authorization failed verification (expired, wrong safeboxId, bad owner signature) |
| `AUTHORIZATION_EXPIRED` | Launch authorization window has passed |
| `TPM_UNAVAILABLE` | TPM not accessible |
| `QUOTE_FAILED` | TPM quote failed |
| `SIGNING_FAILED` | Ed25519 signing failed (box key unavailable) |

---

## POST /derive — stable PRF derivation

Derive a deterministic secret from the TPM-sealed root key using HKDF. The same `(label, context)` pair always produces the same output on the same Safebox, but the output is unpredictable without access to the sealed root key. This is the operation Apple doesn't offer — a stable pseudorandom function tied to the hardware identity.

**Use cases:**
- Deterministic encryption keys for Safecloud content that must survive container restarts
- Stable identifiers (e.g., per-tenant HMACs for deduplication) without storing key material
- Domain-separated secrets for different subsystems from one root

The PRF root key is sealed to the same TPM PCR policy as the box key. If the Safebox boots different code (different PCR values), the TPM refuses to unseal the root and all derived secrets become unavailable — this is by design, since different code means different trust.

### Request

```json
{
    "op": "derive",
    "managedContainer": "safebox-app-safebox",
    "label": "safecloud:content-key:v1",
    "context": "tenant=community-xyz,stream=messages",
    "lengthBytes": 32
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `op` | string | yes | `"derive"` |
| `managedContainer` | string | yes | Caller's managed container name |
| `label` | string | yes | HKDF info label for domain separation. Must match `^[a-zA-Z0-9:._/-]{1,256}$`. Convention: `<system>:<purpose>:<version>` |
| `context` | string | yes | HKDF context string. Must match `^[a-zA-Z0-9:.,=_/-]{0,1024}$`. Typically encodes the parameters that make this derivation unique (tenant, stream, etc.) |
| `lengthBytes` | integer | no | Output length in bytes. Default: 32. Range: 16–64 |

### Response

```json
{
    "status": "ok",
    "data": {
        "derived": "<hex-encoded derived key>",
        "lengthBytes": 32,
        "label": "safecloud:content-key:v1",
        "context": "tenant=community-xyz,stream=messages"
    }
}
```

The `derived` field is the hex-encoded output of `HKDF-SHA-256(ikm=prfRootKey, salt=label, info=context, length=lengthBytes)`. The label and context are echoed for confirmation.

### Failure codes

| Code | Meaning |
|------|---------|
| `BAD_REQUEST` | Invalid label/context format or length out of range |
| `PRF_ROOT_UNAVAILABLE` | PRF root key could not be unsealed (PCR policy changed since boot) |
| `FORBIDDEN_ACTION` | `managedContainer` not allowed to use `derive` |

### Security properties

1. **Deterministic**: same inputs → same output, every time, on this Safebox
2. **Hardware-bound**: output is unpredictable without the TPM-sealed root key
3. **PCR-locked**: if the boot chain changes, the root key won't unseal
4. **Domain-separated**: different labels produce cryptographically independent outputs
5. **Non-exportable**: the root key never leaves the TPM; only derived material is returned

---

## Verify — relying-party verification

Verification is a pure-crypto operation that runs anywhere — no TPM, no System component, no Unix socket. It is implemented in `common/attestation/verifyAnnounce.js` and is what Safecloud JS calls to check whether a Safebox is genuine before releasing decryption keys or routing sensitive data.

### Usage (Safecloud JS side)

```js
const { verifyAnnounce, buildBlessedImages } = require('common/attestation/verifyAnnounce');
const { checkLaunchAuthorization } = require('common/attestation/ocpClaim');

// 1. Build the set of blessed images from M-of-N signed image_blessing claims
const blessed = buildBlessedImages(blessingClaims, {
    trustedKeys: new Set(['<base64 SPKI key 1>', '<base64 SPKI key 2>', '...']),
    minSigners: 2   // M-of-N threshold
});

// 2. Verify an assertion received from a Safebox
const result = verifyAnnounce(claim, {
    blessedImages: blessed,
    now: Math.floor(Date.now() / 1000),
    maxSkewSeconds: 900,            // default: 15 minutes
    allowUnencryptedMemory: false,  // require SEV-SNP or TDX
    fetchVcek: (c, report) => {     // optional: verify SEV-SNP signature
        // return the VCEK PEM for this chip from AMD's KDS
    }
});

if (result.ok) {
    // result.safeboxId    — verified safebox identity
    // result.boxPubkey    — verified Ed25519 public key
    // result.ownerPubkey  — owner who authorized this launch
    // result.publicIp     — attested IP address
    // result.imageRootHash — which blessed image is running
    // result.prev         — previous announce hash (for chain verification)
    // result.launch       — true if this is a launch announce (prev === null)
    // result.chainVerified — true if SEV-SNP/TDX signature verified end-to-end
    // result.issuedAt     — when the attestation was produced
}
```

### Verification checks (in order)

| Step | What is checked | Failure means |
|------|-----------------|---------------|
| 1. Shape | `stm.type === 'safebox_announce'`, valid safeboxId, boxPubkey, ownerPubkey, iss/sub consistency | Malformed claim |
| 2. Box signature | Ed25519 signature by `stm.boxPubkey` over canonical claim | Claim not from this box |
| 3. Launch authorization | Owner's Ed25519 signature, same safeboxId, window contains issuedAt (for launch announces) | Box not authorized by owner |
| 4. Freshness | `|now - issuedAt| ≤ maxSkewSeconds` | Stale or replayed attestation |
| 5. TPM quote | TPMS_ATTEST parses, covers policy PCRs, nonce matches `sha256(canonical(auth) + prev)`, AK signature valid | TPM evidence forged or corrupt |
| 6. Blessed PCRs | Every policy PCR matches the blessed set for `imageRootHash` | Running unknown or tampered code |
| 7. Confidential | SEV-SNP/TDX report present (unless `allowUnencryptedMemory`), REPORT_DATA binds the quote, signature valid (if `fetchVcek` provided) | Memory not encrypted or report forged |

### What the caller must check additionally

`verifyAnnounce` is stateless — it cannot enforce:

- **First-seen rule**: Is this `boxPubkey` the first one seen for this `safeboxId`? The relying party tracks this. A new key for the same safeboxId means a new boot — decide whether to trust it
- **Chain continuity**: Does `prev` match the hash of the last announce you accepted from this box? Gaps may indicate missed announces or a replay attack
- **Application-level policy**: Is the `data` field what you expected? Is `imageRootHash` on your allowlist?

---

## Integration: attestation-gated key release in Jets

The primary integration point for Safecloud JS is **attestation-gated key-fragment release** in Jets. When a Safecloud Jet runs inside a Safebox and needs to decrypt content for processing (e.g., PII redaction, model inference), the key-fragment holder (another Jet, or the OCP grant system) must verify attestation before releasing the fragment.

### Flow

```
Safecloud Jet (inside Safebox)                Key-fragment holder
        │                                              │
        │  1. POST /assert (to local System component) │
        │     → gets signed OCP claim                  │
        │                                              │
        │  2. Send claim + key request ────────────────│
        │                                              │
        │                    3. verifyAnnounce(claim) ──│
        │                       check blessed PCRs     │
        │                       check attestation age  │
        │                       check OCP grant policy │
        │                                              │
        │  4. Receive key fragment ◄───────────────────│
        │                                              │
        │  5. Decrypt content, process, return result  │
        │     (plaintext never leaves the Safebox)     │
```

### OCP grant attestation requirements

An OCP grant that gates on attestation includes these fields in its policy:

```json
{
    "requireAttestation": true,
    "blessedImages": ["<imageRootHash1>", "<imageRootHash2>"],
    "maxAttestationAgeSec": 600,
    "requireConfidential": true
}
```

The key-fragment holder checks:
1. The assertion's `imageRootHash` is in `blessedImages`
2. `now - issuedAt ≤ maxAttestationAgeSec`
3. `confidential.type` is `"sev-snp"` or `"tdx"` (if `requireConfidential`)
4. All `verifyAnnounce` checks pass

---

## Existing implementation references

| File | Role |
|------|------|
| `aws/scripts/components/system/server.js` | System component HTTP server — add `/attest`, `/assert`, `/derive` route handlers here |
| `aws/scripts/components/system/nitroTpmClient.js` | AWS attestation client: `quote(nonceHex)` → TPM quote + EK chain verification |
| `aws/scripts/components/system/gceAttestationClient.js` | GCP attestation client (same interface) |
| `aws/scripts/components/system/azureAttestationClient.js` | Azure attestation client (same interface) |
| `aws/scripts/components/system/ociAttestationClient.js` | OCI attestation client (same interface) |
| `aws/scripts/components/system/tpmQuote.js` | Low-level TPM quote: runs `safebox-tpm-quote`, parses TPMS_ATTEST, verifies AK signature |
| `common/attestation/ocpClaim.js` | OCP claim construction and Ed25519 signing. `signClaim()`, `verifyClaim()`, `buildLaunchAuthorization()`, `announceNonce()` |
| `common/attestation/verifyAnnounce.js` | Relying-party verification. `verifyAnnounce()`, `buildBlessedImages()` |

### Cloud-specific attestation clients — unified interface

All four cloud clients export the same API:

```js
module.exports = {
    quote(nonceHex),      // → { message, signature, pcrs, akPublicPem, nonce,
                          //     ekCertPem, ekVerified, cloud, confidential }
    pcrPolicyList,        // [0, 2, 4, 7, 8, 9, 14, 15]
    checkAvailable(),     // throws AttestationError if TPM/root cert unavailable
    AttestationError,     // error class with .code field
};
```

The System component loads the correct client based on the detected cloud at startup (instance metadata).

---

## What Safecloud JS needs to implement

1. **`Q.Safebox.attest({ nonce, userData })`** — calls `POST /attest` on the local System socket. Returns the attestation bundle. Used during Jet registration to prove identity to the Safecloud network.

2. **`Q.Safebox.assert({ data, launchAuthorization, prev })`** — calls `POST /assert`. Returns a signed OCP claim. Used on every key-fragment request to prove current attestation state.

3. **`Q.Safebox.derive({ label, context, lengthBytes })`** — calls `POST /derive`. Returns the derived secret. Used for deterministic key derivation (content encryption keys, stable HMACs).

4. **`Q.Safebox.verify(claim, { blessedImages, ... })`** — pure JS, calls `verifyAnnounce()` from `common/attestation/verifyAnnounce.js`. No System component needed. Used by any Safecloud participant (Jet, Drop, browser) to verify a Safebox's attestation.

The HMAC signing for the System socket is identical to the existing `Safebox.Protocol.System` client — reuse the same `signRequest()` function and socket path. See SYSTEM-PROTOCOL.md "What Safebox needs to implement" for the client module.

---

## Managed-containers.json — attestation actions

Add `"attest"`, `"assert"`, and `"derive"` to `allowedActions` for containers that need attestation:

```json
{
    "safebox-app-safebox": {
        "imagePattern": "^qbix/app:.*$",
        "allowedActions": [
            "git", "npm", "pip", "cargo",
            "zfs-rollback", "zfs-snapshot", "test", "migrate",
            "attest", "assert", "derive"
        ]
    }
}
```

`derive` is separated from `attest`/`assert` because PRF derivation produces key material. A container that only needs to prove its identity (attest/assert) shouldn't necessarily have access to the PRF root (derive).

---

## Audit trail

Attestation operations are logged to the same journal as other System component events:

```json
{"event":"request","method":"POST","path":"/attest","managedContainer":"safebox-app-safebox","durationMs":45,"status":200}
{"event":"request","method":"POST","path":"/assert","managedContainer":"safebox-app-safebox","durationMs":52,"status":200}
{"event":"request","method":"POST","path":"/derive","managedContainer":"safebox-app-safebox","label":"safecloud:content-key:v1","durationMs":3,"status":200}
{"event":"attest_fail","reason":"TPM_UNAVAILABLE","managedContainer":"safebox-app-safebox"}
```

Forensic recovery:
```bash
journalctl -t safebox-system | jq 'select(.path | startswith("/attest") or startswith("/assert") or startswith("/derive"))'
```

---

## Security notes

1. **No direct TPM access from containers.** Containers never see `/dev/tpmrm0`. The System component mediates all TPM operations through `safebox-tpm-quote` (which runs as root via sudo). This is the same pattern as iOS App Attest — apps call a framework API, not the Secure Enclave directly.

2. **Deterministic nonces.** The TPM quote nonce for `assert` is `sha256(canonical(launchAuthorization) + prev)` — deterministic from fields the relying party already has. This means the relying party can independently verify the nonce was correct without trusting the asserter to generate it honestly.

3. **10-minute attestation window.** Assertions expire after 600 seconds (`exp = issuedAt + 600`). A relying party holding a key fragment should require a fresh assertion if the last one is older than this window. The `maxAttestationAgeSec` field in OCP grants enforces this.

4. **PRF root is separate from HMAC seed.** The PRF root key (`/run/safebox/keys/prf-root.key`) is sealed to the TPM PCR policy independently of the HMAC seed used for System socket auth. Compromise of the HMAC seed (which would allow impersonating a container to the System component) does not leak derived secrets, because the System component re-verifies the caller's identity from the socket before deriving.

5. **PCR policy change = new identity.** If the Safebox boots different code (firmware update, kernel update, different safebox image), the TPM PCR values change. The sealed box key and PRF root won't unseal. The box generates a new key pair and PRF root, which means new `boxPubkey` and new derived secrets. Relying parties see this as a new box (first-seen rule) and must re-authorize.

---

## Safenet Verification Layer

Infrastructure produces raw attestation evidence (TPM quotes, EK chain
verification, Ed25519 signed claims). For a relying party making an
**OCP grant decision** — "should I release my key fragment to this box" —
raw evidence alone is insufficient. The question is not just "are the PCRs
valid" but "is this box running blessed code, deployed through a verified
pipeline, and operating within a healthy fleet".

**Safenet** is the external-facing verification API that enriches
Infrastructure's evidence with three additional signals:

```
┌──────────────────────────────────────────────────────────┐
│                    Relying Party                         │
│              (OCP grant holder, Jet client)              │
└───────────────────────┬──────────────────────────────────┘
                        │  POST /safenet/v1/attestation/verify
                        ▼
┌──────────────────────────────────────────────────────────┐
│                  Safenet Node                            │
│                                                          │
│  1. Verify.boxAttestation()                              │
│     ├─ Signature + PCR verification (Verify.js)          │
│     ├─ Freshness check (10-min window)                   │
│     ├─ Transparency log lookup (attestation lineage)     │
│     ├─ Deployment provenance (image → git tree)          │
│     ├─ Fleet context (peer attestation status)           │
│     └─ OCP grant policy evaluation                       │
│                                                          │
│  2. Verify.attestationHistory()                          │
│     └─ Chain continuity, reboot detection                │
│                                                          │
│  3. Verify.deploymentProvenance()                        │
│     └─ Image hash → publication claim → git commit       │
└──────────────────────────────────────────────────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   Transparency    GitReceiver    Discovery
      Log           (provenance)    (fleet)
```

### HTTP endpoints

#### POST /safenet/v1/attestation/verify

Full attestation verification with enrichment. Primary endpoint for
OCP grant decisions.

**Request:**
```json
{
    "claim": { "...signed safebox_announce or safebox_identity claim..." },
    "trustedImages": ["<sha256-hex>", "..."],
    "maxAgeSec": 600,
    "requireConfidential": false,
    "grantPolicy": {
        "blessedImages": ["<sha256-hex>"],
        "maxAttestationAgeSec": 300,
        "requireConfidential": true,
        "requireTransparencyLog": true
    }
}
```

**Response (success):**
```json
{
    "ok": true,
    "errors": [],
    "safeboxId": "safebox:abc123...",
    "boxPubkey": "<hex>",
    "ownerPubkey": "<hex>",
    "imageHash": "<sha256-hex>",
    "cloud": "aws-nitro",
    "attestationAge": 42,
    "isLaunchAnnounce": false,
    "transparencyEntry": {
        "index": 1847,
        "claimHash": "<hex>",
        "timestamp": "2025-05-20T14:30:00Z",
        "inclusionProof": { "proof": ["..."], "rootHash": "..." }
    },
    "attestationHistory": [
        { "index": 1840, "claimType": "safebox_announce", "timestamp": "..." },
        "..."
    ],
    "provenance": {
        "imageHash": "<sha256-hex>",
        "verified": true
    },
    "fleetContext": {
        "endorsedPeers": 5,
        "peers": [
            { "peerUri": "safenet:peer1...", "trustLevel": 2, "lastSeen": "..." }
        ]
    },
    "grantDecision": {
        "release": true,
        "reasons": []
    }
}
```

The `grantDecision.release` field is the answer to the OCP grant question.
When `false`, the `reasons` array explains why (image not in blessed set,
attestation too old, etc.).

#### GET /safenet/v1/attestation/history/{safeboxId}

Returns attestation chain for a Safebox from the transparency log.

**Query parameters:**
- `since` — ISO timestamp lower bound
- `until` — ISO timestamp upper bound
- `limit` — max entries (default 50)

**Response:**
```json
{
    "ok": true,
    "safeboxId": "safebox:abc123...",
    "entries": [
        { "index": 1840, "claimHash": "...", "claimType": "safebox_announce", "timestamp": "..." }
    ],
    "chainIntact": true,
    "totalAttestations": 12,
    "firstSeen": "2025-05-19T10:00:00Z",
    "lastSeen": "2025-05-20T14:30:00Z"
}
```

A `chainIntact: false` indicates a gap in the hash chain, which could
signal a reboot or a transparency log fork.

#### GET /safenet/v1/attestation/provenance/{imageHash}

Traces an image hash back to its publication claim in the transparency
log. Bridges the attestation layer (this box runs image X) to the
code provenance layer (image X was built from git commit Y).

**Response:**
```json
{
    "ok": true,
    "imageHash": "<sha256-hex>",
    "found": true,
    "logEntry": {
        "index": 342,
        "claimHash": "...",
        "claimType": "publication",
        "subject": "qbix/safebox-app",
        "timestamp": "2025-05-18T09:00:00Z"
    },
    "inclusionProof": { "proof": ["..."], "rootHash": "..." }
}
```

### Two-layer trust model

The two-layer architecture divides attestation concerns:

| Layer          | Responsibility                              | Question answered                        |
|----------------|---------------------------------------------|------------------------------------------|
| Infrastructure | Hardware-bound evidence production           | "Are the PCRs valid and the EK chain authentic?" |
| Safenet        | External verification + enrichment           | "Should I release my key fragment to this box?"  |

**Infrastructure** handles: TPM quote generation via `safebox-tpm-quote`,
EK certificate chain verification against pinned AWS Nitro root,
Ed25519 box key signing, PCR bank reads (sha256 indices 0,2,4,7,8,9,14,15),
and HKDF PRF derivation sealed to PCR policy.

**Safenet** adds: transparency log inclusion proofs (RFC 6962 Merkle tree),
deployment provenance via GitReceiver (image hash → git tree → source commits),
fleet-wide context via Discovery (peer attestation status, gossip protocol),
and OCP grant policy evaluation against the enriched evidence.

### Verification in browsers

The `Verify.js` module is isomorphic — it runs in both Node.js and browsers
using the Web Crypto API (SubtleCrypto). Browser verifiers can call
`Verify.boxAttestation()` directly against a Safenet node's HTTP API, or
use `Verify.fetchAndVerify()` for convenience:

```javascript
const result = await SafenetVerify.fetchAndVerify(
    'https://safenet-node.example.com/safenet/v1/attestation/verify',
    { claim, trustedImages: [...] }
);
if (result.ok && result.grantDecision.release) {
    // Safe to release key fragment
}
```

---

## Out of scope for 1.0

- **Key rotation ceremony.** Planned PCR-policy updates (e.g., kernel upgrades) that should preserve the box identity rather than starting fresh. Requires a migration protocol where the old key signs over to the new one before the reboot.
- **Remote attestation relay.** ~~Resolved: Safenet's `POST /safenet/v1/attestation/verify` serves as the public endpoint for external relying parties.~~ Live attestation challenge-response (requesting a *fresh* quote on demand from a remote box) remains out of scope.
- **HSM backend.** Using a dedicated HSM (CloudHSM, KMS) instead of the vTPM for key sealing. The API is designed to be backend-agnostic — the `cloud` field in responses already accommodates this.
- **Group attestation.** Proving that N Safeboxes collectively hold a secret (M-of-N threshold attestation). Currently each box attests individually.
