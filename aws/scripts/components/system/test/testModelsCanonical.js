// test/testModelsCanonical.js
//
// Tests the RFC 8785 JSON canonicalization and manifest hash computation.
// This is load-bearing: if Safebox computes a different hash for the same
// manifest, the system will reject every install with MANIFEST_HASH_MISMATCH.

'use strict';

const crypto = require('crypto');
const opsModels = require('../opsModels');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── Canonicalization vectors ─────────────────────────────────────────────────
// Sorted keys, no whitespace, JSON-string strings, shortest-form integers,
// preserved array order.

// Sorted keys
check('canonical: keys sorted',
    opsModels._canonicalize({ b: 1, a: 2 }) === '{"a":2,"b":1}');

// Nested sort
check('canonical: nested keys sorted',
    opsModels._canonicalize({ z: { y: 1, x: 2 }, a: 3 }) === '{"a":3,"z":{"x":2,"y":1}}');

// Arrays preserve order
check('canonical: arrays preserve order',
    opsModels._canonicalize({ a: [3, 1, 2] }) === '{"a":[3,1,2]}');

// Booleans, null
check('canonical: booleans and null',
    opsModels._canonicalize({ t: true, f: false, n: null }) === '{"f":false,"n":null,"t":true}');

// String escaping (JSON.stringify gives us this for free)
check('canonical: string with quote escaped',
    opsModels._canonicalize({ s: 'a"b' }) === '{"s":"a\\"b"}');

// Integer encoding
check('canonical: integer',
    opsModels._canonicalize({ n: 123 }) === '{"n":123}');

// Non-integer should throw
let nonIntThrew = false;
try { opsModels._canonicalize({ n: 1.5 }); } catch { nonIntThrew = true; }
check('canonical: rejects non-integer number', nonIntThrew);

// ── Manifest hash determinism ────────────────────────────────────────────────

const sampleManifest = {
    name: 'test-model',
    version: '1.0.0',
    license: 'Apache-2.0',
    runnerType: 'pytorch',
    totalSizeBytes: 1024,
    files: [
        {
            path: 'model.bin',
            sizeBytes: 1024,
            sha256: 'a'.repeat(64),
            sources: ['https://example.com/model.bin'],
        },
    ],
};

const h1 = opsModels._computeManifestHash(sampleManifest);
check('manifest hash is 64 hex chars', /^[0-9a-f]{64}$/.test(h1));

// Same content, different field order — hash MUST be identical
const reordered = {
    files: sampleManifest.files,
    name: 'test-model',
    runnerType: 'pytorch',
    totalSizeBytes: 1024,
    license: 'Apache-2.0',
    version: '1.0.0',
};
const h2 = opsModels._computeManifestHash(reordered);
check('hash is invariant to key order', h1 === h2, `${h1} vs ${h2}`);

// Different content — hash MUST differ
const modified = { ...sampleManifest, version: '1.0.1' };
const h3 = opsModels._computeManifestHash(modified);
check('hash differs when content changes', h1 !== h3);

// Manual sanity check: compute the hash a different way
const expectedCanonical =
    '{"files":[{"path":"model.bin","sha256":"' + 'a'.repeat(64) + '","sizeBytes":1024,"sources":["https://example.com/model.bin"]}],' +
    '"license":"Apache-2.0","name":"test-model","runnerType":"pytorch","totalSizeBytes":1024,"version":"1.0.0"}';
const expectedHash = crypto.createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
check('hash matches independently-computed value', h1 === expectedHash,
    `\n  computed: ${h1}\n  expected: ${expectedHash}\n  canonical: ${opsModels._canonicalize(sampleManifest)}`);

// ── Manifest validation ──────────────────────────────────────────────────────

function validates(m) {
    try { opsModels._validateManifest(m); return true; } catch { return false; }
}
function rejects(m, expectedCode) {
    try { opsModels._validateManifest(m); return false; }
    catch (e) { return expectedCode ? e.code === expectedCode : true; }
}

check('validate: rejects missing name', rejects({ ...sampleManifest, name: undefined }));
check('validate: rejects bad name chars', rejects({ ...sampleManifest, name: 'a b' }));
check('validate: rejects non-positive totalSizeBytes', rejects({ ...sampleManifest, totalSizeBytes: 0 }));
check('validate: rejects empty files array', rejects({ ...sampleManifest, files: [] }));
check('validate: rejects path traversal',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: '../etc/passwd' }] }));
check('validate: rejects absolute path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: '/etc/passwd' }] }));
// New tighter validation: explicit allowlist of [A-Za-z0-9._-] in segments
check('validate: rejects null byte in path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'foo\u0000bar' }] }));
check('validate: rejects backslash in path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'foo\\bar' }] }));
check('validate: rejects single dot segment',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: '.' }] }));
check('validate: rejects dot-slash prefix',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: './foo' }] }));
check('validate: rejects mid-string . segment',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'foo/./bar' }] }));
check('validate: rejects trailing slash',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'foo/' }] }));
check('validate: rejects space in path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'my file.bin' }] }));
check('validate: rejects shell metachar in path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'foo;rm.bin' }] }));
check('validate: rejects unicode in path',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: '\u00e9.bin' }] }));
check('validate: accepts subdir path',
    validates({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: 'onnx/model.onnx' }] }));
check('validate: accepts hidden file',
    validates({ ...sampleManifest, files: [{ ...sampleManifest.files[0], path: '.gitignore' }] }));
check('validate: rejects non-https source',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], sources: ['http://example.com/m'] }] }));
check('validate: rejects bad sha256 (too short)',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], sha256: 'abc' }] }));
check('validate: rejects uppercase sha256',
    rejects({ ...sampleManifest, files: [{ ...sampleManifest.files[0], sha256: 'A'.repeat(64) }] }));
check('validate: rejects size sum mismatch',
    rejects({ ...sampleManifest, totalSizeBytes: 9999 }));
check('validate: accepts valid manifest', validates(sampleManifest));

// Multi-file
const multiFile = {
    ...sampleManifest,
    totalSizeBytes: 3000,
    files: [
        { path: 'a.bin', sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a'] },
        { path: 'b.bin', sizeBytes: 2000, sha256: 'b'.repeat(64), sources: ['https://example.com/b'] },
    ],
};
check('validate: accepts multi-file manifest', validates(multiFile));

// ── Duplicate-path rejection (supply-chain integrity) ────────────────────────
// Two file entries with the same path let the second download overwrite the
// first, so the on-disk artifact set is smaller than the manifest claims and
// totalSizeBytes double-counts. This is the same class of flaw as counting one
// signature N times toward an M-of-N threshold. The validator must reject it.
const dupExactPath = {
    ...sampleManifest,
    totalSizeBytes: 2000,
    files: [
        { path: 'model.bin', sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a'] },
        { path: 'model.bin', sizeBytes: 1000, sha256: 'b'.repeat(64), sources: ['https://example.com/b'] },
    ],
};
check('validate: rejects duplicate path (same size, different sha256)',
    rejects(dupExactPath));

const dupSamePathSameHash = {
    ...sampleManifest,
    totalSizeBytes: 2000,
    files: [
        { path: 'model.bin', sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a'] },
        { path: 'model.bin', sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a2'] },
    ],
};
check('validate: rejects duplicate path even when sha256 matches (double-counts size)',
    rejects(dupSamePathSameHash));

const dupInSubdir = {
    ...sampleManifest,
    totalSizeBytes: 3000,
    files: [
        { path: 'a.bin',       sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a'] },
        { path: 'onnx/m.onnx', sizeBytes: 1000, sha256: 'b'.repeat(64), sources: ['https://example.com/b'] },
        { path: 'onnx/m.onnx', sizeBytes: 1000, sha256: 'c'.repeat(64), sources: ['https://example.com/c'] },
    ],
};
check('validate: rejects duplicate path in subdirectory',
    rejects(dupInSubdir));

// Distinct paths that happen to share a prefix must still be accepted
const distinctPrefix = {
    ...sampleManifest,
    totalSizeBytes: 2000,
    files: [
        { path: 'model.bin',   sizeBytes: 1000, sha256: 'a'.repeat(64), sources: ['https://example.com/a'] },
        { path: 'model.bin.1', sizeBytes: 1000, sha256: 'b'.repeat(64), sources: ['https://example.com/b'] },
    ],
};
check('validate: accepts distinct paths sharing a prefix', validates(distinctPrefix));

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
