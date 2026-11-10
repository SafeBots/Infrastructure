// test/testTenantInstance.js
//
// The system component in TENANT mode (SAFEBOX_TENANT=<name>): it reads
// exactly its own instance key, opens exactly its own socket, keeps only
// its own config entry in memory, and refuses control routes. The key file
// is laid out the way safebox-keyd lays it out.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const TENANT = 'foo';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-tenant-test-'));
const sockDir = path.join(tmpDir, 'run');
const keyDir = path.join(tmpDir, 'keys');
const tenantCfgDir = path.join(tmpDir, 'tenant-config');

process.env.NODE_ENV = 'test';
process.env.SAFEBOX_TENANT = TENANT;
process.env.SAFEBOX_SYSTEM_SOCKET_DIR = sockDir;
process.env.SAFEBOX_SYSTEM_KEYS_DIR = keyDir;
process.env.SAFEBOX_SYSTEM_TENANT_CONFIG_DIR = tenantCfgDir;
delete process.env.SAFEBOX_SYSTEM_CONFIG;
delete process.env.SAFEBOX_SYSTEM_SECRET;
process.env.SAFEBOX_GOVERNANCE_KEYS = path.join(tmpDir, 'no-governance.json');

// What the operator writes for this tenant (plus a stray extra entry, which
// must be dropped), and the keys keyd writes.
fs.mkdirSync(tenantCfgDir, { recursive: true });
fs.writeFileSync(path.join(tenantCfgDir, TENANT + '.json'), JSON.stringify({
    [TENANT]: { imagePattern: '^safebox-app-foo:', execContext: 'container',
        allowedActions: ['npm', 'test'], keyEpoch: 'a'.repeat(32), instanceUid: 20000 },
    'bar': { imagePattern: '^safebox-app-bar:', execContext: 'container',
        allowedActions: ['npm'], keyEpoch: 'b'.repeat(32), instanceUid: 20001 },
}));
const INSTANCE_KEY = Buffer.alloc(32, 0x42);
const OTHER_KEY = Buffer.alloc(32, 0x43);
fs.mkdirSync(path.join(keyDir, TENANT), { recursive: true, mode: 0o750 });
fs.writeFileSync(path.join(keyDir, TENANT, 'instance.hmac'), INSTANCE_KEY, { mode: 0o400 });
fs.writeFileSync(path.join(keyDir, TENANT, 'system.hmac'), INSTANCE_KEY, { mode: 0o440 });
fs.mkdirSync(path.join(keyDir, 'bar'), { recursive: true, mode: 0o750 });
fs.writeFileSync(path.join(keyDir, 'bar', 'instance.hmac'), OTHER_KEY, { mode: 0o400 });

const config = require('../config');
const secret = require('../secret');
const sockets = require('../sockets');
const auth = require('../auth');
const server = require('../server');
const instanceIdentity = require('../instanceIdentity');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(sockPath, method, reqPath, key, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = key ? auth.sign(key, method, reqPath, bodyStr) : {};
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(bodyStr);
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: sockPath, method, path: reqPath, headers }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* raw */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(bodyStr);
    });
}

async function run() {
    check('tenant role detected', sockets.IS_TENANT && sockets.TENANT === TENANT && server.IS_TENANT);
    check('config path is the tenant copy', config.CONFIG_PATH === path.join(tenantCfgDir, TENANT + '.json'));

    config.reload();
    check('only own entry kept in memory', Object.keys(config._raw()).join(',') === TENANT);
    check('resolved() carries instanceUid', config.resolved(TENANT).instanceUid === 20000);

    // ── Key loading ─────────────────────────────────────────────────────────
    const key = await secret.load();
    check('secret.load() returns the instance key', key.equals(INSTANCE_KEY));
    check('tenant key path is keys/<name>/instance.hmac', secret.tenantKeyPath(TENANT) === path.join(keyDir, TENANT, 'instance.hmac'));
    let threw = false;
    try { await secret.loadTenantKey('../bar'); } catch { threw = true; }
    check('loadTenantKey rejects a traversal name', threw);

    // ── Listener ────────────────────────────────────────────────────────────
    // start() is not used here (it would fork the embeddings worker), so
    // the identity the attestation route needs is initialised by hand.
    instanceIdentity.init();
    sockets.start(key, server.handleRequest);
    await sleep(50);
    check('exactly one listener, own identity', sockets.listeners.size === 1 && sockets.listeners.has(TENANT));
    check('no control listener', !sockets.listeners.has('_control') && !fs.existsSync(path.join(sockDir, 'control.sock')));
    const sockPath = path.join(sockDir, 'containers', TENANT + '.sock');
    check('own socket exists', fs.existsSync(sockPath));
    const mode = fs.statSync(sockPath).mode & 0o777;
    check('socket mode is 0660', mode === 0o660, 'got 0' + mode.toString(8));
    threw = false;
    try { sockets.reconcile(); } catch { threw = true; }
    check('reconcile is a no-op in tenant mode', !threw && sockets.listeners.size === 1);

    // ── Requests ────────────────────────────────────────────────────────────
    let r = await request(sockPath, 'GET', '/healthz', INSTANCE_KEY);
    check('healthz with own key: 200', r.status === 200 && r.json.data.identity === TENANT, JSON.stringify(r.json));
    r = await request(sockPath, 'GET', '/healthz', OTHER_KEY);
    check('healthz with another tenant key: 401', r.status === 401);
    r = await request(sockPath, 'GET', '/containers', INSTANCE_KEY);
    check('/containers on tenant socket: WRONG_SOCKET', r.status === 403 && r.json.code === 'WRONG_SOCKET', JSON.stringify(r.json));
    r = await request(sockPath, 'GET', '/models', INSTANCE_KEY);
    check('/models on tenant socket: WRONG_SOCKET', r.status === 403 && r.json.code === 'WRONG_SOCKET');
    r = await request(sockPath, 'GET', '/volumes', INSTANCE_KEY);
    check('/volumes on tenant socket: WRONG_SOCKET', r.status === 403 && r.json.code === 'WRONG_SOCKET');
    r = await request(sockPath, 'GET', '/succession/status', INSTANCE_KEY);
    check('/succession on tenant socket: WRONG_SOCKET', r.status === 403 && r.json.code === 'WRONG_SOCKET');
    r = await request(sockPath, 'POST', '/system', INSTANCE_KEY, { managedContainer: 'bar', tool: 'npm', action: 'list' });
    check('body naming another tenant: WRONG_SOCKET', r.status === 403 && r.json.code === 'WRONG_SOCKET', JSON.stringify(r.json));
    r = await request(sockPath, 'POST', '/system', INSTANCE_KEY, { tool: 'npm', action: 'list' });
    check('/system for own tenant reaches the governance gate (no registry → GOVERNANCE_UNAVAILABLE)',
        r.status === 403 && r.json.code === 'GOVERNANCE_UNAVAILABLE', JSON.stringify(r.json));
    r = await request(sockPath, 'GET', '/transparency', null);
    check('/transparency is not served by a tenant instance', r.status === 404 && r.json.code === 'NOT_SUPPORTED', JSON.stringify(r.json));
    r = await request(sockPath, 'GET', '/attestation', null);
    check('/attestation is public on the tenant socket', r.status === 200, JSON.stringify(r.json).slice(0, 200));

    await sockets.shutdown();
    check('socket removed on shutdown', !fs.existsSync(sockPath));

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
