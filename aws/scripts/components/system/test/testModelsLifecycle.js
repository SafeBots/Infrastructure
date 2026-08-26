// test/testModelsLifecycle.js
//
// End-to-end test: spin up a local HTTPS server serving fake model files,
// install a manifest pointing at it, verify the install, then remove.
// Also tests: scope check (rejects non-_host), hash mismatch detection,
// download SHA mismatch rejection.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── Set up a temp models dir BEFORE requiring opsModels ─────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-models-test-'));
process.env.SAFEBOX_SYSTEM_MODELS_DIR = path.join(TMP, 'models');
process.env.SAFEBOX_SYSTEM_MODELS_STAGING = path.join(TMP, 'staging');

const opsModels = require('../opsModels');

// ── Build a self-signed cert for the local HTTPS server ─────────────────────
// Node's https requires real TLS; we set NODE_TLS_REJECT_UNAUTHORIZED=0 in this
// test process to accept the self-signed cert, since we control both ends.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { execFileSync } = require('child_process');
const tlsDir = path.join(TMP, 'tls');
fs.mkdirSync(tlsDir, { recursive: true });
execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(tlsDir, 'key.pem'),
    '-out', path.join(tlsDir, 'cert.pem'), '-days', '1', '-nodes',
    '-subj', '/CN=localhost',
], { stdio: 'pipe' });
const tlsKey = fs.readFileSync(path.join(tlsDir, 'key.pem'));
const tlsCert = fs.readFileSync(path.join(tlsDir, 'cert.pem'));

// ── Generate fake "weight files" ────────────────────────────────────────────
function fakeWeight(size, seed) {
    const buf = Buffer.alloc(size);
    let s = seed;
    for (let i = 0; i < size; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = s & 0xff;
    }
    return buf;
}
const fileA = fakeWeight(1024, 1);
const fileB = fakeWeight(2048, 2);
const shaA = crypto.createHash('sha256').update(fileA).digest('hex');
const shaB = crypto.createHash('sha256').update(fileB).digest('hex');

// ── Start the local HTTPS server ────────────────────────────────────────────
const server = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    if (req.url === '/file-a') {
        res.writeHead(200, { 'content-length': fileA.length });
        res.end(fileA);
    } else if (req.url === '/file-b') {
        res.writeHead(200, { 'content-length': fileB.length });
        res.end(fileB);
    } else if (req.url === '/file-corrupt') {
        // Right size but wrong bytes — should fail SHA check
        res.writeHead(200, { 'content-length': fileA.length });
        res.end(Buffer.alloc(fileA.length));
    } else {
        res.writeHead(404);
        res.end('not found');
    }
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `https://127.0.0.1:${port}`;

    // ── Build a manifest ─────────────────────────────────────────────────────
    const manifest = {
        name: 'stable-audio-3-small-test',
        version: '1.0.0',
        license: 'Stability-Community-License',
        runnerType: 'stable-audio-3',
        totalSizeBytes: fileA.length + fileB.length,
        files: [
            { path: 'weights/encoder.safetensors', sizeBytes: fileA.length, sha256: shaA, sources: [`${base}/file-a`] },
            { path: 'weights/decoder.safetensors', sizeBytes: fileB.length, sha256: shaB, sources: [`${base}/file-b`] },
        ],
        metadata: { author: 'Stability AI' },
    };
    const hash = opsModels._computeManifestHash(manifest);

    // ── Test 1: scope check ─────────────────────────────────────────────────
    try {
        await opsModels.handle('POST', '/models/install', { managedContainer: 'safebox-app-x', manifestHash: hash, manifest });
        check('scope check: non-_host rejected', false, 'install accepted from non-_host');
    } catch (e) {
        check('scope check: non-_host rejected', e.code === 'FORBIDDEN_ACTION', 'code=' + e.code);
    }

    // ── Test 2: manifest hash mismatch ──────────────────────────────────────
    try {
        await opsModels.handle('POST', '/models/install', { managedContainer: '_host', manifestHash: 'b'.repeat(64), manifest });
        check('hash mismatch detected', false);
    } catch (e) {
        check('hash mismatch detected', e.code === 'MANIFEST_HASH_MISMATCH', 'code=' + e.code);
    }

    // ── Test 3: happy install ───────────────────────────────────────────────
    const installResult = await opsModels.handle('POST', '/models/install', {
        managedContainer: '_host', manifestHash: hash, manifest,
    });
    check('install: returns ok', installResult.status === 'ok');
    check('install: returns the right hash', installResult.data && installResult.data.manifestHash === hash);
    check('install: weights on disk',
        fs.existsSync(path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, hash, 'weights/encoder.safetensors')) &&
        fs.existsSync(path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, hash, 'weights/decoder.safetensors')));
    check('install: manifest.json on disk',
        fs.existsSync(path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, hash, 'manifest.json')));

    // ── Test 4: idempotent re-install ───────────────────────────────────────
    const idempotent = await opsModels.handle('POST', '/models/install', {
        managedContainer: '_host', manifestHash: hash, manifest,
    });
    check('reinstall is idempotent', idempotent.status === 'ok' && idempotent.data.alreadyInstalled === true);

    // ── Test 5: list ────────────────────────────────────────────────────────
    const list = await opsModels.handle('POST', '/models/list', { managedContainer: '_host' });
    check('list: returns the model', list.status === 'ok' && list.data.models.length === 1);
    check('list: model has the right hash', list.data.models[0].manifestHash === hash);
    check('list: model has runnerType', list.data.models[0].runnerType === 'stable-audio-3');

    // ── Test 6: verify ──────────────────────────────────────────────────────
    const verifyResult = await opsModels.handle('POST', `/models/${hash}/verify`, { managedContainer: '_host' });
    check('verify: passes for clean install', verifyResult.status === 'ok');

    // ── Test 7: verify catches tampering ────────────────────────────────────
    const tamperedFile = path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, hash, 'weights/encoder.safetensors');
    fs.writeFileSync(tamperedFile, Buffer.alloc(fileA.length));
    const verifyTampered = await opsModels.handle('POST', `/models/${hash}/verify`, { managedContainer: '_host' });
    check('verify: detects tampered file',
        verifyTampered.status === 'error' && verifyTampered.code === 'VERIFICATION_FAILED');

    // Restore for the remove test
    fs.writeFileSync(tamperedFile, fileA);

    // ── Test 8: download SHA mismatch rejection ─────────────────────────────
    const corruptManifest = {
        name: 'corrupt-test',
        version: '1.0.0',
        license: 'Apache-2.0',
        runnerType: 'test',
        totalSizeBytes: fileA.length,
        files: [
            { path: 'model.bin', sizeBytes: fileA.length, sha256: shaA, sources: [`${base}/file-corrupt`] },
        ],
    };
    const corruptHash = opsModels._computeManifestHash(corruptManifest);
    try {
        await opsModels.handle('POST', '/models/install', { managedContainer: '_host', manifestHash: corruptHash, manifest: corruptManifest });
        check('corrupt download is rejected', false);
    } catch (e) {
        check('corrupt download is rejected', e.code === 'DOWNLOAD_FAILED', 'code=' + e.code);
    }
    // Confirm no partial install lingers
    check('failed install leaves no traces',
        !fs.existsSync(path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, corruptHash)));

    // ── Test 9: remove ──────────────────────────────────────────────────────
    const removeResult = await opsModels.handle('POST', `/models/${hash}/remove`, { managedContainer: '_host' });
    check('remove: succeeds', removeResult.status === 'ok' && removeResult.data.removed === true);
    check('remove: directory is gone',
        !fs.existsSync(path.join(process.env.SAFEBOX_SYSTEM_MODELS_DIR, hash)));

    // ── Test 10: list after remove ──────────────────────────────────────────
    const listEmpty = await opsModels.handle('POST', '/models/list', { managedContainer: '_host' });
    check('list after remove: empty', listEmpty.data.models.length === 0);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('FATAL:', e);
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(2);
});
