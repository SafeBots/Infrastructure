// /opt/safebox/system/ocpVerify.js
//
// OCP (OpenClaiming Protocol) verification for the Infrastructure base layer.
// The base layer ONLY verifies claims — it never signs. Signing is done by
// the governance quorum on the Safebox side.
//
// Supports hybrid post-quantum verification: both ES256 (P-256 + SHA-256) and
// ML-DSA-65 (FIPS 204) signatures. Keys are identified by data:key/ URIs:
//   - data:key/es256;base64,<SPKI-DER>
//   - data:key/ml-dsa-65;base64,<raw-1952-byte-pk>
//
// OCP wire format:
//   {
//     ocp: 1,
//     iss: "<issuer identifier>",
//     sub: "<subject identifier>",
//     stm: { <statement object — operation-specific> },
//     key: [ "data:key/es256;base64,<spki>", "data:key/ml-dsa-65;base64,<pk>", ... ],
//     sig: [ "<signature-base64>", ... ],
//     nbf: <unix-seconds>,
//     exp: <unix-seconds>
//   }
//
// Canonicalization follows the Safebox team's convention: strip sig[] only,
// keep sorted key[]. This commits the canonical form to the signing keys,
// preventing key-substitution attacks.

'use strict';

const crypto = require('crypto');

// Lazy-loaded ML-DSA-65 module (ESM, loaded on first use)
let _ml_dsa65 = null;
async function getMlDsa65() {
    if (_ml_dsa65) return _ml_dsa65;
    const mod = await import('@noble/post-quantum/ml-dsa.js');
    _ml_dsa65 = mod.ml_dsa65;
    return _ml_dsa65;
}

// ── Key URI parsing ────────────────────────────────────────────────────────
// Parses data:key/<algorithm>;base64,<bytes> URIs into { algorithm, bytes }.

const KEY_URI_RE = /^data:key\/([a-z0-9-]+);base64,(.+)$/;

/**
 * Parse a data:key/ URI into its algorithm and raw bytes.
 *
 * @param {string} uri - Key URI (e.g. "data:key/es256;base64,...")
 * @returns {{ algorithm: string, bytes: Buffer }} Parsed key
 * @throws {Error} If the URI format is invalid
 */
function parseKeyUri(uri) {
    const m = KEY_URI_RE.exec(uri);
    if (!m) {
        throw new Error('invalid key URI: expected data:key/<alg>;base64,<bytes>');
    }
    return {
        algorithm: m[1],
        bytes: Buffer.from(m[2], 'base64'),
    };
}

// ── RFC 8785 canonicalization ────────────────────────────────────────────────
// Same algorithm as opsModels.js, but generalized to handle floats and all
// JSON-representable values. RFC 8785 requires shortest-form IEEE-754 for
// numbers; for integers, String(n) already produces that. For floats,
// Number.prototype.toString() produces the shortest round-trippable form
// in V8/SpiderMonkey/JSC, which matches the RFC requirement.

function canonicalize(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('OCP canonicalize: non-finite numbers are not representable in JSON');
        }
        return String(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalize).join(',') + ']';
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k]));
        return '{' + parts.join(',') + '}';
    }
    throw new Error(`OCP canonicalize: unsupported value type: ${typeof value}`);
}

// ── Claim canonical form ────────────────────────────────────────────────────
// The signed payload is the canonical JSON of the claim with sig[] stripped
// and key[] sorted lexicographically. This matches the Safebox team's
// convention: stripping only sig (not key) commits the canonical form to the
// signing keys, preventing key-substitution attacks.

function claimCanonical(claim) {
    const { sig, ...rest } = claim;
    // Sort key[] lexicographically for deterministic canonicalization
    if (Array.isArray(rest.key)) {
        rest.key = [...rest.key].sort();
    }
    return canonicalize(rest);
}

// ── Single-claim verification ───────────────────────────────────────────────
// Returns { ok, validSigners, errors } where validSigners is the count of
// signatures that verified against their corresponding key. Does NOT check
// time bounds or trusted-key membership — use verifyThreshold for that.
//
// Now async because ML-DSA-65 verification requires the noble library.

async function verify(claim) {
    const errors = [];

    if (!claim || typeof claim !== 'object') {
        return { ok: false, validSigners: 0, errors: ['claim must be an object'] };
    }
    if (claim.ocp !== 1) {
        errors.push('unsupported ocp version (expected 1)');
    }
    if (!Array.isArray(claim.key) || !Array.isArray(claim.sig)) {
        return { ok: false, validSigners: 0, errors: ['key and sig must be arrays'] };
    }
    if (claim.key.length === 0 || claim.sig.length === 0) {
        return { ok: false, validSigners: 0, errors: ['key and sig arrays must not be empty'] };
    }
    if (claim.key.length !== claim.sig.length) {
        return { ok: false, validSigners: 0, errors: ['key and sig arrays must have the same length'] };
    }

    let canonical;
    try {
        canonical = claimCanonical(claim);
    } catch (e) {
        return { ok: false, validSigners: 0, errors: [`canonicalization failed: ${e.message}`] };
    }

    const canonicalBytes = Buffer.from(canonical, 'utf8');
    let validSigners = 0;

    for (let i = 0; i < claim.key.length; i++) {
        try {
            const sigBuf = Buffer.from(claim.sig[i], 'base64');
            let parsed;

            try {
                parsed = parseKeyUri(claim.key[i]);
            } catch (_e) {
                // Legacy format: raw SPKI base64 without data:key/ prefix
                // Treat as ES256 for backward compatibility
                parsed = { algorithm: 'es256', bytes: Buffer.from(claim.key[i], 'base64') };
            }

            let ok = false;

            if (parsed.algorithm === 'es256') {
                // ES256: sign SHA-256(canonical), verify with SPKI DER key
                // Accept both DER and IEEE P1363 (raw r||s) signature formats.
                // The Safebox platform stores sigs as raw r||s (64 bytes).
                const isDer = sigBuf.length > 64;
                ok = crypto.verify('sha256', canonicalBytes, {
                    key: parsed.bytes,
                    format: 'der',
                    type: 'spki',
                    dsaEncoding: isDer ? 'der' : 'ieee-p1363',
                }, sigBuf);
            } else if (parsed.algorithm === 'ml-dsa-65') {
                // ML-DSA-65: verify raw canonical bytes (no pre-hash)
                // FIPS 204 does internal SHAKE-256 hashing
                const ml_dsa65 = await getMlDsa65();
                ok = ml_dsa65.verify(sigBuf, canonicalBytes, parsed.bytes);
            } else {
                errors.push(`sig[${i}] unsupported algorithm: ${parsed.algorithm}`);
                continue;
            }

            if (ok) {
                validSigners++;
            } else {
                errors.push(`sig[${i}] failed verification`);
            }
        } catch (e) {
            errors.push(`sig[${i}] error: ${e.message}`);
        }
    }

    return {
        ok: validSigners > 0,
        validSigners,
        errors: errors.length > 0 ? errors : undefined,
    };
}

// ── Threshold verification ──────────────────────────────────────────────────
// Verifies that at least minSigners distinct valid signatures come from keys
// in the trustedKeys Set (Set of key URI strings or legacy SPKI base64).
// Checks time bounds.
//
// Identity deduplication: if an identityMap is provided
// (Map<keyUri, identityId>), the same signer with both ES256 and ML-DSA-65
// keys counts once toward the threshold (by identity, not by key).

async function verifyThreshold(claim, minSigners, trustedKeys, identityMap) {
    if (!claim || typeof claim !== 'object') {
        return { ok: false, code: 'INVALID_CLAIM', message: 'claim must be an object' };
    }
    if (!Array.isArray(claim.key) || !Array.isArray(claim.sig)) {
        return { ok: false, code: 'INVALID_CLAIM', message: 'key and sig must be arrays' };
    }
    if (claim.key.length === 0 || claim.sig.length === 0) {
        return { ok: false, code: 'EMPTY_SIGNERS', message: 'key and sig arrays must not be empty' };
    }
    if (claim.key.length !== claim.sig.length) {
        return { ok: false, code: 'INVALID_CLAIM', message: 'key and sig arrays must have the same length' };
    }

    // Time bounds
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claim.nbf === 'number' && nowSec < claim.nbf) {
        return { ok: false, code: 'NOT_YET_VALID', message: `claim not valid until ${claim.nbf}` };
    }
    if (typeof claim.exp === 'number' && nowSec > claim.exp) {
        return { ok: false, code: 'EXPIRED', message: `claim expired at ${claim.exp}` };
    }

    let canonical;
    try {
        canonical = claimCanonical(claim);
    } catch (e) {
        return { ok: false, code: 'CANONICALIZE_FAILED', message: e.message };
    }

    const canonicalBytes = Buffer.from(canonical, 'utf8');
    const seenKeys = new Set();
    const seenIdentities = new Set();
    const signers = [];

    for (let i = 0; i < claim.key.length; i++) {
        const keyUri = claim.key[i];

        // Deduplicate: same key appearing more than once counts once
        if (seenKeys.has(keyUri)) continue;

        // Only count keys in the trusted set
        if (!trustedKeys.has(keyUri)) continue;

        try {
            const sigBuf = Buffer.from(claim.sig[i], 'base64');
            let parsed;

            try {
                parsed = parseKeyUri(keyUri);
            } catch (_e) {
                // Legacy format: raw SPKI base64
                parsed = { algorithm: 'es256', bytes: Buffer.from(keyUri, 'base64') };
            }

            let ok = false;

            if (parsed.algorithm === 'es256') {
                const isDer = sigBuf.length > 64;
                ok = crypto.verify('sha256', canonicalBytes, {
                    key: parsed.bytes,
                    format: 'der',
                    type: 'spki',
                    dsaEncoding: isDer ? 'der' : 'ieee-p1363',
                }, sigBuf);
            } else if (parsed.algorithm === 'ml-dsa-65') {
                const ml_dsa65 = await getMlDsa65();
                ok = ml_dsa65.verify(sigBuf, canonicalBytes, parsed.bytes);
            }
            // Unknown algorithms silently skipped (not in trusted set anyway)

            if (ok) {
                seenKeys.add(keyUri);

                // Identity deduplication: if an identityMap is provided,
                // the same signer with multiple key types counts once
                const identity = identityMap ? identityMap.get(keyUri) : null;
                if (identity) {
                    if (seenIdentities.has(identity)) continue;
                    seenIdentities.add(identity);
                }

                const fingerprint = crypto.createHash('sha256')
                    .update(parsed.bytes).digest('hex').slice(0, 16);
                signers.push(fingerprint);
            }
        } catch (_e) {
            // Invalid key/sig format — skip, don't count
        }
    }

    if (signers.length >= minSigners) {
        return { ok: true, validSigners: signers.length, signers };
    }

    return {
        ok: false,
        code: 'INSUFFICIENT_SIGNERS',
        message: `need ${minSigners} trusted signers, got ${signers.length}`,
    };
}

// ── Claim hash ──────────────────────────────────────────────────────────────
// SHA-256 hex of the canonical form of the claim's statement (stm field).
// Useful for deduplication and audit logs.

function claimHash(claim) {
    const canonical = canonicalize(claim.stm);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = { canonicalize, parseKeyUri, verify, verifyThreshold, claimHash };
