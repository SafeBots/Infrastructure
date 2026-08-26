// test/testEmbedIpc.js
//
// Tests the opsEmbed IPC + lifecycle layer using a stub worker script
// that doesn't require @huggingface/transformers. Covers:
//   - request → response round-trip
//   - request timeout
//   - worker crash mid-request returns EMBEDDINGS_WORKER_RESTART
//   - worker auto-respawns after crash
//   - shutdownWorker does not respawn
//   - HTTP status mapping for known error codes

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Set up a temp dir for a stub config the opsEmbed tests can use
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-embed-ipc-test-'));
const cfgPath = path.join(tmpDir, 'managed-containers.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    'safebox-app-foo': {
        imagePattern: '^foo/.*$',
        execContext: 'container',
        allowedActions: ['embed'],
        keyEpoch: 'a'.repeat(32),
    },
    'safebox-app-noembed': {
        imagePattern: '^noembed/.*$',
        execContext: 'container',
        allowedActions: ['npm'],   // 'embed' NOT in allowedActions
        keyEpoch: 'b'.repeat(32),
    },
}));
process.env.SAFEBOX_SYSTEM_CONFIG = cfgPath;

// Stub worker that responds to a synthetic protocol — no transformers needed.
const stubWorkerPath = path.join(tmpDir, 'stubWorker.js');
fs.writeFileSync(stubWorkerPath, `
'use strict';
process.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'string') return;

    // Special messages:
    //  type=embed model='crash...' → exit immediately (test crash handling)
    //  type=embed model='hang...'  → never respond (test timeout)
    //  type=embed model='err....'  → respond with structured error
    //  otherwise echo a synthetic OK
    if (msg.type === 'embed' && /^crash/.test(msg.model || '')) {
        process.exit(99);  // unexpected exit
    }
    if (msg.type === 'embed' && /^hang/.test(msg.model || '')) {
        return;  // never respond
    }
    if (msg.type === 'embed' && /^err/.test(msg.model || '')) {
        process.send({ id: msg.id, status: 'error',
            code: 'MODEL_NOT_INSTALLED', message: 'stub: model not found' });
        return;
    }
    if (msg.type === 'embed') {
        process.send({ id: msg.id, status: 'ok', data: {
            model: msg.model, dim: 4, count: (msg.inputs || []).length,
            embeddings: (msg.inputs || []).map(() => [0.1, 0.2, 0.3, 0.4]),
        }});
        return;
    }
    if (msg.type === 'health') {
        process.send({ id: msg.id, status: 'ok', data: { pid: process.pid, stub: true }});
        return;
    }
    if (msg.type === 'list') {
        process.send({ id: msg.id, status: 'ok', data: { models: [], stub: true }});
        return;
    }
    if (msg.type === 'unload') {
        process.send({ id: msg.id, status: 'ok', data: { unloaded: false, reason: 'stub' }});
        return;
    }
    process.send({ id: msg.id, status: 'error', code: 'BAD_REQUEST', message: 'stub: unknown type' });
});
`);

// Force opsEmbed to use the stub
process.env.EMBEDDINGS_REQUEST_TIMEOUT_MS = '500';  // short for the hang test
// We need to intercept the worker script path. Easiest: monkey-patch fork.
const cp = require('child_process');
const origFork = cp.fork;
cp.fork = function(modulePath, args, opts) {
    // Redirect requests for embeddingsWorker.js to our stub
    if (typeof modulePath === 'string' && modulePath.endsWith('/embeddingsWorker.js')) {
        return origFork.call(this, stubWorkerPath, args, opts);
    }
    return origFork.call(this, modulePath, args, opts);
};

// Load config from our synthetic file. opsEmbed transitively loads
// config.js which keys off SAFEBOX_SYSTEM_CONFIG (already set above).
const config = require('../config');
config.reload();

const opsEmbed = require('../opsEmbed');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    // ── Start worker, do a basic embed ───────────────────────────────────────
    opsEmbed.startWorker();
    await sleep(100);  // let fork settle
    check('worker running after startWorker', opsEmbed._isWorkerRunning());

    const r1 = await opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-foo',
        model: 'a'.repeat(64),
        inputs: ['hello', 'world'],
    });
    check('basic embed returns ok',
        r1.status === 'ok' && r1.data.dim === 4 && r1.data.count === 2,
        JSON.stringify(r1).slice(0, 200));

    // ── Missing managedContainer → BAD_REQUEST ───────────────────────────────
    const r2 = await opsEmbed.handle('POST', '/embed', {
        model: 'a'.repeat(64), inputs: ['hi'],
    });
    check('missing managedContainer rejected',
        r2.status === 'error' && r2.code === 'BAD_REQUEST');

    // ── Container without 'embed' in allowedActions → FORBIDDEN_ACTION ───────
    const r3 = await opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-noembed',
        model: 'a'.repeat(64), inputs: ['hi'],
    });
    check('container without embed action rejected',
        r3.status === 'error' && r3.code === 'FORBIDDEN_ACTION');

    // ── Worker-side structured error proxied through ─────────────────────────
    const r4 = await opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-foo',
        model: 'errAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        inputs: ['hi'],
    });
    check('worker-side MODEL_NOT_INSTALLED proxied through with 404',
        r4.status === 'error' && r4.code === 'MODEL_NOT_INSTALLED' && r4._http === 404,
        JSON.stringify(r4));

    // ── Hang → request timeout ───────────────────────────────────────────────
    const t0 = Date.now();
    const r5 = await opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-foo',
        model: 'hangAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        inputs: ['hi'],
    });
    const dur = Date.now() - t0;
    check('hang yields EMBEDDINGS_TIMEOUT 504',
        r5.status === 'error' && r5.code === 'EMBEDDINGS_TIMEOUT' && r5._http === 504,
        JSON.stringify(r5));
    check('timeout fires close to configured value (within 2s of 500ms)',
        dur >= 500 && dur < 2500, 'dur=' + dur);

    // ── Worker crash mid-request → EMBEDDINGS_WORKER_RESTART, then respawn ───
    const r6Promise = opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-foo',
        model: 'crashAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        inputs: ['hi'],
    });
    const r6 = await r6Promise;
    check('worker crash mid-request → EMBEDDINGS_WORKER_RESTART 503',
        r6.status === 'error' && r6.code === 'EMBEDDINGS_WORKER_RESTART' && r6._http === 503,
        JSON.stringify(r6));

    // After crash, worker should be respawned (with backoff)
    check('worker is null right after crash', !opsEmbed._isWorkerRunning());
    await sleep(2500);  // respawn backoff is 2s
    check('worker respawned after backoff', opsEmbed._isWorkerRunning());

    // Post-respawn requests succeed
    const r7 = await opsEmbed.handle('POST', '/embed', {
        managedContainer: 'safebox-app-foo',
        model: 'a'.repeat(64), inputs: ['post-respawn'],
    });
    check('post-respawn request succeeds',
        r7.status === 'ok' && r7.data.count === 1,
        JSON.stringify(r7).slice(0, 200));

    // ── Health endpoint ──────────────────────────────────────────────────────
    // In real use, server.js's reconcileIdentity fills in managedContainer
    // from the calling socket; we pass it explicitly here since this test
    // bypasses server.js.
    const r8 = await opsEmbed.handle('GET', '/embed/health',
        { managedContainer: 'safebox-app-foo' });
    check('health returns ok with running=true',
        r8.status === 'ok' && r8.data.running === true,
        JSON.stringify(r8).slice(0, 200));

    // ── List models ──────────────────────────────────────────────────────────
    const r9 = await opsEmbed.handle('GET', '/embed/models',
        { managedContainer: 'safebox-app-foo' });
    check('list returns ok',
        r9.status === 'ok' && Array.isArray(r9.data.models));

    // ── Container without 'embed' is rejected on /health and /models too ────
    const r9b = await opsEmbed.handle('GET', '/embed/health',
        { managedContainer: 'safebox-app-noembed' });
    check('health rejected for container without embed action',
        r9b.status === 'error' && r9b.code === 'FORBIDDEN_ACTION');

    const r9c = await opsEmbed.handle('GET', '/embed/models',
        { managedContainer: 'safebox-app-noembed' });
    check('models list rejected for container without embed action',
        r9c.status === 'error' && r9c.code === 'FORBIDDEN_ACTION');

    // ── Unknown /embed sub-endpoint ──────────────────────────────────────────
    const r10 = await opsEmbed.handle('GET', '/embed/unknown', null);
    check('unknown /embed endpoint → NOT_FOUND',
        r10.status === 'error' && r10.code === 'NOT_FOUND' && r10._http === 404);

    // ── Shutdown does not respawn ────────────────────────────────────────────
    opsEmbed.shutdownWorker();
    await sleep(500);
    check('shutdown stops worker', !opsEmbed._isWorkerRunning());
    await sleep(2500);
    check('worker NOT respawned after shutdown', !opsEmbed._isWorkerRunning());

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR:', e); process.exit(2); });
