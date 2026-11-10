'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Persistent, append-only state: lives on the encrypted pool under the
// module's own subdirectory of /var/lib/safebox (docs/HARDENING-PLAN.md,
// "Runtime paths"). The root filesystem is read-only and /etc is a
// non-persistent tmpfs overlay, so nothing written here may go there.
// SAFEBOX_SYSTEM_TRANSPARENCY_DIR relocates the directory for tests.
const STATE_DIR = process.env.SAFEBOX_SYSTEM_TRANSPARENCY_DIR || '/var/lib/safebox/transparency';
const LOG_PATH = path.join(STATE_DIR, 'transparency.json');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let log = null;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Read the transparency log from disk, or create a fresh one if it doesn't exist.
 */
function loadLog() {
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // caller will create a new one
    }
    throw err;
  }
}

/**
 * Write the transparency log atomically (tmp file + rename).
 */
function saveLog() {
  if (!log) throw new Error('Transparency log not initialized — call init() first');

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
  const tmp = LOG_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
  fs.renameSync(tmp, LOG_PATH);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Load or create the transparency log. Requires instanceIdentity to be initialized if creating a fresh log (the caller should pass the instance ID).
 */
function init(instanceId) {
  log = loadLog();
  if (!log) {
    log = {
      instanceId: instanceId || 'unknown',
      created: new Date().toISOString(),
      successionChain: [],
      keyRotations: [],
      volumeBlessings: []
    };
    saveLog();
  }
  return log;
}

// ---------------------------------------------------------------------------
// Append operations (all append-only — entries are never removed)
// ---------------------------------------------------------------------------

/**
 * Append a succession claim to the chain. A succession claim records a transfer of authority from one instance identity to another.
 */
function addSuccession(successionClaim) {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  if (!successionClaim || typeof successionClaim !== 'object') {
    throw new Error('Succession claim must be a non-null object');
  }

  const entry = {
    timestamp: new Date().toISOString(),
    claim: successionClaim
  };
  log.successionChain.push(entry);
  saveLog();
  return entry;
}

/**
 * Append a key rotation event. Records when a governance key or operational key is rotated.
 */
function addKeyRotation(rotationClaim) {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  if (!rotationClaim || typeof rotationClaim !== 'object') {
    throw new Error('Rotation claim must be a non-null object');
  }

  const entry = {
    timestamp: new Date().toISOString(),
    claim: rotationClaim
  };
  log.keyRotations.push(entry);
  saveLog();
  return entry;
}

/**
 * Record a volume blessing. Links a volume's manifest hash to the OCP blessing claim that authorized its installation.
 */
function addVolumeBlessing(volumeHash, blessingClaim) {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  if (typeof volumeHash !== 'string' || volumeHash.length === 0) {
    throw new Error('Volume hash must be a non-empty string');
  }
  if (!blessingClaim || typeof blessingClaim !== 'object') {
    throw new Error('Blessing claim must be a non-null object');
  }

  const entry = {
    timestamp: new Date().toISOString(),
    volumeHash: volumeHash,
    claim: blessingClaim
  };
  log.volumeBlessings.push(entry);
  saveLog();
  return entry;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Returns the full succession chain in chronological order.
 */
function getSuccessionChain() {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  return log.successionChain.slice();
}

/**
 * Returns the key rotation history in chronological order.
 */
function getKeyRotationHistory() {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  return log.keyRotations.slice();
}

/**
 * Returns all volume blessing records in chronological order.
 */
function getVolumeBlessings() {
  if (!log) throw new Error('Transparency log not initialized — call init() first');
  return log.volumeBlessings.slice();
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Handle HTTP requests for the transparency log.
 * All endpoints are public (no auth required) — the log is designed for auditability.
 * @param {string} method - HTTP method
 * @param {string} pathname - URL path
 * @returns {{statusCode: number, body: object}}
 */
function handle(method, pathname) {
  if (method !== 'GET') {
    return { statusCode: 405, body: { error: 'Method not allowed' } };
  }

  if (!log) {
    return { statusCode: 503, body: { error: 'Transparency log not initialized' } };
  }

  // GET /transparency — full log
  if (pathname === '/transparency') {
    return {
      statusCode: 200,
      body: {
        instanceId: log.instanceId,
        created: log.created,
        successionChain: log.successionChain,
        keyRotations: log.keyRotations,
        volumeBlessings: log.volumeBlessings
      }
    };
  }

  // GET /transparency/succession — just the succession chain
  if (pathname === '/transparency/succession') {
    return {
      statusCode: 200,
      body: { successionChain: log.successionChain }
    };
  }

  // GET /transparency/keys — just key rotation history
  if (pathname === '/transparency/keys') {
    return {
      statusCode: 200,
      body: { keyRotations: log.keyRotations }
    };
  }

  return { statusCode: 404, body: { error: 'Not found' } };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init: init,
  addSuccession: addSuccession,
  addKeyRotation: addKeyRotation,
  addVolumeBlessing: addVolumeBlessing,
  getSuccessionChain: getSuccessionChain,
  getKeyRotationHistory: getKeyRotationHistory,
  getVolumeBlessings: getVolumeBlessings,
  handle: handle
};
