// test/testCborRoundtrip.js
//
// Verifies the cborDecode module against hand-computed test vectors.

'use strict';

const cbor = require('../cborDecode');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// Test vector 1: uint 0..23 encode in one byte
const r1 = cbor.decode(Buffer.from([0x05]));
check('decode uint 5', r1.value === 5);

// Test vector 2: uint 24 encodes as 0x18 24
const r2 = cbor.decode(Buffer.from([0x18, 24]));
check('decode uint 24', r2.value === 24);

// Test vector 3: byte string of 4 bytes
const r3 = cbor.decode(Buffer.from([0x44, 0xaa, 0xbb, 0xcc, 0xdd]));
check('decode bytes', Buffer.isBuffer(r3.value) && r3.value.toString('hex') === 'aabbccdd');

// Test vector 4: text string "Signature1"
const r4 = cbor.decode(Buffer.from([0x6a, 0x53, 0x69, 0x67, 0x6e, 0x61, 0x74, 0x75, 0x72, 0x65, 0x31]));
check('decode text Signature1', r4.value === 'Signature1');

// Test vector 5: array [1, 2, 3]
const r5 = cbor.decode(Buffer.from([0x83, 0x01, 0x02, 0x03]));
check('decode array', Array.isArray(r5.value) && r5.value.length === 3 && r5.value[2] === 3);

// Test vector 6: map { "a": 1 }
const r6 = cbor.decode(Buffer.from([0xa1, 0x61, 0x61, 0x01]));
check('decode map', r6.value instanceof Map && r6.value.get('a') === 1);

// Test vector 7: nested — array containing a byte string
const r7 = cbor.decode(Buffer.from([0x82, 0x42, 0xaa, 0xbb, 0x05]));
check('decode array with bytes',
    Array.isArray(r7.value) && Buffer.isBuffer(r7.value[0]) &&
    r7.value[0].toString('hex') === 'aabb' && r7.value[1] === 5);

// Test vector 8: negative integer -35 (COSE ES384 alg id)
const r8 = cbor.decode(Buffer.from([0x38, 0x22]));
check('decode negative -35', r8.value === -35);

// Encoding round-trips
const e1 = cbor.encodeUint(24);
const d1 = cbor.decode(e1).value;
check('encode/decode uint 24', d1 === 24);

const e2 = cbor.encodeByteString(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
const d2 = cbor.decode(e2).value;
check('encode/decode bytes', Buffer.isBuffer(d2) && d2.toString('hex') === 'deadbeef');

const e3 = cbor.encodeTextString('hello');
const d3 = cbor.decode(e3).value;
check('encode/decode text', d3 === 'hello');

const e4 = cbor.encodeArray([cbor.encodeUint(1), cbor.encodeUint(2)]);
const d4 = cbor.decode(e4).value;
check('encode/decode array', Array.isArray(d4) && d4[0] === 1 && d4[1] === 2);

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
