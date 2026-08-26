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

'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const config = require('./config');
const { BadRequest } = require('./opsSystem');

const RING_BUFFER_BYTES = 4 * 1024 * 1024;  // 4 MiB per test
const TEST_GC_AFTER_MS = 10 * 60 * 1000;     // keep terminated tests around for 10 min
const DEFAULT_KEEPALIVE_S = 60;
const MAX_KEEPALIVE_S = 600;
const MIN_KEEPALIVE_S = 30;
const DEFAULT_MAX_LIFETIME_S = 1800;
const MAX_MAX_LIFETIME_S = 3600;
const ZFS_CLONE_PARENT = 'safebox-pool/zfs-clones';
const CLONE_MOUNT_BASE = '/srv/zfs-clones';

const RE_CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,255}$/;
const RE_ENVKEY = /^[A-Z][A-Z0-9_]{0,63}$/;
// Dataset names must be 'safebox-pool/<segment>(/<segment>)*' where each
// segment is non-empty and contains only [a-zA-Z0-9_.-]. No '.', '..', or
// empty segments. This is a tightening from the original allowlist which
// permitted '../' and '/./' substrings; zfs itself doesn't path-normalize
// these (they're literal segment characters in zfs), so they wouldn't have
// resolved to anything dangerous, but cleaner input is cleaner code.
const RE_DATASET_SEGMENT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
const RE_DATASET = /^safebox-pool\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
function validateDataset(s) {
    if (typeof s !== 'string' || !RE_DATASET.test(s)) return false;
    const parts = s.split('/');
    // First segment is the pool name. Skip it; check the rest.
    for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === '.' || seg === '..' || seg === '' || !RE_DATASET_SEGMENT.test(seg)) {
            return false;
        }
    }
    return true;
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

function newTestId() {
    return 'tst_' + crypto.randomBytes(8).toString('hex');
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
    execFile('/usr/bin/sudo', ['/usr/bin/docker', 'rm', '-f', t.dockerName],
        { timeout: 30000 }, () => {});
    // Destroy ZFS clone (best-effort, run after docker so we don't try to destroy
    // a dataset that still has a mounted FS in use)
    setTimeout(() => {
        execFile('/usr/bin/sudo', ['/usr/sbin/zfs', 'destroy', '-r', '--', t.cloneDataset],
            { timeout: 30000 }, () => {});
        if (t.sourceSnap) {
            execFile('/usr/bin/sudo', ['/usr/sbin/zfs', 'destroy', '--', t.sourceSnap],
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

// ── Promisified zfs ops ──────────────────────────────────────────────────────

function exec(bin, argv, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(bin, argv, { timeout: timeoutMs || 30000 }, (err, stdout, stderr) => {
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
    if (typeof req.container !== 'string' || !RE_CONTAINER.test(req.container)) {
        throw new BadRequest('container ref invalid');
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

    // envVars
    const envArgs = [];
    if (req.envVars !== undefined) {
        if (typeof req.envVars !== 'object' || req.envVars === null || Array.isArray(req.envVars)) {
            throw new BadRequest('envVars must be an object');
        }
        const keys = Object.keys(req.envVars);
        if (keys.length > 64) throw new BadRequest('envVars exceeds 64 entries');
        for (const k of keys) {
            if (!RE_ENVKEY.test(k)) throw new BadRequest(`envVar key '${k}' invalid`);
            const v = req.envVars[k];
            if (typeof v !== 'string') throw new BadRequest(`envVar value for ${k} must be string`);
            if (v.length > 8192) throw new BadRequest(`envVar value for ${k} exceeds 8192 chars`);
            if (/[\n\r\0]/.test(v)) throw new BadRequest(`envVar value for ${k} contains control chars`);
            envArgs.push('-e', `${k}=${v}`);
        }
    }

    // command
    let commandArgs = [];
    if (req.command !== undefined) {
        if (!Array.isArray(req.command)) throw new BadRequest('command must be an array');
        if (req.command.length > 64) throw new BadRequest('command exceeds 64 elements');
        for (const c of req.command) {
            if (typeof c !== 'string') throw new BadRequest('command elements must be strings');
            if (c.length > 4096) throw new BadRequest('command element exceeds 4096 chars');
        }
        commandArgs = req.command;
    }

    // sourceClone
    let sourceClone = null;
    if (req.sourceClone !== undefined && req.sourceClone !== null) {
        if (!validateDataset(req.sourceClone)) {
            throw new BadRequest('sourceClone invalid');
        }
        sourceClone = req.sourceClone;
    }

    const testId = newTestId();
    const cloneDataset = `${ZFS_CLONE_PARENT}/${testId}`;
    const cloneMount = `${CLONE_MOUNT_BASE}/${testId}`;
    const dockerName = `safebox-test-${testId}`;
    const sourceSnap = sourceClone ? `${sourceClone}@test-${testId}` : null;

    // Set up the clone
    try {
        if (sourceClone) {
            await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'snapshot', '--', sourceSnap]);
            try {
                await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'clone',
                    '-o', `mountpoint=${cloneMount}`, '-o', 'quota=10G',
                    '--', sourceSnap, cloneDataset]);
            } catch (e) {
                await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'destroy', '--', sourceSnap]).catch(() => {});
                throw e;
            }
        } else {
            await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'create',
                '-o', `mountpoint=${cloneMount}`, '-o', 'quota=10G',
                '--', cloneDataset]);
        }
    } catch (e) {
        return { status: 'error', code: sourceClone ? 'ZFS_CLONE_FAILED' : 'ZFS_CREATE_FAILED',
                 message: e.message.slice(0, 1024) };
    }

    // docker run (detached so we don't block; we follow logs separately)
    const dockerArgv = [
        '/usr/bin/docker', 'run', '--detach', '--name', dockerName,
        '--label', `safebox.image=${req.container}`,
        '--label', `safebox.testId=${testId}`,
        '--user', 'nobody',
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:size=64m,mode=1777',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '-v', `${cloneMount}/code:/app/code:ro`,
        '-v', `${cloneMount}/data:/app/data:rw`,
        '--memory', '2g', '--cpus', '2',
        '--stop-timeout', '5',
        ...envArgs,
        req.container,
        ...commandArgs,
    ];

    try {
        // mkdir for the volumes BEFORE docker mounts them
        await exec('/usr/bin/sudo', ['/usr/bin/mkdir', '-p', `${cloneMount}/code`, `${cloneMount}/data`]);
        await exec('/usr/bin/sudo', dockerArgv);
    } catch (e) {
        await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'destroy', '-r', '--', cloneDataset]).catch(() => {});
        if (sourceSnap) await exec('/usr/bin/sudo', ['/usr/sbin/zfs', 'destroy', '--', sourceSnap]).catch(() => {});
        return { status: 'error', code: 'DOCKER_START_FAILED', message: e.message.slice(0, 1024) };
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

    // Follow logs (streams stdout/stderr into the ring buffer)
    const logsProc = spawn('/usr/bin/sudo', ['/usr/bin/docker', 'logs', '-f', dockerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.dockerProc = logsProc;
    logsProc.stdout.on('data', (chunk) => ringPush(t, 'stdout', chunk.toString('utf8')));
    logsProc.stderr.on('data', (chunk) => ringPush(t, 'stderr', chunk.toString('utf8')));

    // Watch for container exit (separate process — docker wait blocks until exit)
    const waitProc = spawn('/usr/bin/sudo', ['/usr/bin/docker', 'wait', dockerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let waitStdout = '';
    waitProc.stdout.on('data', (chunk) => { waitStdout += chunk.toString(); });
    waitProc.on('exit', () => {
        const code = parseInt(waitStdout.trim(), 10);
        if (!Number.isNaN(code)) t.exitCode = code;
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
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    if (!t.containerRunning) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'test already terminated', _http: 404 };
    rearmKeepalive(t);
    return { status: 'ok', data: { testId, keepaliveDeadline: t.keepaliveDeadline, containerRunning: true } };
}

function handleYields(testId, since, callerIdentity) {
    const t = tests.get(testId);
    const denied = checkOwner(t, callerIdentity); if (denied) return denied;
    if (!t) return { status: 'error', code: 'TEST_NOT_FOUND', message: 'no such test', _http: 404 };
    return { status: 'ok', data: ringRead(t, since) };
}

async function handleStop(testId, callerIdentity) {
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

// Called at System component startup to clean up any test containers and
// ZFS clones left over from a previous System instance that crashed or was
// killed before it could clean up.
//
// Without this, a System restart leaves orphan docker containers running
// indefinitely with no keepalive watchdog to kill them (the watchdog state
// lives in this process's `tests` Map). Filesystem clones also accumulate.
//
// We identify our containers by the safebox.testId label, which is set by
// handleCreate at docker-run time.
async function startupCleanup() {
    const { execFile } = require('child_process');
    const util = require('util');
    const execFileP = util.promisify(execFile);
    let names = '';
    try {
        // List containers (running and stopped) with our test label
        const { stdout } = await execFileP('sudo', [
            '-n', 'docker', 'ps', '-a',
            '--filter', 'label=safebox.testId',
            '--format', '{{.Names}}',
        ], { timeout: 15000 });
        names = stdout.trim();
    } catch (e) {
        // If docker is unavailable or we can't sudo, log and continue. This
        // is best-effort — a System startup failure here would prevent the
        // whole component from coming up, which is worse than leaving
        // orphans behind.
        console.warn(`[system] startup cleanup: docker ps failed: ${e.message}`);
        return { cleaned: 0, error: e.message };
    }
    if (!names) return { cleaned: 0 };
    const containerNames = names.split('\n').filter(Boolean);
    let killed = 0;
    for (const name of containerNames) {
        try {
            await execFileP('sudo', ['-n', 'docker', 'rm', '-f', name], { timeout: 15000 });
            killed++;
        } catch (e) {
            console.warn(`[system] startup cleanup: failed to rm ${name}: ${e.message}`);
        }
    }
    console.log(`[system] startup cleanup: removed ${killed}/${containerNames.length} orphan test containers`);
    // We could also try to clean up ZFS clones here, but the clone names
    // are derived from testId which we don't have anymore. Leaving them
    // is acceptable — they'll get cleaned up by the next zfs-rollback or
    // by zfs-snapshot/clone in opsSystem if they collide.
    return { cleaned: killed };
}

module.exports = {
    handleCreate, handleKeepalive, handleYields, handleStop, handleStatus,
    shutdownAll, cleanupForContainer, startupCleanup,
    _tests: tests,
};
