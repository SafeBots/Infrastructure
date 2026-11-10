'use strict';

const crypto = require('crypto');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Module-level state (ephemeral — lives only in RAM)
// ---------------------------------------------------------------------------

let privateKey = null;
let publicKey = null;
let publicKeyDer = null;
let publicKeyBase64 = null;
let publicKeyHash = null;

// ---------------------------------------------------------------------------
// Hardware measurement helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to read the PCR0 measurement from the TPM or Nitro enclave.
 * Returns the hex measurement string or 'dev-mode' if unavailable.
 */
function readMeasurement() {
  // Try the Linux kernel TPM sysfs interface
  const tpmPcrsPath = '/sys/kernel/security/tpm0/pcrs';
  try {
    const raw = fs.readFileSync(tpmPcrsPath, 'utf8');
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // PCR-00 line: "PCR-00: AB CD EF ..."
      if (line.startsWith('PCR-00:') || line.startsWith('PCR-0:') || line.startsWith('PCR0:')) {
        const hex = line.split(':')[1].trim().replace(/\s+/g, '');
        if (hex.length > 0) return hex;
      }
    }
  } catch (_e) {
    // TPM sysfs not available — continue to next method
  }

  // Try /sys/kernel/security/ima/ascii_runtime_measurements for IMA PCR
  // (secondary path; uncommon)
  try {
    const imaPath = '/sys/kernel/security/ima/ascii_runtime_measurements';
    if (fs.existsSync(imaPath)) {
      // IMA is available but we need the aggregate — skip for now
    }
  } catch (_e) { /* ignore */ }

  return 'dev-mode';
}

/**
 * Detect the cloud environment and hardware root of trust.
 */
function detectEnvironment() {
  let cloud = 'dev';
  let hardwareRoot = 'none';

  // AWS detection
  try {
    if (fs.existsSync('/sys/hypervisor/uuid')) {
      const uuid = fs.readFileSync('/sys/hypervisor/uuid', 'utf8').trim();
      if (uuid.startsWith('ec2')) cloud = 'aws';
    }
  } catch (_e) { /* ignore */ }

  try {
    if (fs.existsSync('/sys/devices/virtual/dmi/id/board_vendor')) {
      const vendor = fs.readFileSync('/sys/devices/virtual/dmi/id/board_vendor', 'utf8').trim();
      if (vendor.includes('Amazon')) cloud = 'aws';
      if (vendor.includes('Google')) cloud = 'gcp';
      if (vendor.includes('Microsoft')) cloud = 'azure';
    }
  } catch (_e) { /* ignore */ }

  // Hardware root detection
  try {
    if (fs.existsSync('/dev/nsm')) {
      hardwareRoot = 'nitrotpm';
    } else if (fs.existsSync('/dev/sev')) {
      hardwareRoot = 'sev-snp';
    } else if (fs.existsSync('/sys/firmware/tdx')) {
      hardwareRoot = 'tdx';
    } else if (fs.existsSync('/sys/kernel/security/tpm0')) {
      hardwareRoot = 'nitrotpm'; // Generic TPM, assume Nitro on AWS
    }
  } catch (_e) { /* ignore */ }

  return { cloud: cloud, hardwareRoot: hardwareRoot };
}

/**
 * Try to determine the image hash of the running instance. Returns null if unavailable.
 */
function readImageHash() {
  // On AWS Nitro, could come from NSM attestation document
  // For now, check an environment variable or a stamped file
  if (process.env.SAFEBOX_IMAGE_HASH) {
    return process.env.SAFEBOX_IMAGE_HASH;
  }
  try {
    const stampPath = '/etc/safebox/image-hash';
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Generate an ephemeral P-256 keypair and store it in module-level variables.
 * The private key never leaves RAM. Returns the public key identity.
 */
function init() {
  const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  privateKey = crypto.createPrivateKey({ key: pair.privateKey, format: 'der', type: 'pkcs8' });
  publicKeyDer = pair.publicKey;
  publicKeyBase64 = pair.publicKey.toString('base64');
  publicKey = crypto.createPublicKey({ key: pair.publicKey, format: 'der', type: 'spki' });
  publicKeyHash = crypto.createHash('sha256').update(publicKeyDer).digest('hex');

  return {
    publicKey: publicKeyBase64,
    publicKeyHash: publicKeyHash
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Returns the SPKI base64-encoded public key.
 */
function getPublicKey() {
  if (!publicKeyBase64) throw new Error('instanceIdentity not initialized — call init() first');
  return publicKeyBase64;
}

/**
 * Returns the SHA-256 hex digest of the DER-encoded SPKI public key.
 */
function getPublicKeyHash() {
  if (!publicKeyHash) throw new Error('instanceIdentity not initialized — call init() first');
  return publicKeyHash;
}

// ---------------------------------------------------------------------------
// OCP attestation claim
// ---------------------------------------------------------------------------

/**
 * RFC 8785 canonical JSON — minimal implementation for signing claims.
 */
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalize(value[k]); }).join(',') + '}';
  }
  throw new Error('canonicalize: unsupported type ' + typeof value);
}

/**
 * Create and self-sign an OCP attestation claim. The claim asserts the identity of this instance, its hardware measurement, and its environment.
 */
function issueAttestationClaim(options) {
  if (!privateKey) throw new Error('instanceIdentity not initialized — call init() first');

  options = options || {};
  const env = detectEnvironment();
  const measurement = readMeasurement();
  const imageHash = readImageHash();
  const now = Math.floor(Date.now() / 1000);

  const claim = {
    ocp: 1,
    iss: 'safebox://' + publicKeyHash,
    stm: {
      type: 'attestation',
      instancePublicKey: publicKeyBase64,
      measurement: measurement,
      cloud: options.cloud || env.cloud,
      hardwareRoot: options.hardwareRoot || env.hardwareRoot,
      imageHash: options.imageHash || imageHash,
      bootTime: options.bootTime || new Date().toISOString()
    },
    nbf: now,
    exp: now + 86400
  };

  // Sign the claim without key/sig fields
  const canonical = canonicalize(claim);
  const signature = crypto.sign('sha256', Buffer.from(canonical), privateKey);

  // Attach key and signature
  claim.key = [publicKeyBase64];
  claim.sig = [signature.toString('base64')];

  return claim;
}

// ---------------------------------------------------------------------------
// Challenge-response
// ---------------------------------------------------------------------------

/**
 * Sign a challenge nonce with the instance key and return the attestation package.
 */
function handleChallenge(nonce) {
  if (!privateKey) throw new Error('instanceIdentity not initialized — call init() first');
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('Nonce must be a non-empty string');
  }

  const attestationClaim = issueAttestationClaim();
  const challengeSignature = crypto.sign('sha256', Buffer.from(nonce), privateKey);

  return {
    attestationClaim: attestationClaim,
    challengeSignature: challengeSignature.toString('base64'),
    nonce: nonce
  };
}

// ---------------------------------------------------------------------------
// Generic signing
// ---------------------------------------------------------------------------

/**
 * Sign arbitrary data with the instance private key (ES256). Returns a base64 signature.
 */
function sign(data) {
  if (!privateKey) throw new Error('instanceIdentity not initialized — call init() first');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const signature = crypto.sign('sha256', buf, privateKey);
  return signature.toString('base64');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init: init,
  getPublicKey: getPublicKey,
  getPublicKeyHash: getPublicKeyHash,
  issueAttestationClaim: issueAttestationClaim,
  handleChallenge: handleChallenge,
  sign: sign
};
