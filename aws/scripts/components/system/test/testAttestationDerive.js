// test/testAttestationDerive.js
//
// Locks in the attestationDerive() test vector agreed between Safebox and
// the System. If this test fails, EITHER:
//   - someone modified the verbatim-copy block in secret.js, OR
//   - Safebox modified their copy and we haven't synced
// Either way, authentication is about to silently break. Fix before merging.

'use strict';

const { attestationDerive } = require('../secret');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else      { fail++; console.log('FAIL', name, detail || ''); }
}

const PCR0 = Buffer.from('aa'.repeat(48), 'hex');
const PCR1 = Buffer.from('bb'.repeat(48), 'hex');
const PCR4 = Buffer.from('cc'.repeat(48), 'hex');

const EXPECTED = 'ac39caf5fadb5c00cfee415f7de54007aeb3a86c8b5c1315dd86d537fdb036eb';

// 1. The published test vector (the load-bearing check)
const result = attestationDerive({ pcrs: { 0: PCR0, 1: PCR1, 4: PCR4 } });
check('test vector matches', result.toString('hex') === EXPECTED,
    'got ' + result.toString('hex'));

// 2. Determinism
const r2 = attestationDerive({ pcrs: { 0: PCR0, 1: PCR1, 4: PCR4 } });
check('determinism', result.equals(r2));

// 3. Host-binding: different PCR4 → different key
const PCR4b = Buffer.from('dd'.repeat(48), 'hex');
const rDiff = attestationDerive({ pcrs: { 0: PCR0, 1: PCR1, 4: PCR4b } });
check('different PCR4 yields different key', !result.equals(rDiff));

// 4. Map vs plain object
const pcrMap = new Map([[0, PCR0], [1, PCR1], [4, PCR4]]);
const rMap = attestationDerive({ pcrs: pcrMap });
check('Map and plain object produce same key', result.equals(rMap));

// 5. Uint8Array normalizes
const rU8 = attestationDerive({ pcrs: {
    0: new Uint8Array(PCR0), 1: new Uint8Array(PCR1), 4: new Uint8Array(PCR4),
}});
check('Uint8Array PCRs normalize to same key', result.equals(rU8));

// 6. Hex string normalizes
const rHex = attestationDerive({ pcrs: {
    0: 'aa'.repeat(48), 1: 'bb'.repeat(48), 4: 'cc'.repeat(48),
}});
check('hex-string PCRs normalize to same key', result.equals(rHex));

// 7. Missing PCR throws
let threw = false;
try { attestationDerive({ pcrs: { 0: PCR0, 1: PCR1 } }); }
catch { threw = true; }
check('missing PCR4 throws', threw);

// 8. Anti-swap: swapping PCR0 and PCR4 produces different key
const rSwapped = attestationDerive({ pcrs: { 0: PCR4, 1: PCR1, 4: PCR0 } });
check('PCR0/PCR4 swap yields different key', !result.equals(rSwapped));

// 9. Zero-length PCR rejected
let zeroThrew = false;
try { attestationDerive({ pcrs: { 0: Buffer.alloc(0), 1: PCR1, 4: PCR4 } }); }
catch { zeroThrew = true; }
check('zero-length PCR throws', zeroThrew);

// 10. String-keyed object also works (CBOR libraries sometimes string-key)
const rStrKey = attestationDerive({ pcrs: { '0': PCR0, '1': PCR1, '4': PCR4 } });
check('string-keyed object produces same key', result.equals(rStrKey));

console.log('');
console.log(pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
