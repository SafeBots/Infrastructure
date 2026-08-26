// /opt/safebox/system/auth.js
//
// HMAC-SHA-256 over a canonical envelope:
//   <timestamp>\n<nonce>\n<method>\n<path>\n<body-sha256-hex>
//
// Replay protection: 5-minute timestamp window + 10-minute nonce LRU.

'use strict';

const crypto = require('crypto');

const TIMESTAMP_SKEW_SECONDS = 300;
const NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_LRU_MAX = 10000;

// Nonce LRU: Map preserves insertion order, so eviction is O(1).
// We track expiry separately because we need to age out by time, not capacity.
const seenNonces = new Map();  // nonce -> expiryMs

function pruneNonces() {
    const now = Date.now();
    for (const [nonce, expiry] of seenNonces) {
        if (expiry > now) break;  // Map is insertion-ordered; first non-expired ends pruning
        seenNonces.delete(nonce);
    }
    while (seenNonces.size > NONCE_LRU_MAX) {
        const first = seenNonces.keys().next().value;
        seenNonces.delete(first);
    }
}

function canonicalize(timestamp, nonce, method, path, bodyHashHex) {
    return `${timestamp}\n${nonce}\n${method}\n${path}\n${bodyHashHex}`;
}

function bodyHash(body) {
    return crypto.createHash('sha256').update(body || '').digest('hex');
}

// Compute the signature for outgoing requests. Used by tests; in production
// only the Safebox side signs. System only verifies.
function sign(secret, method, path, body) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = canonicalize(ts, nonce, method, path, bodyHash(body));
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    return {
        'authorization': 'SafeboxHMAC v1',
        'x-safebox-timestamp': ts,
        'x-safebox-nonce': nonce,
        'x-safebox-signature': sig,
    };
}

// Returns { ok: true } or { ok: false, code, message }. Never throws on
// untrusted input — always returns a structured failure so the caller emits
// a single `auth_fail` audit entry and a generic 401 response.
function verify(secret, headers, method, path, body) {
    if ((headers['authorization'] || '').trim() !== 'SafeboxHMAC v1') {
        return { ok: false, code: 'missing_scheme', message: 'unauthorized' };
    }
    const ts = headers['x-safebox-timestamp'];
    const nonce = headers['x-safebox-nonce'];
    const provided = headers['x-safebox-signature'];

    if (!ts || !nonce || !provided) {
        return { ok: false, code: 'missing_header', message: 'unauthorized' };
    }
    if (!/^\d{1,11}$/.test(ts)) {
        return { ok: false, code: 'bad_timestamp', message: 'unauthorized' };
    }
    if (!/^[a-f0-9]{32}$/.test(nonce)) {
        return { ok: false, code: 'bad_nonce', message: 'unauthorized' };
    }
    if (!/^[a-f0-9]{64}$/.test(provided)) {
        return { ok: false, code: 'bad_signature_format', message: 'unauthorized' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tsNum = parseInt(ts, 10);
    if (Math.abs(nowSec - tsNum) > TIMESTAMP_SKEW_SECONDS) {
        return { ok: false, code: 'timestamp_skew', message: 'unauthorized' };
    }

    pruneNonces();
    if (seenNonces.has(nonce)) {
        return { ok: false, code: 'nonce_reuse', message: 'replay' };
    }

    const canonical = canonicalize(ts, nonce, method, path, bodyHash(body));
    const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

    // timingSafeEqual requires equal-length buffers. We've already regex-validated
    // both to be 64-char hex, so length match is guaranteed; this is belt-and-suspenders.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, code: 'signature_mismatch', message: 'unauthorized' };
    }

    seenNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return { ok: true };
}

module.exports = { sign, verify };
