'use strict';

// Tests for shamirSplit.js and succession.js.
// Run: node testSuccession.js

const crypto = require('crypto');
const shamir = require('./shamirSplit');
const succession = require('./succession');

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

// Helper: generate a P-256 keypair and return {privateKey, publicKey, publicKeySpki}.
function generateP256() {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeySpki: spki };
}

// ---------------------------------------------------------------------------
// Shamir tests
// ---------------------------------------------------------------------------

test('1. Split 32-byte secret into 5 shares, reconstruct from any 3', function () {
  const secret = crypto.randomBytes(32);
  const shares = shamir.split(secret, 5, 3);
  assert(shares.length === 5, 'expected 5 shares');

  // Try all C(5,3) = 10 combinations.
  for (let a = 0; a < 5; a++) {
    for (let b = a + 1; b < 5; b++) {
      for (let c = b + 1; c < 5; c++) {
        const subset = [shares[a], shares[b], shares[c]];
        const recovered = shamir.reconstruct(subset, 3);
        assert(recovered.equals(secret), `failed for subset [${a},${b},${c}]`);
      }
    }
  }
});

test('2. Reconstruct from 2 shares with threshold 3 throws', function () {
  const secret = crypto.randomBytes(32);
  const shares = shamir.split(secret, 5, 3);
  let threw = false;
  try {
    shamir.reconstruct([shares[0], shares[1]], 3);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'should have thrown for insufficient shares');
});

test('3. Split and reconstruct a 1-byte secret', function () {
  const secret = Buffer.from([0x42]);
  const shares = shamir.split(secret, 3, 2);
  const recovered = shamir.reconstruct([shares[0], shares[2]], 2);
  assert(recovered.equals(secret), 'recovered secret mismatch');
});

test('4. Split with n=255, threshold=2 (edge case)', function () {
  const secret = crypto.randomBytes(4);
  const shares = shamir.split(secret, 255, 2);
  assert(shares.length === 255, 'expected 255 shares');
  // Reconstruct from the last two shares.
  const recovered = shamir.reconstruct([shares[253], shares[254]], 2);
  assert(recovered.equals(secret), 'recovered secret mismatch');
});

test('5. Tampered share produces wrong reconstruction', function () {
  const secret = crypto.randomBytes(32);
  const shares = shamir.split(secret, 5, 3);

  // Tamper with one share: flip a byte in y.
  const tampered = shares.map(s => ({ x: s.x, y: Buffer.from(s.y) }));
  tampered[1].y[0] ^= 0xFF;

  const recovered = shamir.reconstruct([tampered[0], tampered[1], tampered[2]], 3);
  assert(!recovered.equals(secret), 'tampered share should produce wrong result');
});

test('6. verify() on valid shares returns ok', function () {
  const secret = crypto.randomBytes(16);
  const shares = shamir.split(secret, 5, 3);
  const result = shamir.verify(shares, 3);
  assert(result.ok === true, 'expected ok: true, got: ' + JSON.stringify(result));
});

test('7. verify() on tampered shares returns not ok', function () {
  const secret = crypto.randomBytes(16);
  const shares = shamir.split(secret, 5, 3);

  // Tamper with one share.
  const tampered = shares.map(s => ({ x: s.x, y: Buffer.from(s.y) }));
  tampered[2].y[0] ^= 0xFF;

  const result = shamir.verify(tampered, 3);
  assert(result.ok === false, 'expected ok: false for tampered shares');
  assert(typeof result.message === 'string', 'expected an error message');
});

// ---------------------------------------------------------------------------
// ECIES tests
// ---------------------------------------------------------------------------

test('8. ECIES encrypt/decrypt 32 bytes round-trip', function () {
  const recipient = generateP256();
  const plaintext = crypto.randomBytes(32);
  const envelope = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);

  assert(typeof envelope.ephemeralPublicKey === 'string', 'missing ephemeralPublicKey');
  assert(typeof envelope.iv === 'string', 'missing iv');
  assert(typeof envelope.ciphertext === 'string', 'missing ciphertext');
  assert(typeof envelope.tag === 'string', 'missing tag');

  const decrypted = succession.eciesDecrypt(recipient.privateKey, envelope);
  assert(decrypted.equals(plaintext), 'decrypted does not match plaintext');
});

test('9. ECIES decrypt with wrong key fails', function () {
  const recipient = generateP256();
  const wrongKey = generateP256();
  const plaintext = crypto.randomBytes(32);
  const envelope = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);

  let threw = false;
  try {
    succession.eciesDecrypt(wrongKey.privateKey, envelope);
  } catch (err) {
    threw = true;
    // Node.js crypto throws an error when GCM tag verification fails.
  }
  assert(threw, 'should have thrown for wrong key');
});

test('10. ECIES encrypt empty buffer round-trip', function () {
  const recipient = generateP256();
  const plaintext = Buffer.alloc(0);
  const envelope = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);
  const decrypted = succession.eciesDecrypt(recipient.privateKey, envelope);
  assert(decrypted.length === 0, 'expected empty buffer');
});

test('11. Two ECIES encryptions of same plaintext produce different ciphertexts', function () {
  const recipient = generateP256();
  const plaintext = crypto.randomBytes(32);
  const env1 = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);
  const env2 = succession.eciesEncrypt(recipient.publicKeySpki, plaintext);

  // Ephemeral keys should differ (different random keypair each time).
  assert(env1.ephemeralPublicKey !== env2.ephemeralPublicKey, 'ephemeral keys should differ');
  // Ciphertexts should differ (different IV and ephemeral key).
  assert(env1.ciphertext !== env2.ciphertext || env1.iv !== env2.iv, 'ciphertexts should differ');
});

// ---------------------------------------------------------------------------
// Succession claim tests
// ---------------------------------------------------------------------------

test('12. Create a succession claim and verify structure', function () {
  const predecessor = generateP256();
  const successor = generateP256();

  const claim = succession.createSuccessionClaim({
    predecessorPubkey: predecessor.publicKeySpki,
    predecessorChain: [predecessor.publicKeySpki],
    successorImageHash: 'sha256:deadbeef',
    successorPubkey: successor.publicKeySpki,
    reason: 'scheduled_upgrade'
  });

  assert(claim.ocp === 1, 'ocp version must be 1');
  assert(claim.iss.startsWith('safebox://'), 'iss must start with safebox://');
  assert(claim.stm.type === 'succession', 'stm.type must be succession');
  assert(claim.stm.predecessor === predecessor.publicKeySpki, 'predecessor mismatch');
  assert(claim.stm.successorImageHash === 'sha256:deadbeef', 'imageHash mismatch');
  assert(claim.stm.secretTransfer.method === 'ecies-p256', 'transfer method mismatch');
  assert(claim.stm.secretTransfer.recipientKey === successor.publicKeySpki, 'recipientKey mismatch');
  assert(typeof claim.nbf === 'number', 'missing nbf');
  assert(typeof claim.exp === 'number', 'missing exp');
  assert(claim.exp > claim.nbf, 'exp must be after nbf');

  // Verify the claim.
  const verification = succession.verifySuccessionClaim(
    claim,
    [predecessor.publicKeySpki],
    1
  );
  assert(verification.valid === true, 'claim should be valid, errors: ' + verification.errors.join(', '));
});

test('13. Escrow blob: encrypt master secret, decrypt, matches', function () {
  const failover = generateP256();
  const masterSecret = crypto.randomBytes(32);

  const conditionalClaim = succession.createSuccessionClaim({
    predecessorPubkey: 'dummyPredecessor',
    predecessorChain: ['dummyPredecessor'],
    successorImageHash: 'sha256:abc123',
    successorPubkey: failover.publicKeySpki,
    reason: 'failover',
    conditional: true
  });

  const blob = succession.createEscrowBlob(masterSecret, failover.publicKeySpki, conditionalClaim);

  assert(blob.encryptedSecret, 'blob must have encryptedSecret');
  assert(blob.claim, 'blob must have claim');
  assert(typeof blob.createdAt === 'string', 'blob must have createdAt');

  const decrypted = succession.decryptEscrowBlob(failover.privateKey, blob);
  assert(decrypted.equals(masterSecret), 'decrypted master secret mismatch');
});

test('14. Recovery shares round-trip: split, reconstruct matches', function () {
  const masterSecret = crypto.randomBytes(32);
  const shares = succession.createRecoveryShares(masterSecret, 5, 3);
  assert(shares.length === 5, 'expected 5 shares');

  // Reconstruct from first 3 shares.
  const recovered = succession.recoverFromShares(shares.slice(0, 3), 3);
  assert(recovered.length === masterSecret.length, 'recovered length mismatch');

  // The recovery applies HKDF, so the raw reconstruct matches the original,
  // but recoverFromShares returns HKDF(reconstructed).
  // We need to verify that calling recoverFromShares with any valid subset
  // produces the same output.
  const recovered2 = succession.recoverFromShares([shares[1], shares[3], shares[4]], 3);
  assert(recovered.equals(recovered2), 'different subsets should produce same derived secret');
});

test('15. Full Path A ceremony: predecessor + successor keypairs, claim, ECIES transfer, verify chain', function () {
  // Generate "predecessor" (current instance).
  const predecessor = generateP256();
  const predecessorPubkey = predecessor.publicKeySpki;
  const masterSecret = crypto.randomBytes(32);

  // Initialize the succession module as the predecessor.
  succession.init({
    masterSecret,
    privateKey: predecessor.privateKey,
    publicKey: predecessor.publicKey,
    predecessorChain: [] // first in chain
  });

  // Generate "successor" (new instance).
  const successor = generateP256();

  // Create the succession claim.
  const claim = succession.createSuccessionClaim({
    predecessorPubkey,
    predecessorChain: [predecessorPubkey],
    successorImageHash: 'sha256:newimage123',
    successorPubkey: successor.publicKeySpki,
    reason: 'scheduled_upgrade'
  });

  // Verify the claim.
  const verification = succession.verifySuccessionClaim(claim, [predecessorPubkey], 1);
  assert(verification.valid === true, 'claim should be valid: ' + JSON.stringify(verification.errors));

  // ECIES-encrypt the master secret to the successor.
  const envelope = succession.eciesEncrypt(successor.publicKeySpki, masterSecret);

  // Successor decrypts.
  const recoveredSecret = succession.eciesDecrypt(successor.privateKey, envelope);
  assert(recoveredSecret.equals(masterSecret), 'successor should recover master secret');

  // Verify chain continuity.
  assert(claim.stm.predecessorChain.length === 1, 'chain should have 1 entry');
  assert(claim.stm.predecessorChain[0] === predecessorPubkey, 'chain entry should be predecessor');
  assert(claim.stm.predecessor === predecessorPubkey, 'predecessor should match');

  // Simulate the successor becoming the new predecessor.
  const successorPubkey = successor.publicKeySpki;
  const newChain = [...claim.stm.predecessorChain, successorPubkey];
  assert(newChain.length === 2, 'new chain should have 2 entries');
  assert(newChain[0] === predecessorPubkey, 'first in chain is original predecessor');
  assert(newChain[1] === successorPubkey, 'second in chain is successor');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
if (failed > 0) {
  process.exit(1);
}
