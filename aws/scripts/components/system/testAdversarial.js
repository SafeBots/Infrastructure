'use strict';

// Adversarial / security tests for the Safebox Infrastructure system modules.
// Verifies that the system correctly rejects various attack scenarios.
//
// Run: node testAdversarial.js

const crypto = require('crypto');
const ocpVerify = require('./ocpVerify');
const auth = require('./auth');
const shamir = require('./shamirSplit');
const succession = require('./succession');
const delegation = require('./delegation');

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

// 1. Valid HMAC but no OCP claim: HMAC auth passes, but OCP verification
//    rejects the absent claim — the governance gate catches it.
test('1. Valid HMAC but no OCP claim → governance gate rejects', function () {
  const hmacSecret = crypto.randomBytes(32);
  const headers = auth.sign(hmacSecret, 'POST', '/api/test', '{}');
  const hmacResult = auth.verify(hmacSecret, headers, 'POST', '/api/test', '{}');
  assert(hmacResult.ok === true, 'HMAC should pass');

  // No OCP claim — governance verification must reject
  const ocpNull = ocpVerify.verify(null);
  assert(ocpNull.ok === false, 'null claim must be rejected');

  const ocpUndefined = ocpVerify.verify(undefined);
  assert(ocpUndefined.ok === false, 'undefined claim must be rejected');

  const ocpEmpty = ocpVerify.verifyThreshold(null, 1, new Set());
  assert(ocpEmpty.ok === false, 'null claim in verifyThreshold must be rejected');
});

// 2. Valid HMAC + forged OCP claim: signed by a key NOT in the trusted set.
test('2. Forged OCP claim: signed by untrusted key → verifyThreshold rejects', function () {
  const hmacSecret = crypto.randomBytes(32);
  const headers = auth.sign(hmacSecret, 'POST', '/api/test', '{}');
  const hmacResult = auth.verify(hmacSecret, headers, 'POST', '/api/test', '{}');
  assert(hmacResult.ok === true, 'HMAC should pass');

  // Forger signs with their own key, but it is not in the trusted set
  const kpForger = generateTestKeypair();
  const kpTrusted = generateTestKeypair();
  const claim = makeClaim(null, [kpForger.publicKey], [kpForger.privateKey]);
  const trusted = new Set([kpTrusted.publicKey]); // forger absent

  const result = ocpVerify.verifyThreshold(claim, 1, trusted);
  assert(result.ok === false, 'forged claim must be rejected');
  assert(result.code === 'INSUFFICIENT_SIGNERS', 'expected INSUFFICIENT_SIGNERS, got ' + result.code);
});

// 3. Valid HMAC + insufficient signers: 1 signer when threshold requires 2.
test('3. Insufficient signers: 1 of 2 required → rejected', function () {
  const kp = generateTestKeypair();
  const claim = makeClaim(null, [kp.publicKey], [kp.privateKey]);
  const trusted = new Set([kp.publicKey]);

  const result = ocpVerify.verifyThreshold(claim, 2, trusted);
  assert(result.ok === false, 'insufficient signers must be rejected');
  assert(result.code === 'INSUFFICIENT_SIGNERS', 'expected INSUFFICIENT_SIGNERS');
});

// 4. Wrong operation: claimHash of the authorized operation differs from
//    the actual operation being attempted.
test('4. Wrong operation: claimHash mismatch → unauthorized operation detected', function () {
  const authorizedStm = { type: 'container', action: 'create', imageHash: 'sha256:abc123' };
  const attemptedStm = { type: 'container', action: 'destroy', imageHash: 'sha256:abc123' };

  const authorizedHash = ocpVerify.claimHash({ stm: authorizedStm });
  const attemptedHash = ocpVerify.claimHash({ stm: attemptedStm });

  assert(authorizedHash !== attemptedHash,
    'different operations must produce different claim hashes');

  // Same operation, same hash — sanity check
  const sameHash = ocpVerify.claimHash({ stm: authorizedStm });
  assert(authorizedHash === sameHash, 'same operation must produce same hash');
});

// 5. Replay expired OCP claim: exp in the past → rejected.
test('5. Expired OCP claim → rejected', function () {
  const kp = generateTestKeypair();
  const nowSec = Math.floor(Date.now() / 1000);
  const claim = makeClaim(null, [kp.publicKey], [kp.privateKey], {
    nbf: nowSec - 7200,
    exp: nowSec - 3600, // expired 1 hour ago
  });
  const trusted = new Set([kp.publicKey]);

  const result = ocpVerify.verifyThreshold(claim, 1, trusted);
  assert(result.ok === false, 'expired claim must be rejected');
  assert(result.code === 'EXPIRED', 'expected EXPIRED, got ' + result.code);
});

// 6. OCP claim signed by removed key: key is trusted at signing time,
//    then removed from the trust set before verification.
test('6. Claim signed by removed key → rejected after removal', function () {
  const kp = generateTestKeypair();
  const trusted = new Set([kp.publicKey]);

  const claim = makeClaim(null, [kp.publicKey], [kp.privateKey]);

  // Verify while key is still trusted — should pass
  const result1 = ocpVerify.verifyThreshold(claim, 1, trusted);
  assert(result1.ok === true, 'should pass while key is trusted');

  // Remove the key from the trusted set
  trusted.delete(kp.publicKey);

  // Verify again — should fail
  const result2 = ocpVerify.verifyThreshold(claim, 1, trusted);
  assert(result2.ok === false, 'should fail after key removal');
  assert(result2.code === 'INSUFFICIENT_SIGNERS', 'expected INSUFFICIENT_SIGNERS');
});

// 7. Shamir tampered shares: corrupt one share's y-value → reconstruction
//    produces the wrong result.
test('7. Shamir tampered shares → wrong reconstruction', function () {
  const secretData = crypto.randomBytes(32);
  const shares = shamir.split(secretData, 5, 3);

  // Deep-copy and tamper with one share
  const tampered = shares.map(function (s) { return { x: s.x, y: Buffer.from(s.y) }; });
  tampered[1].y[0] ^= 0xFF;

  const recovered = shamir.reconstruct([tampered[0], tampered[1], tampered[2]], 3);
  assert(!recovered.equals(secretData), 'tampered share must produce wrong result');

  // verify() should also detect the inconsistency
  const vResult = shamir.verify(tampered, 3);
  assert(vResult.ok === false, 'verify must detect tampered shares');
});

// 8. Shamir insufficient shares: fewer than threshold → throws.
test('8. Shamir insufficient shares → reconstruct throws', function () {
  const secretData = crypto.randomBytes(32);
  const shares = shamir.split(secretData, 5, 3);

  // Attempt to reconstruct with only 2 shares (threshold is 3)
  let threw = false;
  try {
    shamir.reconstruct([shares[0], shares[1]], 3);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'reconstruct with < threshold shares must throw');
});

// 9. ECIES tampered ciphertext: flip a byte in the ciphertext, decryption
//    must fail (AES-GCM authentication failure).
test('9. ECIES tampered ciphertext → GCM auth failure', function () {
  const recipient = generateP256();
  const plaintext = crypto.randomBytes(32);
  const envelope = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);

  // Tamper: flip a byte in the ciphertext
  const ctBuf = Buffer.from(envelope.ciphertext, 'base64');
  ctBuf[0] ^= 0xFF;
  const tampered = {
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    iv: envelope.iv,
    ciphertext: ctBuf.toString('base64'),
    tag: envelope.tag,
  };

  let threw = false;
  try {
    succession.eciesDecrypt(recipient.privateKey, tampered);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'tampered ciphertext must cause GCM auth failure');
});

// 10. ECIES wrong recipient key: encrypt to key A, decrypt with key B → fail.
test('10. ECIES wrong recipient key → decryption fails', function () {
  const recipientA = generateP256();
  const recipientB = generateP256();
  const plaintext = crypto.randomBytes(32);

  const envelope = succession.eciesEncrypt(recipientA.publicKeySpki, plaintext);

  let threw = false;
  try {
    succession.eciesDecrypt(recipientB.privateKey, envelope);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'wrong recipient key must fail');
});

// 11. Delegation chain too deep: chain of 6 (MAX_CHAIN_DEPTH is 5) → rejected.
test('11. Delegation chain too deep → verifyChain rejects', function () {
  // Create a chain of 6 dummy delegation objects (only length matters here)
  var chain = [];
  for (var i = 0; i < 6; i++) {
    chain.push({ ocp: 1, stm: { type: 'delegation' } });
  }
  var trusted = new Set();

  var result = delegation.verifyChain(chain, trusted);
  assert(result.ok === false, 'chain of 6 must be rejected');
  assert(result.code === 'CHAIN_TOO_DEEP', 'expected CHAIN_TOO_DEEP, got ' + result.code);

  // Chain of exactly 5 should NOT hit the depth check
  // (it will fail for other reasons, but not CHAIN_TOO_DEEP)
  var chain5 = chain.slice(0, 5);
  var result5 = delegation.verifyChain(chain5, trusted);
  assert(result5.code !== 'CHAIN_TOO_DEEP', 'chain of 5 must not be CHAIN_TOO_DEEP');
});

// 12. Delegation expired in chain: a delegation with exp in the past → rejected.
test('12. Delegation expired → verifyDelegation rejects', function () {
  var nowSec = Math.floor(Date.now() / 1000);
  var expired = {
    ocp: 1,
    stm: {
      type: 'delegation',
      delegator: 'some-delegator-key',
      delegate: 'some-delegate-key',
      scope: { operations: ['read'] },
    },
    exp: nowSec - 3600, // expired 1 hour ago
  };
  var trusted = new Set(['some-delegator-key']);

  var result = delegation.verifyDelegation(expired, trusted);
  assert(result.ok === false, 'expired delegation must be rejected');
  assert(result.code === 'EXPIRED', 'expected EXPIRED, got ' + result.code);
});

// 13. Delegation scope escalation: delegate scope is ["read"], attempting
//     "write" → isOperationAllowed rejects.
test('13. Delegation scope escalation → isOperationAllowed rejects', function () {
  var scope = {
    operations: ['read'],
    maxBudget: {},
    constraints: {},
  };

  assert(delegation.isOperationAllowed(scope, 'read') === true, 'read should be allowed');
  assert(delegation.isOperationAllowed(scope, 'write') === false, 'write must NOT be allowed');
  assert(delegation.isOperationAllowed(scope, 'LLM.chat') === false, 'LLM.chat must NOT be allowed');
  assert(delegation.isOperationAllowed(scope, 'delete') === false, 'delete must NOT be allowed');

  // Scope escalation via intersection must not widen
  var widerScope = {
    operations: ['read', 'write', 'delete'],
    maxBudget: {},
    constraints: {},
  };
  var effective = delegation.scopeIntersection(scope, widerScope);
  assert(effective.operations.length === 1, 'intersection must not widen');
  assert(effective.operations[0] === 'read', 'only read survives intersection');
  assert(delegation.isOperationAllowed(effective, 'write') === false, 'write still denied');
});

// 14. HMAC replay: sign and verify a request (consuming the nonce), then
//     replay the exact same headers → nonce_reuse.
test('14. HMAC replay → nonce_reuse', function () {
  var hmacSecret = crypto.randomBytes(32);
  var headers = auth.sign(hmacSecret, 'POST', '/api/test', '{"data":1}');

  // First verify — passes, consumes the nonce
  var result1 = auth.verify(hmacSecret, headers, 'POST', '/api/test', '{"data":1}');
  assert(result1.ok === true, 'first verify should pass');

  // Replay — same headers, same everything
  var result2 = auth.verify(hmacSecret, headers, 'POST', '/api/test', '{"data":1}');
  assert(result2.ok === false, 'replay must fail');
  assert(result2.code === 'nonce_reuse', 'expected nonce_reuse, got ' + result2.code);
});

// 15. HMAC timestamp skew: set the timestamp 6 minutes in the past (beyond
//     the 5-minute window) → timestamp_skew.
test('15. HMAC timestamp skew → rejected', function () {
  var hmacSecret = crypto.randomBytes(32);
  var method = 'POST';
  var reqPath = '/api/test';
  var body = '{"data":"skew"}';

  // Manually construct headers with a stale timestamp
  var ts = (Math.floor(Date.now() / 1000) - 360).toString(); // 6 minutes ago
  var nonce = crypto.randomBytes(16).toString('hex');
  var bodyHashHex = crypto.createHash('sha256').update(body).digest('hex');
  var canonical = ts + '\n' + nonce + '\n' + method + '\n' + reqPath + '\n' + bodyHashHex;
  var sig = crypto.createHmac('sha256', hmacSecret).update(canonical).digest('hex');
  var headers = {
    'authorization': 'SafeboxHMAC v1',
    'x-safebox-timestamp': ts,
    'x-safebox-nonce': nonce,
    'x-safebox-signature': sig,
  };

  var result = auth.verify(hmacSecret, headers, method, reqPath, body);
  assert(result.ok === false, 'stale timestamp must fail');
  assert(result.code === 'timestamp_skew', 'expected timestamp_skew, got ' + result.code);
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log('');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
if (failed > 0) {
  process.exit(1);
}
