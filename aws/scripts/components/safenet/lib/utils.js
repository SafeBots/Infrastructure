'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * Resolve a Q platform class module path.
 * Checks Q_CLASSES_PATH env var first, then tries Node's normal
 * require resolution (works when Q is in NODE_PATH), then falls
 * back to a relative path from this file into the dev tree.
 *
 * @param {string} mod - Module name relative to Q classes dir, e.g. 'Q/Crypto'
 * @returns {string} Resolved path suitable for require()
 */
function resolveQ(mod) {
  if (process.env.Q_CLASSES_PATH) {
    return path.join(process.env.Q_CLASSES_PATH, mod);
  }
  try {
    return require.resolve(mod);
  } catch (_) {
    // Dev-tree fallback: lib/ -> safenet/ -> components/ -> scripts/
    // -> aws/ -> Infrastructure/ -> infra/ -> (repo root) -> qbix/platform/platform/classes/
    return path.resolve(
      __dirname, '..', '..', '..', '..', '..', '..', '..', '..',
      'qbix', 'platform', 'platform', 'classes', mod
    );
  }
}

/**
 * SHA-256 hex digest of a Buffer or string.
 *
 * @param {Buffer|string} data
 * @returns {string} Lowercase hex hash
 */
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate a random hex string.
 *
 * @param {number} bytes - Number of random bytes (output is 2x this length)
 * @returns {string} Lowercase hex string
 */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Canonical JSON serialisation per RFC 8785 (JCS).
 * Handles sorted keys recursively; does not handle the full spec
 * (no special float serialisation) but covers the claim structures
 * used in Safenet OCP claims.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = [];
  for (const k of keys) {
    if (value[k] === undefined) continue;
    entries.push(JSON.stringify(k) + ':' + canonicalJSON(value[k]));
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Generate the claim hash: SHA-256 of the RFC 8785 canonical
 * serialisation of the claim's `stm` (statement) field.
 *
 * @param {object} claim - An OCP claim object with a `stm` field
 * @returns {string} Lowercase hex hash of the canonical stm
 */
function generateClaimHash(claim) {
  if (!claim || !claim.stm) {
    throw new Error('Claim must have a stm field');
  }
  return sha256hex(canonicalJSON(claim.stm));
}

/**
 * Current time as an ISO 8601 string (UTC, no milliseconds).
 *
 * @returns {string} e.g. "2026-10-07T12:34:56Z"
 */
function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Basic semver validation (major.minor.patch with optional pre-release).
 *
 * @param {string} version
 * @returns {boolean}
 */
function validateSemver(version) {
  if (typeof version !== 'string') return false;
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.test(version);
}

/**
 * Reserved namespace prefixes that authors cannot claim.
 * @type {string[]}
 */
const RESERVED_PREFIXES = ['safebox-', 'safenet-', 'system-'];

/**
 * Validate a Safenet namespace name.
 *
 * Rules:
 *   - Lowercase alphanumeric and hyphens only
 *   - 1-64 characters
 *   - No leading or trailing hyphen
 *   - No consecutive hyphens
 *   - No reserved prefixes (safebox-, safenet-, system-)
 *
 * @param {string} name
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateNamespace(name) {
  if (typeof name !== 'string') {
    return { valid: false, reason: 'Namespace must be a string' };
  }
  if (name.length === 0 || name.length > 64) {
    return { valid: false, reason: 'Namespace must be 1-64 characters' };
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { valid: false, reason: 'Namespace must contain only lowercase alphanumeric characters and hyphens' };
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return { valid: false, reason: 'Namespace must not start or end with a hyphen' };
  }
  if (/--/.test(name)) {
    return { valid: false, reason: 'Namespace must not contain consecutive hyphens' };
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      return { valid: false, reason: `Namespace must not start with reserved prefix "${prefix}"` };
    }
  }
  return { valid: true };
}

module.exports = {
  resolveQ,
  sha256hex,
  randomHex,
  canonicalJSON,
  generateClaimHash,
  nowISO,
  validateSemver,
  validateNamespace,
  RESERVED_PREFIXES
};
