/**
 * Software Signer — Inductive Security invariant enforcer
 *
 * The Software Signer is the mechanism that makes Inductive Security work.
 * It is code baked into the frozen Nix image of the outer Safebox Console,
 * holding a signing key sealed to this box's TPM. It participates as a
 * REQUIRED co-signer in the M-of-N governance quorum.
 *
 * The key insight: the Software Signer enforces STRUCTURAL invariants,
 * not policy decisions. It checks the SHAPE of a proposed change, not
 * its content. Humans provide liveness (the system can evolve); this
 * code provides safety (invariants cannot be violated).
 *
 * Structural invariants enforced:
 *   1. Image updates must preserve dm-verity (root hash present on cmdline)
 *   2. Egress allowlist entries must be domain names, never bare IPs
 *   3. The signer set must always include a software signer
 *   4. The software signer cannot co-sign its own removal
 *   5. Succession images must contain a software signer
 *   6. PCR policy must include at minimum PCRs 0, 2, 4, 7, 8, 9, 14, 15
 *
 * Communication: Unix domain socket only. The Software Signer has
 * IPAddressDeny=any in its systemd unit — it cannot reach the network
 * even if the code has a bug.
 *
 * Key management: two signing keys are sealed to this box's TPM under
 * the same PCR policy as the HMAC seed, generated on first boot:
 *   - Ed25519 (classical): primary attestation signature
 *   - ML-DSA-65 (post-quantum): hybrid dual-signature for PQ resistance
 * Neither key can be extracted. Both public keys are published in the
 * governance key registry as a required signer. Every attestation claim
 * carries both signatures; existing validators that predate PQ support
 * ignore the ML-DSA-65 signature, new validators check both.
 */

'use strict';

const { createServer } = require('net');
const { readFileSync, existsSync } = require('fs');
const crypto = require('crypto');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────

const SOCKET_PATH = '/run/safebox-signer/signer.sock';
const KEY_PATH = '/var/lib/safebox/signer/ed25519.key.sealed';
const PUBKEY_PATH = '/var/lib/safebox/signer/ed25519.pub';
const MLDSA_KEY_PATH = '/var/lib/safebox/signer/mldsa65.key.sealed';
const MLDSA_PUBKEY_PATH = '/var/lib/safebox/signer/mldsa65.pub';

// ── Structural invariants ──────────────────────────────────────────────

/**
 * Validate a proposed governance action against structural invariants.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
function validateInvariants(action) {
  switch (action.type) {
    case 'image_blessing':
      return validateImageBlessing(action);
    case 'allowlist_change':
      return validateAllowlistChange(action);
    case 'signer_change':
      return validateSignerChange(action);
    case 'succession':
      return validateSuccession(action);
    case 'pcr_policy_change':
      return validatePcrPolicy(action);
    default:
      return { ok: false, reason: `unknown action type: ${action.type}` };
  }
}

function validateImageBlessing(action) {
  // Invariant 1: dm-verity must be present
  if (!action.manifest || !action.manifest.rootHash) {
    return { ok: false, reason: 'image blessing missing root hash (no dm-verity)' };
  }
  if (typeof action.manifest.rootHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(action.manifest.rootHash)) {
    return { ok: false, reason: 'root hash must be 64 lowercase hex characters' };
  }

  // Invariant 1: kernel command line must reference verity
  if (!action.manifest.kernelCmdline ||
      !action.manifest.kernelCmdline.includes('dm-mod.create=')) {
    return { ok: false, reason: 'kernel command line missing dm-verity setup' };
  }

  return { ok: true };
}

function validateAllowlistChange(action) {
  // Invariant 2: no bare IPs in egress allowlist
  if (!action.entries || !Array.isArray(action.entries)) {
    return { ok: false, reason: 'allowlist change missing entries array' };
  }

  for (const entry of action.entries) {
    if (!entry.domain || typeof entry.domain !== 'string') {
      return { ok: false, reason: 'allowlist entry missing domain' };
    }

    // Reject bare IPv4 addresses
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(entry.domain)) {
      return {
        ok: false,
        reason: `bare IP address not allowed in egress allowlist: ${entry.domain}`
      };
    }

    // Reject bare IPv6 addresses
    if (/^[0-9a-fA-F:]+$/.test(entry.domain) && entry.domain.includes(':')) {
      return {
        ok: false,
        reason: `bare IPv6 address not allowed in egress allowlist: ${entry.domain}`
      };
    }

    // Reject CIDR notation
    if (entry.domain.includes('/')) {
      return {
        ok: false,
        reason: `CIDR notation not allowed in egress allowlist: ${entry.domain}`
      };
    }

    // Must have at least one dot (a real domain)
    if (!entry.domain.includes('.')) {
      return {
        ok: false,
        reason: `not a valid domain name: ${entry.domain}`
      };
    }
  }

  return { ok: true };
}

function validateSignerChange(action) {
  // Invariant 3: signer set must always include a software signer
  if (!action.newSigners || !Array.isArray(action.newSigners)) {
    return { ok: false, reason: 'signer change missing newSigners array' };
  }

  const hasSoftwareSigner = action.newSigners.some(
    s => s.type === 'software' && s.required
  );

  if (!hasSoftwareSigner) {
    return {
      ok: false,
      reason: 'signer set must include at least one required software signer'
    };
  }

  // Invariant 4: cannot remove THIS software signer unless succession
  // (succession is a different action type handled separately)
  if (action.removedSigners && Array.isArray(action.removedSigners)) {
    const selfPubkey = loadPublicKey();
    const removingSelf = action.removedSigners.some(
      s => s.publicKey === selfPubkey
    );
    if (removingSelf) {
      return {
        ok: false,
        reason: 'software signer cannot co-sign its own removal (use succession instead)'
      };
    }
  }

  return { ok: true };
}

function validateSuccession(action) {
  // Invariant 5: succession image must contain a software signer
  if (!action.newImage || !action.newImage.softwareSignerPubkey) {
    return {
      ok: false,
      reason: 'succession image must declare its software signer public key'
    };
  }

  // The new image must also pass image blessing invariants
  if (action.newImage.manifest) {
    const blessingResult = validateImageBlessing({
      type: 'image_blessing',
      manifest: action.newImage.manifest
    });
    if (!blessingResult.ok) {
      return blessingResult;
    }
  }

  return { ok: true };
}

function validatePcrPolicy(action) {
  // Invariant 6: PCR policy must include the minimum set
  const requiredPcrs = [0, 2, 4, 7, 8, 9, 14, 15];

  if (!action.pcrSet || !Array.isArray(action.pcrSet)) {
    return { ok: false, reason: 'PCR policy change missing pcrSet array' };
  }

  for (const pcr of requiredPcrs) {
    if (!action.pcrSet.includes(pcr)) {
      return {
        ok: false,
        reason: `PCR policy must include PCR ${pcr} (minimum required set: ${requiredPcrs.join(', ')})`
      };
    }
  }

  return { ok: true };
}

// ── Key management ─────────────────────────────────────────────────────

let cachedPubkey = null;
let cachedMldsaPubkey = null;

function loadPublicKey() {
  if (cachedPubkey) return cachedPubkey;
  if (!existsSync(PUBKEY_PATH)) {
    throw new Error('Software signer Ed25519 public key not found — run first-boot key generation');
  }
  cachedPubkey = readFileSync(PUBKEY_PATH, 'utf8').trim();
  return cachedPubkey;
}

function loadMldsaPublicKey() {
  if (cachedMldsaPubkey) return cachedMldsaPubkey;
  if (!existsSync(MLDSA_PUBKEY_PATH)) {
    throw new Error('Software signer ML-DSA-65 public key not found — run first-boot key generation');
  }
  cachedMldsaPubkey = readFileSync(MLDSA_PUBKEY_PATH, 'utf8').trim();
  return cachedMldsaPubkey;
}

/**
 * Canonicalize a governance action for signing.
 * Deterministic JSON serialization: sorted keys, no whitespace.
 */
function canonicalize(action) {
  return JSON.stringify(action, Object.keys(action).sort());
}

/**
 * Unseal a TPM-sealed key and return the raw key buffer.
 * Requires tpm2-tools: tpm2_unseal reads the sealed object under the
 * current PCR policy. If PCRs don't match (image was tampered), this fails.
 */
function unsealKey(sealedPath) {
  const { execFileSync } = require('child_process');
  return execFileSync('tpm2_unseal', [
    '-c', sealedPath,
    '-p', 'pcr:sha256:0,2,4,7,8,9,14,15'
  ]);
}

/**
 * Sign with Ed25519 (classical).
 */
function signEd25519(message) {
  const keyBuf = unsealKey(KEY_PATH);
  const privateKey = crypto.createPrivateKey({
    key: keyBuf,
    format: 'pem',
    type: 'pkcs8'
  });
  return crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
}

/**
 * Sign with ML-DSA-65 (post-quantum).
 * Requires OpenSSL 3.5+ with oqs-provider or built-in ML-DSA support.
 * The key is sealed to TPM in PEM format, same as Ed25519.
 */
function signMldsa65(message) {
  const keyBuf = unsealKey(MLDSA_KEY_PATH);
  const privateKey = crypto.createPrivateKey({
    key: keyBuf,
    format: 'pem',
    type: 'pkcs8'
  });
  return crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
}

// ── Socket server ──────────────────────────────────────────────────────

const server = createServer((conn) => {
  let data = '';

  conn.on('data', (chunk) => {
    data += chunk;
    // Simple framing: one JSON object per connection, max 64 KB
    if (data.length > 65536) {
      conn.end(JSON.stringify({ ok: false, reason: 'request too large' }));
    }
  });

  conn.on('end', () => {
    try {
      const request = JSON.parse(data);

      if (request.method === 'validate') {
        const result = validateInvariants(request.action);
        conn.end(JSON.stringify(result));
      } else if (request.method === 'cosign') {
        // First validate, then sign if invariants pass
        const validation = validateInvariants(request.action);
        if (!validation.ok) {
          conn.end(JSON.stringify(validation));
          return;
        }
        // Dual-sign: Ed25519 (classical) + ML-DSA-65 (post-quantum)
        const message = canonicalize(request.action);
        const ed25519Sig = signEd25519(message);
        const mldsa65Sig = signMldsa65(message);
        conn.end(JSON.stringify({
          ok: true,
          invariantsVerified: true,
          signatures: {
            ed25519: ed25519Sig,
            'ml-dsa-65': mldsa65Sig
          }
        }));
      } else if (request.method === 'pubkey') {
        conn.end(JSON.stringify({
          ok: true,
          publicKeys: {
            ed25519: loadPublicKey(),
            'ml-dsa-65': loadMldsaPublicKey()
          },
          // Backward compat: existing validators read this field
          publicKey: loadPublicKey()
        }));
      } else {
        conn.end(JSON.stringify({ ok: false, reason: `unknown method: ${request.method}` }));
      }
    } catch (err) {
      conn.end(JSON.stringify({ ok: false, reason: `parse error: ${err.message}` }));
    }
  });
});

// Clean up stale socket
const { unlinkSync } = require('fs');
try { unlinkSync(SOCKET_PATH); } catch (e) { /* ok if not found */ }

server.listen(SOCKET_PATH, () => {
  // Set socket permissions: only safebox-console (gid 991) can connect
  const { chmodSync } = require('fs');
  chmodSync(SOCKET_PATH, 0o660);

  console.log(`Software Signer listening on ${SOCKET_PATH}`);
  console.log('Structural invariants: dm-verity, domain-only allowlist, required software signer, PCR minimum set');
  console.log('Dual-signing: Ed25519 (classical) + ML-DSA-65 (post-quantum)');
});

server.on('error', (err) => {
  console.error('Software Signer error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
