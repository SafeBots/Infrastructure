# OCP Verification in the Infrastructure Base

## The Gap: HMAC Alone Is Not Enough

Before Phase 0, the infrastructure base authenticated every request with HMAC-SHA-256 (`auth.js`). A container presents its per-container HMAC key; the control socket uses the master key. This proves the caller is who it says it is -- that the request really came from an authorized container or from the host control channel.

But authentication is not authorization. HMAC tells you *who* is speaking; it does not tell you *whether M-of-N governance signers approved what they're asking for*. A compromised container that obtains a valid HMAC key can call `POST /system` with `tool: "dnf"` and install arbitrary packages. A compromised Safebox Node process on the host can call `POST /models/install` and load a poisoned model. The governance layer -- M-of-N voting, audit trails, threshold enforcement -- lived entirely in the Safebox plugin's PHP and JavaScript, inside the container. The base trusted whatever arrived over an authenticated channel.

OCP verification in the base closes this gap. The base now independently verifies that governance signers approved the operation, using the same OpenClaiming Protocol (OCP) that the Safebox plugin uses. HMAC proves identity; OCP proves authorization. Both must pass.

## What `ocpVerify.js` Does

`ocpVerify.js` is a verification-only port of the Safebox plugin's `Q.Crypto.OpenClaim.js`. It implements three functions:

### `canonicalize(claim)`

Produces the canonical byte string of an OCP claim per RFC 8785 (JSON Canonicalization Scheme). Object keys are sorted by Unicode code point; no whitespace; strings in JSON string form; numbers in shortest IEEE-754 round-trippable form. This is the same canonicalization used by `opsModels.js` for manifest hashing -- the algorithm in `opsModels._canonicalize()` handles the subset needed for manifests, while `ocpVerify.canonicalize()` handles the full OCP claim structure including nested arrays, booleans, and null.

The canonical form is what gets signed. Both signer (in the Safebox plugin) and verifier (in the base) must produce identical canonical bytes for the same claim, or signature verification fails.

### `verify(claim)`

Verifies a single OCP claim. For each pair `(claim.key[i], claim.sig[i])`:

1. Extract the public key from the `data:key/es256;base64,...` URI. The key is in SPKI (SubjectPublicKeyInfo) format, the standard X.509 public key encoding.
2. Compute `SHA-256(canonicalize(claim))` -- the digest of the canonical claim body (everything except `key` and `sig`).
3. Call `crypto.verify('sha256', digest, { key: spkiBuffer, format: 'spki' }, signatureBuffer)` using Node.js's built-in ES256 (ECDSA P-256 + SHA-256) verification.
4. Return a result indicating which signatures are valid and which keys they belong to.

The function never throws on invalid input -- it returns structured results so the caller can make threshold decisions.

### `verifyThreshold(claim, minSigners, trustedKeys)`

The M-of-N gate. Takes a claim, a minimum signer count, and a Set of trusted public key strings. Returns `{ ok: true }` when at least `minSigners` distinct valid signatures come from keys in `trustedKeys`.

Distinct is enforced by key identity: if the same key appears twice in `claim.key` with two valid signatures, it counts as one signer. This prevents a single compromised key from satisfying a threshold by signing multiple times.

Additional checks:
- `claim.nbf` (not before): if present, must be <= current time
- `claim.exp` (expiration): if present, must be > current time
- `claim.stm.sha256`: if present, must match the SHA-256 of the operation being requested (binds the claim to a specific action)

## The Governance Gate in `server.js`

The request pipeline in `server.js` becomes:

```
readBody → HMAC verify → parse JSON → reconcile identity → OCP verify → route
```

The OCP step extracts `body.ocpClaim`, verifies it against the governance key registry, and checks the threshold for the requested operation. If the claim is missing, invalid, or under-signed, the request is rejected with 403 before it reaches the route handler.

### Operations That Require Governance

These operations expand or modify the trust surface. Each requires an OCP claim signed by M-of-N governance signers, with the threshold defined per-operation in `governance-keys.json`:

| Endpoint | Why Governance Required |
|---|---|
| `POST /system` | All tool invocations (dnf, docker exec, git, migrate, zfs-*). A single system tool call can install packages, modify containers, or snapshot ZFS datasets. |
| `POST /containers/create` | Adds a new entity that can speak HMAC to the base. Expands the trust surface. |
| `POST /containers/destroy` | Removes a container and its HMAC key. Modifies the trust surface. |
| `POST /models/install` | Supply chain operation. Pulls external model weights into the base. |
| `POST /volumes/install` | Volume mounting (Phase 1). Same supply chain concern as models. |
| `POST /succession/*` | Succession operations (Phase 3). Transfers the master secret. |

### Operations That Are HMAC-Only

These operations are read-only, unauthenticated, or already scoped by per-container HMAC:

| Endpoint | Why No Governance |
|---|---|
| `GET /healthz` | Read-only status check. Returns uptime and identity. |
| `GET /containers` | Lists current container declarations. Read-only. |
| `GET /test/...` | Test status queries. Read-only. |
| `/embed` | Inference requests from containers. Already scoped by per-container HMAC -- a container can only embed through its own socket, and the embeddings worker runs in a separate process. |
| `GET /attestation` | Public endpoint. No auth at all. Anyone can read the attestation. |

### Claim-to-Operation Binding

The OCP claim's `stm.sha256` field must match the SHA-256 of a canonical representation of the operation being requested. This prevents claim reuse across operations -- a claim that approves `dnf install openssl` cannot be replayed to approve `dnf install backdoor-package`. The base computes the expected hash from the request body and compares.

## The Governance Keys Registry

### File: `/var/lib/safebox/governance/governance-keys.json`

```json
{
  "version": 1,
  "keys": {
    "alice-admin": {
      "publicKey": "data:key/es256;base64,MFkwEwYHKo...",
      "roles": ["admin"],
      "addedBy": "genesis",
      "addedAt": "2026-01-15T00:00:00Z"
    },
    "bob-auditor": {
      "publicKey": "data:key/es256;base64,MFkwEwYHKo...",
      "roles": ["auditor"],
      "addedBy": "genesis",
      "addedAt": "2026-01-15T00:00:00Z"
    }
  },
  "thresholds": {
    "system":              { "m": 3, "n": 5 },
    "containers/create":   { "m": 4, "n": 5 },
    "containers/destroy":  { "m": 4, "n": 5 },
    "models/install":      { "m": 2, "n": 3 },
    "volumes/install":     { "m": 2, "n": 3 },
    "succession/initiate": { "m": 4, "n": 5 }
  }
}
```

### `governanceKeys.js`

This module manages the registry:

- **Load and validate** on startup. Parses the JSON, checks that every key is a valid SPKI-format ES256 public key, checks that threshold values are consistent (m <= n, n <= number of keys with the relevant role).
- **Hot-reload on SIGHUP.** When the system receives SIGHUP (same signal that triggers `config.reload()` and `sockets.reconcile()`), governance keys are re-read from disk. A parse failure keeps the previous keys -- never leave the base without a valid key set.
- **Apply rotation claims.** A key rotation is itself an OCP claim signed by M-of-N of the current key set. The module verifies the rotation claim against the current keys before applying it. After application, it writes the new `governance-keys.json` atomically (write to temp, rename).

### Bootstrap: Genesis Keys

The genesis key set is baked into the base image at build time. It lives in `config/governance-keys.json` in the source tree, is placed on the read-only image at build time, and is installed to `/var/lib/safebox/governance/governance-keys.json` on the encrypted pool the first time the system component starts (the pool is the only writable, persistent place; `/etc` is a tmpfs overlay and the root is a verity volume). Rotations rewrite the pool copy, never the image. The file's contents are part of the measured image -- they contribute to PCR0. Changing who controls the base IS building a new base.

This is deliberate. The genesis keys are the root of trust. If an attacker could modify them without changing the image hash, the entire governance model collapses. By making them part of the measurement, any change requires a new blessed image, which requires governance approval of the new image, which requires M-of-N of the *current* key set.

### Runtime Key Rotation

A rotation claim looks like:

```json
{
  "ocp": 1,
  "stm": {
    "type": "keyRotation",
    "action": "addKey",
    "keyToAdd": "data:key/es256;base64,MFkwEwYHKo...",
    "newVersion": 2
  }
}
```

The rotation is verified against the current key set with a threshold of M+1 (supermajority). After verification, the new key set is written to disk and the in-memory registry is updated.

Exponential backoff applies to key rotation churn: the cooldown between key removal operations doubles with each removal. If churn is detected (multiple rotations in a 90-day window), the cooldown multiplier increases from 2x to 3x to 4x. This prevents a compromised majority from rapidly purging honest keys -- even with 9 of 10 keys, a full takeover takes years, giving the honest minority time to respond.

## How Apps Interact

The Safebox plugin (PHP + Node.js, running inside a container) is the user-facing governance layer. It manages voting, collects signatures, and presents approval UI. When M-of-N signers have approved an operation:

1. The Safebox plugin assembles the OCP claim with all collected signatures.
2. The plugin's Node.js process calls the base's Unix domain socket with HMAC auth, including the OCP claim in the request body as `body.ocpClaim`.
3. The base's `server.js` verifies HMAC (identity), then verifies the OCP claim (authorization), then routes the request.
4. The route handler executes the operation (install a package, create a container, etc.).
5. The result flows back through the socket to the plugin.

The plugin signs; the base verifies. The plugin never needs to trust the base's verification logic -- it can verify the same claim independently. The base never needs to trust the plugin's governance process -- it checks the cryptographic signatures itself.

## Security Properties

**The base never signs.** `ocpVerify.js` has no `sign()` function. The base cannot forge governance claims, issue approvals on its own, or impersonate a governance signer. It is a pure verifier.

**Key rotation requires M-of-N of the current set.** No single entity can unilaterally add or remove governance keys. The rotation claim must itself satisfy the current threshold.

**HMAC and OCP are independent checks.** A valid OCP claim without a valid HMAC is rejected (401). A valid HMAC without a valid OCP claim on a governance-required endpoint is rejected (403). Both must pass.

**Claims are bound to specific operations.** The `stm.sha256` field prevents claim reuse. A claim approved for one operation cannot authorize a different operation.

**Claims expire.** The `nbf` and `exp` fields bound the claim's validity window. A claim approved last month cannot be replayed today if it has expired.

**Duplicate signers are counted once.** The same key appearing multiple times in a claim's `key` array counts as one signer, not multiple. This prevents a single compromised key from satisfying a threshold alone.
