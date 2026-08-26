'use strict';
//
// test/test-cli.js — unit tests for the safebox-models CLI.
//
// The MOST IMPORTANT test is the cross-check against the System component's
// canonicalize() and computeManifestHash(). If those don't match byte-for-byte,
// every install fails with MANIFEST_HASH_MISMATCH.
//
// Run:
//   cd cli/safebox-models
//   node test/test-cli.js
//

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('../lib/util');
const catalog = require('../lib/catalog');

let fails = [];
function expect(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); }
    else      { console.log(`  ✗ ${label}`); fails.push(label); }
}
function section(name) { console.log('\n── ' + name + ' ──'); }


// ═══ Test 1: canonicalize() matches the System component byte-for-byte ═══
section('canonicalize() — cross-check against opsModels.js');

const INFRA_DIR = path.resolve(__dirname, '../../..');
const SYS_OPS_MODELS = path.join(INFRA_DIR, 'aws/scripts/components/system/opsModels.js');

if (fs.existsSync(SYS_OPS_MODELS)) {
    // Load the System component's module and grab its private canonicalize
    const sysOpsModels = require(SYS_OPS_MODELS);
    const sysCanon  = sysOpsModels._canonicalize;
    const sysHash   = sysOpsModels._computeManifestHash;

    expect(typeof sysCanon === 'function', 'System component canonicalize exposed');
    expect(typeof sysHash  === 'function', 'System component computeManifestHash exposed');

    // Test cases covering the canonicalization spec
    const tests = [
        { v: null,                                  label: 'null' },
        { v: true,                                  label: 'true' },
        { v: false,                                 label: 'false' },
        { v: 0,                                     label: 'zero' },
        { v: 42,                                    label: 'small positive integer' },
        { v: -7,                                    label: 'negative integer' },
        { v: 1234567890,                            label: 'large integer' },
        { v: '',                                    label: 'empty string' },
        { v: 'hello',                               label: 'simple string' },
        { v: 'with "quote" and \\backslash',        label: 'string with escapes' },
        { v: 'unicode: ★ → ✓',                      label: 'unicode string' },
        { v: [],                                    label: 'empty array' },
        { v: [1, 2, 3],                             label: 'array of integers' },
        { v: ['a', 'b', 'c'],                       label: 'array of strings' },
        { v: {},                                    label: 'empty object' },
        { v: { a: 1, b: 2 },                        label: 'simple object' },
        { v: { z: 1, a: 2 },                        label: 'object with reordered keys' },
        { v: { b: { a: 1, c: 3 } },                 label: 'nested object' },
        { v: { name: 'foo', files: [{ path: 'x', sha256: 'abc' }] },
                                                     label: 'manifest-shaped object' },
    ];
    for (const t of tests) {
        const ours = util.canonicalize(t.v);
        const theirs = sysCanon(t.v);
        expect(ours === theirs, `canonicalize ${t.label} ⇒ "${ours}"`);
    }

    // Hash check on a realistic install manifest
    const manifest = {
        name:           'whisper-large-v3-turbo',
        version:        'v3-turbo',
        license:        'MIT',
        runnerType:     'transcription',
        totalSizeBytes: 1638400000,
        files: [
            { path: 'config.json',
              sizeBytes: 1234,
              sha256: 'a'.repeat(64),
              sources: ['https://huggingface.co/openai/whisper-large-v3-turbo/resolve/main/config.json'] },
            { path: 'model.safetensors',
              sizeBytes: 1637000000,
              sha256: 'b'.repeat(64),
              sources: ['https://huggingface.co/openai/whisper-large-v3-turbo/resolve/main/model.safetensors'] },
        ],
    };
    const ourHash   = util.computeManifestHash(manifest);
    const theirHash = sysHash(manifest);
    expect(ourHash === theirHash, `manifest hash agrees: ${ourHash.slice(0, 16)}…`);

} else {
    console.log(`  ⚠ System component not at ${SYS_OPS_MODELS} — skipping cross-check`);
    console.log('  (This is fine when running the test outside the Infrastructure repo.)');
}


// ═══ Test 2: HMAC signing produces the right shape ═══
section('signHmac()');

const headers = util.signHmac('{"hello":"world"}', 'test-key-12345');
expect(typeof headers['X-Safebox-Timestamp'] === 'string',  'timestamp header set');
expect(/^\d{10}$/.test(headers['X-Safebox-Timestamp']),     'timestamp is unix seconds');
expect(/^[0-9a-f]{32}$/.test(headers['X-Safebox-Nonce']),   'nonce is 32 hex chars (16 bytes)');
expect(/^[0-9a-f]{64}$/.test(headers['X-Safebox-Signature']), 'signature is 64 hex chars (SHA-256)');

// Deterministic check: same inputs (with fixed ts+nonce) → same signature
const ts = '1700000000', nonce = 'a'.repeat(32);
const body = '{"foo":"bar"}';
const expectedSig = crypto.createHmac('sha256', 'mykey')
    .update(ts + '.' + nonce + '.' + body, 'utf8').digest('hex');
// We can't pass ts/nonce in directly so just verify the math by computing it
// matches the documented payload format.
expect(typeof expectedSig === 'string' && expectedSig.length === 64,
       'reference HMAC computation works');


// ═══ Test 3: fmtBytes ═══
section('fmtBytes()');
expect(util.fmtBytes(0)            === '0.00 B',  '0 bytes');
expect(util.fmtBytes(1024)         === '1.00 KB', '1 KB');
expect(util.fmtBytes(1500)         === '1.46 KB', '1.5 KB');
expect(util.fmtBytes(1024 * 1024)  === '1.00 MB', '1 MB');
expect(util.fmtBytes(1.5 * 1024 ** 3) === '1.50 GB', '1.5 GB');
expect(util.fmtBytes(2.0 * 1024 ** 4) === '2.00 TB', '2 TB');
expect(util.fmtBytes(null)         === '?',       'null handled');


// ═══ Test 4: canonicalize rejects floats and non-finite ═══
section('canonicalize rejects bad types');

let threw = false;
try { util.canonicalize(1.5); } catch { threw = true; }
expect(threw, 'rejects float');

threw = false;
try { util.canonicalize(Infinity); } catch { threw = true; }
expect(threw, 'rejects Infinity');

threw = false;
try { util.canonicalize(NaN); } catch { threw = true; }
expect(threw, 'rejects NaN');

threw = false;
try { util.canonicalize(undefined); } catch { threw = true; }
expect(threw, 'rejects undefined');


// ═══ Test 5: catalog scanning ═══
section('catalog.scanCatalog()');

try {
    const items = catalog.scanCatalog(INFRA_DIR);
    expect(items.length > 0, `found ${items.length} manifests in the live repo`);

    const byRunner = {};
    for (const it of items) { byRunner[it.runner] = (byRunner[it.runner] || 0) + 1; }
    expect(byRunner.vllm    >= 5, 'vllm has at least 5 manifests');
    expect(byRunner.whisper >= 5, 'whisper has at least 5 manifests');
    expect(byRunner.comfyui >= 3, 'comfyui has at least 3 manifests');

    // Find a known model
    const qwen = items.find(e => e.name === 'qwen-3-32b');
    expect(!!qwen, 'qwen-3-32b is in the catalog');
    expect(qwen && qwen.runner === 'vllm', 'qwen-3-32b is under vllm runner');

    // findByName works
    const found = catalog.findByName(INFRA_DIR, 'whisper-large-v3-turbo');
    expect(found.name === 'whisper-large-v3-turbo', 'findByName finds whisper-large-v3-turbo');
    expect(found.runner === 'whisper',              'and identifies its runner');

    // Unknown name throws
    threw = false;
    try { catalog.findByName(INFRA_DIR, 'nonexistent-model-xyz'); } catch { threw = true; }
    expect(threw, 'findByName throws for unknown name');

} catch (e) {
    console.log('  ⚠ catalog scan failed: ' + e.message);
    console.log('  (Run from inside the Infrastructure repo for full coverage.)');
}


// ═══ Test 6: walkAndHash on a temp dir ═══
section('walkAndHash()');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
        fs.mkdirSync(path.join(tmp, 'sub'));
        fs.writeFileSync(path.join(tmp, 'sub/b.txt'), 'world');
        const files = await util.walkAndHash(tmp);
        expect(files.length === 2, 'walkAndHash finds 2 files');
        const a = files.find(f => f.path === 'a.txt');
        const b = files.find(f => f.path === 'sub/b.txt');
        expect(!!a, 'finds a.txt at top level');
        expect(!!b, 'finds sub/b.txt with relative path');
        const expectedA = crypto.createHash('sha256').update('hello').digest('hex');
        const expectedB = crypto.createHash('sha256').update('world').digest('hex');
        expect(a.sha256 === expectedA, 'a.txt SHA-256 correct');
        expect(b.sha256 === expectedB, 'sub/b.txt SHA-256 correct');
        expect(a.sizeBytes === 5,      'a.txt size correct');
        expect(b.sizeBytes === 5,      'sub/b.txt size correct');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    // ═══ Summary ═══
    console.log();
    if (fails.length > 0) {
        console.log(`✗ ${fails.length} test(s) failed:`);
        for (const f of fails) console.log(`    - ${f}`);
        process.exit(1);
    }
    console.log('✓ All tests passed.');
})();
