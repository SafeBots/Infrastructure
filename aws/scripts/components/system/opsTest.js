// /opt/safebox/system/opsTest.js
//
// Test environment lifecycle:
//   POST /test                   → create, spawn container, return testId
//   POST /test/<id>/keepalive    → reset 60s teardown timer
//   GET  /test/<id>/yields       → ring buffer of stdout/stderr
//   POST /test/<id>/stop         → explicit teardown
//   GET  /test/<id>              → status + final metadata
//
// Default behavior: aggressive teardown. If 60s pass without a keepalive,
// the system destroys the ZFS clone, kills the container, and records
// the reason as "keepalive_timeout". Configurable per-request.
//
// Yields are NOT signed by the system — they're stdout from arbitrary
// container code. The Safebox side handles them as data, not authority.
//
// Every privileged step goes through a root-owned wrapper in /opt/safebox/bin
// (docs/HARDENING-PLAN.md, "Sudoers and wrappers"); nothing here calls docker
// or zfs directly:
//
//   safebox-zfs snapshot <ds@snap>            snapshot the source dataset
//   safebox-zfs clone    <ds@snap> <test-id>  clone to safebox-pool/clones/<id>,
//                                             mounted at /srv/zfs-clones/<id>
//   safebox-zfs destroy  <ds[@snap]> [recursive]
//   safebox-test-run     <test-id> <image-ref> /srv/zfs-clones/<test-id>
//   safebox-test-logs    <test-id>             docker logs -f
//   safebox-test-stop    <test-id>             docker rm -f
//
// The wrapper's docker run has a fixed argument list, so envVars and
// command are not supported any more (rejected with NOT_SUPPORTED), the
// clone is mounted at /workspace, and the image ref must be
// safebox-app-<x>:<tag>. There is no `docker wait` wrapper: the end of
// `docker logs -f` is the exit signal, and the exit code is not available.

'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const config = require('./config');
const { BadRequest } = require('./opsSystem');

const RING_BUFFER_BYTES = 4 * 1024 * 1024;  // 4 MiB per test
const TEST_GC_AFTER_MS = 10 * 60 * 1000;     // keep terminated tests around for 10 min
const DEFAULT_KEEPALIVE_S = 60;
const MAX_KEEPALIVE_S = 600;
const MIN_KEEPALIVE_S = 30;
const DEFAULT_MAX_LIFETIME_S = 1800;
const MAX_MAX_LIFETIME_S = 3600;
const ZFS_CLONE_PARENT = 'safebox-pool/clones';
const ZFS_TENANTS_PARENT = 'safebox-pool/tenants';
const CLONE_MOUNT_BASE = '/srv/zfs-clones';

const SUDO = '/usr/bin/sudo';
const WRAPPER_DIR = '/opt/safebox/bin';
const ZFS_WRAPPER  = WRAPPER_DIR + '/safebox-zfs';
const TEST_RUN     = WRAPPER_DIR + '/safebox-test-run';
const TEST_STOP    = WRAPPER_DIR + '/safebox-test-stop';
const TEST_LOGS    = WRAPPER_DIR + '/safebox-test-logs';

// The wrapper patterns, copied here so bad input is a 400 rather than a
// wrapper refusal. The wrappers remain the authority.
const RE_TEST_ID   = /^[a-z0-9-]{1,40}$/;
const RE_CONTAINER = /^safebox-app-[a-z0-9-]+:[a-z0-9.-]+$/;
const RE_DATASET   = /^safebox-pool\/(tenants|clones)\/[a-z0-9-]{1,40}$/;
const RE_SNAPSHOT  = /^safebox-pool\/(tenants|clones)\/[a-z0-9-]{1,40}@[a-z0-9-]{1,40}$/;

function validateDataset(s) {
    return typeof s === 'string' && RE_DATASET.test(s);
}

function assertTestId(id) {
    if (typeof id !== 'string' || !RE_TEST_ID.test(id)) {
        throw new BadRequest('testId must match ^[a-z0-9-]{1,40}$');
    }
    return id;
}

// In-memory registry of all live + recently-terminated tests
//   testId → {
//     managedContainer, container, createdAt,
//     keepaliveSeconds, keepaliveDeadline,
//     maxLifetimeSeconds, maxLifetimeDeadline,
//     containerRunning, exitCode, stoppedAt, reason,
//     cloneDataset, cloneMount, dockerName,
//     ring, ringStartOffset, totalYieldBytes,
//     dockerProc, keepaliveTimer, lifetimeTimer, gcTimer
//   }
const tests = new Map();

// Test ids are generated here, never taken from the caller, and carry the
// owning tenant's name as a prefix: <tenant>-<12 hex>. The clone dataset
// safebox-pool/clones/<test-id> therefore names its owner, which keeps
// clones attributable on the host. The wrappers cap test-ids at 40 chars,
// so a long tenant name is truncated to fit; ownership is NOT decided by
// the prefix (see ownsDataset) but by the registry below.
const TEST_ID_RANDOM_HEX = 12;
const TEST_ID_MAX = 40;

function tenantNameOf(managedContainer) {
    return String(managedContainer).replace(/^safebox-app-/, '');
}

function newTestId(managedContainer) {
    const rand = crypto.randomBytes(TEST_ID_RANDOM_HEX / 2).toString('hex');
    let prefix = tenantNameOf(managedContainer)
        .slice(0, TEST_ID_MAX - TEST_ID_RANDOM_HEX - 1)
        .replace(/-+$/, '');
    if (!RE_TEST_ID.test(prefix)) prefix = 'tst';
    return assertTestId(`${prefix}-${rand}`);
}

// A tenant may clone only from its own data: its own tenant dataset
// (safebox-pool/tenants/<tenant>, exactly) or a clone that belongs to one
// of its own live tests (safebox-pool/clones/<test-id> with the registry
// saying that test is the caller's). A prefix rule alone would not do:
// '^foo(-[a-z0-9-]+)?$' also matches tenant 'foo-bar'.
function ownsDataset(managedContainer, dataset) {
    if (dataset === `${ZFS_TENANTS_PARENT}/${tenantNameOf(managedContainer)}`) return true;
    const m = /^safebox-pool\/clones\/([a-z0-9-]{1,40})$/.exec(dataset);
    if (!m) return false;
    const t = tests.get(m[1]);
    return !!t && t.managedContainer === managedContainer && t.cloneDataset === dataset;
}

// Live tests per tenant: running ones plus those still being created (the
// create path awaits the wrappers, so two requests can race past a plain
// count of the registry).
const creating = new Map();  // managedContainer -> number in flight

function liveTestCount(managedContainer) {
    let n = creating.get(managedContainer) || 0;
    for (const t of tests.values()) {
        if (t.managedContainer === managedContainer && t.containerRunning) n++;
    }
    return n;
}

// ── Ring buffer ──────────────────────────────────────────────────────────────
// Per-test 4 MiB cap. Each yield is {stream, offset, text}. offset is the
// cumulative byte position; ringStartOffset tracks where the buffer begins.

function ringPush(t, stream, text) {
    if (!text) return;
    const entry = { stream, offset: t.totalYieldBytes, text };
    t.ring.push(entry);
    t.totalYieldBytes += Buffer.byteLength(text);
    // Trim oldest entries while ring exceeds cap
    let cumulative = 0;
    for (const e of t.ring) cumulative += Buffer.byteLength(e.text);
    while (cumulative > RING_BUFFER_BYTES && t.ring.length > 1) {
        const dropped = t.ring.shift();
        cumulative -= Buffer.byteLength(dropped.text);
        t.ringStartOffset = dropped.offset + Buffer.byteLength(dropped.text);
    }
}

function ringRead(t, sinceOffset) {
    const since = Math.max(0, sinceOffset | 0);
    const truncated = since < t.ringStartOffset;
    const out = [];
    for (const e of t.ring) {
        if (e.offset >= since) out.push(e);
    }
    return {
        yields: out,
        nextOffset: t.totalYieldBytes,
        truncated,
        containerRunning: t.containerRunning,
    };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupContainer(t, reason) {
    if (!t.containerRunning) return;
    t.containerRunning = false;
    t.stoppedAt = Math.floor(Date.now() / 1000);
    t.reason = reason;
    if (t.keepaliveTimer)  { clearTimeout(t.keepaliveTimer);  t.keepaliveTimer = null;  }
    if (t.lifetimeTimer)   { clearTimeout(t.lifetimeTimer);   t.lifetimeTimer = null;   }
    // Kill container (best-effort)
    execFile(SUDO, ['-n', TEST_STOP, t.testId],
        { timeout: 30000 }, () => {});
    // Destroy ZFS clone (best-effort, run after docker so we don't try to destroy
    // a dataset that still has a mounted FS in use)
    setTimeout(() => {
        execFile(SUDO, ['-n', ZFS_WRAPPER, 'destroy', t.cloneDataset, 'recursive'],
            { timeout: 30000 }, () => {});
        if (t.sourceSnap) {
            execFile(SUDO, ['-n', ZFS_WRAPPER, 'destroy', t.sourceSnap],
                { timeout: 30000 }, () => {});
        }
    }, 2000);
    // Schedule GC of the in-memory record
    t.gcTimer = setTimeout(() => tests.delete(t.testId), TEST_GC_AFTER_MS);
}

function rearmKeepalive(t) {
    if (t.keepaliveTimer) clearTimeout(t.keepaliveTimer);
    if (!t.containerRunning) return;
    const nowSec = Math.floor(Date.now() / 1000);
    // The keepalive deadline never extends past the absolute max-lifetime
    // deadline. A caller renewing every keepaliveSeconds will see the
    // deadline cap at maxLifetimeDeadline as that approaches, giving them
    // accurate "you have N seconds left" feedback rather than promising
    // time the lifetimeTimer will refuse to deliver.
    const wouldBe = nowSec + t.keepaliveSeconds;
    t.keepaliveDeadline = t.maxLifetimeDeadline
        ? Math.min(wouldBe, t.maxLifetimeDeadline)
        : wouldBe;
    const remainingMs = Math.max(1, (t.keepaliveDeadline - nowSec) * 1000);
    t.keepaliveTimer = setTimeout(() => cleanupContainer(t, 'keepalive_timeout'),
        remainingMs);
}

// ── Promisified wrapper invocation ───────────────────────────────────────────
// sudo -n so a misconfigured sudoers fails immediately instead of hanging on
// a password prompt. argv is an array: no shell.

function exec(bin, argv, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(bin, argv, {
            timeout: timeoutMs || 30000,
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
        }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(`${bin} ${argv.join(' ')}: ${err.message}\n${stderr || ''}`);
                e.cause = err;
                return reject(e);
            }
            resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

// ── Create ───────────────────────────────────────────────────────────────────

async function handleCreate(req) {
    // Validate envelope
    if (!req || typeof req !== 'object') throw new BadRequest('body must be a JSON object');
    if (!req.managedContainer) throw new BadRequest('managedContainer is required');
    if (!config.get(req.managedContainer)) throw new BadRequest('managedContainer not found');
    if (!config.actionAllowed(req.managedContainer, 'test')) {
        throw new BadRequest(`'test' not in allowedActions for ${req.managedContainer}`, 'FORBIDDEN_ACTION');
    }
    if (typeof req.container !== 'string' || req.container.length > 255 || !RE_CONTAINER.test(req.container)) {
        throw new BadRequest('container ref invalid (must be safebox-app-<name>:<tag>)');
    }
    if (!config.imageMatches(req.managedContainer, req.container)) {
        throw new BadRequest(`container '${req.container}' does not match imagePattern for ${req.managedContainer}`, 'IMAGE_NOT_ALLOWED');
    }

    const keepaliveSeconds = req.keepaliveSeconds === undefined ? DEFAULT_KEEPALIVE_S : req.keepaliveSeconds;
    if (!Number.isInteger(keepaliveSeconds) || keepaliveSeconds < MIN_KEEPALIVE_S || keepaliveSeconds > MAX_KEEPALIVE_S) {
        throw new BadRequest(`keepaliveSeconds must be ${MIN_KEEPALIVE_S}..${MAX_KEEPALIVE_S}`);
    }
    const maxLifetimeSeconds = req.maxLifetimeSeconds === undefined ? DEFAULT_MAX_LIFETIME_S : req.maxLifetimeSeconds;
    if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1 || maxLifetimeSeconds > MAX_MAX_LIFETIME_S) {
        throw new BadRequest(`maxLifetimeSeconds must be 1..${MAX_MAX_LIFETIME_S}`);
    }

    // envVars / command: the wrapper's docker run has a fixed argument list
    // and the image's own entrypoint runs. Refuse rather than silently drop.
    if (req.envVars !== undefined && req.envVars !== null
        && !(typeof req.envVars === 'object' && Object.keys(req.envVars).length === 0)) {
        throw new BadRequest('envVars are not supported by safebox-test-run; bake them into the image', 'NOT_SUPPORTED');
    }
    if (req.command !== undefined && req.command !== null
        && !(Array.isArray(req.command) && req.command.length === 0)) {
        throw new BadRequest('command is not supported by safebox-test-run; use the image entrypoint', 'NOT_SUPPORTED');
    }

    // sourceClone: the dataset to snapshot and clone into the test's
    // /workspace. Defaults to the caller's own tenant dataset. The wrapper
    // only allows safebox-pool/(tenants|clones)/<name>, and there is no
    // `zfs create` wrapper, so a clone always has a source.
    let sourceClone;
    if (req.sourceClone !== undefined && req.sourceClone !== null) {
        if (!validateDataset(req.sourceClone)) {
            throw new BadRequest('sourceClone invalid (must be safebox-pool/(tenants|clones)/<name>)');
        }
        if (!ownsDataset(req.managedContainer, req.sourceClone)) {
            throw new BadRequest('sourceClone must be the caller\'s own tenant dataset or a clone of one of its own live tests', 'FORBIDDEN_DATASET');
        }
        sourceClone = req.sourceClone;
    } else {
        sourceClone = `${ZFS_TENANTS_PARENT}/${tenantNameOf(req.managedContainer)}`;
        if (!validateDataset(sourceClone)) {
            throw new BadRequest('sourceClone is required: managedContainer name is not a tenant dataset name');
        }
    }

    // Per-tenant concurrency cap: each test is a ZFS clone plus a 2 GiB
    // container, so an unbounded tenant could exhaust the pool and memory
    // for everyone else.
    const cap = config.maxConcurrentTests(req.managedContainer);
    if (liveTestCount(req.managedContainer) >= cap) {
        throw new BadRequest(`at most ${cap} concurrent tests per container`, 'TEST_LIMIT');
    }

    const testId = newTestId(req.managedContainer);
    const cloneDataset = `${ZFS_CLONE_PARENT}/${testId}`;
    const cloneMount = `${CLONE_MOUNT_BASE}/${testId}`;
    const dockerName = `safebox-test-${testId}`;
    const sourceSnap = `${sourceClone}@test-${testId}`;
    if (!RE_SNAPSHOT.test(sourceSnap)) {
        throw new BadRequest('derived snapshot name is not wrapper-valid');
    }

    creating.set(req.managedContainer, (creating.get(req.managedContainer) || 0) + 1);
    try {
        // Set up the clone: snapshot, then clone. The wrapper computes the
        // mountpoint (/srv/zfs-clones/<test-id>) and creates it; no mkdir here.
        try {
            await exec(SUDO, ['-n', ZFS_WRAPPER, 'snapshot', sourceSnap]);
            try {
                await exec(SUDO, ['-n', ZFS_WRAPPER, 'clone', sourceSnap, testId]);
            } catch (e) {
                await exec(SUDO, ['-n', ZFS_WRAPPER, 'destroy', sourceSnap]).catch(() => {});
                throw e;
            }
        } catch (e) {
            return { status: 'error', code: 'ZFS_CLONE_FAILED', message: e.message.slice(0, 1024) };
        }

        // docker run through the wrapper (detached; logs are followed separately)
        try {
            await exec(SUDO, ['-n', TEST_RUN, testId, req.container, cloneMount], 120000);
        } catch (e) {
            await exec(SUDO, ['-n', ZFS_WRAPPER, 'destroy', cloneDataset, 'recursive']).catch(() => {});
            await exec(SUDO, ['-n', ZFS_WRAPPER, 'destroy', sourceSnap]).catch(() => {});
            return { status: 'error', code: 'DOCKER_START_FAILED', message: e.message.slice(0, 1024) };
        }
    } finally {
        const n = (creating.get(req.managedContainer) || 1) - 1;
        if (n > 0) creating.set(req.managedContainer, n); else creating.delete(req.managedContainer);
    }

    // Build the in-memory record
    const t = {
        testId, managedContainer: req.managedContainer, container: req.container,
        createdAt: Math.floor(Date.now() / 1000),
        keepaliveSeconds, maxLifetimeSeconds,
        keepaliveDeadline: 0, maxLifetimeDeadline: 0,
        containerRunning: true, exitCode: null, stoppedAt: null, reason: null,
        cloneDataset, cloneMount, dockerName, sourceSnap,
        ring: [], ringStartOffset: 0, totalYieldBytes: 0,
        dockerProc: null, keepaliveTimer: null, lifetimeTimer: null, gcTimer: null,
        allowlistVersion: req.allowlistVersion || '',
        tenantHint: req.tenantHint || '',
    };
    tests.set(testId, t);

    // Follow logs (streams stdout/stderr into the ring buffer). `docker logs -f`
    // ends when the container exits, which is the only exit signal available
    // through the wrappers (there is no docker wait wrapper), so its exit is
    // treated as container exit. The container's exit code is not exposed.
    // sudo's use_pty merges the container's stdout and stderr onto one pty;
    // everything arrives on stdout and is recorded as 'stdout'.
    const logsProc = spawn(SUDO, ['-n', TEST_LOGS, testId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
    });
    t.dockerProc = logsProc;
    logsProc.stdout.on('data', (chunk) => ringPush(t, 'stdout', chunk.toString('utf8')));
    logsProc.stderr.on('data', (chunk) => ringPush(t, 'stderr', chunk.toString('utf8')));
    logsProc.on('exit', () => {
        if (t.containerRunning) {
            cleanupContainer(t, 'container_exited');
        }
    });

    // Schedule keepalive + lifetime timeouts. Order matters: maxLifetimeDeadline
    // must be set before rearmKeepalive runs, so the keepalive deadline can be
    // capped against it from the very first call.
    t.maxLifetimeDeadline = Math.floor(Date.now() / 1000) + maxLifetimeSeconds;
    t.lifetimeTimer = setTimeout(() => cleanupContainer(t, 'max_lifetime'),
        maxLifetimeSeconds * 1000);
    rearmKeepalive(t);

    return {
        status: 'ok',
        data: {
            testId,
            createdAt: t.createdAt,
            keepaliveDeadline: t.keepaliveDeadline,
            maxLifetimeDeadline: t.maxLifetimeDeadline,
        },
    };
}

// ── Caller-identity check ────────────────────────────────────────────────────
// Tests are owned by the managedContainer that created them. Only that
// container's socket can keepalive, poll, stop, or query the test. We return
// TEST_NOT_FOUND on mismatch rather than a different code, so non-owners
// can't probe for the existence of other containers' tests.
function checkOwner(t, callerIdentity) {
    if (!t) return null;
    if (t.managedContainer !== callerIdentity) {
        return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    }
    return null;
}

function handleKeepalive(testId, callerIdentity) {
    if (typeof testId !== 'string' || !RE_TEST_ID.test(testId)) {
        return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    }
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    if (!t.containerRunning) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'test already terminated', _http: 404 };
    rearmKeepalive(t);
    return { status: 'ok', data: { testId, keepaliveDeadline: t.keepaliveDeadline, containerRunning: true } };
}

function handleYields(testId, since, callerIdentity) {
    if (typeof testId !== 'string' || !RE_TEST_ID.test(testId)) {
        return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    }
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    return { status: 'ok', data: ringRead(t, since) };
}

async function handleStop(testId, callerIdentity) {
    if (typeof testId !== 'string' || !RE_TEST_ID.test(testId)) {
        return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    }
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    cleanupContainer(t, 'explicit_stop');
    await new Promise(r => setTimeout(r, 500));
    return {
        status: 'ok',
        data: {
            testId, exitCode: t.exitCode, stoppedAt: t.stoppedAt, reason: t.reason,
        },
    };
}

function handleStatus(testId, callerIdentity) {
    if (typeof testId !== 'string' || !RE_TEST_ID.test(testId)) {
        return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    }
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    return {
        status: 'ok',
        data: {
            testId: t.testId,
            createdAt: t.createdAt,
            containerRunning: t.containerRunning,
            exitCode: t.exitCode,
            stoppedAt: t.stoppedAt,
            reason: t.reason,
            totalYieldBytes: t.totalYieldBytes,
            keepaliveDeadline: t.containerRunning ? t.keepaliveDeadline : null,
            maxLifetimeDeadline: t.maxLifetimeDeadline,
        },
    };
}

function shutdownAll() {
    for (const t of tests.values()) {
        if (t.containerRunning) cleanupContainer(t, 'system_shutdown');
    }
}

// Cleanup all tests owned by a given managedContainer. Called by
// /containers/destroy so a destroyed container's tests don't linger as
// orphan docker containers/ZFS clones until the keepalive watchdog fires,
// AND so a re-created container with the same name doesn't inherit them.
function cleanupForContainer(managedContainer) {
    const killed = [];
    for (const t of tests.values()) {
        if (t.managedContainer === managedContainer && t.containerRunning) {
            cleanupContainer(t, 'container_destroyed');
            killed.push(t.testId);
        }
    }
    return killed;
}

// Called at System component startup. Previously this listed containers
// with `docker ps` and removed them; there is no wrapper for `docker ps`
// and the system component no longer has docker access, so orphan test
// containers from a crashed instance are not enumerable from here. They
// are bounded by the wrapper's --pids-limit/--memory, use --network none,
// and are removed by image rotation (a reboot clears /var/lib/docker's
// running state). Kept as a no-op so server.js's startup sequence is
// unchanged.
async function startupCleanup() {
    console.log('[system] startup cleanup: no docker enumeration wrapper; orphan test containers (if any) are left to the next reboot');
    return { cleaned: 0 };
}

module.exports = {
    handleCreate, handleKeepalive, handleYields, handleStop, handleStatus,
    shutdownAll, cleanupForContainer, startupCleanup,
    _tests: tests,
    _newTestId: newTestId,
    _ownsDataset: ownsDataset,
    _liveTestCount: liveTestCount,
    RE_TEST_ID,
};
