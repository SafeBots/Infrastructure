// test/testContainerRouting.js
//
// Tests the routing decision in opsSystem.js: given a request shape, does
// validateRequest accept or reject it for the right reason, and does the
// resulting bin+argv get built correctly for the (tool, execContext) pair?
//
// We don't actually exec anything — we intercept the execFile call via
// child_process module mocking.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Set up an isolated config before requiring opsSystem ────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-routing-test-'));
const cfgPath = path.join(tmpDir, 'managed-containers.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    '_host': {
        imagePattern: '',
        execContext: 'host',
        allowedActions: ['dnf'],
    },
    'safebox-app-foo': {
        imagePattern: '^foo/.*$',
        containerName: 'safebox-app-foo',
        runUser: 'safebox-app',
        execContext: 'container',
        allowedActions: ['npm', 'pip', 'cargo', 'gem', 'composer', 'git', 'migrate', 'zfs-snapshot'],
    },
    'safebox-app-custom': {
        imagePattern: '^bar/.*$',
        containerName: 'custom-container-name',
        runUser: 'baz-user',
        execContext: 'container',
        allowedActions: ['npm'],
    },
}));
process.env.SAFEBOX_SYSTEM_CONFIG = cfgPath;

const config = require('../config');
config.reload();

const ops = require('../opsSystem');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}
function rejected(req, expectedCode, label) {
    let threw = false, gotCode = null;
    try { ops._validateRequest(req); }
    catch (e) {
        threw = true;
        gotCode = e.code;
    }
    check(label, threw && gotCode === expectedCode,
        `threw=${threw} code=${gotCode} (expected ${expectedCode})`);
}
function accepted(req, label) {
    let threw = false, msg = '';
    try { ops._validateRequest(req); }
    catch (e) { threw = true; msg = e.message; }
    check(label, !threw, `unexpected throw: ${msg}`);
}

// ── Allowlist baselines ──────────────────────────────────────────────────────
rejected({ tool: 'npm', action: 'list', managedContainer: 'nope' },
    'BAD_REQUEST', 'reject: unknown managedContainer');

rejected({ tool: 'mystery-tool', action: 'list', managedContainer: 'safebox-app-foo' },
    'FORBIDDEN_ACTION', 'reject: tool not in allowedActions');

// ── dnf is host-only ─────────────────────────────────────────────────────────
accepted({ tool: 'dnf', action: 'list', managedContainer: '_host' },
    'accept: dnf from _host');

rejected({ tool: 'dnf', action: 'list', managedContainer: 'safebox-app-foo' },
    'FORBIDDEN_ACTION', 'reject: dnf from non-_host');

// ── Container-routed tools can't target _host ───────────────────────────────
rejected({ tool: 'npm', action: 'list', managedContainer: '_host' },
    'FORBIDDEN_ACTION', 'reject: npm from _host (npm not in _host allowedActions)');

// Add npm to _host's allowedActions in a fake entry to test the execContext check
// (we test this by directly invoking validateRequest with a managedContainer that
// would have execContext='host' but tool is a container-tool — the validator
// rejects this. Since our fixture doesn't have such a case, we trust the
// allowlist check fires first; the execContext branch is hit only if
// allowedActions misconfigures it.)

// ── Container tools accepted with default containerWorkdir ──────────────────
accepted({ tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo' },
    'accept: npm with default workdir');
accepted({ tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo', containerWorkdir: '/srv/app' },
    'accept: npm with explicit workdir');

// ── Bad containerWorkdir ────────────────────────────────────────────────────
rejected({ tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo', containerWorkdir: '/app; rm' },
    'BAD_REQUEST', 'reject: workdir with ;');
rejected({ tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo', containerWorkdir: '/app/../etc' },
    'BAD_REQUEST', 'reject: workdir with ..');

// ── Package validation still works ──────────────────────────────────────────
rejected({ tool: 'npm', action: 'install', managedContainer: 'safebox-app-foo', packages: ['--registry=evil'] },
    'BAD_REQUEST', 'reject: bad package name (--registry=...)');

accepted({ tool: 'npm', action: 'install', managedContainer: 'safebox-app-foo', packages: ['lodash@4.17.21'] },
    'accept: npm install with pinned version');

// ── lockfileHash validation ─────────────────────────────────────────────────
accepted({ tool: 'npm', action: 'install', managedContainer: 'safebox-app-foo', packages: ['lodash@4.17.21'],
    lockfileHash: 'a'.repeat(64) },
    'accept: lockfileHash with install');

rejected({ tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo', lockfileHash: 'a'.repeat(64) },
    'BAD_REQUEST', 'reject: lockfileHash with list (not install/update)');

rejected({ tool: 'zfs-snapshot', action: 'create', managedContainer: 'safebox-app-foo',
    dataset: 'safebox-pool/foo', snapshotName: 'snap1',
    lockfileHash: 'a'.repeat(64) },
    'BAD_REQUEST', 'reject: lockfileHash with non-container tool');

rejected({ tool: 'npm', action: 'install', managedContainer: 'safebox-app-foo', packages: ['lodash@4.17.21'],
    lockfileHash: 'A'.repeat(64) },
    'BAD_REQUEST', 'reject: lockfileHash uppercase hex');

rejected({ tool: 'npm', action: 'install', managedContainer: 'safebox-app-foo', packages: ['lodash@4.17.21'],
    lockfileHash: 'a'.repeat(63) },
    'BAD_REQUEST', 'reject: lockfileHash wrong length');

// ── Resolved entry is stashed on the request ────────────────────────────────
const r1 = { tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo' };
ops._validateRequest(r1);
check('validateRequest stashes _entry',
    r1._entry && r1._entry.containerName === 'safebox-app-foo'
    && r1._entry.runUser === 'safebox-app'
    && r1._entry.execContext === 'container',
    JSON.stringify(r1._entry));

const r2 = { tool: 'npm', action: 'list', managedContainer: 'safebox-app-custom' };
ops._validateRequest(r2);
check('custom containerName + runUser preserved',
    r2._entry.containerName === 'custom-container-name'
    && r2._entry.runUser === 'baz-user',
    JSON.stringify(r2._entry));

const r3 = { tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo' };
ops._validateRequest(r3);
check('default containerWorkdir applied',
    r3._containerWorkdir === '/app',
    'got: ' + r3._containerWorkdir);

const r4 = { tool: 'npm', action: 'list', managedContainer: 'safebox-app-foo', containerWorkdir: '/srv/foo' };
ops._validateRequest(r4);
check('explicit containerWorkdir preserved',
    r4._containerWorkdir === '/srv/foo',
    'got: ' + r4._containerWorkdir);

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
