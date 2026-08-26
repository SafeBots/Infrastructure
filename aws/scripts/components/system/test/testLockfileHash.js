// test/testLockfileHash.js
//
// Tests the lockfile-hash verification path. The real implementation
// shells out to `sudo docker exec ... cat <lockfile>` and compares the
// SHA-256 against req.lockfileHash. We mock execFile to return
// predictable bytes and verify the hash matching, mismatch handling,
// and error paths.

'use strict';

const crypto = require('crypto');
const Module = require('module');
const path = require('path');

// Mock child_process.execFile BEFORE opsSystem is loaded.
const realChildProc = require('child_process');
let mockBehavior = null;  // set by each test
const origExecFile = realChildProc.execFile;

realChildProc.execFile = function(bin, argv, opts, cb) {
    if (mockBehavior) {
        const r = mockBehavior(bin, argv, opts);
        // execFile callback signature: (err, stdout, stderr)
        process.nextTick(() => cb(r.err, r.stdout || '', r.stderr || ''));
        return { stdin: { end: () => {} } };  // fake child handle
    }
    return origExecFile.call(this, bin, argv, opts, cb);
};

const ops = require('../opsSystem');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function run() {
    // ── Happy path: lockfile content matches the declared hash ───────────────
    const goodLockfile = '{"name":"my-app","version":"1.0.0","lockfileVersion":3}\n';
    const goodHash = crypto.createHash('sha256').update(goodLockfile).digest('hex');

    mockBehavior = (bin, argv) => {
        // Verify we're calling the right binary with the right shape
        if (bin !== '/usr/bin/sudo') return { err: new Error('expected sudo'), stdout: '', stderr: 'wrong bin' };
        if (argv[0] !== '/usr/bin/docker' || argv[1] !== 'exec') {
            return { err: new Error('expected docker exec'), stdout: '', stderr: 'wrong argv' };
        }
        // Confirm --user, --workdir, then container name, then cat
        if (argv[2] !== '--user' || argv[4] !== '--workdir' || argv[7] !== '/usr/bin/cat') {
            return { err: new Error('argv shape wrong'), stdout: '', stderr: 'shape' };
        }
        return { err: null, stdout: goodLockfile, stderr: '' };
    };

    const entry = { containerName: 'safebox-app-foo', runUser: 'safebox-app' };
    const req1 = { tool: 'npm', _containerWorkdir: '/app', lockfileHash: goodHash };
    const r1 = await ops._verifyLockfileHash(entry, req1);
    check('happy path: matching hash returns null',
        r1 === null,
        'got: ' + JSON.stringify(r1));

    // ── Mismatch: bytes don't hash to the declared value ─────────────────────
    const req2 = { tool: 'npm', _containerWorkdir: '/app', lockfileHash: 'b'.repeat(64) };
    const r2 = await ops._verifyLockfileHash(entry, req2);
    check('mismatch: returns LOCKFILE_HASH_MISMATCH error',
        r2 && r2.status === 'error' && r2.code === 'LOCKFILE_HASH_MISMATCH',
        'got: ' + JSON.stringify(r2));

    // ── docker exec fails (e.g. lockfile doesn't exist) ──────────────────────
    mockBehavior = () => ({
        err: Object.assign(new Error('exit 1'), { code: 1 }),
        stdout: '',
        stderr: 'cat: package-lock.json: No such file or directory',
    });
    const req3 = { tool: 'npm', _containerWorkdir: '/app', lockfileHash: 'a'.repeat(64) };
    const r3 = await ops._verifyLockfileHash(entry, req3);
    check('missing lockfile: returns LOCKFILE_READ_FAILED',
        r3 && r3.status === 'error' && r3.code === 'LOCKFILE_READ_FAILED',
        'got: ' + JSON.stringify(r3));

    // ── Tool without a lockfile concept ──────────────────────────────────────
    const req4 = { tool: 'gem', _containerWorkdir: '/app', lockfileHash: 'a'.repeat(64) };
    const r4 = await ops._verifyLockfileHash(entry, req4);
    check('tool without lockfile mapping: NO_LOCKFILE_DEFINED',
        r4 && r4.status === 'error' && r4.code === 'NO_LOCKFILE_DEFINED',
        'got: ' + JSON.stringify(r4));

    // ── Per-tool lockfile path is correct ────────────────────────────────────
    const lockPaths = ops._LOCKFILE_BY_TOOL;
    check('npm lockfile path is package-lock.json',  lockPaths.npm === 'package-lock.json');
    check('cargo lockfile path is Cargo.lock',       lockPaths.cargo === 'Cargo.lock');
    check('composer lockfile path is composer.lock', lockPaths.composer === 'composer.lock');
    check('git is NOT a lockfile-having tool',       lockPaths.git === undefined);
    check('gem is NOT in lockfile map (bundler concern)', lockPaths.gem === undefined);

    // ── argv shape verification ──────────────────────────────────────────────
    let capturedArgv = null;
    mockBehavior = (bin, argv) => {
        capturedArgv = { bin, argv: [...argv] };
        return { err: null, stdout: goodLockfile, stderr: '' };
    };
    const req5 = { tool: 'npm', _containerWorkdir: '/srv/app/sub', lockfileHash: goodHash };
    const entry5 = { containerName: 'my-container', runUser: 'my-user' };
    await ops._verifyLockfileHash(entry5, req5);

    check('argv includes correct user',
        capturedArgv.argv[3] === 'my-user',
        'argv[3]=' + capturedArgv.argv[3]);
    check('argv includes correct workdir',
        capturedArgv.argv[5] === '/srv/app/sub',
        'argv[5]=' + capturedArgv.argv[5]);
    check('argv includes correct container',
        capturedArgv.argv[6] === 'my-container',
        'argv[6]=' + capturedArgv.argv[6]);
    check('argv ends with full lockfile path',
        capturedArgv.argv[capturedArgv.argv.length - 1] === '/srv/app/sub/package-lock.json',
        'last arg=' + capturedArgv.argv[capturedArgv.argv.length - 1]);

    // Restore
    realChildProc.execFile = origExecFile;

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
