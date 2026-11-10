// test/testAutovhostHandler.js
//
// Tests the Unix-socket HTTP handler that nginx posts to. We start the
// socket server in-process, make POSTs to it, and verify responses.
// We do NOT run real ACME — we stub the provisioning function so the
// handler is exercised against synthetic outcomes.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stub the autovhost module's heavy dependencies before requiring it.
// We do this by setting the config path to a temp file we control.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovhost-handler-'));
const socketPath = path.join(tmpDir, 'autovhost.sock');
const cfgPath = path.join(tmpDir, 'autovhost.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    socketPath,
    vhostConfDir:       path.join(tmpDir, 'conf.d/auto'),
    vhostCertDir:       path.join(tmpDir, 'certs'),
    acmeAccountKeyPath: path.join(tmpDir, 'acme-account.key'),
    acmeChallengesDir:  path.join(tmpDir, 'challenges'),
    acmeStaging:        true,
    nginxReloadCommand: ['/bin/true'],  // pretend the reload wrapper always succeeds
    ourIps:             ['127.0.0.1'],  // for dns checks
}));
process.env.SAFEBOX_AUTOVHOST_CONFIG = cfgPath;

const av = require('../autovhost');

// Replace tryProvision with a stub that returns whatever a side channel says
let stubResponse = { status: 'ok', code: 'STUB_OK' };
let provisionedHosts = [];
const originalTryProvision = av.tryProvision;
av.tryProvision = async function(host) {
    provisionedHosts.push(host);
    // Mimic the real validation gate — invalid hostnames don't even reach
    // the provisioning logic in the real code.
    if (!av._isValidHostname(host)) {
        return { status: 'error', code: 'INVALID_HOST', message: 'bad hostname format' };
    }
    return stubResponse;
};

function post(socketPath, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({
            method: 'POST',
            socketPath,
            path: urlPath,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 3000,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

(async () => {
    const server = av.startServer();
    // Wait for socket to be ready
    let waited = 0;
    while (!fs.existsSync(socketPath) && waited < 2000) {
        await sleep(50); waited += 50;
    }
    check('server bound socket', fs.existsSync(socketPath));

    // ── Wrong path → 404 ────────────────────────────────────────────────────
    const r1 = await post(socketPath, '/something-else', { host: 'app.example.com' });
    check('wrong path → 404',
        r1.status === 404,
        `status=${r1.status} body=${r1.body}`);

    // ── /provision with valid host → ok ─────────────────────────────────────
    stubResponse = { status: 'ok', code: 'INSTALLED' };
    provisionedHosts = [];
    const r2 = await post(socketPath, '/provision', { host: 'app.example.com' });
    check('valid host → 200',
        r2.status === 200);
    check('valid host → status:ok',
        JSON.parse(r2.body).status === 'ok');
    check('valid host → tryProvision called',
        provisionedHosts.length === 1 && provisionedHosts[0] === 'app.example.com');

    // ── /provision with invalid host (per stub) → error ─────────────────────
    provisionedHosts = [];
    const r3 = await post(socketPath, '/provision', { host: 'has space.example.com' });
    check('invalid host → status:error',
        r3.status === 200 && JSON.parse(r3.body).status === 'error');

    // ── Malformed JSON → 400 ────────────────────────────────────────────────
    const r4 = await post(socketPath, '/provision', '{not json}');
    check('malformed JSON → 400',
        r4.status === 400);

    // ── Body too large → connection killed ──────────────────────────────────
    // Hard to test reliably across Node versions; skip
    // (the 4096-byte cap is enforced in autovhost.js)

    // ── Stub returning ACME_FAILED is passed through ────────────────────────
    stubResponse = { status: 'error', code: 'ACME_FAILED', message: 'rate limit' };
    const r5 = await post(socketPath, '/provision', { host: 'fail.example.com' });
    check('ACME error passed through',
        r5.status === 200 && JSON.parse(r5.body).code === 'ACME_FAILED');

    // ── Missing host field ──────────────────────────────────────────────────
    provisionedHosts = [];
    const r6 = await post(socketPath, '/provision', {});
    check('missing host → invalid host error',
        r6.status === 200 && JSON.parse(r6.body).status === 'error');

    // Cleanup
    av.tryProvision = originalTryProvision;
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
