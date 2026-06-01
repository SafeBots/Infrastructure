// test/testCrossContainerTestAccess.js
//
// Regression: tests created by container foo must not be accessible (poll,
// keepalive, stop, status) from container bar's socket — even if bar gets
// a hold of foo's testId. opsTest's handlers must verify the test's
// managedContainer equals the calling socket's identity, and return
// TEST_NOT_FOUND otherwise (don't leak existence to non-owners).

'use strict';

const opsTest = require('../opsTest');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const tests = opsTest._tests;
const testId = 'tst_synthetic_for_test';
tests.set(testId, {
    testId,
    managedContainer: 'safebox-app-foo',
    containerRunning: true,
    createdAt: Date.now(),
    exitCode: null,
    stoppedAt: null,
    reason: null,
    totalYieldBytes: 0,
    keepaliveDeadline: Date.now() + 60000,
    maxLifetimeDeadline: Date.now() + 1800000,
    keepaliveTimer: null,
    maxLifetimeTimer: null,
    ring: [],
    ringStartOffset: 0,
});

const r1 = opsTest.handleStatus(testId, 'safebox-app-foo');
check('owner can see status', r1.status === 'ok' && r1.data.testId === testId);

const r2 = opsTest.handleYields(testId, 0, 'safebox-app-foo');
check('owner can poll yields', r2.status === 'ok');

const r3 = opsTest.handleStatus(testId, 'safebox-app-bar');
check('non-owner gets TEST_NOT_FOUND on status',
    r3.status === 'error' && r3.code === 'TEST_NOT_FOUND');

const r4 = opsTest.handleYields(testId, 0, 'safebox-app-bar');
check('non-owner gets TEST_NOT_FOUND on yields',
    r4.status === 'error' && r4.code === 'TEST_NOT_FOUND');

const r5 = opsTest.handleKeepalive(testId, 'safebox-app-bar');
check('non-owner gets TEST_NOT_FOUND on keepalive',
    r5.status === 'error' && r5.code === 'TEST_NOT_FOUND');

const r6 = opsTest.handleStatus(testId, '_control');
check('control identity gets TEST_NOT_FOUND',
    r6.status === 'error' && r6.code === 'TEST_NOT_FOUND');

const r7 = opsTest.handleStatus(testId, undefined);
check('undefined identity gets TEST_NOT_FOUND',
    r7.status === 'error' && r7.code === 'TEST_NOT_FOUND');

const r8 = opsTest.handleStatus(testId, '');
check('empty identity gets TEST_NOT_FOUND',
    r8.status === 'error' && r8.code === 'TEST_NOT_FOUND');

(async () => {
    const r9 = await opsTest.handleStop(testId, 'safebox-app-bar');
    check('non-owner cannot stop test',
        r9.status === 'error' && r9.code === 'TEST_NOT_FOUND');

    const r10 = opsTest.handleStatus(testId, 'safebox-app-foo');
    check('after failed cross-container stop, test still owned and running',
        r10.status === 'ok' && r10.data.containerRunning === true);

    const t = tests.get(testId);
    t.containerRunning = false;
    t.stoppedAt = Date.now();
    t.reason = 'synthetic';

    const r11 = opsTest.handleStatus(testId, 'safebox-app-foo');
    check('owner status after manual stop shows not running',
        r11.status === 'ok' && r11.data.containerRunning === false);

    const r12 = opsTest.handleStatus(testId, 'safebox-app-bar');
    check('non-owner still gets TEST_NOT_FOUND after test stopped',
        r12.status === 'error' && r12.code === 'TEST_NOT_FOUND');

    const r13 = opsTest.handleStatus('tst_does_not_exist', 'safebox-app-foo');
    check('missing testId: TEST_NOT_FOUND for owner-like identity',
        r13.status === 'error' && r13.code === 'TEST_NOT_FOUND');
    const r14 = opsTest.handleStatus('tst_does_not_exist', 'safebox-app-bar');
    check('missing testId: TEST_NOT_FOUND for other identity',
        r14.status === 'error' && r14.code === 'TEST_NOT_FOUND');

    tests.delete(testId);

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
