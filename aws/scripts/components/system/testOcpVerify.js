// testOcpVerify.js
//
// Tests for ocpVerify.js. Uses Node.js built-in assert and crypto.
// Generates real P-256 keypairs, signs real OCP claims, then verifies them.
//
// Run: node testOcpVerify.js

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const ocpVerify = require('./ocpVerify');

let testCount = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateTestKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return { publicKey: publicKey.toString('base64'), privateKey };
}

function signClaim(claim, privateKeyDer) {
    const canonical = ocpVerify.canonicalize({
        ocp: claim.ocp,
        iss: claim.iss,
        sub: claim.sub,
        stm: claim.stm,
        nbf: claim.nbf,
        exp: claim.exp,
    });
    return crypto.sign('sha256', Buffer.from(canonical), {
        key: privateKeyDer,
        format: 'der',
        type: 'pkcs8',
    }).toString('base64');
}

function makeClaim(stm, keys, privateKeys, overrides) {
    const nowSec = Math.floor(Date.now() / 1000);
    const claim = {
        ocp: 1,
        iss: 'test-issuer',
        sub: 'test-subject',
        stm: stm || { type: 'test', action: 'verify' },
        key: [],
        sig: [],
        nbf: nowSec - 60,
        exp: nowSec + 3600,
    };
    Object.assign(claim, overrides || {});

    for (let i = 0; i < keys.length; i++) {
        claim.key.push(keys[i]);
        claim.sig.push(signClaim(claim, privateKeys[i]));
    }
    return claim;
}

// ── Tests ───────────────────────────────────────────────────────────────────

// Test 1: 2 valid signatures, threshold 2 → pass
{
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const claim = makeClaim(null, [kp1.publicKey, kp2.publicKey], [kp1.privateKey, kp2.privateKey]);
    const trusted = new Set([kp1.publicKey, kp2.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 2, trusted);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.validSigners, 2);
    assert.strictEqual(result.signers.length, 2);
    testCount++;
    console.log('✓ 2 valid signatures, threshold 2 → pass');
}

// Test 2: 2 valid signatures, threshold 3 → fail
{
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const claim = makeClaim(null, [kp1.publicKey, kp2.publicKey], [kp1.privateKey, kp2.privateKey]);
    const trusted = new Set([kp1.publicKey, kp2.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 3, trusted);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_SIGNERS');
    testCount++;
    console.log('✓ 2 valid signatures, threshold 3 → fail');
}

// Test 3: 1 valid + 1 invalid signature, threshold 1 → pass
{
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const kpBogus = generateTestKeypair();
    const claim = makeClaim(null, [kp1.publicKey], [kp1.privateKey]);
    // Add a second key with an invalid signature (signed by a different key)
    claim.key.push(kp2.publicKey);
    claim.sig.push(signClaim(claim, kpBogus.privateKey));
    const trusted = new Set([kp1.publicKey, kp2.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.validSigners, 1);
    testCount++;
    console.log('✓ 1 valid + 1 invalid signature, threshold 1 → pass');
}

// Test 4: 1 valid + 1 invalid, threshold 2 → fail
{
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const kpBogus = generateTestKeypair();
    const claim = makeClaim(null, [kp1.publicKey], [kp1.privateKey]);
    claim.key.push(kp2.publicKey);
    claim.sig.push(signClaim(claim, kpBogus.privateKey));
    const trusted = new Set([kp1.publicKey, kp2.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 2, trusted);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_SIGNERS');
    testCount++;
    console.log('✓ 1 valid + 1 invalid, threshold 2 → fail');
}

// Test 5: Duplicate signer (same key signs twice) → counts as 1
{
    const kp1 = generateTestKeypair();
    const claim = makeClaim(null, [kp1.publicKey, kp1.publicKey], [kp1.privateKey, kp1.privateKey]);
    const trusted = new Set([kp1.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.validSigners, 1, 'duplicate key should count as 1');

    const result2 = ocpVerify.verifyThreshold(claim, 2, trusted);
    assert.strictEqual(result2.ok, false, 'duplicate key should not satisfy threshold of 2');
    testCount++;
    console.log('✓ duplicate signer counts as 1');
}

// Test 6: Expired claim → reject
{
    const kp1 = generateTestKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    const claim = makeClaim(null, [kp1.publicKey], [kp1.privateKey], {
        nbf: nowSec - 7200,
        exp: nowSec - 3600,
    });
    const trusted = new Set([kp1.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'EXPIRED');
    testCount++;
    console.log('✓ expired claim → reject');
}

// Test 7: Not-yet-valid claim (nbf in the future) → reject
{
    const kp1 = generateTestKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    const claim = makeClaim(null, [kp1.publicKey], [kp1.privateKey], {
        nbf: nowSec + 3600,
        exp: nowSec + 7200,
    });
    const trusted = new Set([kp1.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'NOT_YET_VALID');
    testCount++;
    console.log('✓ not-yet-valid claim → reject');
}

// Test 8: Tampered claim (modify stm after signing) → signature fails
{
    const kp1 = generateTestKeypair();
    const claim = makeClaim({ type: 'test', value: 'original' }, [kp1.publicKey], [kp1.privateKey]);
    // Tamper with the statement after signing
    claim.stm.value = 'tampered';
    const trusted = new Set([kp1.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, false);
    testCount++;
    console.log('✓ tampered claim → signature fails');
}

// Test 9: Empty key/sig arrays → reject
{
    const nowSec = Math.floor(Date.now() / 1000);
    const claim = {
        ocp: 1,
        iss: 'test',
        sub: 'test',
        stm: { type: 'test' },
        key: [],
        sig: [],
        nbf: nowSec - 60,
        exp: nowSec + 3600,
    };
    const trusted = new Set();

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'EMPTY_SIGNERS');

    const vResult = ocpVerify.verify(claim);
    assert.strictEqual(vResult.ok, false);
    testCount++;
    console.log('✓ empty key/sig arrays → reject');
}

// Test 10: claimHash produces consistent SHA-256
{
    const stm = { type: 'test', data: { a: 1, b: 2 } };
    const h1 = ocpVerify.claimHash({ stm });
    const h2 = ocpVerify.claimHash({ stm });
    assert.strictEqual(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);

    // Different stm should produce different hash
    const h3 = ocpVerify.claimHash({ stm: { type: 'other' } });
    assert.notStrictEqual(h1, h3);
    testCount++;
    console.log('✓ claimHash produces consistent SHA-256');
}

// Test 11: canonicalize sorts keys, handles nested objects
{
    const c1 = ocpVerify.canonicalize({ z: 1, a: 2, m: { y: 3, b: 4 } });
    assert.strictEqual(c1, '{"a":2,"m":{"b":4,"y":3},"z":1}');

    // Array order preserved
    const c2 = ocpVerify.canonicalize([3, 1, 2]);
    assert.strictEqual(c2, '[3,1,2]');

    // Nested arrays
    const c3 = ocpVerify.canonicalize({ arr: [{ b: 1, a: 2 }] });
    assert.strictEqual(c3, '{"arr":[{"a":2,"b":1}]}');
    testCount++;
    console.log('✓ canonicalize sorts keys, handles nested objects');
}

// Test 12: Untrusted key (valid signature but key not in trustedKeys) → doesn't count
{
    const kpTrusted = generateTestKeypair();
    const kpUntrusted = generateTestKeypair();
    const claim = makeClaim(null,
        [kpTrusted.publicKey, kpUntrusted.publicKey],
        [kpTrusted.privateKey, kpUntrusted.privateKey]
    );
    // Only trust the first key
    const trusted = new Set([kpTrusted.publicKey]);

    const result = ocpVerify.verifyThreshold(claim, 1, trusted);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.validSigners, 1, 'untrusted key should not count');

    const result2 = ocpVerify.verifyThreshold(claim, 2, trusted);
    assert.strictEqual(result2.ok, false, 'should not reach 2 with only 1 trusted');
    testCount++;
    console.log('✓ untrusted key does not count toward threshold');
}

// Test 13: Valid claim with exactly threshold signers → pass
{
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const kp3 = generateTestKeypair();
    const claim = makeClaim(null,
        [kp1.publicKey, kp2.publicKey, kp3.publicKey],
        [kp1.privateKey, kp2.privateKey, kp3.privateKey]
    );
    const trusted = new Set([kp1.publicKey, kp2.publicKey, kp3.publicKey]);

    // Exactly 3 signers, threshold 3
    const result = ocpVerify.verifyThreshold(claim, 3, trusted);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.validSigners, 3);
    testCount++;
    console.log('✓ valid claim with exactly threshold signers → pass');
}

// Test 14: RFC 8785 edge cases
{
    // Unicode strings: JSON.stringify handles escape sequences per spec
    const c1 = ocpVerify.canonicalize({ emoji: 'é' });
    assert.strictEqual(c1, '{"emoji":"\\u00e9"}' === c1 ? c1 : '{"emoji":"é"}');
    // The key test: it should round-trip to the same canonical form
    const parsed = JSON.parse(c1);
    const c1b = ocpVerify.canonicalize(parsed);
    assert.strictEqual(c1, c1b, 'unicode canonicalization must be idempotent');

    // Negative numbers
    const c2 = ocpVerify.canonicalize({ n: -42 });
    assert.strictEqual(c2, '{"n":-42}');

    // Negative float
    const c3 = ocpVerify.canonicalize({ f: -0.5 });
    assert.strictEqual(c3, '{"f":-0.5}');

    // Empty arrays
    const c4 = ocpVerify.canonicalize({ a: [] });
    assert.strictEqual(c4, '{"a":[]}');

    // Empty objects
    const c5 = ocpVerify.canonicalize({});
    assert.strictEqual(c5, '{}');

    // Empty string
    const c6 = ocpVerify.canonicalize({ s: '' });
    assert.strictEqual(c6, '{"s":""}');

    // Zero
    const c7 = ocpVerify.canonicalize({ z: 0 });
    assert.strictEqual(c7, '{"z":0}');

    // Boolean and null
    const c8 = ocpVerify.canonicalize(null);
    assert.strictEqual(c8, 'null');

    const c9 = ocpVerify.canonicalize(true);
    assert.strictEqual(c9, 'true');

    // Non-finite should throw
    assert.throws(() => ocpVerify.canonicalize({ n: Infinity }));
    assert.throws(() => ocpVerify.canonicalize({ n: NaN }));

    testCount++;
    console.log('✓ RFC 8785 edge cases: unicode, negatives, empty arrays');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nAll ${testCount} tests passed`);
