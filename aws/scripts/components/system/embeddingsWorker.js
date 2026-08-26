// /opt/safebox/system/embeddingsWorker.js
//
// Embeddings inference subprocess. Forked at System startup via
// child_process.fork(). Communicates with the parent via Node's built-in
// IPC channel (process.send / process.on('message')).
//
// This process holds models in memory and runs inference. The parent
// (System component) never imports @huggingface/transformers and never
// holds model weights. The master HMAC key stays in the parent process,
// out of reach of any ONNX Runtime native-code crash, model-parser bug,
// or transformers.js issue.
//
// Models are loaded from /srv/safebox/models/<manifestHash>/. They MUST
// already be installed via the System component's /models/install
// endpoint — the worker does not download anything. transformers.js is
// configured with allowRemoteModels = false to make this guarantee
// enforced at the library level.
//
// IPC protocol:
//   Parent → Worker:
//     { id, type: 'embed',  model, inputs, pooling, normalize, task }
//     { id, type: 'unload', model }
//     { id, type: 'list' }
//     { id, type: 'health' }
//   Worker → Parent:
//     { id, status: 'ok',    data: {...} }
//     { id, status: 'error', code: '...', message: '...' }
//     { type: 'log', level, message }       (out-of-band logging)
//
// LRU cache: loaded models stay in memory until the total resident
// (estimated) size exceeds EMBEDDINGS_MEMORY_BUDGET_MB. On the next
// load, evicts least-recently-used models until there's room.

'use strict';

const fs   = require('fs');
const path = require('path');

const MODELS_ROOT = process.env.SAFEBOX_MODELS_ROOT || '/srv/safebox/models';
const BUDGET_MB   = parseInt(process.env.EMBEDDINGS_MEMORY_BUDGET_MB || '2048', 10);
const BUDGET_BYTES = BUDGET_MB * 1024 * 1024;

const MANIFEST_HASH_RE = /^[a-f0-9]{64}$/;
const MAX_INPUTS_PER_CALL = 64;
const MAX_INPUT_LENGTH    = 8192;   // chars per input

// ── Transformers configuration ───────────────────────────────────────────────
//
// Loaded lazily so an `npm install` failure doesn't block the worker from
// starting (it can still answer health/list with NOT_INITIALIZED).

let transformers = null;
let transformersInitError = null;

function initTransformers() {
    if (transformers !== null) return transformers;
    if (transformersInitError !== null) throw transformersInitError;
    try {
        const t = require('@huggingface/transformers');
        // Lock down the library: no remote fetches, no cache directory.
        t.env.allowLocalModels  = true;
        t.env.allowRemoteModels = false;
        t.env.localModelPath    = MODELS_ROOT + '/';
        t.env.useFSCache        = false;
        t.env.useBrowserCache   = false;
        // Conservative threading: ONNX Runtime can spawn many threads by
        // default. We're in a subprocess that should yield CPU to the host.
        if (t.env.backends && t.env.backends.onnx && t.env.backends.onnx.wasm) {
            t.env.backends.onnx.wasm.numThreads = Math.min(
                parseInt(process.env.EMBEDDINGS_THREADS || '4', 10),
                require('os').cpus().length
            );
        }
        transformers = t;
        return t;
    } catch (e) {
        transformersInitError = e;
        log('error', `transformers init failed: ${e.message}`);
        throw e;
    }
}

// ── Out-of-band logging ──────────────────────────────────────────────────────
function log(level, message) {
    try { process.send({ type: 'log', level, message }); }
    catch { /* parent went away */ }
}

// ── Model cache ──────────────────────────────────────────────────────────────
//
// Map<modelHash, {pipeline, task, sizeBytes, lastUsedMs}>
// LRU eviction when totalBytes + neededBytes > BUDGET_BYTES.

const loaded = new Map();
let totalBytes = 0;

// In-flight loads: Map<modelHash, Promise<pipeline>>
// Deduplicates concurrent loads of the same model. Without this, two embed
// calls for an uncached model would each enter loadPipeline, each call
// t.pipeline() (slow), each call loaded.set() — the second overwriting
// the first, totalBytes double-counted, and any LRU evictions made along
// the way doubled too.
const inflightLoads = new Map();

// Estimate the on-disk size of a model directory. We use the sum of file
// sizes as a proxy for resident memory — for ONNX models this is close
// (the weights ARE the resident memory, plus a small fixed overhead).
// Sum file sizes in a model directory. Used as a proxy for resident model
// memory. NOTE: we use lstat() (no symlink follow) — a symlink to a large
// directory elsewhere should not cause us to walk the filesystem. Symlinks
// are simply ignored. Hard caps on entry count and recursion depth prevent
// pathological directory layouts from hanging the worker. Real model dirs
// are flat or near-flat with a handful of files; the caps are loose
// enough to never affect legitimate uses.
const MAX_WALK_ENTRIES = 10000;
const MAX_WALK_DEPTH   = 8;

function estimateSize(modelDir) {
    let bytes = 0;
    let entries = 0;
    function walk(p, depth) {
        if (depth > MAX_WALK_DEPTH) return;
        if (entries++ > MAX_WALK_ENTRIES) {
            throw Object.assign(new Error(
                `model dir has too many entries (>${MAX_WALK_ENTRIES})`),
                { code: 'MODEL_LOAD_FAILED' });
        }
        // lstat does NOT follow symlinks. We treat symlinks as zero-sized
        // and don't recurse through them.
        const stat = fs.lstatSync(p);
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) { bytes += stat.size; return; }
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(p)) walk(path.join(p, entry), depth + 1);
        }
    }
    walk(modelDir, 0);
    return bytes;
}

function evictUntilRoom(neededBytes) {
    if (neededBytes > BUDGET_BYTES) {
        throw Object.assign(new Error(
            `model needs ${neededBytes} bytes, exceeds budget ${BUDGET_BYTES}`),
            { code: 'MODEL_EXCEEDS_BUDGET' });
    }
    while (totalBytes + neededBytes > BUDGET_BYTES && loaded.size > 0) {
        // Find LRU
        let oldestHash = null;
        let oldestMs   = Infinity;
        for (const [hash, entry] of loaded) {
            if (entry.lastUsedMs < oldestMs) {
                oldestMs   = entry.lastUsedMs;
                oldestHash = hash;
            }
        }
        if (oldestHash === null) break;
        const entry = loaded.get(oldestHash);
        loaded.delete(oldestHash);
        totalBytes -= entry.sizeBytes;
        // Best-effort: let GC reclaim the pipeline. transformers.js v3 doesn't
        // expose explicit dispose, so we drop the reference and rely on V8.
        log('info', `evicted ${oldestHash} (${entry.sizeBytes} bytes, lastUsedMs=${oldestMs})`);
    }
}

async function loadPipeline(modelHash, task) {
    // Fast path: already loaded
    const cached = loaded.get(modelHash);
    if (cached) {
        if (cached.task !== task) {
            throw Object.assign(new Error(
                `model ${modelHash} already loaded for task '${cached.task}', not '${task}'`),
                { code: 'TASK_MISMATCH' });
        }
        cached.lastUsedMs = Date.now();
        return cached.pipeline;
    }

    // Deduplicate: if another call is already loading this model, await its
    // promise instead of starting a second load. The promise resolves to the
    // pipeline; if our task differs from the in-flight load's task, we throw
    // TASK_MISMATCH after the load completes.
    const existing = inflightLoads.get(modelHash);
    if (existing) {
        await existing;  // wait for the load to finish (may throw — that's fine)
        const nowCached = loaded.get(modelHash);
        if (nowCached) {
            if (nowCached.task !== task) {
                throw Object.assign(new Error(
                    `model ${modelHash} already loaded for task '${nowCached.task}', not '${task}'`),
                    { code: 'TASK_MISMATCH' });
            }
            nowCached.lastUsedMs = Date.now();
            return nowCached.pipeline;
        }
        // The in-flight load failed and left no cache entry; fall through and
        // try again ourselves. We'll either succeed or get the same failure.
    }

    // Start a new load, recording the promise so concurrent callers can join.
    const loadPromise = (async () => {
        const modelDir = path.join(MODELS_ROOT, modelHash);
        if (!fs.existsSync(modelDir)) {
            throw Object.assign(new Error(
                `model ${modelHash} not installed (no directory at ${modelDir})`),
                { code: 'MODEL_NOT_INSTALLED' });
        }

        const t = initTransformers();
        const sizeBytes = estimateSize(modelDir);
        evictUntilRoom(sizeBytes);

        // transformers.js takes a "model id" that it resolves under
        // localModelPath. We pass the manifestHash as the id — the directory
        // name. The library looks for config.json, tokenizer.json, and a
        // model file under it.
        let pipeline;
        try {
            pipeline = await t.pipeline(task, modelHash);
        } catch (e) {
            throw Object.assign(new Error(
                `pipeline load failed for ${modelHash} (task=${task}): ${e.message}`),
                { code: 'MODEL_LOAD_FAILED' });
        }

        loaded.set(modelHash, {
            pipeline,
            task,
            sizeBytes,
            lastUsedMs: Date.now(),
        });
        totalBytes += sizeBytes;
        log('info', `loaded ${modelHash} (${sizeBytes} bytes, task=${task}, total=${totalBytes}/${BUDGET_BYTES})`);
        return pipeline;
    })();

    inflightLoads.set(modelHash, loadPromise);
    try {
        return await loadPromise;
    } finally {
        // Clear the inflight slot whether the load succeeded or threw.
        inflightLoads.delete(modelHash);
    }
}

// ── Operations ───────────────────────────────────────────────────────────────

function validateModel(model) {
    if (typeof model !== 'string' || !MANIFEST_HASH_RE.test(model)) {
        throw Object.assign(new Error('model must be a 64-char hex manifestHash'),
            { code: 'BAD_REQUEST' });
    }
}

function validateEmbedRequest(req) {
    validateModel(req.model);
    if (!Array.isArray(req.inputs) || req.inputs.length === 0) {
        throw Object.assign(new Error('inputs must be a non-empty array of strings'),
            { code: 'BAD_REQUEST' });
    }
    if (req.inputs.length > MAX_INPUTS_PER_CALL) {
        throw Object.assign(new Error(`too many inputs (${req.inputs.length} > ${MAX_INPUTS_PER_CALL})`),
            { code: 'BAD_REQUEST' });
    }
    for (const x of req.inputs) {
        if (typeof x !== 'string') {
            throw Object.assign(new Error('all inputs must be strings'),
                { code: 'BAD_REQUEST' });
        }
        if (x.length > MAX_INPUT_LENGTH) {
            throw Object.assign(new Error(`input too long (${x.length} chars > ${MAX_INPUT_LENGTH})`),
                { code: 'BAD_REQUEST' });
        }
    }
    if (req.pooling !== undefined && !['none', 'mean', 'cls'].includes(req.pooling)) {
        throw Object.assign(new Error(`pooling must be one of none|mean|cls`),
            { code: 'BAD_REQUEST' });
    }
    if (req.normalize !== undefined && typeof req.normalize !== 'boolean') {
        throw Object.assign(new Error('normalize must be a boolean'),
            { code: 'BAD_REQUEST' });
    }
    if (req.task !== undefined) {
        if (typeof req.task !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(req.task)) {
            throw Object.assign(new Error('task must be a string ≤64 chars matching [a-z0-9_-]'),
                { code: 'BAD_REQUEST' });
        }
    }
}

async function handleEmbed(req) {
    validateEmbedRequest(req);
    const task     = req.task     || 'feature-extraction';
    const pooling  = req.pooling  || 'mean';
    const normalize = req.normalize !== false;  // default true

    const startedMs = Date.now();
    const pipeline = await loadPipeline(req.model, task);

    // transformers.js feature-extraction returns a Tensor. We pass through
    // pooling and normalize options.
    const result = await pipeline(req.inputs, { pooling, normalize });

    // Tensor → JSON array
    // result.dims = [batch, dim] for pooled, [batch, tokens, dim] for none
    if (!result || !result.data || !Array.isArray(result.dims) || result.dims.length < 2) {
        throw Object.assign(new Error('worker got malformed tensor from pipeline'),
            { code: 'MODEL_LOAD_FAILED' });
    }

    // Defensive cap: a crafted model could return huge tensors that would
    // OOM the worker during Array.from or during IPC JSON serialization.
    // 20M entries ≈ 160MB JSON serialized — large but tractable. This is
    // enough for batches of up to ~50 inputs × 512 tokens × 768 dim with
    // pooling='none' (token-level), which is the largest realistic case.
    // Beyond that, callers should batch smaller.
    const MAX_TENSOR_ENTRIES = 20_000_000;
    const totalEntries = result.dims.reduce((a, b) => a * b, 1);
    if (totalEntries > MAX_TENSOR_ENTRIES) {
        throw Object.assign(new Error(
            `model returned tensor with ${totalEntries} entries (exceeds ${MAX_TENSOR_ENTRIES})`),
            { code: 'MODEL_LOAD_FAILED' });
    }

    const arr = Array.from(result.data);
    const dims = result.dims;

    let embeddings;
    if (dims.length === 2) {
        // [batch, dim] — most common case for pooled
        const dim = dims[1];
        embeddings = [];
        for (let i = 0; i < dims[0]; i++) {
            embeddings.push(arr.slice(i * dim, (i + 1) * dim));
        }
    } else if (dims.length === 3 && pooling === 'none') {
        // [batch, tokens, dim] — token-level embeddings
        const tokens = dims[1], dim = dims[2];
        embeddings = [];
        for (let i = 0; i < dims[0]; i++) {
            const perInput = [];
            for (let j = 0; j < tokens; j++) {
                const off = (i * tokens + j) * dim;
                perInput.push(arr.slice(off, off + dim));
            }
            embeddings.push(perInput);
        }
    } else {
        // Fallback: pass the raw shape and flat data
        embeddings = { dims, data: arr };
    }

    return {
        model:       req.model,
        task,
        pooling,
        normalize,
        dim:         dims[dims.length - 1],
        count:       req.inputs.length,
        embeddings,
        durationMs:  Date.now() - startedMs,
    };
}

function handleUnload(req) {
    validateModel(req.model);
    const entry = loaded.get(req.model);
    if (!entry) {
        return { unloaded: false, reason: 'not_loaded' };
    }
    loaded.delete(req.model);
    totalBytes -= entry.sizeBytes;
    log('info', `explicit unload ${req.model} (freed ${entry.sizeBytes})`);
    return { unloaded: true, freedBytes: entry.sizeBytes };
}

function handleList() {
    const models = [];
    for (const [hash, entry] of loaded) {
        models.push({
            model:      hash,
            task:       entry.task,
            sizeBytes:  entry.sizeBytes,
            lastUsedMs: entry.lastUsedMs,
        });
    }
    return {
        models,
        totalBytes,
        budgetBytes: BUDGET_BYTES,
        transformersReady: transformers !== null,
        transformersError: transformersInitError ? transformersInitError.message : null,
    };
}

function handleHealth() {
    return {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        loadedCount: loaded.size,
        totalBytes,
        budgetBytes: BUDGET_BYTES,
        rss: process.memoryUsage().rss,
        transformersReady: transformers !== null,
    };
}

// ── IPC dispatcher ───────────────────────────────────────────────────────────

process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
        return;
    }
    const respond = (status, body) => {
        try { process.send(Object.assign({ id: msg.id, status }, body)); }
        catch { /* parent went away */ }
    };
    try {
        let data;
        switch (msg.type) {
            case 'embed':   data = await handleEmbed(msg); break;
            case 'unload':  data = handleUnload(msg);      break;
            case 'list':    data = handleList();           break;
            case 'health':  data = handleHealth();         break;
            default:
                respond('error', { code: 'BAD_REQUEST', message: `unknown type '${msg.type}'` });
                return;
        }
        respond('ok', { data });
    } catch (e) {
        respond('error', {
            code: e.code || 'INTERNAL_ERROR',
            message: e.message || 'embeddings worker error',
        });
    }
});

process.on('uncaughtException', (e) => {
    log('error', `uncaughtException: ${e.message}`);
    process.exit(2);
});
process.on('unhandledRejection', (e) => {
    log('error', `unhandledRejection: ${e && e.message}`);
    process.exit(3);
});

log('info', `embeddings worker started (pid=${process.pid}, budget=${BUDGET_MB} MB, models=${MODELS_ROOT})`);
