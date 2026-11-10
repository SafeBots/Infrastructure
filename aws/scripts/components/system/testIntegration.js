'use strict';

// Integration tests for the Safebox Infrastructure system modules.
// Exercises multiple modules working together.
//
// Run: NODE_ENV=test node testIntegration.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set up a temp directory and governance keys file BEFORE requiring
// governanceKeys (it reads process.env.SAFEBOX_GOVERNANCE_KEYS at load time).
const tmpDir = path.join(os.tmpdir(), 'test-integration-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
const govKeysPath = path.join(tmpDir, 'governance-keys.json');
process.env.SAFEBOX_GOVERNANCE_KEYS = govKeysPath;

// secret.js reads the 32-byte HMAC seed the initramfs leaves at
// /run/safebox/hmac-seed. Under NODE_ENV=test it honours SAFEBOX_SYSTEM_SECRET
// (resolved at require time), so write a seed file first and point it there.
process.env.NODE_ENV = 'test';
const seedPath = path.join(tmpDir, 'hmac-seed');
const TEST_SEED = Buffer.alloc(32, 0x5a);
fs.writeFileSync(seedPath, TEST_SEED, { mode: 0o400 });
process.env.SAFEBOX_SYSTEM_SECRET = seedPath;

const ocpVerify = require('./ocpVerify');
const governanceKeys = require('./governanceKeys');
const instanceIdentity = require('./instanceIdentity');
const succession = require('./succession');
const shamir = require('./shamirSplit');
const delegation = require('./delegation');
const auth = require('./auth');
const secret = require('./secret');
const imageDistribution = require('./imageDistribution');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error('Assertion failed: ' + msg);
}

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey.toString('base64'), privateKey };
}

function generateP256() {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeySpki: spki };
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

// 1. Governance round-trip: generate keypairs, write a governance registry,
//    create an OCP claim, sign it, and verify using the governance trust set.
test('1. Governance round-trip: keypair → OCP claim → sign → verify with governance trust set', function () {
  const kp1 = generateTestKeypair();
  const kp2 = generateTestKeypair();

  // Write a governance keys file with both keys
  const govKeys = {
    version: 1,
    keys: {
      'key-alpha': {
        publicKey: kp1.publicKey,
        roles: ['admin'],
        addedBy: 'genesis',
        addedAt: new Date().toISOString(),
      },
      'key-beta': {
        publicKey: kp2.publicKey,
        roles: ['admin'],
        addedBy: 'genesis',
        addedAt: new Date().toISOString(),
      },
    },
    thresholds: {
      system: { m: 2, n: 2 },
    },
  };
  fs.writeFileSync(govKeysPath, JSON.stringify(govKeys, null, 2));
  governanceKeys.load();

  // Create and sign an OCP claim with both keys
  const claim = makeClaim(
    { type: 'test', action: 'govern' },
    [kp1.publicKey, kp2.publicKey],
    [kp1.privateKey, kp2.privateKey]
  );

  // Query the governance module for trust set and threshold
  const trusted = governanceKeys.getTrustedKeys();
  assert(trusted.size === 2, 'expected 2 trusted keys, got ' + trusted.size);
  assert(trusted.has(kp1.publicKey), 'kp1 should be in trusted set');
  assert(trusted.has(kp2.publicKey), 'kp2 should be in trusted set');

  const threshold = governanceKeys.getThreshold('system');
  assert(threshold.m === 2, 'system threshold m should be 2');
  assert(threshold.n === 2, 'system threshold n should be 2');

  // Verify the claim against the governance trust set
  const result = ocpVerify.verifyThreshold(claim, threshold.m, trusted);
  assert(result.ok === true, 'verifyThreshold should pass: ' + JSON.stringify(result));
  assert(result.validSigners === 2, 'expected 2 valid signers, got ' + result.validSigners);
});

// 2. Secret derivation chain: the master is HKDF-SHA256 of the sealed seed
//    (no attestation-derived key any more; see secret.js), then per-container
//    keys are derived from the master. Verify determinism and independence.
test('2. Secret derivation chain: sealed seed → deriveMaster → derivePerContainerKey → deterministic', function () {
  assert(secret.SEED_PATH === seedPath, 'secret.js must honour SAFEBOX_SYSTEM_SECRET under NODE_ENV=test');

  // Derive master from the seed twice — must be identical
  const master1 = secret.deriveMaster(Buffer.from(TEST_SEED));
  const master2 = secret.deriveMaster(Buffer.from(TEST_SEED));
  assert(master1.equals(master2), 'deriveMaster must be deterministic');
  assert(master1.length === 32, 'master secret must be 32 bytes');

  // Must equal RFC 5869 HKDF-SHA256(ikm=seed, salt=32 zero bytes,
  // info="safebox-gateway-hmac-v2", L=32), computed independently here.
  const expected = Buffer.from(crypto.hkdfSync('sha256', TEST_SEED, Buffer.alloc(32),
    Buffer.from('safebox-gateway-hmac-v2', 'utf8'), 32));
  assert(master1.equals(expected), 'master must be HKDF-SHA256 of the seed with the documented salt and info');

  // A different seed must give a different master
  const masterOther = secret.deriveMaster(Buffer.alloc(32, 0xa5));
  assert(!master1.equals(masterOther), 'different seeds must yield different masters');

  // Seeds of the wrong length are refused
  let threw = false;
  try { secret.deriveMaster(Buffer.alloc(16, 0x5a)); } catch (_) { threw = true; }
  assert(threw, 'deriveMaster must reject a seed that is not 32 bytes');

  // Derive per-container keys — same inputs must produce same output
  const epoch = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
  const ck1 = secret.derivePerContainerKey(master1, 'my-container', epoch);
  const ck2 = secret.derivePerContainerKey(master2, 'my-container', epoch);
  assert(ck1.equals(ck2), 'derivePerContainerKey must be deterministic');
  assert(ck1.length === 32, 'container key must be 32 bytes');

  // Different container names must produce different keys
  const ck3 = secret.derivePerContainerKey(master1, 'other-container', epoch);
  assert(!ck1.equals(ck3), 'different container names must yield different keys');

  // Different epochs must produce different keys
  const epoch2 = 'b2c3d4e5f6a7b8a9b2c3d4e5f6a7b8a9';
  const ck4 = secret.derivePerContainerKey(master1, 'my-container', epoch2);
  assert(!ck1.equals(ck4), 'different epochs must yield different keys');
});

// 3. Succession + ECIES: predecessor encrypts a secret to the successor's
//    public key; successor decrypts and recovers the same bytes.
test('3. Succession + ECIES: predecessor encrypts → successor decrypts → same bytes', function () {
  const predecessor = generateP256();
  const successor = generateP256();
  const masterSecret = crypto.randomBytes(32);

  // Predecessor ECIES-encrypts the master secret to the successor
  const envelope = succession.eciesEncrypt(successor.publicKeySpki, masterSecret);

  // Verify envelope structure
  assert(typeof envelope.ephemeralPublicKey === 'string', 'must have ephemeralPublicKey');
  assert(typeof envelope.iv === 'string', 'must have iv');
  assert(typeof envelope.ciphertext === 'string', 'must have ciphertext');
  assert(typeof envelope.tag === 'string', 'must have tag');

  // Successor decrypts and recovers the original secret
  const decrypted = succession.eciesDecrypt(successor.privateKey, envelope);
  assert(decrypted.equals(masterSecret), 'successor must recover the master secret');

  // Predecessor's key cannot decrypt
  let threw = false;
  try {
    succession.eciesDecrypt(predecessor.privateKey, envelope);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'predecessor key must NOT decrypt a message to successor');
});

// 4. Shamir + succession recovery: split a master secret, reconstruct from
//    threshold shares, verify it matches, use it for key derivation.
test('4. Shamir + succession recovery: split → reconstruct → derivePerContainerKey → keys match', function () {
  const masterSecret = crypto.randomBytes(32);

  // Split into 5 shares with threshold 3
  const shares = shamir.split(masterSecret, 5, 3);
  assert(shares.length === 5, 'expected 5 shares');

  // Any 3 shares reconstruct the original secret
  const recovered1 = shamir.reconstruct([shares[0], shares[1], shares[2]], 3);
  const recovered2 = shamir.reconstruct([shares[2], shares[3], shares[4]], 3);
  assert(recovered1.equals(masterSecret), 'subset [0,1,2] must reconstruct correctly');
  assert(recovered2.equals(masterSecret), 'subset [2,3,4] must reconstruct correctly');

  // Derived keys from both reconstructions must match
  const epoch = crypto.randomBytes(16).toString('hex');
  const key1 = secret.derivePerContainerKey(recovered1, 'test-svc', epoch);
  const key2 = secret.derivePerContainerKey(recovered2, 'test-svc', epoch);
  assert(key1.equals(key2), 'derived keys from different reconstructions must match');

  // succession.recoverFromShares applies HKDF — results must be deterministic
  const derived1 = succession.recoverFromShares([shares[0], shares[1], shares[2]], 3);
  const derived2 = succession.recoverFromShares([shares[2], shares[3], shares[4]], 3);
  assert(derived1.equals(derived2), 'recoverFromShares must be deterministic across subsets');
});

// 5. Delegation scope intersection and operation authorization.
test('5. Delegation + OCP: scope intersection → isOperationAllowed', function () {
  // Root scope (what the root delegator grants)
  const rootScope = {
    operations: ['LLM.chat', 'embed', 'read', 'write'],
    maxBudget: { USD: 100, EUR: 80 },
    constraints: { maxTokens: 4096, allowPII: true },
  };

  // Delegated scope (what the delegate is given)
  const delegatedScope = {
    operations: ['LLM.chat', 'embed', 'read'],
    maxBudget: { USD: 50 },
    constraints: { maxTokens: 2048, allowPII: false },
  };

  // Effective scope is the intersection
  const effective = delegation.scopeIntersection(rootScope, delegatedScope);

  // Operations: set intersection
  assert(effective.operations.length === 3, 'expected 3 operations');
  assert(effective.operations.indexOf('LLM.chat') !== -1, 'LLM.chat in intersection');
  assert(effective.operations.indexOf('embed') !== -1, 'embed in intersection');
  assert(effective.operations.indexOf('read') !== -1, 'read in intersection');
  assert(effective.operations.indexOf('write') === -1, 'write NOT in intersection');

  // Budget: per-currency minimum; EUR only in one scope → excluded
  assert(effective.maxBudget.USD === 50, 'USD budget = min(100, 50) = 50');
  assert(effective.maxBudget.EUR === undefined, 'EUR excluded (only in one scope)');

  // Constraints: numeric → min, boolean → AND
  assert(effective.constraints.maxTokens === 2048, 'maxTokens = min(4096, 2048)');
  assert(effective.constraints.allowPII === false, 'allowPII = AND(true, false)');

  // isOperationAllowed against effective scope
  assert(delegation.isOperationAllowed(effective, 'LLM.chat') === true, 'LLM.chat allowed');
  assert(delegation.isOperationAllowed(effective, 'embed') === true, 'embed allowed');
  assert(delegation.isOperationAllowed(effective, 'read') === true, 'read allowed');
  assert(delegation.isOperationAllowed(effective, 'write') === false, 'write NOT allowed');
  assert(delegation.isOperationAllowed(effective, 'delete') === false, 'delete NOT allowed');

  // Further narrowing: intersect with an even tighter scope
  const tighterScope = {
    operations: ['read'],
    maxBudget: { USD: 10 },
    constraints: { maxTokens: 512 },
  };
  const narrower = delegation.scopeIntersection(effective, tighterScope);
  assert(narrower.operations.length === 1, 'only read survives');
  assert(narrower.operations[0] === 'read', 'the survivor is read');
  assert(narrower.maxBudget.USD === 10, 'budget further narrowed');
  assert(narrower.constraints.maxTokens === 512, 'maxTokens further narrowed');
});

// 6. Instance identity + attestation: init, issue an attestation claim,
//    verify the claim's signature using ocpVerify's canonicalization.
test('6. Instance identity + attestation: init → issueAttestationClaim → verify signature', function () {
  const identity = instanceIdentity.init();
  assert(typeof identity.publicKey === 'string', 'init must return publicKey');
  assert(typeof identity.publicKeyHash === 'string', 'init must return publicKeyHash');
  assert(identity.publicKeyHash.length === 64, 'publicKeyHash must be 64 hex chars');

  // getPublicKey must return the same value
  assert(instanceIdentity.getPublicKey() === identity.publicKey, 'getPublicKey consistency');

  // Issue an attestation claim
  const claim = instanceIdentity.issueAttestationClaim({
    cloud: 'test',
    hardwareRoot: 'none',
    imageHash: 'sha256:testimage',
  });

  // Structural checks
  assert(claim.ocp === 1, 'ocp must be 1');
  assert(claim.stm.type === 'attestation', 'stm.type must be attestation');
  assert(claim.stm.instancePublicKey === identity.publicKey, 'instancePublicKey match');
  assert(claim.key.length === 1, 'one signing key');
  assert(claim.sig.length === 1, 'one signature');
  assert(claim.key[0] === identity.publicKey, 'key must be the instance key');

  // Verify the signature manually.
  // instanceIdentity signs over canonicalize({ocp, iss, stm, nbf, exp}) — no sub.
  // Rebuild that payload and verify with ocpVerify.canonicalize + crypto.verify.
  const signedPayload = {
    ocp: claim.ocp,
    iss: claim.iss,
    stm: claim.stm,
    nbf: claim.nbf,
    exp: claim.exp,
  };
  const canonical = ocpVerify.canonicalize(signedPayload);
  const keyDer = Buffer.from(claim.key[0], 'base64');
  const sigBuf = Buffer.from(claim.sig[0], 'base64');
  const ok = crypto.verify('sha256', Buffer.from(canonical), {
    key: keyDer,
    format: 'der',
    type: 'spki',
  }, sigBuf);
  assert(ok === true, 'attestation claim signature must verify');
});

// 7. Image distribution + verification: chunk a file, verify each chunk
//    against its CID, verify the Merkle tree.
test('7. Image distribution: chunk → verify chunks → verify Merkle tree', function () {
  // Create a 4 KiB test image
  const testImagePath = path.join(tmpDir, 'test-image.bin');
  const imageData = crypto.randomBytes(4 * 1024);
  fs.writeFileSync(testImagePath, imageData);

  // Chunk with 1 KiB chunks, fanout 2
  const result = imageDistribution.chunkImage(testImagePath, { chunkSize: 1024, fanout: 2 });
  assert(result.chunks.length === 4, 'expected 4 chunks for 4 KiB / 1 KiB');
  assert(typeof result.root === 'string', 'must have a root CID');
  assert(result.root.length === 64, 'root CID must be SHA-256 hex (64 chars)');

  // Verify each chunk's CID against its bytes
  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    const chunkData = imageData.slice(chunk.offset, chunk.offset + chunk.size);
    const v = imageDistribution.verifyChunk(chunkData, chunk.cid);
    assert(v.ok === true, 'chunk ' + i + ' must verify');
    assert(v.actual === chunk.cid, 'actual CID must match');
  }

  // Verify Merkle tree internal consistency
  const treeResult = imageDistribution.verifyMerkleTree(result.tree, result.chunks);
  assert(treeResult.ok === true, 'Merkle tree must verify: ' + JSON.stringify(treeResult.errors));

  // Tamper with a chunk CID — Merkle tree verification must fail
  const tamperedChunks = result.chunks.map(function (c) { return { index: c.index, cid: c.cid, offset: c.offset, size: c.size }; });
  tamperedChunks[0].cid = 'deadbeef'.repeat(8);
  const tamperedResult = imageDistribution.verifyMerkleTree(result.tree, tamperedChunks);
  assert(tamperedResult.ok === false, 'tampered chunk CID must break Merkle verification');
});

// 8. HMAC auth round-trip: sign a request, verify it passes, then tamper
//    with the body and verify it fails.
test('8. HMAC auth round-trip: sign → verify → pass; tamper body → fail', function () {
  const hmacSecret = crypto.randomBytes(32);
  const method = 'POST';
  const reqPath = '/api/containers/create';
  const body = '{"name":"test-container"}';

  // Sign and verify — should pass
  const headers1 = auth.sign(hmacSecret, method, reqPath, body);
  const result1 = auth.verify(hmacSecret, headers1, method, reqPath, body);
  assert(result1.ok === true, 'valid HMAC should pass');

  // Sign again (new nonce), verify with tampered body — should fail
  const headers2 = auth.sign(hmacSecret, method, reqPath, body);
  const tamperedBody = '{"name":"HIJACKED"}';
  const result2 = auth.verify(hmacSecret, headers2, method, reqPath, tamperedBody);
  assert(result2.ok === false, 'tampered body must fail');
  assert(result2.code === 'signature_mismatch', 'expected signature_mismatch, got ' + result2.code);
});

// 9. In operator mode (no SAFEBOX_TENANT) secret.load() returns the OPERATOR
//    key — never the master. Under NODE_ENV=test it derives it from the seed
//    file the way safebox-keyd does (seed → master → operator key); a seed of
//    the wrong size is a refusal to start.
async function testLoad() {
  const name = '9. secret.load(): operator key = deriveOperatorKey(deriveMaster(seed)), never the master; wrong size refused';
  try {
    delete process.env.SAFEBOX_TENANT;
    const loaded = await secret.load();
    const master = secret.deriveMaster(Buffer.from(TEST_SEED));
    assert(loaded.equals(secret.deriveOperatorKey(master)), 'load() must derive the operator key from the seed file');
    assert(!loaded.equals(master), 'load() must not hand the master to the operator instance');
    assert(secret.readSeed().equals(TEST_SEED), 'readSeed() reads the seed file under NODE_ENV=test');
    fs.writeFileSync(seedPath, Buffer.alloc(31, 0x5a), { mode: 0o400 });
    let threw = false;
    try { await secret.load(); } catch (_) { threw = true; }
    assert(threw, 'load() must refuse a seed file that is not exactly 32 bytes');
    console.log('✓ ' + name);
    passed++;
  } catch (err) {
    console.log('✗ ' + name);
    console.log('  ' + err.message);
    failed++;
  }
}

// ── Cleanup & Summary ──────────────────────────────────────────────────────

testLoad().then(function () {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }

  console.log('');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
  if (failed > 0) {
    process.exit(1);
  }
});
