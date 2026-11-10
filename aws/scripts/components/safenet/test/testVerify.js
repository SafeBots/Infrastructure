#!/usr/bin/env node
'use strict';

/**
 * End-to-end tests for the Verify library.
 *
 * Uses Node.js crypto (SubtleCrypto) to generate real P-256 keypairs,
 * sign OCP claims, and verify them through Verify — no Q platform needed.
 *
 * Run: node test/testVerify.js
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const Verify = require(path.resolve(__dirname, '..', 'lib', 'Verify'));

// ── TAP harness ─────────────────────────────────────────────────────────────

let testCount = 0;
let passed = 0;
let failed = 0;
const errors = [];

async function asyncTest(name, fn) {
  testCount++;
  try {
    await fn();
    passed++;
    console.log(`ok ${testCount} - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok ${testCount} - ${name}`);
    console.log(`  # ${e.message}`);
    if (e.stack) console.log(`  # ${e.stack.split('\n').slice(1, 3).join('\n  # ')}`);
    errors.push({ name, error: e });
  }
}

// ── Crypto helpers (test-only, mirrors what Identity.sign() does) ───────────

const subtle = crypto.webcrypto
  ? crypto.webcrypto.subtle
  : (crypto.subtle || null);

if (!subtle) {
  console.log('1..0 # SKIP SubtleCrypto not available (Node.js 16+ required)');
  process.exit(0);
}

/**
 * Generate a P-256 keypair and return { publicKey (hex SPKI), privateKey, cryptoKeyPair }
 */
async function generateKeypair() {
  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const spkiDer = await subtle.exportKey('spki', keyPair.publicKey);
  const rawKey = await subtle.exportKey('raw', keyPair.publicKey);
  return {
    cryptoKeyPair: keyPair,
    publicKeyHex: Buffer.from(spkiDer).toString('hex'),
    publicKeyRawHex: Buffer.from(rawKey).toString('hex'),
    publicKeySpki: new Uint8Array(spkiDer)
  };
}

/**
 * Sign an OCP claim in the same way Identity.sign() does:
 * - Compute canonicalJSON(claim.stm)
 * - ECDSA-SHA256 sign it
 * - Attach sig and keys fields
 */
async function signClaim(claim, keypair) {
  const payload = new TextEncoder().encode(Verify.canonicalJSON(claim.stm));
  const sigBuf = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keypair.cryptoKeyPair.privateKey,
    payload
  );

  const signed = Object.assign({}, claim, {
    sig: {
      algorithm: 'ES256',
      value: Buffer.from(sigBuf).toString('hex')
    },
    keys: [{
      id: 'key-0',
      algorithm: 'ES256',
      publicKey: keypair.publicKeyHex
    }]
  });
  return signed;
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Helpers for building test claims ────────────────────────────────────────

function buildSafeboxIdentityClaim(publicKeyHex) {
  const pkBuf = Buffer.from(publicKeyHex, 'hex');
  const uri = 'safebox://' + sha256hex(pkBuf);
  return {
    ocp: 1,
    iss: uri,
    sub: uri,
    stm: {
      type: 'safebox_identity',
      publicKey: publicKeyHex,
      pcr0: 'a'.repeat(64),
      pcr1: 'b'.repeat(64),
      pcr4: 'c'.repeat(64),
      imageHash: 'd'.repeat(64),
      endpoints: ['https://10.0.1.5:8443'],
      capabilities: ['inference', 'storage'],
      version: '1.0.0'
    },
    nbf: nowISO()
  };
}

function buildPublicationClaim() {
  return {
    ocp: 1,
    iss: 'safenet:namespace:myns',
    sub: 'safenet:package:myns/mypkg@1.0.0',
    stm: {
      type: 'publication',
      namespace: 'myns',
      package: 'myns/mypkg',
      version: '1.0.0',
      merkleRoot: 'e'.repeat(64),
      manifestHash: 'f'.repeat(64),
      languages: ['javascript'],
      license: 'MIT'
    },
    nbf: nowISO()
  };
}

function buildAuditClaim() {
  return {
    ocp: 1,
    iss: 'safenet:auditor:alice',
    sub: 'safenet:package:myns/mypkg',
    stm: {
      type: 'audit_attestation',
      topic: 'safenet.audit.ml-inference',
      namespace: 'myns',
      package: 'myns/mypkg',
      versionRange: '>=1.0.0 <2.0.0',
      assessment: 'approved',
      auditor: 'alice',
      summary: 'Passed all inference safety checks'
    },
    nbf: nowISO()
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('TAP version 13');

  // ── canonicalJSON ──────────────────────────────────────────────────────

  await asyncTest('canonicalJSON: sorts keys', async () => {
    const result = Verify.canonicalJSON({ b: 1, a: 2 });
    assert.strictEqual(result, '{"a":2,"b":1}');
  });

  await asyncTest('canonicalJSON: handles nested objects', async () => {
    const result = Verify.canonicalJSON({ z: { b: 1, a: 2 }, a: 3 });
    assert.strictEqual(result, '{"a":3,"z":{"a":2,"b":1}}');
  });

  await asyncTest('canonicalJSON: handles arrays (preserves order)', async () => {
    const result = Verify.canonicalJSON([3, 1, 2]);
    assert.strictEqual(result, '[3,1,2]');
  });

  await asyncTest('canonicalJSON: strips undefined values', async () => {
    const result = Verify.canonicalJSON({ a: 1, b: undefined, c: 3 });
    assert.strictEqual(result, '{"a":1,"c":3}');
  });

  await asyncTest('canonicalJSON: handles null', async () => {
    assert.strictEqual(Verify.canonicalJSON(null), 'null');
  });

  await asyncTest('canonicalJSON: handles negative zero', async () => {
    assert.strictEqual(Verify.canonicalJSON(-0), '0');
  });

  // ── sha256hex ─────────────────────────────────────────────────────────

  await asyncTest('sha256hex: matches Node crypto', async () => {
    const data = 'hello world';
    const expected = sha256hex(data);
    const got = await Verify.sha256hex(data);
    assert.strictEqual(got, expected);
  });

  await asyncTest('sha256hex: works with Uint8Array', async () => {
    const bytes = new TextEncoder().encode('test data');
    const expected = sha256hex(Buffer.from(bytes));
    const got = await Verify.sha256hex(bytes);
    assert.strictEqual(got, expected);
  });

  // ── claimHash ─────────────────────────────────────────────────────────

  await asyncTest('claimHash: deterministic', async () => {
    const claim = { stm: { type: 'test', foo: 'bar' } };
    const h1 = await Verify.claimHash(claim);
    const h2 = await Verify.claimHash(claim);
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 64);
  });

  await asyncTest('claimHash: matches sha256(canonicalJSON(stm))', async () => {
    const claim = { stm: { type: 'test', z: 1, a: 2 } };
    const expected = sha256hex(Verify.canonicalJSON(claim.stm));
    const got = await Verify.claimHash(claim);
    assert.strictEqual(got, expected);
  });

  await asyncTest('claimHash: rejects missing stm', async () => {
    try {
      await Verify.claimHash({});
      assert.fail('Should throw');
    } catch (e) {
      assert.ok(e.message.includes('stm'));
    }
  });

  // ── validateStructure ─────────────────────────────────────────────────

  await asyncTest('validateStructure: valid claim', async () => {
    const claim = {
      ocp: 1, iss: 'safebox://abc', sub: 'safebox://abc',
      stm: { type: 'safebox_identity' }, nbf: nowISO()
    };
    const r = Verify.validateStructure(claim);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.errors.length, 0);
  });

  await asyncTest('validateStructure: catches all missing fields', async () => {
    const r = Verify.validateStructure({});
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 4); // ocp, iss, sub, stm
  });

  await asyncTest('validateStructure: catches wrong ocp version', async () => {
    const claim = {
      ocp: 2, iss: 'x', sub: 'x', stm: { type: 'test' }, nbf: nowISO()
    };
    const r = Verify.validateStructure(claim);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors[0].includes('ocp'));
  });

  // ── Verify.claim: signature verification (end-to-end) ─────────────────

  await asyncTest('Verify.claim: valid signed claim', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
    assert.strictEqual(result.errors.length, 0);
  });

  await asyncTest('Verify.claim: rejects tampered stm', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    // Tamper with the statement after signing
    signed.stm.version = '2.0.0';

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Signature')));
  });

  await asyncTest('Verify.claim: rejects wrong public key', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp1);

    // Replace with different key
    signed.keys = [{ id: 'key-0', algorithm: 'ES256', publicKey: kp2.publicKeyHex }];

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, false);
  });

  await asyncTest('Verify.claim: rejects missing signature', async () => {
    const claim = buildPublicationClaim();
    claim.nbf = nowISO();

    const result = await Verify.claim(claim);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('sig')));
  });

  await asyncTest('Verify.claim: expectedIssuer match', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    const r1 = await Verify.claim(signed, { expectedIssuer: 'safenet:namespace:myns' });
    assert.strictEqual(r1.valid, true);

    const r2 = await Verify.claim(signed, { expectedIssuer: 'safenet:namespace:other' });
    assert.strictEqual(r2.valid, false);
    assert.ok(r2.errors.some(e => e.includes('Issuer mismatch')));
  });

  await asyncTest('Verify.claim: expectedType match', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    const r1 = await Verify.claim(signed, { expectedType: 'publication' });
    assert.strictEqual(r1.valid, true);

    const r2 = await Verify.claim(signed, { expectedType: 'safebox_identity' });
    assert.strictEqual(r2.valid, false);
  });

  await asyncTest('Verify.claim: maxAgeSec enforcement', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    // Backdate the claim by 2 hours
    const twoHoursAgo = new Date(Date.now() - 7200000);
    claim.nbf = twoHoursAgo.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const signed = await signClaim(claim, kp);

    const r1 = await Verify.claim(signed, { maxAgeSec: 3600 }); // 1 hour
    assert.strictEqual(r1.valid, false);
    assert.ok(r1.errors.some(e => e.includes('too old')));

    const r2 = await Verify.claim(signed, { maxAgeSec: 86400 }); // 1 day
    assert.strictEqual(r2.valid, true);
  });

  await asyncTest('Verify.claim: publicKey override', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    // Remove keys from claim, provide via opts
    const noKeys = Object.assign({}, signed);
    delete noKeys.keys;

    const result = await Verify.claim(noKeys, { publicKey: kp.publicKeyHex });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, 'override');
  });

  await asyncTest('Verify.claim: raw public key format', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    // Use raw key format (65 bytes uncompressed) instead of SPKI
    signed.keys = [{
      id: 'raw-0',
      algorithm: 'ES256',
      publicKey: kp.publicKeyRawHex
    }];

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
  });

  // ── Verify.safeboxAttestation ─────────────────────────────────────────

  await asyncTest('safeboxAttestation: valid claim with trusted image', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    const signed = await signClaim(claim, kp);

    const result = await Verify.safeboxAttestation(signed, {
      trustedImages: ['d'.repeat(64)]
    });
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
    assert.ok(result.safeboxUri.startsWith('safebox://'));
    assert.strictEqual(result.imageHash, 'd'.repeat(64));
    assert.deepStrictEqual(result.endpoints, ['https://10.0.1.5:8443']);
    assert.deepStrictEqual(result.capabilities, ['inference', 'storage']);
  });

  await asyncTest('safeboxAttestation: rejects untrusted image', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    const signed = await signClaim(claim, kp);

    const result = await Verify.safeboxAttestation(signed, {
      trustedImages: ['e'.repeat(64)]  // different hash
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('imageHash not in trusted')));
  });

  await asyncTest('safeboxAttestation: rejects untrusted PCR0', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    const signed = await signClaim(claim, kp);

    const result = await Verify.safeboxAttestation(signed, {
      trustedPCR0: ['f'.repeat(64)]
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('pcr0 not in trusted')));
  });

  await asyncTest('safeboxAttestation: rejects non-self-issued', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    claim.sub = 'safebox://different';
    const signed = await signClaim(claim, kp);

    const result = await Verify.safeboxAttestation(signed);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('self-issued')));
  });

  await asyncTest('safeboxAttestation: without trust sets (signature-only)', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    const signed = await signClaim(claim, kp);

    // No trustedImages or trustedPCR0 — just check signature + structure
    const result = await Verify.safeboxAttestation(signed);
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
  });

  // ── Verify.publication ────────────────────────────────────────────────

  await asyncTest('publication: valid claim', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    const result = await Verify.publication(signed);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.package, 'myns/myns/mypkg@1.0.0');
  });

  await asyncTest('publication: Merkle root verification against files', async () => {
    const kp = await generateKeypair();

    // Create real files and compute real Merkle root
    const files = [
      { path: 'a.js', content: 'console.log("a")' },
      { path: 'b.js', content: 'console.log("b")' }
    ];
    const sorted = files.slice().sort((a, b) => a.path < b.path ? -1 : 1);
    const leafHashes = sorted.map(f => sha256hex(f.content));
    const merkleRoot = sha256hex(leafHashes[0] + leafHashes[1]);

    const claim = buildPublicationClaim();
    claim.stm.merkleRoot = merkleRoot;
    const signed = await signClaim(claim, kp);

    const result = await Verify.publication(signed, { files });
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
    assert.strictEqual(result.merkleVerified, true);
  });

  await asyncTest('publication: rejects wrong Merkle root', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);

    const files = [{ path: 'a.js', content: 'tampered content' }];
    const result = await Verify.publication(signed, { files });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Merkle root mismatch')));
  });

  // ── Verify.auditAttestation ───────────────────────────────────────────

  await asyncTest('auditAttestation: valid claim with trusted auditor', async () => {
    const kp = await generateKeypair();
    const claim = buildAuditClaim();
    const signed = await signClaim(claim, kp);

    const result = await Verify.auditAttestation(signed, {
      trustedAuditors: ['alice']
    });
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
    assert.strictEqual(result.topic, 'safenet.audit.ml-inference');
    assert.strictEqual(result.assessment, 'approved');
  });

  await asyncTest('auditAttestation: rejects untrusted auditor', async () => {
    const kp = await generateKeypair();
    const claim = buildAuditClaim();
    const signed = await signClaim(claim, kp);

    const result = await Verify.auditAttestation(signed, {
      trustedAuditors: ['bob']
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('not trusted')));
  });

  await asyncTest('auditAttestation: rejects expired attestation', async () => {
    const kp = await generateKeypair();
    const claim = buildAuditClaim();
    // Set expiry in the past
    claim.stm.expiry = new Date(Date.now() - 3600000).toISOString();
    const signed = await signClaim(claim, kp);

    const result = await Verify.auditAttestation(signed);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('expired')));
  });

  // ── Verify.isRevoked ──────────────────────────────────────────────────

  await asyncTest('isRevoked: returns true for revoked claim', async () => {
    const claim = { stm: { type: 'test', data: 'revoked-claim' } };
    const hash = await Verify.claimHash(claim);
    const revoked = await Verify.isRevoked(claim, [hash]);
    assert.strictEqual(revoked, true);
  });

  await asyncTest('isRevoked: returns false for non-revoked claim', async () => {
    const claim = { stm: { type: 'test', data: 'good-claim' } };
    const revoked = await Verify.isRevoked(claim, ['0'.repeat(64)]);
    assert.strictEqual(revoked, false);
  });

  await asyncTest('isRevoked: works with Set', async () => {
    const claim = { stm: { type: 'test', data: 'set-test' } };
    const hash = await Verify.claimHash(claim);
    const revokedSet = new Set([hash]);
    assert.strictEqual(await Verify.isRevoked(claim, revokedSet), true);
    assert.strictEqual(await Verify.isRevoked({ stm: { type: 'other' } }, revokedSet), false);
  });

  // ── Merkle proof verification ─────────────────────────────────────────

  await asyncTest('inclusionProof: verifies valid proof', async () => {
    // Build a 4-leaf tree manually
    const leaves = ['leaf0', 'leaf1', 'leaf2', 'leaf3']
      .map(l => sha256hex(l));

    const h01 = sha256hex(leaves[0] + leaves[1]);
    const h23 = sha256hex(leaves[2] + leaves[3]);
    const root = sha256hex(h01 + h23);

    // Proof for leaf[0]: sibling is leaf[1] (right), then h23 (right)
    const proof = [
      { position: 'right', hash: leaves[1] },
      { position: 'right', hash: h23 }
    ];

    const ok = await Verify.inclusionProof(leaves[0], proof, root);
    assert.strictEqual(ok, true);
  });

  await asyncTest('inclusionProof: rejects invalid proof', async () => {
    const ok = await Verify.inclusionProof(
      sha256hex('leaf0'),
      [{ position: 'right', hash: sha256hex('wrong') }],
      sha256hex('fake-root')
    );
    assert.strictEqual(ok, false);
  });

  // ── Merkle root computation ───────────────────────────────────────────

  await asyncTest('merkleRoot: matches manual computation', async () => {
    const h1 = sha256hex('a');
    const h2 = sha256hex('b');
    const expected = sha256hex(h1 + h2);
    const got = await Verify.merkleRoot([h1, h2]);
    assert.strictEqual(got, expected);
  });

  await asyncTest('merkleRoot: single leaf returns itself', async () => {
    const h = sha256hex('only');
    const got = await Verify.merkleRoot([h]);
    assert.strictEqual(got, h);
  });

  await asyncTest('merkleRoot: odd number of leaves promotes last', async () => {
    const leaves = [sha256hex('a'), sha256hex('b'), sha256hex('c')];
    const h01 = sha256hex(leaves[0] + leaves[1]);
    // c promoted, then sha256(h01 + c)
    const expected = sha256hex(h01 + leaves[2]);
    const got = await Verify.merkleRoot(leaves);
    assert.strictEqual(got, expected);
  });

  // ── fetchAndVerify ────────────────────────────────────────────────────

  await asyncTest('fetchAndVerify: works with mock fetch', async () => {
    const kp = await generateKeypair();
    const claim = buildSafeboxIdentityClaim(kp.publicKeyHex);
    const signed = await signClaim(claim, kp);

    const mockFetch = async (url) => {
      assert.ok(url.includes('/safenet/v1/identity'));
      return {
        ok: true,
        json: async () => signed
      };
    };

    const result = await Verify.fetchAndVerify('https://10.0.1.5:8443', {
      fetch: mockFetch
    });
    assert.strictEqual(result.valid, true, 'errors: ' + result.errors.join(', '));
    assert.ok(result.claim);
    assert.ok(result.safeboxUri);
  });

  await asyncTest('fetchAndVerify: handles HTTP error', async () => {
    const mockFetch = async () => ({ ok: false, status: 500 });

    const result = await Verify.fetchAndVerify('https://10.0.1.5:8443', {
      fetch: mockFetch
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('500')));
  });

  await asyncTest('fetchAndVerify: handles network error', async () => {
    const mockFetch = async () => { throw new Error('ECONNREFUSED'); };

    const result = await Verify.fetchAndVerify('https://10.0.1.5:8443', {
      fetch: mockFetch
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('ECONNREFUSED')));
  });

  // ── Cross-compatibility with existing utils ───────────────────────────

  await asyncTest('canonicalJSON matches utils.js implementation', async () => {
    // Load utils.js canonicalJSON for comparison
    let utilsCJ;
    try {
      utilsCJ = require(path.resolve(__dirname, '..', 'lib', 'utils')).canonicalJSON;
    } catch (e) {
      // utils.js not loadable (e.g. missing dependencies) — skip
      console.log('  # skipped: utils.js not loadable');
      return;
    }

    const testCases = [
      { b: 2, a: 1 },
      { nested: { z: 1, a: 2 }, top: 'hi' },
      [1, 'two', { three: 3 }],
      { empty: null, bool: true, num: -42.5 },
      'just a string',
      { with: { deep: { nesting: { here: true } } } }
    ];

    for (const tc of testCases) {
      const fromVerify = Verify.canonicalJSON(tc);
      const fromUtils = utilsCJ(tc);
      assert.strictEqual(fromVerify, fromUtils,
        'Mismatch for: ' + JSON.stringify(tc) +
        '\n  Verify: ' + fromVerify +
        '\n  utils:  ' + fromUtils
      );
    }
  });

  await asyncTest('claimHash matches utils.js generateClaimHash', async () => {
    let generateClaimHash;
    try {
      generateClaimHash = require(path.resolve(__dirname, '..', 'lib', 'utils')).generateClaimHash;
    } catch (e) {
      console.log('  # skipped: utils.js not loadable');
      return;
    }

    const claim = {
      ocp: 1, iss: 'test', sub: 'test',
      stm: { type: 'test', data: 'hello', number: 42 },
      nbf: nowISO()
    };

    const fromVerify = await Verify.claimHash(claim);
    const fromUtils = generateClaimHash(claim);
    assert.strictEqual(fromVerify, fromUtils);
  });

  // ── DER signature handling ────────────────────────────────────────────

  await asyncTest('Verify.claim: handles DER-encoded signatures', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const payload = new TextEncoder().encode(Verify.canonicalJSON(claim.stm));

    // Sign and get raw IEEE P1363 signature
    const sigBuf = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.cryptoKeyPair.privateKey,
      payload
    );
    const p1363 = new Uint8Array(sigBuf);

    // Convert to DER manually
    const r = p1363.slice(0, 32);
    const s = p1363.slice(32, 64);
    function integerBytes(val) {
      // Remove leading zeros, add 0x00 if high bit set
      let start = 0;
      while (start < val.length - 1 && val[start] === 0) start++;
      const trimmed = val.slice(start);
      const needPad = trimmed[0] & 0x80;
      const result = new Uint8Array(trimmed.length + (needPad ? 1 : 0));
      if (needPad) result[0] = 0;
      result.set(trimmed, needPad ? 1 : 0);
      return result;
    }
    const rBytes = integerBytes(r);
    const sBytes = integerBytes(s);
    const seqLen = 2 + rBytes.length + 2 + sBytes.length;
    const der = new Uint8Array(2 + seqLen);
    let pos = 0;
    der[pos++] = 0x30; // SEQUENCE
    der[pos++] = seqLen;
    der[pos++] = 0x02; // INTEGER
    der[pos++] = rBytes.length;
    der.set(rBytes, pos); pos += rBytes.length;
    der[pos++] = 0x02; // INTEGER
    der[pos++] = sBytes.length;
    der.set(sBytes, pos);

    const signed = Object.assign({}, claim, {
      sig: { algorithm: 'ES256', value: Buffer.from(der).toString('hex') },
      keys: [{ id: 'key-0', algorithm: 'ES256', publicKey: kp.publicKeyHex }],
      nbf: claim.nbf
    });

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, true, 'DER sig errors: ' + result.errors.join(', '));
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  await asyncTest('Verify.claim: rejects unsupported algorithm', async () => {
    const kp = await generateKeypair();
    const claim = buildPublicationClaim();
    const signed = await signClaim(claim, kp);
    signed.sig.algorithm = 'RS256';

    const result = await Verify.claim(signed);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Unsupported algorithm')));
  });

  await asyncTest('Verify.claim: rejects non-object claim', async () => {
    const result = await Verify.claim(null);
    assert.strictEqual(result.valid, false);
  });

  await asyncTest('Verify.claim: rejects no keys and no override', async () => {
    const claim = buildPublicationClaim();
    claim.sig = { algorithm: 'ES256', value: 'deadbeef' };
    const result = await Verify.claim(claim);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('No public key')));
  });

  // ── Summary ───────────────────────────────────────────────────────────

  console.log(`\n1..${testCount}`);
  console.log(`# tests ${testCount}`);
  console.log(`# pass  ${passed}`);
  console.log(`# fail  ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const e of errors) {
      console.log(`  - ${e.name}: ${e.error.message}`);
    }
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
