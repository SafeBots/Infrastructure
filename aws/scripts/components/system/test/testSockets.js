// test/testSockets.js
//
// The sockets module in OPERATOR mode (no SAFEBOX_TENANT): it opens the
// control socket and nothing else, writes no key, and refuses to open a
// per-container listener however many containers the config declares.
// Tenant mode is covered by testTenantInstance.js and key materialisation
// by testKeyd.js.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-sockets-test-'));
const sockDir = path.join(tmpDir, 'run');
const keyDir = path.join(tmpDir, 'keys');
const cfgPath = path.join(tmpDir, 'managed-containers.json');

delete process.env.SAFEBOX_TENANT;
process.env.NODE_ENV = 'test';
process.env.SAFEBOX_SYSTEM_SOCKET_DIR = sockDir;
process.env.SAFEBOX_SYSTEM_KEYS_DIR = keyDir;
process.env.SAFEBOX_SYSTEM_CONFIG     = cfgPath;

fs.writeFileSync(cfgPath, JSON.stringify({
    '_host': { imagePattern: '', execContext: 'host', allowedActions: ['dnf'] },
    'safebox-app-foo': {
        imagePattern: '^foo/.*$', execContext: 'container',
        allowedActions: ['npm', 'git'], keyEpoch: 'a'.repeat(32), instanceUid: 20000,
    },
    'safebox-app-bar': {
        imagePattern: '^bar/.*$', execContext: 'container',
        allowedActions: ['pip'], keyEpoch: 'b'.repeat(32), instanceUid: 20001,
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
    const handler = () => {};
    const key = Buffer.from('ac39caf5fadb5c00cfee415f7de54007aeb3a86c8b5c1315dd86d537fdb036eb', 'hex');

    check('operator role detected', !sockets.IS_TENANT && sockets.TENANT === null);
    check('own identity is _control', sockets.ownIdentity() === sockets.CONTROL_IDENTITY);

    sockets.start(key, handler);
    await sleep(50);

    check('socket dir created', fs.existsSync(sockDir));
    check('container subdir created', fs.existsSync(path.join(sockDir, 'containers')));

    // ── Only the control listener ────────────────────────────────────────────
    check('control listener opened',  sockets.listeners.has('_control'));
    check('exactly one listener',      sockets.listeners.size === 1);
    check('no listener for foo',      !sockets.listeners.has('safebox-app-foo'));
    check('no listener for bar',      !sockets.listeners.has('safebox-app-bar'));
    check('control socket exists', fs.existsSync(path.join(sockDir, 'control.sock')));
    check('no per-container socket files',
        !fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-foo.sock'))
        && !fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-bar.sock')));
    check('control listener uses the key it was started with',
        sockets.listeners.get('_control').hmacKey.equals(key));

    // ── No key is written by this process ───────────────────────────────────
    check('operator writes no key directory', !fs.existsSync(keyDir));

    // ── Control socket is 0600 ──────────────────────────────────────────────
    const ctlMode = fs.statSync(path.join(sockDir, 'control.sock')).mode & 0o777;
    check('control socket mode is 0600', ctlMode === 0o600, 'got: 0' + ctlMode.toString(8));

    // ── pathsFor still describes the tenant layout for /containers/create ──
    const p = sockets.pathsFor('safebox-app-foo');
    check('pathsFor: socket under containers/', p.sockPath === path.join(sockDir, 'containers', 'safebox-app-foo.sock'));
    check('pathsFor: container key is system.hmac', p.keyPath === path.join(keyDir, 'safebox-app-foo', 'system.hmac'));
    check('pathsFor: instance key is instance.hmac', p.instanceKeyPath === path.join(keyDir, 'safebox-app-foo', 'instance.hmac'));
    check('in-container key path is /run/safebox/keys/system.hmac',
        sockets.KEY_PATH_IN_CONTAINER === '/run/safebox/keys/system.hmac');

    // ── reconcile after a config change opens nothing new ───────────────────
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg['safebox-app-baz'] = { imagePattern: '^baz/.*$', execContext: 'container',
        allowedActions: ['npm'], keyEpoch: 'c'.repeat(32), instanceUid: 20002 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    config.reload();
    sockets.reconcile();
    await sleep(50);
    check('reconcile: still exactly the control listener',
        sockets.listeners.size === 1 && sockets.listeners.has('_control'));
    check('reconcile: no baz socket', !fs.existsSync(path.join(sockDir, 'containers', 'safebox-app-baz.sock')));

    // ── reconcile reopens the control listener if it is gone ────────────────
    sockets.listeners.get('_control').server.close();
    sockets.listeners.delete('_control');
    sockets.reconcile();
    await sleep(50);
    check('reconcile reopens own listener', sockets.listeners.has('_control')
        && fs.existsSync(path.join(sockDir, 'control.sock')));

    // ── Shutdown closes everything ───────────────────────────────────────────
    await sockets.shutdown();
    check('all listeners closed after shutdown', sockets.listeners.size === 0);
    check('control socket file removed', !fs.existsSync(path.join(sockDir, 'control.sock')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
