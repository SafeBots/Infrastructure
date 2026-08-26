// test/testPerContainerKey.js
//
// Verifies the per-container HMAC key derivation: deterministic per
// (master, containerName), independent across containers, refuses invalid
// inputs.

'use strict';

const crypto = require('crypto');
const secret = require('../secret');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const master = Buffer.from(
    'ac39caf5fadb5c00cfee415f7de54007aeb3a86c8b5c1315dd86d537fdb036eb',
    'hex'
);

const EPOCH_A = '0123456789abcdef';
const EPOCH_B = 'fedcba9876543210';

// ── Determinism ──────────────────────────────────────────────────────────────
const fooKey1 = secret.derivePerContainerKey(master, 'safebox-app-foo', EPOCH_A);
const fooKey2 = secret.derivePerContainerKey(master, 'safebox-app-foo', EPOCH_A);
check('determinism: same inputs produce same output', fooKey1.equals(fooKey2));
check('output is 32 bytes', fooKey1.length === 32);

// Locked test vector
const EXPECTED_FOO_EPOCH_A = '739cc9bf3e79366ccc7a91a341a738320e703df1d5967ba95480a3852ffcd5d2';
check('locked test vector: safebox-app-foo with epoch A',
    fooKey1.toString('hex') === EXPECTED_FOO_EPOCH_A,
    'got: ' + fooKey1.toString('hex'));

// ── Independence ─────────────────────────────────────────────────────────────
const barKey = secret.derivePerContainerKey(master, 'safebox-app-bar', EPOCH_A);
check('different containerName → different key', !fooKey1.equals(barKey));

const fooKeyDifferentMaster = secret.derivePerContainerKey(
    Buffer.alloc(32, 0xff), 'safebox-app-foo', EPOCH_A
);
check('different master → different key', !fooKey1.equals(fooKeyDifferentMaster));

// Epoch rotation
const fooKeyEpochB = secret.derivePerContainerKey(master, 'safebox-app-foo', EPOCH_B);
check('different epoch → different key (rotation across destroy/create)',
    !fooKey1.equals(fooKeyEpochB));

// ── Validation ───────────────────────────────────────────────────────────────
function rejected(call, label) {
    let threw = false;
    try { call(); }
    catch { threw = true; }
    check(label, threw);
}

rejected(() => secret.derivePerContainerKey('not a buffer', 'foo', EPOCH_A), 'reject: non-Buffer master');
rejected(() => secret.derivePerContainerKey(Buffer.alloc(16), 'foo', EPOCH_A), 'reject: master wrong length (16)');
rejected(() => secret.derivePerContainerKey(Buffer.alloc(64), 'foo', EPOCH_A), 'reject: master wrong length (64)');
rejected(() => secret.derivePerContainerKey(master, '', EPOCH_A),    'reject: empty container name');
rejected(() => secret.derivePerContainerKey(master, '-bad', EPOCH_A), 'reject: container name starts with -');
rejected(() => secret.derivePerContainerKey(master, '.bad', EPOCH_A), 'reject: container name starts with .');
rejected(() => secret.derivePerContainerKey(master, 'has/slash', EPOCH_A), 'reject: container name has /');
rejected(() => secret.derivePerContainerKey(master, 'has space', EPOCH_A), 'reject: container name has space');
rejected(() => secret.derivePerContainerKey(master, 'a'.repeat(129), EPOCH_A), 'reject: container name too long');
rejected(() => secret.derivePerContainerKey(master, null, EPOCH_A), 'reject: null container name');

// Epoch validation
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo'), 'reject: missing keyEpoch');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', null), 'reject: null keyEpoch');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', ''), 'reject: empty keyEpoch');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', 'short'), 'reject: keyEpoch < 16 chars');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', 'a'.repeat(129)), 'reject: keyEpoch > 128 chars');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', 'NOT_LOWERCASE_HEX12345'), 'reject: keyEpoch non-hex chars');
rejected(() => secret.derivePerContainerKey(master, 'safebox-app-foo', '012345678901234G'), 'reject: keyEpoch with non-hex G');

// Valid container names
const ok1 = secret.derivePerContainerKey(master, 'safebox-app-foo', EPOCH_A);
const ok2 = secret.derivePerContainerKey(master, '_underscore-start', EPOCH_A);
const ok3 = secret.derivePerContainerKey(master, 'has.dots', EPOCH_A);
const ok4 = secret.derivePerContainerKey(master, 'A1', EPOCH_A);
check('accept: standard kebab name', ok1.length === 32);
check('accept: underscore start',    ok2.length === 32);
check('accept: dots in name',        ok3.length === 32);
check('accept: short uppercase',     ok4.length === 32);

// ── Key strength sanity ──────────────────────────────────────────────────────
// Verify output is not all-zero or trivially patterned (HKDF would never
// produce these, but a regression that broke the function might).
check('output not all zero',  !fooKey1.equals(Buffer.alloc(32, 0)));
check('output not all 0xff',  !fooKey1.equals(Buffer.alloc(32, 0xff)));

// Verify entropy ish: bytes should be reasonably distributed
const histogram = new Array(256).fill(0);
for (const b of fooKey1) histogram[b]++;
const maxFreq = Math.max(...histogram);
check('output has reasonable byte distribution (no value appears >4 times in 32 bytes)',
    maxFreq <= 4, `max freq: ${maxFreq}`);

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
