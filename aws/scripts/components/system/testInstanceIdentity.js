'use strict';

const assert = require('assert');
const crypto = require('crypto');
const identity = require('./instanceIdentity');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('✓ ' + name);
    passed++;
  } catch (err) {
    console.log('✗ ' + name);
    console.log('  ' + err.message);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Test 1: init() generates a valid P-256 keypair
// ---------------------------------------------------------------------------
test('init() generates a valid P-256 keypair', function () {
  const result = identity.init();

  assert.ok(result, 'init() should return an object');
  assert.ok(typeof result.publicKey === 'string', 'publicKey should be a string');
  assert.ok(typeof result.publicKeyHash === 'string', 'publicKeyHash should be a string');
  assert.ok(result.publicKey.length > 0, 'publicKey should be non-empty');

  // Verify the public key is valid SPKI by importing it
  const der = Buffer.from(result.publicKey, 'base64');
  const pubKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.ok(pubKey, 'Should be able to import the public key as SPKI');

  // Verify it is a P-256 key by checking asymmetricKeyType and size
  assert.strictEqual(pubKey.asymmetricKeyType, 'ec', 'Key should be EC');
  // DER SPKI for P-256 is 91 bytes
  assert.strictEqual(der.length, 91, 'P-256 SPKI DER should be 91 bytes');
});

// ---------------------------------------------------------------------------
// Test 2: getPublicKey() returns consistent base64
// ---------------------------------------------------------------------------
test('getPublicKey() returns consistent base64', function () {
  const pk1 = identity.getPublicKey();
  const pk2 = identity.getPublicKey();
  assert.strictEqual(pk1, pk2, 'getPublicKey() should return the same value on repeated calls');
  assert.ok(typeof pk1 === 'string' && pk1.length > 0, 'Should be a non-empty string');

  // Verify it's valid base64
  const decoded = Buffer.from(pk1, 'base64');
  assert.strictEqual(decoded.toString('base64'), pk1, 'Should round-trip through base64');
});

// ---------------------------------------------------------------------------
// Test 3: getPublicKeyHash() matches SHA-256 of DER public key
// ---------------------------------------------------------------------------
test('getPublicKeyHash() matches SHA-256 of DER public key', function () {
  const hash = identity.getPublicKeyHash();
  const pk = identity.getPublicKey();
  const der = Buffer.from(pk, 'base64');
  const expected = crypto.createHash('sha256').update(der).digest('hex');
  assert.strictEqual(hash, expected, 'Hash should be SHA-256 of the DER-encoded SPKI public key');
});

// ---------------------------------------------------------------------------
// Test 4: issueAttestationClaim() returns a valid OCP claim — verify self-signature
// ---------------------------------------------------------------------------
test('issueAttestationClaim() returns a valid OCP claim with verifiable self-signature', function () {
  const claim = identity.issueAttestationClaim();

  // Reconstruct the signed payload (claim without key/sig)
  const claimForSigning = {
    ocp: claim.ocp,
    iss: claim.iss,
    stm: claim.stm,
    nbf: claim.nbf,
    exp: claim.exp
  };

  // Use the same canonical JSON that the module uses internally
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
    throw new Error('Unsupported type');
  }

  const canonical = canonicalize(claimForSigning);
  const sigBuf = Buffer.from(claim.sig[0], 'base64');
  const pubKeyDer = Buffer.from(claim.key[0], 'base64');
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

  const valid = crypto.verify('sha256', Buffer.from(canonical), pubKey, sigBuf);
  assert.ok(valid, 'Self-signature should verify against the embedded public key');
});

// ---------------------------------------------------------------------------
// Test 5: issueAttestationClaim() has correct structure
// ---------------------------------------------------------------------------
test('issueAttestationClaim() has correct OCP structure', function () {
  const claim = identity.issueAttestationClaim();

  assert.strictEqual(claim.ocp, 1, 'ocp field should be 1');
  assert.ok(claim.iss.startsWith('safebox://'), 'iss should start with safebox://');
  assert.strictEqual(claim.stm.type, 'attestation', 'stm.type should be "attestation"');
  assert.ok(typeof claim.stm.instancePublicKey === 'string', 'stm.instancePublicKey should be a string');
  assert.ok(typeof claim.stm.measurement === 'string', 'stm.measurement should be a string');
  assert.ok(typeof claim.stm.cloud === 'string', 'stm.cloud should be a string');
  assert.ok(typeof claim.stm.hardwareRoot === 'string', 'stm.hardwareRoot should be a string');
  assert.ok(typeof claim.stm.bootTime === 'string', 'stm.bootTime should be a string');

  const now = Math.floor(Date.now() / 1000);
  assert.ok(claim.nbf <= now + 2, 'nbf should be at or before current time (with 2s tolerance)');
  assert.ok(claim.exp > now, 'exp should be in the future');
  assert.ok(Array.isArray(claim.key), 'key should be an array');
  assert.ok(Array.isArray(claim.sig), 'sig should be an array');
  assert.strictEqual(claim.key.length, 1, 'key array should have one entry');
  assert.strictEqual(claim.sig.length, 1, 'sig array should have one entry');
});

// ---------------------------------------------------------------------------
// Test 6: handleChallenge() signs a nonce — verify signature
// ---------------------------------------------------------------------------
test('handleChallenge() signs a nonce — verify signature against public key', function () {
  const nonce = crypto.randomBytes(32).toString('hex');
  const response = identity.handleChallenge(nonce);

  assert.ok(response.attestationClaim, 'Should include attestation claim');
  assert.strictEqual(response.nonce, nonce, 'Should echo back the nonce');
  assert.ok(typeof response.challengeSignature === 'string', 'challengeSignature should be a string');

  // Verify the challenge signature
  const sigBuf = Buffer.from(response.challengeSignature, 'base64');
  const pubKeyDer = Buffer.from(identity.getPublicKey(), 'base64');
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

  const valid = crypto.verify('sha256', Buffer.from(nonce), pubKey, sigBuf);
  assert.ok(valid, 'Challenge signature should verify');
});

// ---------------------------------------------------------------------------
// Test 7: handleChallenge() with different nonces produces different signatures
// ---------------------------------------------------------------------------
test('handleChallenge() with different nonces produces different signatures', function () {
  const nonce1 = 'nonce-alpha-' + Date.now();
  const nonce2 = 'nonce-beta-' + Date.now();

  const r1 = identity.handleChallenge(nonce1);
  const r2 = identity.handleChallenge(nonce2);

  assert.notStrictEqual(
    r1.challengeSignature,
    r2.challengeSignature,
    'Different nonces should produce different signatures'
  );
});

// ---------------------------------------------------------------------------
// Test 8: sign() produces verifiable ES256 signatures
// ---------------------------------------------------------------------------
test('sign() produces verifiable ES256 signatures', function () {
  const data = 'The quick brown fox jumps over the lazy dog';
  const sigBase64 = identity.sign(data);
  assert.ok(typeof sigBase64 === 'string' && sigBase64.length > 0, 'sign() should return a non-empty base64 string');

  const sigBuf = Buffer.from(sigBase64, 'base64');
  const pubKeyDer = Buffer.from(identity.getPublicKey(), 'base64');
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

  const valid = crypto.verify('sha256', Buffer.from(data), pubKey, sigBuf);
  assert.ok(valid, 'Signature should verify with the public key');

  // Verify that a different message does NOT verify
  const invalid = crypto.verify('sha256', Buffer.from(data + '!'), pubKey, sigBuf);
  assert.ok(!invalid, 'Signature should NOT verify against a different message');
});

// ---------------------------------------------------------------------------
// Test 9: Two init() calls produce different keypairs (ephemeral)
// ---------------------------------------------------------------------------
test('Two init() calls produce different keypairs (ephemeral)', function () {
  const first = identity.init();
  const pk1 = identity.getPublicKey();

  const second = identity.init();
  const pk2 = identity.getPublicKey();

  assert.notStrictEqual(pk1, pk2, 'Two init() calls should produce different public keys');
  assert.notStrictEqual(first.publicKeyHash, second.publicKeyHash, 'Two init() calls should produce different key hashes');
});

// ---------------------------------------------------------------------------
// Test 10: Attestation claim expiry is ~24h from issuance
// ---------------------------------------------------------------------------
test('Attestation claim expiry is ~24h from issuance', function () {
  // Re-init so we have a fresh keypair for this test
  identity.init();

  const before = Math.floor(Date.now() / 1000);
  const claim = identity.issueAttestationClaim();
  const after = Math.floor(Date.now() / 1000);

  const duration = claim.exp - claim.nbf;
  assert.strictEqual(duration, 86400, 'Expiry should be exactly 86400 seconds (24h) after nbf');

  // nbf should be close to current time
  assert.ok(claim.nbf >= before && claim.nbf <= after + 1, 'nbf should be approximately now');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
if (failed > 0) {
  process.exit(1);
}
