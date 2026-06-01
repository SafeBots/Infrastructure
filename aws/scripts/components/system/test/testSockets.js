// test/testSockets.js
//
// Verifies the sockets module: that it opens listeners per container,
// writes per-container key files, reconciles on config change, and
// cleans up on shutdown.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Set up an isolated test environment BEFORE requiring modules
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-sockets-test-'));
const sockDir = path.join(tmpDir, 'run');
const keyDir = path.join(tmpDir, 'keys');
const cfgPath = path.join(tmpDir, 'managed-containers.json');

process.env.SAFEBOX_SYSTEM_SOCKET_DIR = sockDir;
process.env.SAFEBOX_SYSTEM_KEY_DIR    = keyDir;
process.env.SAFEBOX_SYSTEM_CONFIG     = cfgPath;

fs.writeFileSync(cfgPath, JSON.stringify({
    '_host': { imagePattern: '', execContext: 'host', allowedActions: ['dnf'] },
    'safebox-app-foo': {
        imagePattern: '^foo/.*$',
        execContext: 'container',
        allowedActions: ['npm', 'git'],
        keyEpoch: 'a'.repeat(32),
    },
    'safebox-app-bar': {
        imagePattern: '^bar/.*$',
        execContext: 'container',
        allowedActions: ['pip'],
        keyEpoch: 'b'.repeat(32),
    },
}));

const config = require('../config');
const sockets = require('../sockets');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    config.reload();

    // Dummy handler — we're not testing requests here
    const handler = () => {};

    const master = Buffer.from(
        'ac39caf5fadb5c00cfee415f7de54007aeb3a86c8b5c1315dd86d537fdb036eb',
        'hex'
    );

    sockets.start(master, handler);
    await sleep(50);  // let listen() callbacks fire

    // ── Directories created ──────────────────────────────────────────────────
    check('socket dir created', fs.existsSync(sockDir));
    check('container subdir created', fs.existsSync(path.join(sockDir, 'containers')));
    check('key dir created', fs.existsSync(keyDir));

    // ── Listeners opened ─────────────────────────────────────────────────────
    check('control listener opened',  sockets.listeners.has('_control'));
    check('foo listener opened',      sockets.listeners.has('safebox-app-foo'));
    check('bar listener opened',      sockets.listeners.has('safebox-app-bar'));
    check('no listener for _host',   !sockets.listeners.has('_host'));

    // ── Socket files exist ───────────────────────────────────────────────────
    check('control socket exists', fs.existsSync(path.join(sockDir, 'control.sock')));
    check('foo socket exists',     fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-foo.sock')));
    check('bar socket exists',     fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-bar.sock')));

    // ── Key files written for containers (NOT for control — uses master) ─────
    const fooKeyPath = path.join(keyDir, 'safebox-app-foo.hmac');
    const barKeyPath = path.join(keyDir, 'safebox-app-bar.hmac');
    check('foo key file exists', fs.existsSync(fooKeyPath));
    check('bar key file exists', fs.existsSync(barKeyPath));
    check('control has no key file', !fs.existsSync(path.join(keyDir, '_control.hmac')));

    // Key file contents are 32 bytes and distinct
    const fooBytes = fs.readFileSync(fooKeyPath);
    const barBytes = fs.readFileSync(barKeyPath);
    check('foo key is 32 bytes', fooBytes.length === 32);
    check('bar key is 32 bytes', barBytes.length === 32);
    check('foo and bar keys differ', !fooBytes.equals(barBytes));

    // Foo's key matches what derivePerContainerKey would produce — check by
    // re-deriving and comparing
    const secret = require('../secret');
    const expectedFoo = secret.derivePerContainerKey(master, 'safebox-app-foo', 'a'.repeat(32));
    check('foo key matches derivePerContainerKey output', fooBytes.equals(expectedFoo));

    // ── Key file mode ────────────────────────────────────────────────────────
    const fooMode = fs.statSync(fooKeyPath).mode & 0o777;
    check('foo key file mode is 0640', fooMode === 0o640, 'got: 0' + fooMode.toString(8));

    // ── Reconciliation: add a container ──────────────────────────────────────
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg['safebox-app-baz'] = {
        imagePattern: '^baz/.*$',
        execContext: 'container',
        allowedActions: ['npm'],
        keyEpoch: 'c'.repeat(32),
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    config.reload();
    sockets.reconcile();
    await sleep(50);

    check('baz listener opened after reconcile', sockets.listeners.has('safebox-app-baz'));
    check('baz socket file exists',
        fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-baz.sock')));
    check('baz key file written',
        fs.existsSync(path.join(keyDir, 'safebox-app-baz.hmac')));

    // ── Reconciliation: remove a container ───────────────────────────────────
    delete cfg['safebox-app-bar'];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    config.reload();
    sockets.reconcile();
    await sleep(100);

    check('bar listener closed after reconcile', !sockets.listeners.has('safebox-app-bar'));
    check('bar socket file removed',
        !fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-bar.sock')));
    // Key file is NOT removed on reconcile (only on /containers/destroy)
    check('bar key file PRESERVED (only /containers/destroy removes it)',
        fs.existsSync(barKeyPath));

    // ── Regression: rapid remove-then-readd in the same tick ─────────────────
    // Tests that closeListener removes from the listeners map synchronously,
    // so a subsequent openListener for the same name in the same reconcile
    // pass actually opens a fresh listener instead of being skipped by the
    // listeners.has() guard. Bug: a destroy+create cycle could leave the
    // container with no listener and no socket file.
    delete cfg['safebox-app-baz'];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    config.reload();
    sockets.reconcile();
    // IMMEDIATELY re-add baz before the async close completes
    cfg['safebox-app-baz'] = {
        imagePattern: '^baz/.*$',
        execContext: 'container',
        allowedActions: ['npm'],
        keyEpoch: 'c'.repeat(32),
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    config.reload();
    sockets.reconcile();

    check('rapid cycle: baz listener present in map immediately',
        sockets.listeners.has('safebox-app-baz'));

    await sleep(300);  // let async close complete
    check('rapid cycle: baz listener still present after async close',
        sockets.listeners.has('safebox-app-baz'));
    check('rapid cycle: baz socket file exists after async close',
        fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-baz.sock')));

    // ── destroyContainerKey removes the key file ─────────────────────────────
    sockets.destroyContainerKey('safebox-app-bar');
    check('bar key file removed by destroyContainerKey', !fs.existsSync(barKeyPath));

    // ── destroyContainerKey refuses _host / _control ─────────────────────────
    let threw = false;
    try { sockets.destroyContainerKey('_host'); } catch { threw = true; }
    check('destroyContainerKey rejects _host', threw);
    threw = false;
    try { sockets.destroyContainerKey('_control'); } catch { threw = true; }
    check('destroyContainerKey rejects _control', threw);

    // ── Shutdown closes everything ───────────────────────────────────────────
    await sockets.shutdown();
    check('all listeners closed after shutdown', sockets.listeners.size === 0);
    check('control socket file removed', !fs.existsSync(path.join(sockDir, 'control.sock')));
    check('foo socket file removed',
        !fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-foo.sock')));

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
