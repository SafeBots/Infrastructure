// test/testAuth.js
//
// Direct coverage for auth.js — the HMAC sign/verify + replay protection that
// gates every System-component request. Previously exercised only indirectly.
//
// Run: node aws/scripts/components/system/test/testAuth.js

'use strict';

const path = require('path');
const auth = require(path.join(__dirname, '..', 'auth'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log(`  PASS ${label}`); }
    else      { fail++; console.log(`  FAIL ${label}`); }
}

const SECRET = 'test-secret-key-do-not-use-in-prod';

// ── sign() → verify() round trip ──────────────────────────────────────
console.log('── sign/verify round trip ──');
{
    const body = JSON.stringify({ managedContainer: '_host', tool: 'dnf' });
    const headers = auth.sign(SECRET, 'POST', '/system', body);
    const r = auth.verify(SECRET, headers, 'POST', '/system', body);
    ok(r.ok === true, 'valid signature verifies');
}

// ── wrong secret is rejected ──────────────────────────────────────────
console.log('\n── wrong key / tampering ──');
{
    const body = 'x';
    const headers = auth.sign(SECRET, 'POST', '/system', body);
    const r = auth.verify('different-secret', headers, 'POST', '/system', body);
    ok(r.ok === false && r.code === 'signature_mismatch', 'wrong secret rejected');
}

// ── tampered body rejected (signature bound to body) ──────────────────
{
    const headers = auth.sign(SECRET, 'POST', '/system', 'original');
    const r = auth.verify(SECRET, headers, 'POST', '/system', 'tampered');
    ok(r.ok === false, 'tampered body rejected');
}

// ── tampered method/path rejected (signature bound to both) ───────────
{
    const body = 'x';
    const headers = auth.sign(SECRET, 'POST', '/system', body);
    const rMethod = auth.verify(SECRET, headers, 'GET', '/system', body);
    ok(rMethod.ok === false, 'tampered method rejected');
    const rPath = auth.verify(SECRET, headers, 'POST', '/models/install', body);
    ok(rPath.ok === false, 'tampered path rejected (cannot replay a /system sig on /models)');
}

// ── missing scheme / headers ──────────────────────────────────────────
console.log('\n── malformed requests ──');
{
    const r = auth.verify(SECRET, {}, 'POST', '/system', 'x');
    ok(r.ok === false && r.code === 'missing_scheme', 'no auth header → missing_scheme');
}
{
    const r = auth.verify(SECRET, { authorization: 'SafeboxHMAC v1' }, 'POST', '/system', 'x');
    ok(r.ok === false && r.code === 'missing_header', 'scheme but no ts/nonce/sig → missing_header');
}
{
    const headers = auth.sign(SECRET, 'POST', '/system', 'x');
    headers['x-safebox-timestamp'] = 'not-a-number';
    const r = auth.verify(SECRET, headers, 'POST', '/system', 'x');
    ok(r.ok === false && r.code === 'bad_timestamp', 'non-numeric timestamp rejected');
}
{
    const headers = auth.sign(SECRET, 'POST', '/system', 'x');
    headers['x-safebox-nonce'] = 'SHORT';
    const r = auth.verify(SECRET, headers, 'POST', '/system', 'x');
    ok(r.ok === false && r.code === 'bad_nonce', 'malformed nonce rejected');
}
{
    const headers = auth.sign(SECRET, 'POST', '/system', 'x');
    headers['x-safebox-signature'] = 'nothex!!';
    const r = auth.verify(SECRET, headers, 'POST', '/system', 'x');
    ok(r.ok === false && r.code === 'bad_signature_format', 'malformed signature format rejected');
}

// ── timestamp skew window ─────────────────────────────────────────────
console.log('\n── timestamp skew ──');
{
    // Forge a signature with a far-past timestamp but otherwise valid.
    const crypto = require('crypto');
    const oldTs = String(Math.floor(Date.now() / 1000) - 10000); // ~2.7h ago
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = 'x';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonical = `${oldTs}\n${nonce}\nPOST\n/system\n${bodyHash}`;
    const sig = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
    const headers = {
        'authorization': 'SafeboxHMAC v1',
        'x-safebox-timestamp': oldTs,
        'x-safebox-nonce': nonce,
        'x-safebox-signature': sig,
    };
    const r = auth.verify(SECRET, headers, 'POST', '/system', body);
    ok(r.ok === false && r.code === 'timestamp_skew', 'stale (but correctly signed) request rejected on skew');
}

// ── nonce replay ──────────────────────────────────────────────────────
console.log('\n── nonce replay protection ──');
{
    const body = 'replay-body';
    const headers = auth.sign(SECRET, 'POST', '/system', body);
    const first  = auth.verify(SECRET, headers, 'POST', '/system', body);
    const second = auth.verify(SECRET, headers, 'POST', '/system', body);
    ok(first.ok === true, 'first use of nonce accepted');
    ok(second.ok === false && second.code === 'nonce_reuse', 'replay of same nonce rejected');
}

// ── nonce NOT consumed when the signature is invalid ──────────────────
// (regression guard: a bad-sig request must not burn a nonce the legit
//  client will later use with a correct signature)
{
    const body = 'legit-body';
    const headers = auth.sign(SECRET, 'POST', '/system', body);
    // First, an attacker sends the same nonce with a broken signature.
    const badHeaders = { ...headers, 'x-safebox-signature': 'a'.repeat(64) };
    const badResult = auth.verify(SECRET, badHeaders, 'POST', '/system', body);
    ok(badResult.ok === false, 'bad-sig request rejected');
    // The legit client then uses that nonce with the correct signature.
    const goodResult = auth.verify(SECRET, headers, 'POST', '/system', body);
    ok(goodResult.ok === true, 'nonce still usable after a bad-sig attempt (not burned by attacker)');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
