// /opt/safebox/system/governanceKeys.js
//
// Manages the trusted governance key registry. Governance keys are identified
// by data:key/ URIs (supporting both ES256 and ML-DSA-65):
//   - data:key/es256;base64,<SPKI-DER>
//   - data:key/ml-dsa-65;base64,<raw-1952-byte-pk>
//
// All OCP claims from the Safebox layer must be verified against this registry
// before the system acts on them.
//
// The registry lives at /var/lib/safebox/governance/governance-keys.json
// (on the encrypted pool: key rotations rewrite it at runtime, and the root
// filesystem is read-only with /etc as a non-persistent tmpfs overlay). It
// is loaded at startup. SIGHUP triggers a reload (same pattern as config.js — parse
// failure keeps the previous config).
//
// Key rotation is applied through OCP claims of type 'key_rotation'. The
// claim must be verified against the CURRENT key set with the 'system'
// threshold before applyRotation is called. Rotations are rate-limited
// with exponential backoff: no more than 1 rotation per hour by default,
// with the cooldown doubling for each rotation within a 24-hour window.
//
// Identity deduplication: each key entry may carry an 'identity' field.
// When present, multiple keys with the same identity value belong to the
// same signer (e.g. an ES256 key and an ML-DSA-65 key for the same person).
// verifyThreshold counts distinct identities, not distinct keys, so a
// single signer with both key types counts once toward the M-of-N threshold.
//
// Registry schema (v2):
//   {
//     "version": 2,
//     "keys": {
//       "<label>": {
//         "publicKey": "data:key/es256;base64,...",
//         "identity": "<identity-id>",
//         "roles": ["admin", ...],
//         "addedBy": "<label-or-genesis>",
//         "addedAt": "<iso8601>"
//       }
//     },
//     "thresholds": {
//       "system":              { "m": 3, "n": 5 },
//       "containers/create":   { "m": 4, "n": 5 },
//       "containers/destroy":  { "m": 4, "n": 5 },
//       "models/install":      { "m": 2, "n": 3 },
//       "volumes/install":     { "m": 2, "n": 3 },
//       "manifest/approve":    { "m": 2, "n": 3 },
//       "succession/initiate": { "m": 4, "n": 5 }
//     }
//   }

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SAFEBOX_GOVERNANCE_KEYS names a full file path (tests point it at a temp
// file); the directory is derived from it so the atomic write below can
// create it.
const STATE_DIR_DEFAULT = '/var/lib/safebox/governance';
const KEYS_PATH = process.env.SAFEBOX_GOVERNANCE_KEYS || path.join(STATE_DIR_DEFAULT, 'governance-keys.json');

// Rate-limiting defaults for key rotation
const ROTATION_BASE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;   // 24 hours

let registry = null;             // parsed registry object
let trustedKeysSet = new Set();  // Set of publicKey URI strings for fast lookup
let identityMap = new Map();     // Map<keyUri, identityId> for threshold dedup
let rotationHistory = [];        // timestamps of recent rotations for backoff

// ── Validation ──────────────────────────────────────────────────────────────

function validateRegistry(obj) {
    if (!obj || typeof obj !== 'object') {
        throw new Error('governance-keys.json root must be an object');
    }
    // Accept version 1 (legacy) or 2 (with data:key/ URIs and identity)
    if (obj.version !== 1 && obj.version !== 2) {
        throw new Error(`unsupported governance-keys version: ${obj.version}`);
    }
    if (!obj.keys || typeof obj.keys !== 'object') {
        throw new Error('governance-keys.json must have a "keys" object');
    }
    if (!obj.thresholds || typeof obj.thresholds !== 'object') {
        throw new Error('governance-keys.json must have a "thresholds" object');
    }
    if (!obj.thresholds.system || typeof obj.thresholds.system.m !== 'number') {
        throw new Error('governance-keys.json must define a "system" threshold with numeric "m"');
    }

    for (const [label, entry] of Object.entries(obj.keys)) {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`key "${label}" must be an object`);
        }
        if (typeof entry.publicKey !== 'string' || entry.publicKey.length === 0) {
            throw new Error(`key "${label}" must have a non-empty publicKey`);
        }
        if (!Array.isArray(entry.roles)) {
            throw new Error(`key "${label}" must have a roles array`);
        }
        if (typeof entry.addedBy !== 'string') {
            throw new Error(`key "${label}" must have an addedBy string`);
        }
        if (typeof entry.addedAt !== 'string') {
            throw new Error(`key "${label}" must have an addedAt string`);
        }
        // identity is optional (v2) — if present must be a non-empty string
        if (entry.identity !== undefined && (typeof entry.identity !== 'string' || entry.identity.length === 0)) {
            throw new Error(`key "${label}" identity must be a non-empty string if provided`);
        }
    }

    for (const [op, thresh] of Object.entries(obj.thresholds)) {
        if (!thresh || typeof thresh !== 'object') {
            throw new Error(`threshold "${op}" must be an object`);
        }
        if (typeof thresh.m !== 'number' || thresh.m < 1) {
            throw new Error(`threshold "${op}" must have m >= 1`);
        }
        if (typeof thresh.n !== 'number' || thresh.n < thresh.m) {
            throw new Error(`threshold "${op}" must have n >= m`);
        }
    }
}

function buildTrustedSet(reg) {
    const s = new Set();
    for (const entry of Object.values(reg.keys)) {
        s.add(entry.publicKey);
    }
    return s;
}

function buildIdentityMap(reg) {
    const m = new Map();
    for (const entry of Object.values(reg.keys)) {
        if (entry.identity) {
            m.set(entry.publicKey, entry.identity);
        }
    }
    return m;
}

// ── Load / Reload ───────────────────────────────────────────────────────────

function load() {
    let raw;
    try {
        raw = fs.readFileSync(KEYS_PATH, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.warn(`[system] WARN ${KEYS_PATH} not found; governance verification will reject all claims`);
            registry = { version: 2, keys: {}, thresholds: { system: { m: 1, n: 1 } } };
            trustedKeysSet = new Set();
            identityMap = new Map();
            return;
        }
        throw e;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`${KEYS_PATH} is not valid JSON: ${e.message}`);
    }

    validateRegistry(parsed);
    registry = parsed;
    trustedKeysSet = buildTrustedSet(registry);
    identityMap = buildIdentityMap(registry);
    console.log(`[system] governance keys loaded: ${trustedKeysSet.size} keys, ${identityMap.size} with identity, ${Object.keys(registry.thresholds).length} threshold rules`);
}

function reload() {
    let raw;
    try {
        raw = fs.readFileSync(KEYS_PATH, 'utf8');
    } catch (e) {
        console.warn(`[system] governance-keys reload failed (read): ${e.message}; keeping previous config`);
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.warn(`[system] governance-keys reload failed (parse): ${e.message}; keeping previous config`);
        return;
    }

    try {
        validateRegistry(parsed);
    } catch (e) {
        console.warn(`[system] governance-keys reload failed (validate): ${e.message}; keeping previous config`);
        return;
    }

    registry = parsed;
    trustedKeysSet = buildTrustedSet(registry);
    identityMap = buildIdentityMap(registry);
    console.log(`[system] governance keys reloaded: ${trustedKeysSet.size} keys`);
}

// ── Queries ─────────────────────────────────────────────────────────────────

function getThreshold(operation) {
    if (!registry) throw new Error('governance keys not loaded');
    const t = registry.thresholds[operation];
    if (t) return { m: t.m, n: t.n };
    // Fall back to the system threshold for unconfigured operations
    const sys = registry.thresholds.system;
    return { m: sys.m, n: sys.n };
}

function getTrustedKeys() {
    return trustedKeysSet;
}

function getIdentityMap() {
    return identityMap;
}

// ── Key rotation ────────────────────────────────────────────────────────────
// Applies a verified key_rotation claim. The caller MUST have already verified
// the claim against the current key set with the system threshold. This
// function trusts the caller's verification and applies the mutation.

function pruneRotationHistory() {
    const cutoff = Date.now() - ROTATION_WINDOW_MS;
    rotationHistory = rotationHistory.filter(ts => ts > cutoff);
}

function checkRotationCooldown() {
    pruneRotationHistory();
    if (rotationHistory.length === 0) return null;

    // Exponential backoff: base cooldown doubles for each rotation in the window
    const cooldownMs = ROTATION_BASE_COOLDOWN_MS * Math.pow(2, rotationHistory.length - 1);
    const lastRotation = rotationHistory[rotationHistory.length - 1];
    const elapsed = Date.now() - lastRotation;

    if (elapsed < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
        return `rotation rate limit: wait ${waitSec}s (cooldown ${Math.round(cooldownMs / 1000)}s, ${rotationHistory.length} rotations in 24h window)`;
    }
    return null;
}

function applyRotation(rotationClaim) {
    if (!registry) throw new Error('governance keys not loaded');

    const stm = rotationClaim.stm;
    if (!stm || stm.type !== 'key_rotation') {
        return { ok: false, code: 'INVALID_ROTATION', message: 'stm.type must be key_rotation' };
    }
    if (stm.action !== 'add' && stm.action !== 'remove') {
        return { ok: false, code: 'INVALID_ROTATION', message: 'stm.action must be add or remove' };
    }
    if (typeof stm.label !== 'string' || stm.label.length === 0) {
        return { ok: false, code: 'INVALID_ROTATION', message: 'stm.label is required' };
    }

    // Rate limiting
    const cooldownMsg = checkRotationCooldown();
    if (cooldownMsg) {
        return { ok: false, code: 'RATE_LIMITED', message: cooldownMsg };
    }

    // Deep-copy the registry so a failed write doesn't corrupt in-memory state
    const next = JSON.parse(JSON.stringify(registry));

    if (stm.action === 'add') {
        if (typeof stm.publicKey !== 'string' || stm.publicKey.length === 0) {
            return { ok: false, code: 'INVALID_ROTATION', message: 'stm.publicKey is required for add' };
        }
        if (!Array.isArray(stm.roles) || stm.roles.length === 0) {
            return { ok: false, code: 'INVALID_ROTATION', message: 'stm.roles must be a non-empty array for add' };
        }
        if (next.keys[stm.label]) {
            return { ok: false, code: 'KEY_EXISTS', message: `key "${stm.label}" already exists` };
        }
        next.keys[stm.label] = {
            publicKey: stm.publicKey,
            identity: stm.identity || null,
            roles: stm.roles,
            addedBy: rotationClaim.iss || 'governance',
            addedAt: new Date().toISOString(),
        };
    } else {
        // remove
        if (!next.keys[stm.label]) {
            return { ok: false, code: 'KEY_NOT_FOUND', message: `key "${stm.label}" does not exist` };
        }
        delete next.keys[stm.label];
    }

    // Bump version to 2 on any mutation
    next.version = 2;

    // Ensure manifest/approve threshold exists
    if (!next.thresholds['manifest/approve']) {
        next.thresholds['manifest/approve'] = { m: 2, n: 3 };
    }

    // Atomic write: write to a temp file in the same directory, then rename
    const dir = path.dirname(KEYS_PATH);
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o751 });
    } catch (e) {
        return { ok: false, code: 'WRITE_FAILED', message: `failed to create ${dir}: ${e.message}` };
    }
    const tmpPath = path.join(dir, `.governance-keys.${crypto.randomBytes(8).toString('hex')}.tmp`);

    try {
        const json = JSON.stringify(next, null, 2) + '\n';
        fs.writeFileSync(tmpPath, json, { mode: 0o644 });
        fs.renameSync(tmpPath, KEYS_PATH);
    } catch (e) {
        // Clean up the temp file if rename failed
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        return { ok: false, code: 'WRITE_FAILED', message: `failed to write registry: ${e.message}` };
    }

    // Update in-memory state only after successful disk write
    registry = next;
    trustedKeysSet = buildTrustedSet(registry);
    identityMap = buildIdentityMap(registry);
    rotationHistory.push(Date.now());

    console.log(`[system] governance key ${stm.action}: "${stm.label}" (${trustedKeysSet.size} keys now)`);
    return { ok: true, action: stm.action, label: stm.label, totalKeys: trustedKeysSet.size };
}

function installSighupReload() {
    process.on('SIGHUP', () => {
        console.log('[system] SIGHUP — reloading governance keys');
        reload();
    });
}

module.exports = {
    load, reload, getThreshold, getTrustedKeys, getIdentityMap, applyRotation, installSighupReload,
    // exposed for tests and sockets.js reconciliation
    _raw: () => registry,
};
