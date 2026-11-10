// test/testInstanceUid.js
//
// opsContainers (operator): instance uid allocation and the one-entry
// tenant config copy. /containers/create itself needs keyd, systemd and
// docker through the wrappers and is exercised on a box, not here.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-uid-test-'));
process.env.NODE_ENV = 'test';
delete process.env.SAFEBOX_TENANT;
process.env.SAFEBOX_SYSTEM_CONFIG = path.join(tmpDir, 'managed-containers.json');
process.env.SAFEBOX_SYSTEM_TENANT_CONFIG_DIR = path.join(tmpDir, 'tenant-config');
process.env.SAFEBOX_SYSTEM_CONTAINERS_DIR = path.join(tmpDir, 'containers');
process.env.SAFEBOX_SYSTEM_SOCKET_DIR = path.join(tmpDir, 'run');
fs.writeFileSync(process.env.SAFEBOX_SYSTEM_CONFIG, '{}');

const config = require('../config');
const opsContainers = require('../opsContainers');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const alloc = opsContainers._allocateInstanceUid;
check('range starts at 20000', opsContainers.INSTANCE_UID_MIN === 20000 && opsContainers.INSTANCE_UID_MAX === 29999);
check('empty config → 20000', alloc({}) === 20000);
check('_host ignored, lowest free chosen', alloc({ _host: {}, a: { instanceUid: 20000 }, b: { instanceUid: 20002 } }) === 20001);
check('gap after destroy is reused', alloc({ a: { instanceUid: 20001 } }) === 20000);
check('entries without instanceUid do not reserve one', alloc({ a: {}, b: { instanceUid: 20000 } }) === 20001);
const full = {};
for (let u = 20000; u <= 29999; u++) full['t' + u] = { instanceUid: u };
let threw = null;
try { alloc(full); } catch (e) { threw = e; }
check('exhausted range → TOO_MANY_CONTAINERS', threw && threw.code === 'TOO_MANY_CONTAINERS');

// Tenant config copy
const entry = { imagePattern: '^safebox-app-foo:', allowedActions: ['npm'], keyEpoch: 'a'.repeat(32), instanceUid: 20000 };
opsContainers._writeTenantConfig('foo', entry);
const p = config.tenantConfigPath('foo');
check('tenant config written at tenant-config/<name>.json', p === path.join(process.env.SAFEBOX_SYSTEM_TENANT_CONFIG_DIR, 'foo.json') && fs.existsSync(p));
check('tenant config is world-readable (0644)', (fs.statSync(p).mode & 0o777) === 0o644);
check('tenant config dir is 0751', (fs.statSync(path.dirname(p)).mode & 0o777) === 0o751);
const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
check('tenant config holds exactly the one entry', Object.keys(parsed).join(',') === 'foo' && parsed.foo.instanceUid === 20000);
check('no temp file left', fs.readdirSync(path.dirname(p)).join(',') === 'foo.json');
opsContainers._removeTenantConfig('foo');
check('tenant config removed', !fs.existsSync(p));
opsContainers._removeTenantConfig('foo');
check('removing twice is fine', true);

// Operator config path is the shared file; a tenant would get its own.
check('operator reads managed-containers.json', config.CONFIG_PATH === process.env.SAFEBOX_SYSTEM_CONFIG && config.TENANT === null);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
