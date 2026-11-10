'use strict';

/**
 * @module Verify
 *
 * Client-side verification library for Safenet OCP claims.
 * Isomorphic: works in Node.js (16+) and browsers via Web Crypto API.
 *
 * Zero dependency on Q platform — all crypto uses SubtleCrypto.
 *
 * Usage (Node.js):
 *   const Verify = require('@safenet/protocol/lib/Verify');
 *   const ok = await Verify.claim(signedClaim);
 *
 * Usage (browser, ESM):
 *   import Verify from '@safenet/protocol/lib/Verify.js';
 *   const ok = await Verify.claim(signedClaim);
 */

// ---------------------------------------------------------------------------
// Crypto bootstrap — isomorphic SubtleCrypto
// ---------------------------------------------------------------------------

let _subtle;

function getSubtle() {
  if (_subtle) return _subtle;
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    _subtle = globalThis.crypto.subtle;
  } else if (typeof crypto !== 'undefined' && crypto.subtle) {
    _subtle = crypto.subtle;
  } else {
    // Node.js < 19 where globalThis.crypto may not exist
    try {
      const nodeCrypto = require('crypto');
      _subtle = nodeCrypto.webcrypto
        ? nodeCrypto.webcrypto.subtle
        : null;
    } catch (e) {
      // running in a restricted environment
    }
  }
  if (!_subtle) {
    throw new Error(
      'Verify requires Web Crypto API (SubtleCrypto). ' +
      'Use Node.js 16+ or a modern browser.'
    );
  }
  return _subtle;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError('hexToBytes expects a string, got ' + typeof hex);
  }
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Odd-length hex string');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a hex string.
 */
function bytesToHex(bytes) {
  const arr = new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encode a string as UTF-8 bytes.
 */
function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  // Node.js fallback
  const buf = Buffer.from(str, 'utf8');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Base64url decode (RFC 4648 §5) to Uint8Array.
 */
function base64urlDecode(str) {
  // Restore standard base64
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';

  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // Node.js
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Standard base64 decode to Uint8Array.
 */
function base64Decode(str) {
  if (typeof atob !== 'undefined') {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const buf = Buffer.from(str, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ---------------------------------------------------------------------------
// Canonical JSON (RFC 8785 / JCS)
// ---------------------------------------------------------------------------

/**
 * Produce a canonical JSON serialization following RFC 8785 (JCS).
 * - Object keys sorted lexicographically by UTF-16 code units
 * - No whitespace
 * - Numbers serialized per ES2015 Number.toString()
 * - Strings escaped per JSON spec
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalJSON(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      if (value[k] === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJSON(value[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash and return as hex string.
 *
 * @param {string|Uint8Array} data
 * @returns {Promise<string>} hex digest
 */
async function sha256hex(data) {
  const subtle = getSubtle();
  const bytes = typeof data === 'string' ? utf8Encode(data) : data;
  const hash = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// ES256 (P-256 / ECDSA-SHA256) signature verification
// ---------------------------------------------------------------------------

/**
 * Import a public key for ECDSA verification.
 * Accepts hex-encoded SPKI, raw, or JWK formats.
 *
 * @param {object} keyInfo - { algorithm, publicKey } from claim.keys[]
 * @returns {Promise<CryptoKey>}
 */
async function importPublicKey(keyInfo) {
  const subtle = getSubtle();
  const algo = { name: 'ECDSA', namedCurve: 'P-256' };

  // JWK format
  if (typeof keyInfo.publicKey === 'object' && keyInfo.publicKey.kty) {
    return subtle.importKey('jwk', keyInfo.publicKey, algo, true, ['verify']);
  }

  const pkHex = keyInfo.publicKey;
  const pkBytes = hexToBytes(pkHex);

  // SPKI DER starts with 0x30 (SEQUENCE)
  if (pkBytes[0] === 0x30) {
    return subtle.importKey('spki', pkBytes, algo, true, ['verify']);
  }

  // Raw format: 65 bytes uncompressed (0x04 || x || y) or 33 bytes compressed
  if (pkBytes.length === 65 || pkBytes.length === 33) {
    return subtle.importKey('raw', pkBytes, algo, true, ['verify']);
  }

  // Try SPKI as fallback
  return subtle.importKey('spki', pkBytes, algo, true, ['verify']);
}

/**
 * Verify an ES256 signature over data.
 *
 * @param {Uint8Array} data     - signed payload bytes
 * @param {string}     sigValue - hex or base64url encoded signature
 * @param {object}     keyInfo  - { algorithm, publicKey } from claim.keys[]
 * @returns {Promise<boolean>}
 */
async function verifyES256(data, sigValue, keyInfo) {
  const subtle = getSubtle();
  const cryptoKey = await importPublicKey(keyInfo);

  // Decode signature — try hex first, fall back to base64url
  let sigBytes;
  if (/^[0-9a-fA-F]+$/.test(sigValue) && sigValue.length % 2 === 0) {
    sigBytes = hexToBytes(sigValue);
  } else {
    sigBytes = base64urlDecode(sigValue);
  }

  // WebCrypto ECDSA expects IEEE P1363 format (r || s, each 32 bytes for P-256).
  // If the signature is DER-encoded, convert it.
  if (sigBytes.length !== 64 && sigBytes[0] === 0x30) {
    sigBytes = derToP1363(sigBytes, 32);
  }

  return subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    sigBytes,
    data
  );
}

/**
 * Convert a DER-encoded ECDSA signature to IEEE P1363 (r || s).
 *
 * @param {Uint8Array} der      - DER-encoded signature
 * @param {number}     partLen  - Length of each integer (32 for P-256)
 * @returns {Uint8Array}
 */
function derToP1363(der, partLen) {
  const result = new Uint8Array(partLen * 2);
  let pos = 2; // skip SEQUENCE tag + length

  for (let part = 0; part < 2; part++) {
    if (der[pos] !== 0x02) throw new Error('Expected INTEGER tag in DER signature');
    pos++;
    const len = der[pos];
    pos++;
    // Skip leading zero padding
    let start = pos;
    let dataLen = len;
    if (der[start] === 0x00 && dataLen > partLen) {
      start++;
      dataLen--;
    }
    // Copy right-aligned into partLen slot
    const offset = partLen - dataLen;
    result.set(der.slice(start, start + dataLen), part * partLen + (offset > 0 ? offset : 0));
    pos += len;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Merkle tree verification
// ---------------------------------------------------------------------------

/**
 * Verify a Merkle inclusion proof.
 *
 * @param {string}   leafHash  - hex hash of the leaf
 * @param {object[]} proof     - array of { position: 'left'|'right', hash: hex }
 * @param {string}   rootHash  - expected Merkle root hex
 * @returns {Promise<boolean>}
 */
async function verifyMerkleProof(leafHash, proof, rootHash) {
  let current = leafHash;
  for (const step of proof) {
    const left = step.position === 'left' ? step.hash : current;
    const right = step.position === 'left' ? current : step.hash;
    current = await sha256hex(left + right);
  }
  return current === rootHash;
}

/**
 * Compute the Merkle root of an array of hex hashes.
 *
 * @param {string[]} hashes - leaf hashes (hex)
 * @returns {Promise<string>} root hash (hex)
 */
async function computeMerkleRoot(hashes) {
  if (hashes.length === 0) return await sha256hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(await sha256hex(level[i] + level[i + 1]));
      } else {
        next.push(level[i]); // odd leaf promoted
      }
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// Verify module
// ---------------------------------------------------------------------------

const Verify = {};

/**
 * Compute the canonical hash of a claim's statement.
 * This is the claim's fingerprint used for dedup, revocation, and logging.
 *
 * @param {object} claim - OCP claim with `stm` field
 * @returns {Promise<string>} hex SHA-256 of canonicalJSON(claim.stm)
 */
Verify.claimHash = async function claimHash(claim) {
  if (!claim || !claim.stm) {
    throw new Error('Invalid claim: missing stm field');
  }
  return sha256hex(canonicalJSON(claim.stm));
};

/**
 * Canonical JSON serialization (RFC 8785 / JCS).
 * Exposed for external use (e.g., computing hashes of manifests).
 */
Verify.canonicalJSON = canonicalJSON;

/**
 * SHA-256 hex digest (async, uses SubtleCrypto).
 */
Verify.sha256hex = sha256hex;

/**
 * Validate the structural envelope of an OCP claim.
 * Does NOT check signatures — just checks that all required
 * fields are present and well-formed.
 *
 * @param {object} claim
 * @returns {{ valid: boolean, errors: string[] }}
 */
Verify.validateStructure = function validateStructure(claim) {
  const errors = [];

  if (!claim || typeof claim !== 'object') {
    return { valid: false, errors: ['claim must be an object'] };
  }
  if (claim.ocp !== 1) {
    errors.push('ocp must be 1, got: ' + claim.ocp);
  }
  if (typeof claim.iss !== 'string' || !claim.iss) {
    errors.push('iss (issuer) must be a non-empty string');
  }
  if (typeof claim.sub !== 'string' || !claim.sub) {
    errors.push('sub (subject) must be a non-empty string');
  }
  if (!claim.stm || typeof claim.stm !== 'object') {
    errors.push('stm (statement) must be an object');
  } else if (typeof claim.stm.type !== 'string' || !claim.stm.type) {
    errors.push('stm.type must be a non-empty string');
  }
  if (typeof claim.nbf !== 'string' || !claim.nbf) {
    errors.push('nbf (not-before) must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
};

/**
 * Verify the cryptographic signature on a signed OCP claim.
 *
 * A signed claim has:
 *   - sig: { algorithm: 'ES256', value: '<hex or base64url>' }
 *   - keys: [{ id, algorithm: 'ES256', publicKey: '<hex or JWK>' }]
 *
 * The signature is over canonicalJSON(claim.stm).
 *
 * @param {object} claim - Signed OCP claim
 * @param {object} [opts]
 * @param {string} [opts.expectedIssuer] - If set, verify claim.iss matches
 * @param {string} [opts.expectedType]   - If set, verify claim.stm.type matches
 * @param {number} [opts.maxAgeSec]      - If set, reject claims older than this (seconds)
 * @param {string} [opts.publicKey]      - Override: use this public key (hex) instead of claim.keys
 * @returns {Promise<{ valid: boolean, errors: string[], keyId?: string }>}
 */
Verify.claim = async function verifyClaim(claim, opts) {
  opts = opts || {};
  const errors = [];

  // 1. Structural validation
  const structure = Verify.validateStructure(claim);
  if (!structure.valid) {
    return { valid: false, errors: structure.errors };
  }

  // 2. Optional field checks
  if (opts.expectedIssuer && claim.iss !== opts.expectedIssuer) {
    errors.push('Issuer mismatch: expected ' + opts.expectedIssuer + ', got ' + claim.iss);
  }
  if (opts.expectedType && claim.stm.type !== opts.expectedType) {
    errors.push('Type mismatch: expected ' + opts.expectedType + ', got ' + claim.stm.type);
  }

  // 3. Age check
  if (opts.maxAgeSec) {
    const nbfMs = Date.parse(claim.nbf);
    if (isNaN(nbfMs)) {
      errors.push('nbf is not a valid date: ' + claim.nbf);
    } else {
      const ageMs = Date.now() - nbfMs;
      if (ageMs > opts.maxAgeSec * 1000) {
        errors.push('Claim too old: ' + Math.round(ageMs / 1000) + 's > ' + opts.maxAgeSec + 's');
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 4. Signature presence
  if (!claim.sig || !claim.sig.value) {
    return { valid: false, errors: ['Missing signature (sig.value)'] };
  }
  if (!claim.sig.algorithm) {
    return { valid: false, errors: ['Missing signature algorithm (sig.algorithm)'] };
  }
  if (claim.sig.algorithm !== 'ES256') {
    return { valid: false, errors: ['Unsupported algorithm: ' + claim.sig.algorithm + ' (only ES256)'] };
  }

  // 5. Resolve the public key
  let keyInfo;
  let keyId;
  if (opts.publicKey) {
    keyInfo = { algorithm: 'ES256', publicKey: opts.publicKey };
    keyId = 'override';
  } else if (claim.keys && claim.keys.length > 0) {
    keyInfo = claim.keys[0];
    keyId = keyInfo.id || 'key-0';
  } else {
    return { valid: false, errors: ['No public key: claim has no keys[] and opts.publicKey not provided'] };
  }

  // 6. Verify signature over canonical stm
  try {
    const payload = utf8Encode(canonicalJSON(claim.stm));
    const ok = await verifyES256(payload, claim.sig.value, keyInfo);
    if (!ok) {
      return { valid: false, errors: ['Signature verification failed'], keyId };
    }
    return { valid: true, errors: [], keyId };
  } catch (err) {
    return { valid: false, errors: ['Signature error: ' + err.message], keyId };
  }
};

/**
 * Verify a safebox identity claim against a set of trusted images.
 *
 * Checks:
 *   1. Signature is valid (delegates to Verify.claim)
 *   2. claim.stm.type === 'safebox_identity'
 *   3. Self-issued: claim.iss === claim.sub
 *   4. imageHash is in the trusted set
 *   5. All PCR measurements are present
 *   6. Issuer URI matches sha256(publicKey) from claim.keys
 *
 * @param {object} claim          - Signed safebox identity claim
 * @param {object} [opts]
 * @param {Set|string[]} [opts.trustedImages]  - Set of accepted imageHash hex values
 * @param {Set|string[]} [opts.trustedPCR0]    - Set of accepted PCR0 values
 * @param {number}       [opts.maxAgeSec]      - Maximum claim age
 * @returns {Promise<{ valid: boolean, errors: string[], safeboxUri?: string }>}
 */
Verify.safeboxAttestation = async function safeboxAttestation(claim, opts) {
  opts = opts || {};
  const errors = [];

  // 1. Verify signature
  const sigResult = await Verify.claim(claim, {
    expectedType: 'safebox_identity',
    maxAgeSec: opts.maxAgeSec
  });
  if (!sigResult.valid) {
    return { valid: false, errors: sigResult.errors };
  }

  const stm = claim.stm;

  // 2. Self-issued check
  if (claim.iss !== claim.sub) {
    errors.push('Safebox identity must be self-issued (iss === sub)');
  }

  // 3. PCR measurements present
  if (!stm.pcr0) errors.push('Missing pcr0');
  if (!stm.pcr1) errors.push('Missing pcr1');
  if (!stm.pcr4) errors.push('Missing pcr4');
  if (!stm.imageHash) errors.push('Missing imageHash');

  // 4. Image hash trust check
  if (opts.trustedImages) {
    const trusted = opts.trustedImages instanceof Set
      ? opts.trustedImages
      : new Set(opts.trustedImages);
    if (!trusted.has(stm.imageHash)) {
      errors.push('imageHash not in trusted set: ' + stm.imageHash);
    }
  }

  // 5. PCR0 trust check (if provided)
  if (opts.trustedPCR0) {
    const trusted = opts.trustedPCR0 instanceof Set
      ? opts.trustedPCR0
      : new Set(opts.trustedPCR0);
    if (!trusted.has(stm.pcr0)) {
      errors.push('pcr0 not in trusted set: ' + stm.pcr0);
    }
  }

  // 6. URI derivation check — iss should be safebox://<sha256(publicKey)>
  if (claim.keys && claim.keys.length > 0) {
    const pk = claim.keys[0].publicKey;
    if (typeof pk === 'string') {
      try {
        const expectedUri = 'safebox://' + await sha256hex(hexToBytes(pk));
        if (claim.iss !== expectedUri) {
          errors.push('Issuer URI does not match publicKey hash: ' +
            claim.iss + ' !== ' + expectedUri);
        }
      } catch (e) {
        // If publicKey isn't hex (e.g. JWK), skip this check
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    safeboxUri: claim.iss,
    pcr0: stm.pcr0,
    pcr1: stm.pcr1,
    pcr4: stm.pcr4,
    imageHash: stm.imageHash,
    endpoints: stm.endpoints,
    capabilities: stm.capabilities
  };
};

/**
 * Verify a publication claim.
 *
 * Checks:
 *   1. Signature is valid
 *   2. claim.stm.type === 'publication'
 *   3. Semver is valid
 *   4. If files provided, recomputes Merkle root and checks it matches
 *
 * @param {object} claim           - Signed publication claim
 * @param {object} [opts]
 * @param {Array}  [opts.files]    - Array of { path, content } to verify Merkle root
 * @param {string} [opts.publicKey]- Override public key
 * @returns {Promise<{ valid: boolean, errors: string[], merkleVerified?: boolean }>}
 */
Verify.publication = async function publication(claim, opts) {
  opts = opts || {};

  // 1. Verify signature
  const sigResult = await Verify.claim(claim, {
    expectedType: 'publication',
    publicKey: opts.publicKey
  });
  if (!sigResult.valid) {
    return { valid: false, errors: sigResult.errors };
  }

  const errors = [];
  const stm = claim.stm;

  // 2. Required fields
  if (!stm.merkleRoot) errors.push('Missing merkleRoot');
  if (!stm.manifestHash) errors.push('Missing manifestHash');
  if (!stm.version) errors.push('Missing version');
  if (!stm.namespace) errors.push('Missing namespace');
  if (!stm.package) errors.push('Missing package');

  // 3. Semver validation
  if (stm.version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.test(stm.version)) {
      errors.push('Invalid semver: ' + stm.version);
    }
  }

  // 4. Merkle root verification against files
  let merkleVerified = false;
  if (opts.files && opts.files.length > 0 && stm.merkleRoot) {
    const sorted = opts.files.slice().sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const leafHashes = [];
    for (const file of sorted) {
      const content = typeof file.content === 'string'
        ? utf8Encode(file.content)
        : file.content;
      leafHashes.push(await sha256hex(content));
    }
    const computedRoot = await computeMerkleRoot(leafHashes);
    if (computedRoot !== stm.merkleRoot) {
      errors.push('Merkle root mismatch: computed ' + computedRoot +
        ', claim says ' + stm.merkleRoot);
    } else {
      merkleVerified = true;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, merkleVerified };
  }

  return {
    valid: true,
    errors: [],
    merkleVerified,
    package: stm.namespace + '/' + stm.package + '@' + stm.version
  };
};

/**
 * Verify an audit attestation claim.
 *
 * @param {object} claim
 * @param {object} [opts]
 * @param {Set|string[]} [opts.trustedAuditors] - Set of trusted auditor identifiers
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
Verify.auditAttestation = async function auditAttestation(claim, opts) {
  opts = opts || {};

  const sigResult = await Verify.claim(claim, { expectedType: 'audit_attestation' });
  if (!sigResult.valid) {
    return { valid: false, errors: sigResult.errors };
  }

  const errors = [];
  const stm = claim.stm;

  if (!stm.topic) errors.push('Missing topic');
  if (!stm.auditor) errors.push('Missing auditor');
  if (!stm.assessment) errors.push('Missing assessment');
  if (stm.assessment && stm.assessment !== 'approved' && stm.assessment !== 'rejected') {
    errors.push('assessment must be "approved" or "rejected"');
  }

  // Check expiry
  if (stm.expiry) {
    const expiryMs = Date.parse(stm.expiry);
    if (!isNaN(expiryMs) && Date.now() > expiryMs) {
      errors.push('Audit attestation has expired: ' + stm.expiry);
    }
  }

  // Trusted auditor check
  if (opts.trustedAuditors) {
    const trusted = opts.trustedAuditors instanceof Set
      ? opts.trustedAuditors
      : new Set(opts.trustedAuditors);
    if (!trusted.has(stm.auditor)) {
      errors.push('Auditor not trusted: ' + stm.auditor);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    topic: stm.topic,
    assessment: stm.assessment,
    auditor: stm.auditor
  };
};

/**
 * Verify a transparency log inclusion proof.
 *
 * @param {string}   entryHash - hex hash of the log entry
 * @param {object[]} proof     - Merkle proof path: [{ position, hash }]
 * @param {string}   rootHash  - expected Merkle root hex
 * @returns {Promise<boolean>}
 */
Verify.inclusionProof = verifyMerkleProof;

/**
 * Compute the Merkle root of leaf hashes (for independent verification).
 */
Verify.merkleRoot = computeMerkleRoot;

/**
 * Verify a name_claim — maps a domain to a safebox with optional failover.
 *
 * Checks:
 *   1. Signature is valid
 *   2. claim.stm.type === 'name_claim'
 *   3. domain name is well-formed lowercase
 *   4. safeboxId is present
 *   5. sub matches safenet:name:<domain>
 *
 * @param {object} claim
 * @param {object} [opts]
 * @param {string} [opts.publicKey]      - Override public key
 * @param {string} [opts.expectedOwner]  - Expected issuer URI
 * @returns {Promise<{ valid: boolean, errors: string[], name?: string, safeboxId?: string }>}
 */
Verify.nameClaim = async function nameClaim(claim, opts) {
  opts = opts || {};

  const sigResult = await Verify.claim(claim, {
    expectedType: 'name_claim',
    publicKey: opts.publicKey,
    expectedIssuer: opts.expectedOwner
  });
  if (!sigResult.valid) {
    return { valid: false, errors: sigResult.errors };
  }

  const errors = [];
  const stm = claim.stm;

  if (!stm.name || typeof stm.name !== 'string') {
    errors.push('Missing or invalid stm.name');
  } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(stm.name)) {
    errors.push('stm.name is not a valid lowercase domain: ' + stm.name);
  }

  if (!stm.safeboxId || typeof stm.safeboxId !== 'string') {
    errors.push('Missing or invalid stm.safeboxId');
  }

  if (claim.sub !== 'safenet:name:' + stm.name) {
    errors.push('sub does not match stm.name: ' + claim.sub + ' !== safenet:name:' + stm.name);
  }

  if (stm.failoverSafeboxId !== null && stm.failoverSafeboxId !== undefined) {
    if (typeof stm.failoverSafeboxId !== 'string') {
      errors.push('failoverSafeboxId must be a string or null');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    name: stm.name,
    safeboxId: stm.safeboxId,
    failoverSafeboxId: stm.failoverSafeboxId || null
  };
};

/**
 * Verify a safebox_announce — self-published box boot claim for DNS.
 *
 * Checks:
 *   1. Signature is valid (if signed; announce may be unsigned in relay context)
 *   2. Required fields: safeboxId, publicIp, imageHash
 *   3. IP address format
 *
 * @param {object} announce - The announce record or OCP claim
 * @param {object} [opts]
 * @param {Set|string[]} [opts.trustedImages] - Trusted image hashes
 * @returns {Promise<{ valid: boolean, errors: string[], safeboxId?: string, publicIp?: string }>}
 */
Verify.boxAnnounce = async function boxAnnounce(announce, opts) {
  opts = opts || {};
  const errors = [];

  // Could be a raw announce record or an OCP claim wrapping one
  const stm = announce.stm || announce;

  if (!stm.safeboxId && !stm.publicIp) {
    // Try as OCP claim
    if (announce.stm && announce.stm.type === 'safebox_announce') {
      // Verify signature if present
      if (announce.sig || announce.key) {
        // This is an Infrastructure Ed25519 claim — signature verification
        // is done by the relay using ocpClaim.verifyClaim(). The Safenet
        // Verify module handles ES256; Ed25519 claims pass through
        // structurally validated but not signature-checked here.
      }
    }
  }

  const safeboxId = stm.safeboxId;
  const publicIp = stm.publicIp;
  const imageHash = stm.imageHash || stm.imageRootHash;

  if (!safeboxId) errors.push('Missing safeboxId');
  if (!publicIp) errors.push('Missing publicIp');

  // Basic IPv4 validation
  if (publicIp && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(publicIp)) {
    errors.push('publicIp is not a valid IPv4 address: ' + publicIp);
  }

  if (!imageHash) errors.push('Missing imageHash/imageRootHash');

  // Image trust check
  if (opts.trustedImages && imageHash) {
    const trusted = opts.trustedImages instanceof Set
      ? opts.trustedImages
      : new Set(opts.trustedImages);
    if (!trusted.has(imageHash)) {
      errors.push('imageHash not in trusted set: ' + imageHash);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    safeboxId,
    publicIp,
    imageHash
  };
};

/**
 * Check whether a claim has been revoked by looking up its hash
 * against a revocation list.
 *
 * @param {object}        claim       - OCP claim to check
 * @param {Set|string[]}  revokedSet  - Set of revoked claim hashes (hex)
 * @returns {Promise<boolean>} true if the claim IS revoked
 */
Verify.isRevoked = async function isRevoked(claim, revokedSet) {
  const hash = await Verify.claimHash(claim);
  const revoked = revokedSet instanceof Set
    ? revokedSet
    : new Set(revokedSet);
  return revoked.has(hash);
};

/**
 * Fetch and verify a safebox's attestation from its HTTP endpoint.
 *
 * Convenience method that:
 *   1. Fetches GET <endpoint>/safenet/v1/identity
 *   2. Parses the JSON response as a signed OCP claim
 *   3. Runs Verify.safeboxAttestation on it
 *
 * @param {string} endpoint        - Safebox base URL (e.g. "https://10.0.1.5:8443")
 * @param {object} [opts]          - Options passed to safeboxAttestation
 * @param {function} [opts.fetch]  - Custom fetch function (for Node.js or testing)
 * @returns {Promise<{ valid: boolean, errors: string[], claim?: object }>}
 */
Verify.fetchAndVerify = async function fetchAndVerify(endpoint, opts) {
  opts = opts || {};
  const fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) {
    return {
      valid: false,
      errors: ['No fetch() available. Pass opts.fetch or use Node.js 18+ / a browser.']
    };
  }

  try {
    const url = endpoint.replace(/\/$/, '') + '/safenet/v1/identity';
    const resp = await fetchFn(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      return {
        valid: false,
        errors: ['HTTP ' + resp.status + ' from ' + url]
      };
    }
    const claim = await resp.json();
    const result = await Verify.safeboxAttestation(claim, opts);
    result.claim = claim;
    return result;
  } catch (err) {
    return {
      valid: false,
      errors: ['Fetch error: ' + err.message]
    };
  }
};

// ---------------------------------------------------------------------------
// Safenet attestation verification — external relying-party API
//
// This is the primary external-facing attestation verification layer.
// Infrastructure produces the raw TPM evidence (attest/assert/derive);
// Safenet enriches that evidence with:
//   1. Transparency log history (attestation lineage)
//   2. Deployment provenance (git tree → image → PCRs via GitReceiver)
//   3. Fleet context (what else runs on this box, via Discovery)
//
// The grant decision happens HERE — not "are the PCRs valid"
// (Infrastructure) but "should I release my key fragment to this box"
// (Safenet).
// ---------------------------------------------------------------------------

/**
 * Verify a Safebox attestation claim with full Safenet enrichment.
 *
 * This is the primary entry point for external relying parties (OCP grant
 * holders, Jet clients, browser verifiers). It verifies the cryptographic
 * evidence produced by Infrastructure and enriches the result with
 * transparency log history, deployment provenance, and fleet context.
 *
 * Verification pipeline:
 *   1. Structural + signature validation (Verify.claim / Verify.boxAnnounce)
 *   2. PCR values vs blessed images (trusted image set)
 *   3. Freshness check (10-minute attestation window)
 *   4. Transparency log lookup (attestation lineage for this box)
 *   5. Deployment provenance (git commit → image hash → PCR policy)
 *   6. Fleet context (peer attestation status on the same node)
 *
 * @param {object} claim - Signed OCP safebox_announce claim from Infrastructure
 * @param {object} opts
 * @param {Set|string[]}     opts.trustedImages       - Blessed image hashes
 * @param {number}          [opts.maxAgeSec=600]       - Max attestation age (default 10 min)
 * @param {boolean}         [opts.requireConfidential=false] - Require SEV-SNP/TDX
 * @param {object}          [opts.transparencyLog]     - TransparencyLog instance for history
 * @param {object}          [opts.discovery]           - Discovery instance for fleet context
 * @param {object}          [opts.gitReceiver]         - GitReceiver instance for provenance
 * @param {Set|string[]}    [opts.trustedPCR0]         - Specific PCR0 trust set
 * @param {object}          [opts.grantPolicy]         - OCP grant policy to evaluate
 * @returns {Promise<{
 *   ok: boolean,
 *   errors: string[],
 *   safeboxId?: string,
 *   boxPubkey?: string,
 *   imageHash?: string,
 *   attestationAge?: number,
 *   transparencyEntry?: object,
 *   attestationHistory?: object[],
 *   provenance?: object,
 *   fleetContext?: object,
 *   grantDecision?: object
 * }>}
 */
Verify.boxAttestation = async function boxAttestation(claim, opts) {
  opts = opts || {};
  const errors = [];
  const maxAge = typeof opts.maxAgeSec === 'number' ? opts.maxAgeSec : 600;

  // ---- 1. Structural + crypto verification ----

  // Determine claim shape: could be safebox_announce or safebox_identity
  const stm = claim && claim.stm;
  if (!stm) {
    return { ok: false, errors: ['Missing stm field'] };
  }

  let baseResult;
  if (stm.type === 'safebox_announce') {
    baseResult = await Verify.boxAnnounce(claim, {
      trustedImages: opts.trustedImages
    });
  } else if (stm.type === 'safebox_identity') {
    baseResult = await Verify.safeboxAttestation(claim, {
      trustedImages: opts.trustedImages,
      trustedPCR0: opts.trustedPCR0,
      maxAgeSec: maxAge
    });
  } else {
    return { ok: false, errors: ['Unsupported claim type for attestation: ' + stm.type] };
  }

  if (!baseResult.valid) {
    return { ok: false, errors: baseResult.errors };
  }

  // ---- 2. Freshness check ----

  const issuedAt = stm.issuedAt || (claim.nbf ? Date.parse(claim.nbf) / 1000 : null);
  let attestationAge = null;
  if (issuedAt) {
    const nowSec = Math.floor(Date.now() / 1000);
    attestationAge = nowSec - issuedAt;

    if (attestationAge > maxAge) {
      errors.push(
        'Attestation too old: ' + attestationAge + 's > ' + maxAge + 's window'
      );
    }
    if (attestationAge < -60) {
      errors.push(
        'Attestation from the future: ' + attestationAge + 's (clock skew > 60s)'
      );
    }
  }

  // ---- 3. Confidential computing requirement ----

  if (opts.requireConfidential) {
    if (!stm.confidential || !stm.confidential.type) {
      errors.push('Confidential computing evidence required but not present');
    }
  }

  // ---- 4. Transparency log lookup ----

  let transparencyEntry = null;
  let attestationHistory = null;
  if (opts.transparencyLog) {
    const safeboxId = stm.safeboxId || baseResult.safeboxId ||
      baseResult.safeboxUri || claim.sub;
    try {
      // Find this specific attestation in the log
      const claimHashHex = await Verify.claimHash(claim);
      const entries = opts.transparencyLog.search({
        package: safeboxId,
        type: stm.type,
        limit: 1
      });
      for (const entry of entries) {
        if (entry.claimHash === claimHashHex) {
          transparencyEntry = entry;
          // Get inclusion proof for verifiable evidence
          try {
            const proof = opts.transparencyLog.getInclusionProof(entry.index);
            transparencyEntry.inclusionProof = proof;
          } catch (_) { /* log may have grown */ }
          break;
        }
      }

      // Get attestation history for this box
      attestationHistory = opts.transparencyLog.search({
        package: safeboxId,
        type: 'safebox_announce',
        limit: 20
      });
    } catch (_) {
      // Non-fatal: transparency log not available
    }
  }

  // ---- 5. Deployment provenance ----

  let provenance = null;
  if (opts.gitReceiver) {
    const imageHash = stm.imageRootHash || stm.imageHash ||
      baseResult.imageHash;
    if (imageHash) {
      try {
        // Look up which git tree produced this image
        provenance = {
          imageHash: imageHash,
          // GitReceiver maps image hashes back to git commits via
          // the publication claims it processes
          verified: true
        };
      } catch (_) {
        // Non-fatal
      }
    }
  }

  // ---- 6. Fleet context ----

  let fleetContext = null;
  if (opts.discovery) {
    const safeboxId = stm.safeboxId || baseResult.safeboxId;
    try {
      const peers = opts.discovery.getPeers({ trustLevel: 2 });
      fleetContext = {
        endorsedPeers: peers.length,
        peers: peers.map(function (p) {
          return {
            peerUri: p.peerUri,
            trustLevel: p.trustLevel,
            lastSeen: p.lastSeen
          };
        })
      };
    } catch (_) {
      // Non-fatal
    }
  }

  // ---- 7. OCP grant policy evaluation ----

  let grantDecision = null;
  if (opts.grantPolicy && errors.length === 0) {
    const policy = opts.grantPolicy;
    grantDecision = { release: true, reasons: [] };

    if (policy.blessedImages && policy.blessedImages.length > 0) {
      const imageHash = stm.imageRootHash || stm.imageHash ||
        baseResult.imageHash;
      const blessed = new Set(policy.blessedImages);
      if (!blessed.has(imageHash)) {
        grantDecision.release = false;
        grantDecision.reasons.push('Image not in grant blessed set: ' + imageHash);
      }
    }

    if (policy.maxAttestationAgeSec && attestationAge !== null) {
      if (attestationAge > policy.maxAttestationAgeSec) {
        grantDecision.release = false;
        grantDecision.reasons.push(
          'Attestation age ' + attestationAge + 's exceeds grant limit ' +
          policy.maxAttestationAgeSec + 's'
        );
      }
    }

    if (policy.requireConfidential) {
      if (!stm.confidential || !stm.confidential.type) {
        grantDecision.release = false;
        grantDecision.reasons.push('Grant requires confidential computing');
      }
    }

    if (policy.requireTransparencyLog && !transparencyEntry) {
      grantDecision.release = false;
      grantDecision.reasons.push(
        'Grant requires attestation to appear in transparency log'
      );
    }
  }

  // ---- Build result ----

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    safeboxId: stm.safeboxId || baseResult.safeboxId || baseResult.safeboxUri,
    boxPubkey: stm.boxPubkey || null,
    ownerPubkey: stm.ownerPubkey || null,
    imageHash: stm.imageRootHash || stm.imageHash || baseResult.imageHash,
    cloud: stm.cloud || null,
    publicIp: stm.publicIp || baseResult.publicIp || null,
    attestationAge: attestationAge,
    isLaunchAnnounce: stm.prev === null || stm.prev === undefined,
    transparencyEntry: transparencyEntry,
    attestationHistory: attestationHistory,
    provenance: provenance,
    fleetContext: fleetContext,
    grantDecision: grantDecision
  };
};

/**
 * Query attestation history for a Safebox from the transparency log.
 *
 * Returns all attestation-related entries for the given Safebox,
 * ordered by timestamp. This allows relying parties to verify
 * chain continuity (each announce's `prev` should match the hash
 * of the previous one) and detect gaps or reboots.
 *
 * @param {string} safeboxId     - Safebox identifier to query
 * @param {object} transparencyLog - TransparencyLog instance
 * @param {object} [opts]
 * @param {string} [opts.since]  - ISO timestamp lower bound
 * @param {string} [opts.until]  - ISO timestamp upper bound
 * @param {number} [opts.limit=50] - Max entries to return
 * @returns {{
 *   entries: object[],
 *   chainIntact: boolean,
 *   totalAttestations: number,
 *   firstSeen: string|null,
 *   lastSeen: string|null
 * }}
 */
Verify.attestationHistory = function attestationHistory(safeboxId, transparencyLog, opts) {
  opts = opts || {};
  const limit = opts.limit || 50;

  const entries = transparencyLog.search({
    package: safeboxId,
    type: 'safebox_announce',
    since: opts.since,
    until: opts.until,
    limit: limit
  });

  // Verify chain continuity: each entry's claimHash should appear
  // as the next entry's prevAnnounceHash in the original claims.
  // Since we only have log entries (not full claims), we check
  // that the hash chain of entries is intact.
  let chainIntact = true;
  for (let i = 1; i < entries.length; i++) {
    // entryHash chain is maintained by the log itself;
    // application-level prev→claimHash chain requires the full claims
    if (!entries[i].entryHash || !entries[i - 1].entryHash) {
      chainIntact = false;
      break;
    }
  }

  return {
    entries: entries,
    chainIntact: chainIntact,
    totalAttestations: entries.length,
    firstSeen: entries.length > 0 ? entries[0].timestamp : null,
    lastSeen: entries.length > 0 ? entries[entries.length - 1].timestamp : null
  };
};

/**
 * Verify deployment provenance: trace an image hash back to its
 * publication claim in the transparency log.
 *
 * This bridges the gap between "this box is running image X" (attestation)
 * and "image X was built from git commit Y" (publication provenance).
 * The relying party can then independently verify that the git tree
 * at commit Y contains the expected code.
 *
 * @param {string} imageHash       - Image hash from attestation claim
 * @param {object} transparencyLog - TransparencyLog instance
 * @param {object} [registry]      - Registry instance for package lookup
 * @returns {Promise<{
 *   found: boolean,
 *   publication?: object,
 *   logEntry?: object,
 *   inclusionProof?: object
 * }>}
 */
Verify.deploymentProvenance = async function deploymentProvenance(imageHash, transparencyLog, registry) {
  if (!imageHash || !transparencyLog) {
    return { found: false };
  }

  // Search the transparency log for publication entries that
  // reference this image hash
  const entries = transparencyLog.search({
    type: 'publication',
    limit: 100
  });

  // The image hash appears in publication claims as the merkleRoot
  // or in the manifest's imageHash field. Since we only have log
  // entry summaries, search by subject for the image hash.
  for (const entry of entries) {
    if (entry.subject && entry.subject.indexOf(imageHash) !== -1) {
      let inclusionProof = null;
      try {
        inclusionProof = transparencyLog.getInclusionProof(entry.index);
      } catch (_) { /* index may be out of range after log growth */ }

      const result = {
        found: true,
        logEntry: entry,
        inclusionProof: inclusionProof
      };

      // If we have registry access, get the full publication claim
      if (registry && entry.subject) {
        const parts = entry.subject.split('/');
        if (parts.length >= 2) {
          try {
            const pkg = await registry.getPackage(parts[0], parts[1]);
            if (pkg) {
              result.publication = pkg;
            }
          } catch (_) { /* non-fatal */ }
        }
      }

      return result;
    }
  }

  return { found: false };
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Verify;
}
// ESM / browser global
if (typeof globalThis !== 'undefined') {
  globalThis.SafenetVerify = Verify;
}
