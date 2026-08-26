// test/testEmbedWorker.js
//
// Tests the embeddings worker's own logic — LRU cache, model directory
// validation, request validation, IPC response shape — using a mocked
// @huggingface/transformers module so we don't need real model bytes.
//
// This complements testEmbedIpc.js, which tests the parent-side IPC
// supervision with a stub worker. Together they cover the full
// worker code path without needing a real ONNX model on disk.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { fork } = require('child_process');

// Setup: temp model root with two fake model directories
const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-embed-worker-test-'));
const modelRoot = path.join(tmpDir, 'models');
fs.mkdirSync(modelRoot, { recursive: true });

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_HUGE = 'c'.repeat(64);

// Make fake model dirs with various sizes
fs.mkdirSync(path.join(modelRoot, HASH_A));
fs.writeFileSync(path.join(modelRoot, HASH_A, 'model.bin'), Buffer.alloc(100 * 1024));   // 100 KB

fs.mkdirSync(path.join(modelRoot, HASH_B));
fs.writeFileSync(path.join(modelRoot, HASH_B, 'model.bin'), Buffer.alloc(100 * 1024));   // 100 KB

fs.mkdirSync(path.join(modelRoot, HASH_HUGE));
fs.writeFileSync(path.join(modelRoot, HASH_HUGE, 'model.bin'), Buffer.alloc(3 * 1024 * 1024));  // 3 MB

// Build a mock for @huggingface/transformers and inject it via a wrapper
// worker script. The wrapper loads our mock instead of the real module,
// then loads the real embeddingsWorker.js, which will see the mock when
// it requires('@huggingface/transformers').

const mockTransformersPath = path.join(tmpDir, 'mockTransformers.js');
fs.writeFileSync(mockTransformersPath, `
'use strict';
module.exports = {
    env: {
        allowLocalModels: false,
        allowRemoteModels: true,
        localModelPath: '',
        useFSCache: true,
        useBrowserCache: true,
        backends: { onnx: { wasm: { numThreads: 1 } } },
    },
    pipeline: async (task, modelId) => {
        // Mock pipeline: returns a function that produces synthetic tensors.
        const dim = 4;
        return async (inputs, opts) => {
            const arr = Array.isArray(inputs) ? inputs : [inputs];
            const flat = [];
            for (let i = 0; i < arr.length; i++) {
                // Make each embedding distinguishable by input length
                for (let j = 0; j < dim; j++) {
                    flat.push((arr[i].length + j) * 0.01);
                }
            }
            return {
                dims: [arr.length, dim],
                data: Float32Array.from(flat),
            };
        };
    },
};
`);

const wrapperPath = path.join(tmpDir, 'wrapperWorker.js');
fs.writeFileSync(wrapperPath, `
'use strict';
// Inject the mock for '@huggingface/transformers' BEFORE the worker requires it.
const Module = require('module');
const mockPath = ${JSON.stringify(mockTransformersPath)};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    if (request === '@huggingface/transformers') return mockPath;
    return origResolve.call(this, request, parent, ...rest);
};
// Now load the real worker
require(${JSON.stringify(path.join(__dirname, '..', 'embeddingsWorker.js'))});
`);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fork the wrapper worker
let nextReqId = 1;
const pending = new Map();
function call(message) {
    return new Promise((resolve, reject) => {
        const id = 'req_' + (nextReqId++);
        const timeoutHandle = setTimeout(() => {
            pending.delete(id);
            reject(new Error('test request timeout'));
        }, 5000);
        pending.set(id, { resolve, reject, timeoutHandle });
        worker.send(Object.assign({ id }, message));
    });
}

let worker;

(async () => {
    worker = fork(wrapperPath, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: Object.assign({}, process.env, {
            SAFEBOX_MODELS_ROOT: modelRoot,
            EMBEDDINGS_MEMORY_BUDGET_MB: '2',  // 2 MB budget — forces LRU eviction
        }),
    });

    worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log') return;  // ignore log lines
        if (typeof msg.id !== 'string') return;
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timeoutHandle);
        pending.delete(msg.id);
        p.resolve(msg);
    });

    await sleep(200);  // let mock + worker init

    // ── Valid embed call works ───────────────────────────────────────────────
    const r1 = await call({ type: 'embed', model: HASH_A, inputs: ['hello'] });
    check('basic embed returns ok',
        r1.status === 'ok' && r1.data.dim === 4 && r1.data.count === 1,
        JSON.stringify(r1).slice(0, 200));
    check('embeddings are arrays',
        Array.isArray(r1.data.embeddings) && Array.isArray(r1.data.embeddings[0]) &&
        r1.data.embeddings[0].length === 4);

    // ── Batch embed ─────────────────────────────────────────────────────────
    const r2 = await call({ type: 'embed', model: HASH_A, inputs: ['a', 'bb', 'ccc'] });
    check('batch embed: count matches inputs', r2.status === 'ok' && r2.data.count === 3);
    check('batch embed: embeddings array length matches', r2.data.embeddings.length === 3);

    // ── Validation: bad model hash ───────────────────────────────────────────
    const r3 = await call({ type: 'embed', model: 'not-a-hex-hash', inputs: ['x'] });
    check('non-hex model rejected', r3.status === 'error' && r3.code === 'BAD_REQUEST');

    // ── Validation: missing inputs ───────────────────────────────────────────
    const r4 = await call({ type: 'embed', model: HASH_A, inputs: [] });
    check('empty inputs rejected', r4.status === 'error' && r4.code === 'BAD_REQUEST');

    // ── Validation: non-string in inputs ─────────────────────────────────────
    const r5 = await call({ type: 'embed', model: HASH_A, inputs: ['x', 42, 'y'] });
    check('non-string input rejected', r5.status === 'error' && r5.code === 'BAD_REQUEST');

    // ── Validation: too many inputs ──────────────────────────────────────────
    const tooMany = Array(100).fill('x');
    const r6 = await call({ type: 'embed', model: HASH_A, inputs: tooMany });
    check('too many inputs rejected', r6.status === 'error' && r6.code === 'BAD_REQUEST');

    // ── Validation: input too long ───────────────────────────────────────────
    const r7 = await call({ type: 'embed', model: HASH_A, inputs: ['x'.repeat(10000)] });
    check('input too long rejected', r7.status === 'error' && r7.code === 'BAD_REQUEST');

    // ── Bad pooling value ────────────────────────────────────────────────────
    const r8 = await call({ type: 'embed', model: HASH_A, inputs: ['x'], pooling: 'banana' });
    check('bad pooling rejected', r8.status === 'error' && r8.code === 'BAD_REQUEST');

    // ── Bad normalize value ──────────────────────────────────────────────────
    const r9 = await call({ type: 'embed', model: HASH_A, inputs: ['x'], normalize: 'yes' });
    check('bad normalize rejected', r9.status === 'error' && r9.code === 'BAD_REQUEST');

    // ── Model dir doesn't exist ──────────────────────────────────────────────
    const r10 = await call({ type: 'embed', model: 'f'.repeat(64), inputs: ['x'] });
    check('missing model dir → MODEL_NOT_INSTALLED',
        r10.status === 'error' && r10.code === 'MODEL_NOT_INSTALLED');

    // ── LRU: list shows 1 loaded ─────────────────────────────────────────────
    const r11 = await call({ type: 'list' });
    check('list: 1 model loaded after first calls',
        r11.status === 'ok' && r11.data.models.length === 1 &&
        r11.data.models[0].model === HASH_A);

    // ── LRU eviction: load HASH_B, both fit (100K + 100K < 2MB budget) ──────
    await call({ type: 'embed', model: HASH_B, inputs: ['x'] });
    const r12 = await call({ type: 'list' });
    check('LRU: both small models fit', r12.data.models.length === 2);

    // ── LRU eviction: load HASH_HUGE (3 MB > 2 MB budget) → exceeds ──────────
    const r13 = await call({ type: 'embed', model: HASH_HUGE, inputs: ['x'] });
    check('huge model exceeds budget → MODEL_EXCEEDS_BUDGET',
        r13.status === 'error' && r13.code === 'MODEL_EXCEEDS_BUDGET',
        JSON.stringify(r13).slice(0, 200));

    // ── Concurrent loads of same model: must deduplicate ─────────────────────
    // Without deduplication, two concurrent embed calls for an uncached model
    // each call t.pipeline() (slow) and each call loaded.set() — second
    // overwrites first, totalBytes double-counted. This test fires two
    // requests for HASH_NEW simultaneously and verifies totalBytes is correct.
    const HASH_NEW = 'f'.repeat(64);
    fs.mkdirSync(path.join(modelRoot, HASH_NEW));
    fs.writeFileSync(path.join(modelRoot, HASH_NEW, 'model.bin'), Buffer.alloc(50 * 1024));

    // First, free up cache so we have room
    await call({ type: 'unload', model: HASH_A });
    await call({ type: 'unload', model: HASH_B });
    const beforeList = await call({ type: 'list' });
    const beforeBytes = beforeList.data.totalBytes;

    // Fire two concurrent loads
    const [conc1, conc2] = await Promise.all([
        call({ type: 'embed', model: HASH_NEW, inputs: ['a'] }),
        call({ type: 'embed', model: HASH_NEW, inputs: ['b'] }),
    ]);
    check('concurrent embed call 1 succeeds', conc1.status === 'ok');
    check('concurrent embed call 2 succeeds', conc2.status === 'ok');
    const afterList = await call({ type: 'list' });
    check('concurrent loads: totalBytes increased by EXACTLY one model size',
        afterList.data.totalBytes - beforeBytes === 50 * 1024,
        `before=${beforeBytes} after=${afterList.data.totalBytes} diff=${afterList.data.totalBytes - beforeBytes}, expected diff 51200`);
    check('concurrent loads: only one cache entry for HASH_NEW',
        afterList.data.models.filter(m => m.model === HASH_NEW).length === 1);

    // Reload A and B for subsequent tests (they were unloaded above)
    await call({ type: 'embed', model: HASH_A, inputs: ['x'] });
    await call({ type: 'embed', model: HASH_B, inputs: ['x'] });

    // Both small models still loaded (huge was rejected before any eviction)
    const r14 = await call({ type: 'list' });
    check('after concurrent load and reload, all 3 small models present',
        r14.data.models.length === 3);

    // ── LRU eviction: load a third small model that triggers eviction ────────
    // Budget = 2 MB. Cache currently has HASH_NEW (50K), HASH_A (100K),
    // HASH_B (100K) — total 250K. Load HASH_C (1.9MB) which forces evictions.
    // 250K + 1900K = 2150K > 2048K budget. Need to evict 102K. LRU order
    // (oldest first): HASH_NEW, HASH_A, HASH_B. Evicting HASH_NEW frees
    // 50K (still over), evict HASH_A frees another 100K (total 150K freed),
    // 100K remaining + 1900K = 2000K ≤ 2048K — done. So HASH_B and HASH_C
    // remain; HASH_NEW and HASH_A evicted.
    const HASH_C = 'e'.repeat(64);
    fs.mkdirSync(path.join(modelRoot, HASH_C));
    fs.writeFileSync(path.join(modelRoot, HASH_C, 'model.bin'),
        Buffer.alloc(1900 * 1024));  // 1.9 MB

    // Touch HASH_B so it's the most recent
    await call({ type: 'embed', model: HASH_B, inputs: ['recent'] });
    await sleep(10);
    // Load HASH_C — should evict HASH_NEW and HASH_A to make room
    const r14b = await call({ type: 'embed', model: HASH_C, inputs: ['x'] });
    check('LRU eviction: HASH_C loads despite cache pressure',
        r14b.status === 'ok', JSON.stringify(r14b).slice(0, 200));

    const r14c = await call({ type: 'list' });
    const loadedHashes = r14c.data.models.map(m => m.model).sort();
    check('LRU eviction: HASH_NEW and HASH_A evicted, HASH_B and HASH_C remain',
        loadedHashes.length === 2 &&
        loadedHashes.includes(HASH_B) &&
        loadedHashes.includes(HASH_C) &&
        !loadedHashes.includes(HASH_A) &&
        !loadedHashes.includes(HASH_NEW),
        'loaded: ' + loadedHashes.join(','));

    // ── Explicit unload ──────────────────────────────────────────────────────
    const r15 = await call({ type: 'unload', model: HASH_B });
    check('unload: HASH_B unloaded', r15.status === 'ok' && r15.data.unloaded === true);

    const r16 = await call({ type: 'list' });
    check('after unload, only HASH_C remains',
        r16.data.models.length === 1 && r16.data.models[0].model === HASH_C);

    // Unload of not-loaded model
    const r17 = await call({ type: 'unload', model: 'd'.repeat(64) });
    check('unload of non-loaded model returns not_loaded',
        r17.status === 'ok' && r17.data.unloaded === false &&
        r17.data.reason === 'not_loaded');

    // ── Health ───────────────────────────────────────────────────────────────
    const r18 = await call({ type: 'health' });
    check('health returns ok with budget info',
        r18.status === 'ok' && r18.data.budgetBytes === 2 * 1024 * 1024);

    // ── Unknown message type ─────────────────────────────────────────────────
    const r19 = await call({ type: 'unknown_op' });
    check('unknown op rejected', r19.status === 'error' && r19.code === 'BAD_REQUEST');

    // Cleanup
    worker.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('ERR:', e);
    if (worker) worker.kill('SIGKILL');
    process.exit(2);
});
