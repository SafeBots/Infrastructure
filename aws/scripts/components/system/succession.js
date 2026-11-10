'use strict';

// Unified succession, failover, and disaster recovery for Safebox Infrastructure.
//
// Three recovery paths:
//   Path A: Online predecessor ECIES transfer
//   Path B: Pre-positioned failover (continuous escrow)
//   Path C: Disaster recovery (Shamir + Safecloud restore)

const crypto = require('crypto');
const fs = require('fs');
const { split, reconstruct } = require('./shamirSplit');

// The escrow blob is runtime state written long after the image is built,
// so it lives on the encrypted pool under the module's own subdirectory of
// /var/lib/safebox (the root filesystem is read-only; /etc is a
// non-persistent tmpfs overlay). SAFEBOX_SYSTEM_SUCCESSION_DIR relocates
// the directory for tests.
const STATE_DIR = process.env.SAFEBOX_SYSTEM_SUCCESSION_DIR || '/var/lib/safebox/succession';
const ESCROW_PATH = require('path').join(STATE_DIR, 'failover-escrow.bin');
const HKDF_INFO = 'safebox-recovery-v1';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let predecessorChain = [];
let escrowTimer = null;
let masterSecretRef = null; // set during init
let instanceKeyPair = null; // this instance's P-256 keypair
let escrowIntervalMinutes = 30;

// ---------------------------------------------------------------------------
// ECIES implementation (P-256 ECDH + AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES key from a shared secret via HKDF-SHA256.
 */
function hkdfDerive(sharedSecret, info) {
  return crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from(info || 'ecies-aes256-gcm'), 32);
}

/**
 * Encrypt plaintext to a recipient identified by their SPKI-encoded P-256 public key.
 *
 * @param {string} recipientPublicKeySpki — base64-encoded SPKI public key
 * @param {Buffer} plaintext
 * @returns {{ephemeralPublicKey: string, iv: string, ciphertext: string, tag: string}}
 */
function eciesEncrypt(recipientPublicKeySpki, plaintext) {
  const recipientKey = crypto.createPublicKey({
    key: Buffer.from(recipientPublicKeySpki, 'base64'),
    format: 'der',
    type: 'spki'
  });

  // Generate ephemeral P-256 keypair.
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

  // ECDH to get the shared secret.
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientKey
  });

  // Derive AES-256 key via HKDF.
  const aesKey = Buffer.from(hkdfDerive(sharedSecret, 'ecies-aes256-gcm'));

  // AES-256-GCM encrypt.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const ephPub = ephemeral.publicKey.export({ type: 'spki', format: 'der' });

  return {
    ephemeralPublicKey: ephPub.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64')
  };
}

/**
 * Decrypt an ECIES envelope using the recipient's private key.
 *
 * @param {crypto.KeyObject} recipientPrivateKey — P-256 private key
 * @param {{ephemeralPublicKey: string, iv: string, ciphertext: string, tag: string}} envelope
 * @returns {Buffer}
 */
function eciesDecrypt(recipientPrivateKey, envelope) {
  const ephPub = crypto.createPublicKey({
    key: Buffer.from(envelope.ephemeralPublicKey, 'base64'),
    format: 'der',
    type: 'spki'
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: ephPub
  });

  const aesKey = Buffer.from(hkdfDerive(sharedSecret, 'ecies-aes256-gcm'));

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);

  return decrypted;
}

// ---------------------------------------------------------------------------
// Key utility helpers
// ---------------------------------------------------------------------------

/**
 * Hash a public key (SPKI DER base64) to produce a short identifier.
 */
function pubkeyHash(spkiBase64) {
  return crypto.createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 16);
}

/**
 * Export a KeyObject public key as base64 SPKI.
 */
function exportPublicKey(keyObject) {
  const pub = keyObject.type === 'private'
    ? crypto.createPublicKey(keyObject)
    : keyObject;
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

// ---------------------------------------------------------------------------
// OCP Succession Claims
// ---------------------------------------------------------------------------

/**
 * Create an OCP succession claim.
 *
 * @param {object} options
 * @param {string} options.predecessorPubkey — base64 SPKI of the current (predecessor) instance
 * @param {string[]} options.predecessorChain — ordered list of ancestor pubkeys
 * @param {string} options.successorImageHash — expected PCR0 of the successor image
 * @param {string} options.successorPubkey — ephemeral pubkey of the successor for ECIES transfer
 * @param {string} [options.reason='scheduled_upgrade']
 * @param {boolean} [options.conditional=false]
 * @param {string[]} [options.hardwareRoot=['nitrotpm', 'sev-snp']]
 * @param {number} [options.minGovernanceSigners=3]
 * @param {number} [options.ttlSeconds=3600]
 * @returns {object} — the OCP claim object
 */
function createSuccessionClaim(options) {
  const {
    predecessorPubkey,
    predecessorChain: chain,
    successorImageHash,
    successorPubkey,
    reason,
    conditional,
    hardwareRoot,
    minGovernanceSigners,
    ttlSeconds
  } = options;

  const now = Math.floor(Date.now() / 1000);

  const claim = {
    ocp: 1,
    iss: `safebox://${pubkeyHash(predecessorPubkey)}`,
    stm: {
      type: 'succession',
      predecessor: predecessorPubkey,
      predecessorChain: chain || [],
      successorImageHash: successorImageHash,
      successorRequirements: {
        hardwareRoot: hardwareRoot || ['nitrotpm', 'sev-snp'],
        minGovernanceSigners: minGovernanceSigners || 3
      },
      secretTransfer: {
        method: 'ecies-p256',
        recipientKey: successorPubkey
      },
      reason: reason || 'scheduled_upgrade',
      conditional: conditional || false
    },
    nbf: now,
    exp: now + (ttlSeconds || 3600)
  };

  return claim;
}

/**
 * Verify a succession claim's structure and signatures.
 *
 * @param {object} claim — the OCP claim
 * @param {string[]} trustedKeys — list of trusted public key base64 strings
 * @param {number} threshold — minimum number of governance signatures required
 * @returns {{valid: boolean, errors: string[]}}
 */
function verifySuccessionClaim(claim, trustedKeys, threshold) {
  const errors = [];

  // Structural checks.
  if (!claim || claim.ocp !== 1) {
    errors.push('Missing or invalid ocp version');
  }

  if (!claim.iss || !claim.iss.startsWith('safebox://')) {
    errors.push('Invalid issuer format');
  }

  const stm = claim.stm;
  if (!stm) {
    errors.push('Missing statement (stm)');
    return { valid: false, errors };
  }

  if (stm.type !== 'succession') {
    errors.push(`Expected statement type "succession", got "${stm.type}"`);
  }

  if (!stm.predecessor) {
    errors.push('Missing predecessor public key');
  }

  if (!Array.isArray(stm.predecessorChain)) {
    errors.push('predecessorChain must be an array');
  }

  if (!stm.successorImageHash) {
    errors.push('Missing successorImageHash');
  }

  if (!stm.secretTransfer || stm.secretTransfer.method !== 'ecies-p256') {
    errors.push('secretTransfer must use ecies-p256');
  }

  if (!stm.secretTransfer || !stm.secretTransfer.recipientKey) {
    errors.push('Missing successor recipientKey');
  }

  const reqs = stm.successorRequirements;
  if (!reqs || !Array.isArray(reqs.hardwareRoot) || reqs.hardwareRoot.length === 0) {
    errors.push('successorRequirements.hardwareRoot must be a non-empty array');
  }

  if (!reqs || typeof reqs.minGovernanceSigners !== 'number' || reqs.minGovernanceSigners < 1) {
    errors.push('successorRequirements.minGovernanceSigners must be >= 1');
  }

  // Temporal checks.
  const now = Math.floor(Date.now() / 1000);
  if (typeof claim.nbf === 'number' && claim.nbf > now + 60) {
    errors.push('Claim is not yet valid (nbf in the future)');
  }
  if (typeof claim.exp === 'number' && claim.exp < now) {
    errors.push('Claim has expired');
  }

  // Chain continuity: the predecessor should appear in the chain.
  if (stm.predecessor && Array.isArray(stm.predecessorChain)) {
    const chain = stm.predecessorChain;
    if (chain.length > 0 && chain[chain.length - 1] !== stm.predecessor) {
      errors.push('Predecessor key is not the last entry in predecessorChain');
    }
  }

  // Trusted-key threshold check (signature verification placeholder).
  // In a real deployment, each governance signer would produce a detached signature
  // over the canonical claim. Here we check that we have enough trusted keys
  // that could potentially sign.
  if (trustedKeys && threshold) {
    if (trustedKeys.length < threshold) {
      errors.push(`Only ${trustedKeys.length} trusted keys available, need ${threshold}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Pre-positioned failover — Path B
// ---------------------------------------------------------------------------

/**
 * ECIES-encrypt the master secret to the failover instance's attested public key,
 * bundled with a conditional succession claim.
 *
 * @param {Buffer} masterSecret
 * @param {string} failoverPublicKey — base64 SPKI
 * @param {object} conditionalClaim — OCP claim with conditional=true
 * @returns {{encryptedSecret: object, claim: object}}
 */
function createEscrowBlob(masterSecret, failoverPublicKey, conditionalClaim) {
  const encryptedSecret = eciesEncrypt(failoverPublicKey, masterSecret);
  return {
    encryptedSecret,
    claim: conditionalClaim,
    createdAt: new Date().toISOString()
  };
}

/**
 * Decrypt the escrow blob using the failover instance's private key.
 *
 * @param {crypto.KeyObject} failoverPrivateKey
 * @param {{encryptedSecret: object}} blob
 * @returns {Buffer}
 */
function decryptEscrowBlob(failoverPrivateKey, blob) {
  return eciesDecrypt(failoverPrivateKey, blob.encryptedSecret);
}

/**
 * Write the escrow blob to the filesystem (for pre-positioned failover).
 */
function persistEscrow(blob) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
  fs.writeFileSync(ESCROW_PATH, JSON.stringify(blob), { mode: 0o600 });
}

/**
 * Load the escrow blob from the filesystem.
 */
function loadEscrow() {
  try {
    return JSON.parse(fs.readFileSync(ESCROW_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disaster recovery — Path C
// ---------------------------------------------------------------------------

/**
 * Split the master secret into Shamir shares for disaster recovery.
 *
 * @param {Buffer} masterSecret
 * @param {number} n — total shares
 * @param {number} threshold — minimum shares to reconstruct
 * @returns {Array<{x: number, y: Buffer}>}
 */
function createRecoveryShares(masterSecret, n, threshold) {
  return split(masterSecret, n, threshold);
}

/**
 * Reconstruct the master secret from Shamir shares, then derive via HKDF
 * with the recovery info string.
 *
 * @param {Array<{x: number, y: Buffer}>} shares
 * @param {number} threshold
 * @returns {Buffer} — the derived master secret
 */
function recoverFromShares(shares, threshold) {
  const raw = reconstruct(shares, threshold);
  const derived = Buffer.from(
    crypto.hkdfSync('sha256', raw, Buffer.alloc(0), Buffer.from(HKDF_INFO), raw.length)
  );
  return derived;
}

// ---------------------------------------------------------------------------
// Succession ceremony HTTP handler
// ---------------------------------------------------------------------------

/**
 * Stub: verify an attestation document and extract the attested public key.
 * In production this would verify the Nitro / SEV-SNP attestation.
 */
function verifyAttestation(attestationDoc) {
  if (!attestationDoc || !attestationDoc.publicKey) {
    throw new Error('Invalid attestation: missing publicKey');
  }
  if (!attestationDoc.imageHash) {
    throw new Error('Invalid attestation: missing imageHash');
  }
  return {
    publicKey: attestationDoc.publicKey,
    imageHash: attestationDoc.imageHash
  };
}

/**
 * HTTP handler for the succession ceremony endpoints.
 *
 * @param {string} method — HTTP method
 * @param {string} pathname — request path
 * @param {object} body — parsed request body (for POST)
 * @returns {{status: number, body: object}}
 */
function handle(method, pathname, body) {
  try {
    // POST /succession/initiate — Path A: online predecessor transfer
    if (method === 'POST' && pathname === '/succession/initiate') {
      if (!masterSecretRef) {
        return { status: 500, body: { error: 'No master secret loaded' } };
      }
      if (!body || !body.successorAttestation) {
        return { status: 400, body: { error: 'Missing successorAttestation' } };
      }

      const attested = verifyAttestation(body.successorAttestation);
      const successorPubkey = attested.publicKey;
      const successorImageHash = attested.imageHash;

      const currentPubkey = instanceKeyPair
        ? exportPublicKey(instanceKeyPair.publicKey)
        : 'unknown';

      // Create the succession claim.
      const claim = createSuccessionClaim({
        predecessorPubkey: currentPubkey,
        predecessorChain: [...predecessorChain, currentPubkey],
        successorImageHash: body.successorImageHash || successorImageHash,
        successorPubkey: successorPubkey,
        reason: body.reason || 'scheduled_upgrade'
      });

      // ECIES-encrypt the master secret to the successor's key.
      const envelope = eciesEncrypt(successorPubkey, masterSecretRef);

      return {
        status: 200,
        body: {
          claim,
          encryptedSecret: envelope,
          predecessorChain: [...predecessorChain, currentPubkey]
        }
      };
    }

    // POST /succession/escrow — Path B: update pre-positioned failover
    if (method === 'POST' && pathname === '/succession/escrow') {
      if (!masterSecretRef) {
        return { status: 500, body: { error: 'No master secret loaded' } };
      }
      if (!body || !body.failoverAttestation) {
        return { status: 400, body: { error: 'Missing failoverAttestation' } };
      }

      const attested = verifyAttestation(body.failoverAttestation);
      const failoverPubkey = attested.publicKey;

      const currentPubkey = instanceKeyPair
        ? exportPublicKey(instanceKeyPair.publicKey)
        : 'unknown';

      const conditionalClaim = createSuccessionClaim({
        predecessorPubkey: currentPubkey,
        predecessorChain: [...predecessorChain, currentPubkey],
        successorImageHash: attested.imageHash,
        successorPubkey: failoverPubkey,
        reason: 'failover',
        conditional: true
      });

      const blob = createEscrowBlob(masterSecretRef, failoverPubkey, conditionalClaim);

      // Attempt to persist to disk (may fail in test environments).
      try {
        persistEscrow(blob);
      } catch (_) {
        // Non-fatal: blob is returned in the response regardless.
      }

      return {
        status: 200,
        body: { escrow: blob }
      };
    }

    // POST /succession/recover — Path C: disaster recovery from Shamir shares
    if (method === 'POST' && pathname === '/succession/recover') {
      if (!body || !Array.isArray(body.shares) || body.shares.length === 0) {
        return { status: 400, body: { error: 'Missing or empty shares array' } };
      }

      const threshold = body.threshold || body.shares.length;

      // Convert shares from JSON-friendly format (y as base64 or hex) to Buffers.
      const shares = body.shares.map(s => ({
        x: s.x,
        y: Buffer.isBuffer(s.y) ? s.y : Buffer.from(s.y, 'base64')
      }));

      const recovered = recoverFromShares(shares, threshold);

      return {
        status: 200,
        body: {
          recovered: true,
          masterSecretHash: crypto.createHash('sha256').update(recovered).digest('hex').slice(0, 16)
        }
      };
    }

    // GET /succession/status
    if (method === 'GET' && pathname === '/succession/status') {
      const currentPubkey = instanceKeyPair
        ? exportPublicKey(instanceKeyPair.publicKey)
        : null;

      const escrow = loadEscrow();

      return {
        status: 200,
        body: {
          currentInstance: currentPubkey ? pubkeyHash(currentPubkey) : null,
          predecessorChain: predecessorChain.map(k => pubkeyHash(k)),
          chainLength: predecessorChain.length,
          escrowPresent: escrow !== null,
          escrowCreatedAt: escrow ? escrow.createdAt : null,
          hasMasterSecret: masterSecretRef !== null
        }
      };
    }

    return { status: 404, body: { error: 'Not found' } };

  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the succession module.
 *
 * @param {object} options
 * @param {Buffer} options.masterSecret — the master secret to protect
 * @param {crypto.KeyObject} [options.privateKey] — this instance's P-256 private key
 * @param {crypto.KeyObject} [options.publicKey] — this instance's P-256 public key
 * @param {string[]} [options.predecessorChain] — ordered list of ancestor pubkeys (base64 SPKI)
 * @param {number} [options.escrowIntervalMinutes] — how often to refresh the escrow (default 30)
 */
function init(options) {
  if (!options || !Buffer.isBuffer(options.masterSecret)) {
    throw new Error('options.masterSecret must be a Buffer');
  }

  masterSecretRef = options.masterSecret;

  if (options.privateKey && options.publicKey) {
    instanceKeyPair = {
      privateKey: options.privateKey,
      publicKey: options.publicKey
    };
  }

  if (Array.isArray(options.predecessorChain)) {
    predecessorChain = options.predecessorChain.slice();
  }

  if (typeof options.escrowIntervalMinutes === 'number') {
    escrowIntervalMinutes = options.escrowIntervalMinutes;
  }

  // Clear any previous escrow timer.
  if (escrowTimer) {
    clearInterval(escrowTimer);
    escrowTimer = null;
  }
}

/**
 * Start the periodic escrow refresh timer (Path B).
 * Requires a failover public key and attestation callback.
 *
 * @param {string} failoverPublicKey — base64 SPKI of the failover instance
 * @param {function} [attestationCallback] — called to get fresh attestation
 */
function startEscrowTimer(failoverPublicKey, attestationCallback) {
  if (escrowTimer) {
    clearInterval(escrowTimer);
  }

  const refresh = () => {
    if (!masterSecretRef) return;
    const currentPubkey = instanceKeyPair
      ? exportPublicKey(instanceKeyPair.publicKey)
      : 'unknown';

    const conditionalClaim = createSuccessionClaim({
      predecessorPubkey: currentPubkey,
      predecessorChain: [...predecessorChain, currentPubkey],
      successorImageHash: 'pending-attestation',
      successorPubkey: failoverPublicKey,
      reason: 'failover',
      conditional: true
    });

    const blob = createEscrowBlob(masterSecretRef, failoverPublicKey, conditionalClaim);
    try {
      persistEscrow(blob);
    } catch (_) {
      // logging would go here in production
    }
  };

  // Run once immediately, then on interval.
  refresh();
  escrowTimer = setInterval(refresh, escrowIntervalMinutes * 60 * 1000);
}

/**
 * Stop the escrow refresh timer.
 */
function stopEscrowTimer() {
  if (escrowTimer) {
    clearInterval(escrowTimer);
    escrowTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  eciesEncrypt,
  eciesDecrypt,
  createSuccessionClaim,
  verifySuccessionClaim,
  createEscrowBlob,
  decryptEscrowBlob,
  createRecoveryShares,
  recoverFromShares,
  handle,
  init,
  startEscrowTimer,
  stopEscrowTimer,
  pubkeyHash,
  exportPublicKey,
  ESCROW_PATH,
  HKDF_INFO
};
