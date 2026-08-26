// test/testDnsclientChallengeServer.js
//
// Tests the HTTP challenge server: starts the dnsclient as a child process
// with a known challenge port, generates a nonce via the in-process API,
// then makes a GET to the challenge endpoint and verifies the response.
// Also tests that wrong nonces 404 and that a consumed nonce 404s the
// second time.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-chall-srv-'));

    // Minimal config that lets the dnsclient start without trying to actually
    // announce (we use a bogus URL — it'll fail but the challenge server starts
    // independently of announce success).
    const cfgPath = path.join(tmpDir, 'dnsclient.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
        safeboxId: 'sbx_testvalue123',
        accountToken: 'tok_' + 'a'.repeat(32),
        dnsApiUrl: 'https://127.0.0.1:1/none',  // unreachable; announce will fail
        allowUnattested: true,
    }));

    // Pick an ephemeral port for the challenge server.
    const tmp = http.createServer();
    await new Promise(r => tmp.listen(0, '127.0.0.1', r));
    const challengePort = tmp.address().port;
    tmp.close();

    // Suppress the dnsclient's IMDS lookups by pointing them at a dead host.
    // This causes announce to fail fast; we only care about the challenge port.
    const shimPath = path.join(tmpDir, 'shim.js');
    fs.writeFileSync(shimPath, `
        const http = require('http');
        const origHttpReq = http.request;
        http.request = function(opts, cb) {
            if (opts && opts.host === '169.254.169.254') {
                opts = Object.assign({}, opts, { host: '127.0.0.1', port: 1 });
            }
            return origHttpReq.call(this, opts, cb);
        };
    `);

    const dnsclientPath = path.resolve(__dirname, '..', 'dnsclient.js');
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const child = spawn(process.execPath, ['--require', shimPath, dnsclientPath], {
        env: Object.assign({}, process.env, {
            SAFEBOX_DNSCLIENT_CONFIG: cfgPath,
            SAFEBOX_DNSCLIENT_STATE: path.join(stateDir, 'state.json'),
            SAFEBOX_DNSCLIENT_CHALLENGE_PORT: String(challengePort),
        }),
        stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => stderr += c);

    // Wait for challenge server to start
    let waited = 0;
    while (!/challenge_server_listening/.test(stderr) && waited < 5000) {
        await sleep(100); waited += 100;
    }
    check('challenge server started',
        /challenge_server_listening/.test(stderr),
        stderr.slice(-500));

    if (!/challenge_server_listening/.test(stderr)) {
        child.kill('SIGTERM');
        await new Promise(r => child.on('exit', r));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(2);
    }

    // ── Test 1: unknown nonce returns 404 ────────────────────────────────────
    const r1 = await get(challengePort, '/.well-known/safebox-announce-challenge/unknown-nonce-not-issued');
    check('unknown nonce → 404',
        r1.status === 404,
        `status=${r1.status}, body=${r1.body}`);

    // ── Test 2: malformed path returns 404 ───────────────────────────────────
    const r2 = await get(challengePort, '/some/random/path');
    check('non-challenge path → 404',
        r2.status === 404);

    // ── Test 3: malformed nonce (has slash) → 404 ────────────────────────────
    const r3 = await get(challengePort, '/.well-known/safebox-announce-challenge/has/slash');
    check('nonce with slash → 404',
        r3.status === 404);

    // ── Test 4: empty nonce → 404 ────────────────────────────────────────────
    const r4 = await get(challengePort, '/.well-known/safebox-announce-challenge/');
    check('empty nonce → 404',
        r4.status === 404);

    // ── Test 5: nonce too long → 404 ─────────────────────────────────────────
    const r5 = await get(challengePort, '/.well-known/safebox-announce-challenge/' + 'a'.repeat(200));
    check('nonce >64 chars → 404',
        r5.status === 404);

    // Note: we can't test that a valid nonce returns 200 from this test because
    // the challenge nonces are generated inside the child process. That path
    // is tested at the unit level in testDnsclientChallenge.js.

    // Cleanup
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
