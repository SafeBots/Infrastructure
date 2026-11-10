// test/testTestCreateOwnership.js
//
// /test create: a tenant may only clone from its own data, test ids carry
// the tenant prefix and are generated server-side, and each tenant is
// capped at maxConcurrentTestsPerContainer live tests. Nothing is exec'd:
// every rejection here happens before the first wrapper call, and the
// accepted path is checked by probing the helpers directly.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-testcreate-'));
const cfgPath = path.join(tmpDir, 'managed-containers.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    'foo':     { imagePattern: '^safebox-app-foo:', allowedActions: ['test'] },
    'foo-bar': { imagePattern: '^safebox-app-foo-bar:', allowedActions: ['test'] },
    'capped':  { imagePattern: '^safebox-app-capped:', allowedActions: ['test'], maxConcurrentTestsPerContainer: 1 },
    'silly':   { imagePattern: '^safebox-app-silly:', allowedActions: ['test'], maxConcurrentTestsPerContainer: 9999 },
    'a-very-long-tenant-name-that-is-forty-ch': { imagePattern: '^safebox-app-x:', allowedActions: ['test'] },
}));
process.env.SAFEBOX_SYSTEM_CONFIG = cfgPath;

const config = require('../config');
config.reload();
const opsTest = require('../opsTest');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function expectCode(req, code, label) {
    let got = null;
    try {
        const r = await opsTest.handleCreate(req);
        got = r && r.code;
    } catch (e) { got = e.code; }
    check(label, got === code, `got ${got}, expected ${code}`);
}

// ── config: cap defaults and clamps ──────────────────────────────────────────
check('default cap is 2', config.maxConcurrentTests('foo') === 2);
check('explicit cap honoured', config.maxConcurrentTests('capped') === 1);
check('absurd cap clamped to 64', config.maxConcurrentTests('silly') === 64);
check('unknown container gets default', config.maxConcurrentTests('nope') === config.DEFAULT_MAX_CONCURRENT_TESTS);
check('resolved() carries the cap', config.resolved('capped').maxConcurrentTestsPerContainer === 1);

// ── test ids: server-generated, tenant-prefixed, wrapper-valid ───────────────
const id1 = opsTest._newTestId('foo');
const id2 = opsTest._newTestId('foo');
check('test id is prefixed with tenant name', id1.startsWith('foo-'));
check('test ids are unique', id1 !== id2);
check('test id is wrapper-valid', opsTest.RE_TEST_ID.test(id1));
check('safebox-app- prefix stripped from tenant', opsTest._newTestId('safebox-app-foo').startsWith('foo-'));
const longId = opsTest._newTestId('a-very-long-tenant-name-that-is-forty-ch');
check('long tenant name: id still <= 40 and wrapper-valid',
    longId.length <= 40 && opsTest.RE_TEST_ID.test(longId) && longId.startsWith('a-very-long-tenant'), longId);

// ── dataset ownership ────────────────────────────────────────────────────────
const tests = opsTest._tests;
tests.set('foo-aaaaaaaaaaaa', { testId: 'foo-aaaaaaaaaaaa', managedContainer: 'foo',
    cloneDataset: 'safebox-pool/clones/foo-aaaaaaaaaaaa', containerRunning: true });
tests.set('foo-bar-bbbbbbbb', { testId: 'foo-bar-bbbbbbbb', managedContainer: 'foo-bar',
    cloneDataset: 'safebox-pool/clones/foo-bar-bbbbbbbb', containerRunning: true });

check('own tenant dataset is owned', opsTest._ownsDataset('foo', 'safebox-pool/tenants/foo'));
check('other tenant dataset is not owned', !opsTest._ownsDataset('foo', 'safebox-pool/tenants/foo-bar'));
check('prefix-sharing tenant dataset is not owned (foo vs foo-bar)',
    !opsTest._ownsDataset('foo-bar', 'safebox-pool/tenants/foo')
    && !opsTest._ownsDataset('foo', 'safebox-pool/tenants/foo-bar'));
check('own live clone is owned', opsTest._ownsDataset('foo', 'safebox-pool/clones/foo-aaaaaaaaaaaa'));
check('other tenant\'s clone is not owned, even with a matching prefix',
    !opsTest._ownsDataset('foo', 'safebox-pool/clones/foo-bar-bbbbbbbb'));
check('unknown clone is not owned', !opsTest._ownsDataset('foo', 'safebox-pool/clones/foo-cccccccccccc'));
check('snapshot form is not a dataset', !opsTest._ownsDataset('foo', 'safebox-pool/tenants/foo@snap'));

// ── handleCreate: rejections happen before any wrapper call ──────────────────
(async () => {
    await expectCode({ managedContainer: 'foo', container: 'safebox-app-foo:1',
        sourceClone: 'safebox-pool/tenants/foo-bar' },
        'FORBIDDEN_DATASET', 'reject: sourceClone of another tenant');
    await expectCode({ managedContainer: 'foo', container: 'safebox-app-foo:1',
        sourceClone: 'safebox-pool/clones/foo-bar-bbbbbbbb' },
        'FORBIDDEN_DATASET', 'reject: sourceClone clone owned by another tenant');
    await expectCode({ managedContainer: 'foo', container: 'safebox-app-foo:1',
        sourceClone: 'safebox-pool/safebox' },
        'BAD_REQUEST', 'reject: sourceClone outside tenants/clones');

    // Cap: 'foo' has 1 running test (default cap 2) -> one more allowed; the
    // accepted path would call sudo, so instead fill it to the cap and
    // check the rejection code.
    tests.set('foo-dddddddddddd', { testId: 'foo-dddddddddddd', managedContainer: 'foo',
        cloneDataset: 'safebox-pool/clones/foo-dddddddddddd', containerRunning: true });
    check('live count counts only running tests of that tenant', opsTest._liveTestCount('foo') === 2
        && opsTest._liveTestCount('foo-bar') === 1);
    await expectCode({ managedContainer: 'foo', container: 'safebox-app-foo:1' },
        'TEST_LIMIT', 'reject: tenant at its concurrent-test cap');
    tests.get('foo-dddddddddddd').containerRunning = false;
    check('terminated tests do not count toward the cap', opsTest._liveTestCount('foo') === 1);

    tests.set('capped-eeeeeeeeeeee', { testId: 'capped-eeeeeeeeeeee', managedContainer: 'capped',
        cloneDataset: 'safebox-pool/clones/capped-eeeeeeeeeeee', containerRunning: true });
    await expectCode({ managedContainer: 'capped', container: 'safebox-app-capped:1' },
        'TEST_LIMIT', 'reject: per-container cap of 1 enforced');

    tests.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
