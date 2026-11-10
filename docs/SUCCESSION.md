# Unified Succession, Failover, and Recovery Protocol

## The Unified Model

Succession, failover, and disaster recovery are the same operation: a new safebox boots, attests, proves it is running a blessed image, and receives the master secret. What varies is the source of the master secret and the urgency of the handoff.

This unification is not just conceptual convenience. The code path is the same: `succession.js` handles all three paths. The claim format is the same: an OCP succession claim. The verification is the same: `ocpVerify.verifyThreshold()` against governance keys. The ECIES encryption is the same: P-256 ECDH + HKDF-SHA256 + AES-256-GCM. The transparency log entry is the same: a new link in the succession chain. By making these the same operation, there is one code path to audit, one set of test vectors, one ceremony to practice.

## The PCR4 Tension

The master secret is derived from PCR0 (image hash), PCR1 (kernel), and PCR4 (EC2 instance ID) via HKDF in `secret.attestationDerive()`. PCR4 is an anti-copy defense: if someone clones the disk image to a different EC2 instance, the different PCR4 produces a different master secret, and all per-container HMAC keys fail to verify. The clone cannot impersonate the original.

But PCR4 is also a succession barrier. A successor safebox runs on a different EC2 instance with a different PCR4. It cannot derive the same master secret from its own attestation. The keys are bound to the predecessor's hardware.

ECIES resolves this tension. Instead of having the successor derive the secret from its own hardware, the predecessor (or a recovery mechanism) encrypts the master secret to the successor's ephemeral public key using ECIES. The successor decrypts with its private key. The master secret transfers without ever appearing in plaintext on the wire, without requiring matching PCR4 values, and without weakening the anti-copy defense on the predecessor.

The successor keeps the received master in memory only. There is no on-disk master any more: on a hardened box the system component derives its master from the seed at `/run/safebox/hmac-seed`, which the initramfs unseals from the TPM each boot, so a warm restart of the successor re-derives its own master without any round trip.

## Path A: Online Predecessor (Planned Upgrade / Migration)

This is the standard succession path. The predecessor is alive and cooperating. A governance ceremony blesses the new image and authorizes the handoff.

### Ceremony

1. **Governance blesses the new image.** Governance signers review the new base image (built by Nix or Packer) and sign an OCP claim over its hash. The hash will become the successor's PCR0.

2. **Successor boots.** A new EC2 instance launches with the blessed image. On first boot, the system component (`server.js`) starts, but its own master (derived from its own sealed seed at `/run/safebox/hmac-seed`) is not the predecessor's, so none of the predecessor's per-container keys validate. The successor enters a "waiting for succession" state.

3. **Successor generates ephemeral keypair.** `instanceIdentity.js` generates a P-256 keypair. The private key lives only in RAM (never written to disk, same principle as the master secret in `secret.js`). The public key IS the instance identity.

4. **Successor attests.** The successor requests an attestation document from its NSM (`nsmClient.getVerifiedAttestationSync()`), verifying the cert chain to the AWS Nitro root. It issues a self-signed OCP claim binding its public key to its hardware measurements:
   ```json
   {
     "ocp": 1,
     "iss": "safebox://<successor-pubkey-hash>",
     "stm": {
       "type": "attestation",
       "instancePublicKey": "<SPKI base64>",
       "measurement": "<PCR0 hex>",
       "cloud": "aws",
       "hardwareRoot": "nitrotpm"
     }
   }
   ```

5. **Successor presents attestation to predecessor.** Via Safenet (the safebox-to-safebox overlay) or localhost (if on the same physical host during migration).

6. **Predecessor verifies.** The predecessor checks:
   - The attestation document chains to the AWS Nitro hardware root (cert chain verification, COSE_Sign1 signature).
   - PCR0 matches the governance-blessed image hash.
   - The successor's public key is bound to the attestation (the attestation claim's `instancePublicKey` matches the key that signed the claim).

7. **Predecessor encrypts.** The predecessor ECIES-encrypts the master secret to the successor's attested public key (details in the ECIES section below).

8. **Governance co-signs the succession claim.** The predecessor creates a succession claim and governance signers co-sign it (M-of-N threshold):
   ```json
   {
     "ocp": 1,
     "stm": {
       "type": "succession",
       "predecessor": "<predecessor pubkey>",
       "successorImageHash": "<expected PCR0>",
       "secretTransfer": {
         "method": "ecies-p256",
         "recipientKey": "<successor's ephemeral pubkey>"
       },
       "reason": "scheduled_upgrade"
     }
   }
   ```

9. **Predecessor writes encrypted blob.** The ECIES-encrypted master secret + signed succession claim are written to the shared ZFS volume. The predecessor then destroys its own key material and shuts down.

10. **Successor decrypts.** The successor reads the encrypted blob from ZFS, decrypts with its ephemeral private key, and obtains the master secret.

11. **Successor re-derives keys.** Using the master secret, the successor calls `secret.derivePerContainerKey()` for each container in `managed-containers.json`. The derived keys are identical to the predecessor's (same master, same container names, same key epochs). The successor writes them to `/run/safebox/keys/<name>/system.hmac` on tmpfs.

12. **Successor issues attestation.** The successor publishes its own attestation claim, naming the predecessor in its `predecessorChain`. This extends the succession chain in the transparency log.

## Path B: Pre-Positioned Failover

The predecessor is dead or unreachable. A failover safebox, already running and attested, takes over using a pre-positioned encrypted secret.

### Continuous Escrow

During normal operation, the primary continuously pre-authorizes the failover. Every N minutes (configurable, default 15):

1. The primary reads the failover's current attestation claim over Safenet. The failover is a live attested safebox with its own ephemeral keypair.

2. The primary ECIES-encrypts the current master secret to the failover's attested public key.

3. The primary signs a conditional succession claim:
   ```json
   {
     "ocp": 1,
     "stm": {
       "type": "succession",
       "predecessor": "<primary pubkey>",
       "successorImageHash": "<failover's PCR0>",
       "secretTransfer": {
         "method": "ecies-p256",
         "recipientKey": "<failover's current pubkey>"
       },
       "reason": "failover",
       "conditional": true,
       "conditionTimeout": 1800
     }
   }
   ```
   The `conditionTimeout` (seconds) is the liveness threshold: if the primary is unreachable for this long, the failover may promote.

4. The primary writes the encrypted blob + conditional claim to the shared ZFS volume (which the failover receives via ZFS send/receive).

### Promotion

The failover checks for the primary's liveness. If the primary is unreachable for `conditionTimeout` seconds:

1. The failover promotes its ZFS dataset to read-write.
2. Decrypts the pre-positioned master secret blob using its own ephemeral private key.
3. Re-derives per-container HMAC keys from the master.
4. Issues its own attestation claim, referencing the conditional succession claim.
5. Notifies governance signers. They can revoke if the promotion was premature (the primary was temporarily unreachable but is now back).

No ceremony is needed at failover time. The handoff was done in advance. The failover's promotion is automatic, bounded only by the liveness timeout and the age of the pre-positioned blob.

### Revocation

If the primary comes back after a failover promoted, the primary detects (via the transparency log) that its conditional succession was exercised. The primary shuts down -- it no longer holds the identity. Two instances cannot both claim the same succession chain. The transparency log makes fork detection possible (see `TRANSPARENCY.md`).

## Path C: Disaster Recovery (Shamir Shares)

Both primary and failover are gone. The master secret must be reconstructed from governance shares.

### Provisioning

At initial provisioning, a recovery key is generated inside the first safebox's encrypted memory:

1. Generate 256 bits of randomness (`crypto.randomBytes(32)`).
2. Derive the master secret from the recovery key: `HKDF-SHA256(ikm=recoveryKey, salt=zeros(32), info="safebox-recovery-v1", length=32)`.
3. Split the recovery key into N shares using Shamir Secret Sharing, with threshold M.
4. Distribute one share to each governance signer. Storage is the signer's choice: their own safebox, a hardware wallet, printed paper in a safe.
5. Destroy the recovery key from memory. Only the shares and the derived master secret remain.

### Recovery

1. A new safebox boots with a governance-blessed image, attests.
2. M-of-N governance signers each submit their Shamir share to the new safebox (encrypted to its attested public key via ECIES).
3. The safebox reconstructs the recovery key inside its encrypted memory using `shamirSplit.js`.
4. The safebox derives the master secret: `HKDF-SHA256(ikm=recoveryKey, salt=zeros(32), info="safebox-recovery-v1", length=32)`.
5. The safebox pulls encrypted ZFS snapshots from Safecloud (tier 3 archive) or S3.
6. Decrypts using the recovered master secret, mounts, resumes.

The recovery key is destroyed from memory after the master secret is derived. It exists only during reconstruction and derivation.

## Path D: Solo Operator Escape Hatch

At provisioning time, the operator may generate a recovery seed: 256 bits of randomness, displayed as a BIP39 mnemonic (24 words). The recovery seed derives the master secret the same way as Path C's recovery key.

This is for solo operators who ARE the governance quorum, or as a last resort when even M-of-N governance is unavailable. The seed is a single point of failure by design -- the operator chooses to accept that tradeoff in exchange for being able to recover without coordinating with others.

The operator writes down the mnemonic words, stores them securely (split across locations, in a safe, etc.), and does not store them digitally. If both primary and failover are gone, the operator enters the mnemonic into a recovery tool that derives the master secret and bootstraps a new safebox.

## ECIES Implementation

All succession paths use ECIES (Elliptic Curve Integrated Encryption Scheme) for encrypting the master secret in transit. The implementation in `succession.js` uses P-256 as the curve, matching the ES256 keys used throughout the system.

### Algorithm

1. **ECDH key agreement.** The sender (predecessor or recovery tool) generates an ephemeral P-256 keypair. The sender computes the shared secret: `ECDH(ephemeralPrivate, recipientPublic)`. The ephemeral public key is included in the ciphertext so the recipient can compute the same shared secret.

2. **Key derivation.** The shared secret is fed through HKDF-SHA256:
   ```
   derivedKey = HKDF-SHA256(
     ikm = sharedSecret,
     salt = zeros(32),
     info = "safebox-ecies-v1",
     length = 32
   )
   ```
   This produces a 256-bit AES key.

3. **Encryption.** AES-256-GCM encrypts the master secret:
   ```
   nonce = randomBytes(12)   // 96-bit GCM nonce
   { ciphertext, tag } = AES-256-GCM(key=derivedKey, nonce=nonce, plaintext=masterSecret)
   ```

4. **Output.** The encrypted blob is:
   ```json
   {
     "ephemeralPublicKey": "<SPKI base64>",
     "nonce": "<base64>",
     "ciphertext": "<base64>",
     "tag": "<base64>"
   }
   ```

5. **Decryption.** The recipient computes `ECDH(recipientPrivate, ephemeralPublic)`, derives the same key via HKDF, and decrypts with AES-256-GCM.

### Why P-256 and Not X25519

The rest of the system uses P-256 (ES256) for OCP signatures and attestation. Using P-256 for ECIES means one key type, one set of libraries, one set of test vectors. X25519 + XSalsa20-Poly1305 (NaCl box) would also work, but it would add a second curve and key format. P-256 ECDH + HKDF + AES-256-GCM achieves the same security properties with the existing key infrastructure.

## Shamir Secret Sharing

`shamirSplit.js` implements Shamir's Secret Sharing over GF(256) -- the Galois field with 256 elements, using the AES irreducible polynomial 0x11B and generator 3.

### Why GF(256)

Shamir's scheme works over any finite field. GF(256) is the natural choice for byte-oriented secrets: each byte of the secret is split independently, and each share is the same length as the secret. No big-integer arithmetic, no variable-length encoding, no padding.

The AES polynomial (0x11B, x^8 + x^4 + x^3 + x + 1) and generator 3 are well-studied and widely implemented. Using the same field as AES is not a security dependency -- it is an implementation convenience that avoids inventing field parameters.

### Split

To split a 32-byte secret with threshold M and N total shares:

1. For each byte position `i` (0 to 31):
   - Choose M-1 random bytes as polynomial coefficients: `a_1, a_2, ..., a_{M-1}`
   - The polynomial is `f(x) = secret[i] + a_1*x + a_2*x^2 + ... + a_{M-1}*x^{M-1}` over GF(256)
   - Evaluate `f(1), f(2), ..., f(N)` to produce N share bytes for this position

2. Share `j` (for signer `j`) is the concatenation of bytes `f_0(j), f_1(j), ..., f_31(j)` -- a 32-byte value.

3. Each share is labeled with its index (1 through N). The index is not secret.

### Reconstruct

Given M shares:

1. For each byte position `i`:
   - Use Lagrange interpolation over GF(256) to reconstruct `f(0) = secret[i]`
   - The interpolation uses the share indices as x-coordinates and the share bytes as y-coordinates

2. The reconstructed secret is the concatenation of all `f(0)` values.

3. Any M shares suffice. Fewer than M shares reveal no information about the secret (information-theoretic security).

### Tampered Shares

A tampered share produces a wrong secret. There is no built-in integrity check in basic Shamir -- the reconstructed secret is just wrong, silently. The system detects this downstream: the derived master secret fails to decrypt the ZFS volumes, or the derived per-container HMAC keys fail to authenticate.

To detect tampering before attempting decryption, the system can store a commitment (SHA-256 of the recovery key) alongside the governance-keys registry. After reconstruction, hash the result and compare. If they do not match, one or more shares are corrupt.

## Succession Claim Format

All succession paths produce an OCP claim of the same structure:

```json
{
  "ocp": 1,
  "iss": "safebox://<current-instance-pubkey-hash>",
  "stm": {
    "type": "succession",
    "predecessor": "<current instance pubkey, SPKI base64>",
    "predecessorChain": [
      "<grandparent pubkey>",
      "<parent pubkey>",
      "<current pubkey>"
    ],
    "successorImageHash": "<expected PCR0 of successor, hex>",
    "successorRequirements": {
      "hardwareRoot": ["nitrotpm", "sev-snp"],
      "minGovernanceSigners": 3
    },
    "secretTransfer": {
      "method": "ecies-p256",
      "recipientKey": "<successor's ephemeral pubkey, SPKI base64>"
    },
    "reason": "scheduled_upgrade",
    "conditional": false
  },
  "nbf": "<ceremony-start-time>",
  "exp": "<ceremony-start-time + 3600>"
}
```

For Path B (pre-positioned failover), `conditional` is `true` and `conditionTimeout` specifies the liveness timeout in seconds.

For Path C (disaster recovery), the `predecessor` field is the last known instance pubkey (from the transparency log), and `reason` is `"disaster_recovery"`.

The `predecessorChain` is the full succession history: every instance that has held this identity, in chronological order. This chain is what the transparency log records. A verifier can walk the chain from genesis to the current instance, checking each succession claim's signatures and measurements.

## Nix Integration

In a Nix world, every base update IS a succession:

1. `nix build` produces a new image. The Nix store hash is deterministic -- the same inputs always produce the same output. This hash becomes the predicted PCR0.

2. Governance signs an OCP claim blessing that hash. They can do this before the image is even deployed, because the hash is known from the build.

3. The current instance pre-authorizes that hash as its successor's expected measurement. The succession claim's `successorImageHash` is set to the Nix-predicted PCR0.

4. A new instance boots with the blessed image. Its actual PCR0 matches the predicted hash (Nix is deterministic). The succession ceremony completes.

There is no "in-place upgrade." Every update is a clean succession to a new instance running the new image. The old instance transfers its master secret and shuts down.

For dnf-based images (the current production path), the same ceremony applies, but the PCR0 is measured empirically after the image is built rather than predicted from the build inputs. Governance blesses the specific AMI hash after inspection.

## Security Properties

**No plaintext key on the wire.** The master secret is always ECIES-encrypted to the recipient's attested public key. Even if the ZFS transport is compromised, the attacker sees only ciphertext.

**Hardware binding.** The successor must attest. The attestation proves the successor is running the blessed image on real hardware (Nitro TPM, SEV-SNP, or TDX). A software emulator cannot produce a valid attestation document.

**Governance oversight.** Path A requires M-of-N governance co-signing. Path B uses a pre-authorized conditional claim (signed by the primary, which was itself governance-approved). Path C requires M-of-N Shamir shares. In all paths, governance participates.

**Forward secrecy.** Each successor generates a fresh ephemeral keypair. Compromise of the predecessor's key material after the succession does not reveal the secret transferred to the successor (the ECIES ephemeral key is destroyed after encryption).

**Succession chain integrity.** The transparency log records every succession. A verifier can walk the chain from genesis to the current instance. A fork (two instances claiming the same predecessor) is detectable (see `TRANSPARENCY.md`).

**Shamir information-theoretic security.** Fewer than M shares reveal zero information about the recovery key. An attacker with M-1 shares knows no more than an attacker with zero shares.
