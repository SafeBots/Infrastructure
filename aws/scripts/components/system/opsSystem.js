// /opt/safebox/system/opsSystem.js
//
// Synchronous tool invocation. The HTTP handler awaits the result and
// returns it in the response.
//
// Build the argv on this side, never construct a shell string. execFile
// passes argv directly to the kernel; no shell interpretation.

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const WORKSPACE_PREFIX = process.env.SAFEBOX_SYSTEM_WORKSPACE_PREFIX || '/srv/encrypted/apps/';
const DEFAULT_TIMEOUT_MS = 1800 * 1000;
const MAX_TIMEOUT_MS = 3600 * 1000;
const STDOUT_CAP = 64 * 1024;
const STDERR_CAP = 16 * 1024;

// ── argv builders, per tool ──────────────────────────────────────────────────
// Each takes (req, packages) and returns the binary + argv array.
// Validation happens BEFORE these are called.

const TOOL_BUILDERS = {
    npm: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['/usr/local/bin/npm', ['install', '--save-exact', '--ignore-scripts', '--', ...packages]];
        if (action === 'remove')   return ['/usr/local/bin/npm', ['uninstall', '--ignore-scripts', '--', ...packages]];
        if (action === 'update')   return ['/usr/local/bin/npm', ['update', '--ignore-scripts', '--', ...packages]];
        if (action === 'list')     return ['/usr/local/bin/npm', ['ls', '--json', '--depth=0']];
        if (action === 'outdated') return ['/usr/local/bin/npm', ['outdated', '--json']];
        return null;
    },
    pip: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['/usr/local/bin/pip', ['install', '--', ...packages]];
        if (action === 'update')   return ['/usr/local/bin/pip', ['install', '--upgrade', '--', ...packages]];
        if (action === 'remove')   return ['/usr/local/bin/pip', ['uninstall', '-y', '--', ...packages]];
        if (action === 'list')     return ['/usr/local/bin/pip', ['list', '--format=json']];
        if (action === 'outdated') return ['/usr/local/bin/pip', ['list', '--outdated', '--format=json']];
        return null;
    },
    cargo: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['/usr/local/bin/cargo', ['add', '--', ...packages]];
        if (action === 'remove')   return ['/usr/local/bin/cargo', ['remove', '--', ...packages]];
        if (action === 'update')   return ['/usr/local/bin/cargo', ['update', '--', ...packages]];
        if (action === 'list')     return ['/usr/local/bin/cargo', ['tree', '--depth', '1']];
        if (action === 'outdated') return ['/usr/local/bin/cargo', ['outdated', '--format', 'json']];
        return null;
    },
    gem: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['/usr/local/bin/gem', ['install',   '--', ...packages]];
        if (action === 'remove')   return ['/usr/local/bin/gem', ['uninstall', '--', ...packages]];
        if (action === 'update')   return ['/usr/local/bin/gem', ['update',    '--', ...packages]];
        if (action === 'list')     return ['/usr/local/bin/gem', ['list']];
        if (action === 'outdated') return ['/usr/local/bin/gem', ['outdated']];
        return null;
    },
    composer: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['/usr/local/bin/composer', ['require',  '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'remove')   return ['/usr/local/bin/composer', ['remove',   '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'update')   return ['/usr/local/bin/composer', ['update',   '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'list')     return ['/usr/local/bin/composer', ['show',     '--format=json']];
        if (action === 'outdated') return ['/usr/local/bin/composer', ['outdated', '--format=json']];
        return null;
    },
    dnf: (req, packages) => {
        // Privileged: run via sudo. sudoers config restricts the exact form.
        const action = req.action;
        if (action === 'install')      return ['/usr/bin/sudo', ['/usr/bin/dnf', '-y', '--setopt=install_weak_deps=False', 'install', '--', ...packages]];
        if (action === 'remove')       return ['/usr/bin/sudo', ['/usr/bin/dnf', '-y', 'remove', '--', ...packages]];
        if (action === 'update')       return ['/usr/bin/sudo', ['/usr/bin/dnf', '-y', '--setopt=install_weak_deps=False', 'upgrade']];
        if (action === 'list')         return ['/usr/bin/sudo', ['/usr/bin/dnf', 'list', 'installed']];
        if (action === 'check-update') return ['/usr/bin/sudo', ['/usr/bin/dnf', 'check-update']];
        return null;
    },
    git: (req) => {
        const action = req.action;
        const cwd = req._resolvedWorkspace;
        const base = ['/usr/bin/git', ['-C', cwd]];
        if (action === 'status')   { base[1].push('status', '--porcelain'); return base; }
        if (action === 'diff')     { base[1].push('diff', '--no-color');    return base; }
        if (action === 'log')      { base[1].push('log', '--oneline', '-n', '50'); return base; }
        if (action === 'branch')   { base[1].push('branch', '--list');      return base; }
        if (action === 'checkout') { base[1].push('checkout', req.ref);     return base; }
        if (action === 'pull')     { base[1].push('pull', '--ff-only');     return base; }
        if (action === 'add') {
            const files = Array.isArray(req.files) && req.files.length ? req.files : ['.'];
            base[1].push('add', '--', ...files);
            return base;
        }
        if (action === 'commit') {
            const author = req.author || 'safebox-system <safebox-system@localhost>';
            base[1].push('commit', '--author', author, '-m', req.message);
            return base;
        }
        if (action === 'clone') {
            // workspaceParent + url already validated; clone into ./clone
            return ['/usr/bin/git', ['clone', '--depth', '1', '--', req.url, path.join(req._resolvedWorkspace, 'clone')]];
        }
        return null;
    },
    migrate: (req) => {
        // The workspace provides its own migrate.sh runner.
        const cwd = req._resolvedWorkspace;
        const runner = path.join(cwd, 'migrate.sh');
        const args = ['bash', runner, req.action];
        if (req.target) args.push(req.target);
        return ['/usr/bin/env', args];
    },
    'zfs-snapshot': (req) => {
        // Privileged: run via sudo. sudoers config restricts the exact form.
        const snap = `${req.dataset}@${req.snapshotName}`;
        return ['/usr/bin/sudo', ['/usr/sbin/zfs', 'snapshot', '--', snap]];
    },
    'zfs-rollback': (req) => {
        const args = ['/usr/sbin/zfs', 'rollback'];
        if (req.force === true) args.push('-r');
        args.push('--', req.snapshot);
        return ['/usr/bin/sudo', args];
    },
};

// ── Validation helpers ───────────────────────────────────────────────────────

// Per-segment check for zfs dataset names. The regex above matches the shape;
// this rejects segments that are '.', '..', or empty — these are legal zfs
// segment characters but lead to confusing operations (zfs treats them as
// literal segment names; not exploitable but ugly).
function validateDatasetSegments(s) {
    const parts = s.split('/');
    for (let i = 1; i < parts.length; i++) {  // skip pool name
        const seg = parts[i];
        if (seg === '.' || seg === '..' || seg === '') return false;
    }
    return true;
}

const RE = {
    packageName: /^[a-zA-Z0-9_./@][a-zA-Z0-9_./@~^=<>!-]*$/,
    gitRef:      /^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$/,
    gitUrl:      /^(https|ssh):\/\/[^\x00-\x20<>"\\^`{|}]+$/,
    // dataset/snapshot use a segment-based check below (validateDataset). The
    // regex matches the rough shape; per-segment validation rejects '.', '..',
    // and empty segments.
    dataset:     /^safebox-pool\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/,
    snapshot:    /^safebox-pool\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*@[a-zA-Z0-9_.-]+$/,
    snapshotName:/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/,
    migrateTarget:/^[a-zA-Z0-9._-]{1,256}$/,
    // containerWorkdir: absolute path, no traversal, no shell metachars.
    // 1-255 chars, must start with /, allowed chars [a-zA-Z0-9._/-]
    containerWorkdir: /^\/[a-zA-Z0-9._/-]{0,254}$/,
};

// Which tools are per-app (container-routed) vs host-scope.
// dnf is the only host-scope tool today; the rest run inside the app container.
// zfs-snapshot/zfs-rollback/migrate already build their own `sudo ...` argv —
// they operate on host-side ZFS datasets and host-side schema runners, not
// inside a container. We do NOT wrap them in `docker exec`.
const HOST_NATIVE_TOOLS = new Set(['dnf', 'zfs-snapshot', 'zfs-rollback', 'migrate']);
const CONTAINER_TOOLS   = new Set(['npm', 'pip', 'cargo', 'gem', 'composer', 'git']);

// Default workdir inside the app container when none specified
const DEFAULT_CONTAINER_WORKDIR = '/app';

class BadRequest extends Error {
    constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

// Sanitize a containerWorkdir before it's interpolated into docker exec argv.
// Rejects anything with shell metacharacters, path traversal, or non-absolute
// paths. Returns the validated string. Throws BadRequest on invalid input.
function sanitizeWorkdir(workdir) {
    if (workdir === undefined || workdir === null || workdir === '') {
        return DEFAULT_CONTAINER_WORKDIR;
    }
    if (typeof workdir !== 'string') {
        throw new BadRequest('containerWorkdir must be a string');
    }
    if (workdir.length < 1 || workdir.length > 255) {
        throw new BadRequest('containerWorkdir length out of range');
    }
    if (!RE.containerWorkdir.test(workdir)) {
        throw new BadRequest('containerWorkdir contains invalid characters');
    }
    // Reject path traversal even though the regex would catch ".."
    // (defense in depth: belt-and-suspenders).
    if (workdir.includes('..')) {
        throw new BadRequest('containerWorkdir must not contain ".."');
    }
    return workdir;
}

function resolveWorkspace(req) {
    const ws = req.workspaceRoot;
    if (typeof ws !== 'string' || !ws) throw new BadRequest('workspaceRoot is required');
    let resolved;
    try {
        resolved = fs.realpathSync(ws);
    } catch {
        throw new BadRequest('workspaceRoot does not exist', 'WORKSPACE_NOT_FOUND');
    }
    // Must be under the standard prefix OR be a declared zfsVolume for the container
    if (resolved.startsWith(WORKSPACE_PREFIX)) return resolved;
    const entry = config.get(req.managedContainer);
    if (entry && entry.zfsVolumes) {
        for (const v of Object.values(entry.zfsVolumes)) {
            if (resolved.startsWith(v)) return resolved;
        }
    }
    throw new BadRequest('workspaceRoot must be under an allowed prefix', 'WORKSPACE_NOT_FOUND');
}

function validatePackages(arr) {
    if (!Array.isArray(arr) || arr.length === 0) throw new BadRequest('packages is required and must be non-empty');
    if (arr.length > 1000) throw new BadRequest('packages exceeds 1000 entries');
    for (const p of arr) {
        if (typeof p !== 'string' || p.length === 0 || p.length > 256) throw new BadRequest('invalid package name');
        if (!RE.packageName.test(p)) throw new BadRequest(`invalid package name: ${p}`);
    }
    return arr;
}

function validateRequest(req) {
    if (!req || typeof req !== 'object') throw new BadRequest('body must be a JSON object');
    if (!req.managedContainer || typeof req.managedContainer !== 'string') throw new BadRequest('managedContainer is required');
    if (!req.tool || typeof req.tool !== 'string') throw new BadRequest('tool is required');

    const entry = config.resolved(req.managedContainer);
    if (!entry) throw new BadRequest('managedContainer not found', 'BAD_REQUEST');
    if (!config.actionAllowed(req.managedContainer, req.tool)) {
        throw new BadRequest(`tool '${req.tool}' not in allowedActions for ${req.managedContainer}`, 'FORBIDDEN_ACTION');
    }
    if (!TOOL_BUILDERS[req.tool]) throw new BadRequest(`unknown tool: ${req.tool}`);
    if (!req.action || typeof req.action !== 'string') throw new BadRequest('action is required');

    // System-wide actions can only be invoked by the _host pseudo-container.
    // A SQL injection in safebox-app-X PHP code cannot trigger a dnf upgrade
    // that affects every other tenant on the box, because the _host channel
    // demands a different governance signature on the Safebox side.
    if (req.tool === 'dnf' && req.managedContainer !== '_host') {
        throw new BadRequest(`tool 'dnf' is host-wide and may only be invoked by managedContainer '_host'`, 'FORBIDDEN_ACTION');
    }

    // Per-container-tool requests cannot target _host (it has no container)
    if (CONTAINER_TOOLS.has(req.tool) && entry.execContext === 'host') {
        throw new BadRequest(`tool '${req.tool}' is per-app and cannot run with execContext='host'`, 'FORBIDDEN_ACTION');
    }

    const tool = req.tool;
    // Stash the resolved entry for handle() to use without re-resolving
    req._entry = entry;

    // Per-tool validation
    if (CONTAINER_TOOLS.has(tool)) {
        // Container-routed: validate containerWorkdir if present, default if not.
        // We do NOT resolve a host workspace; the work happens inside the container.
        req._containerWorkdir = sanitizeWorkdir(req.containerWorkdir);
    }
    if (tool === 'migrate') {
        // migrate stays host-side: it runs the workspace's migrate.sh from the host.
        req._resolvedWorkspace = resolveWorkspace(req);
    }
    if (['npm','pip','cargo','gem','composer'].includes(tool)) {
        if (['install','remove','update'].includes(req.action)) validatePackages(req.packages);
    }
    if (tool === 'dnf') {
        if (['install','remove'].includes(req.action)) validatePackages(req.packages);
    }
    if (tool === 'git') {
        if (req.action === 'checkout') {
            if (!req.ref || !RE.gitRef.test(req.ref)) throw new BadRequest('invalid git ref');
        }
        if (req.action === 'clone') {
            if (!req.url || !RE.gitUrl.test(req.url) || req.url.length > 2048) throw new BadRequest('invalid git url');
        }
        if (req.action === 'commit') {
            if (!req.message || typeof req.message !== 'string' || req.message.length > 5000) throw new BadRequest('invalid commit message');
            if (req.author && (req.author.length > 256 || /[\n\r\0]/.test(req.author))) throw new BadRequest('invalid author');
        }
    }
    if (tool === 'migrate') {
        if (!['run','rollback','status'].includes(req.action)) throw new BadRequest('migrate action must be run|rollback|status');
        if (req.target && !RE.migrateTarget.test(req.target)) throw new BadRequest('invalid migrate target');
    }
    if (tool === 'zfs-snapshot') {
        if (!req.dataset || !RE.dataset.test(req.dataset) || !validateDatasetSegments(req.dataset)) {
            throw new BadRequest('invalid dataset');
        }
        if (!req.snapshotName || !RE.snapshotName.test(req.snapshotName) ||
            req.snapshotName === '.' || req.snapshotName === '..') {
            throw new BadRequest('invalid snapshotName');
        }
    }
    if (tool === 'zfs-rollback') {
        if (!req.snapshot || !RE.snapshot.test(req.snapshot)) throw new BadRequest('invalid snapshot');
        // Snapshot is 'dataset@name'; validate dataset segments.
        const ds = req.snapshot.split('@', 1)[0];
        if (!validateDatasetSegments(ds)) throw new BadRequest('invalid snapshot dataset');
        if (req.force !== undefined && typeof req.force !== 'boolean') throw new BadRequest('force must be boolean');
    }

    // Optional lockfileHash for reproducibility-pinned installs
    if (req.lockfileHash !== undefined) {
        if (typeof req.lockfileHash !== 'string' || !/^[0-9a-f]{64}$/.test(req.lockfileHash)) {
            throw new BadRequest('lockfileHash must be a 64-character lowercase hex SHA-256');
        }
        if (!CONTAINER_TOOLS.has(tool) || !['install', 'update'].includes(req.action)) {
            throw new BadRequest(`lockfileHash only applies to install/update of container-routed tools`);
        }
    }
}

// ── execFile wrapper ─────────────────────────────────────────────────────────

function run(bin, argv, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const child = execFile(bin, argv, {
            cwd: cwd || '/tmp',
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: STDOUT_CAP + STDERR_CAP,
            env: {
                PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                HOME: cwd || '/tmp',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                GIT_TERMINAL_PROMPT: '0',
                GIT_ASKPASS: '/bin/true',
            },
        }, (err, stdout, stderr) => {
            const durationMs = Date.now() - startedAt;
            const stdoutStr = (stdout || '').toString().slice(0, STDOUT_CAP);
            const stderrStr = (stderr || '').toString().slice(0, STDERR_CAP);
            if (err) {
                // err.killed=true with err.signal='SIGKILL' means we hit the timeout
                if (err.killed && (err.signal === 'SIGKILL' || err.signal === 'SIGTERM')) {
                    return resolve({ returncode: 124, stdout: stdoutStr, stderr: stderrStr, durationMs, timedOut: true });
                }
                return resolve({ returncode: typeof err.code === 'number' ? err.code : 1,
                                 stdout: stdoutStr, stderr: stderrStr, durationMs, timedOut: false });
            }
            resolve({ returncode: 0, stdout: stdoutStr, stderr: stderrStr, durationMs, timedOut: false });
        });
        child.stdin.end();  // never let the child block on stdin
    });
}

// ── Lockfile-hash verification ───────────────────────────────────────────────
//
// Optional reproducibility check. After a successful install/update inside a
// container, the System component reads the project's lockfile out of the
// container, hashes it, and compares to req.lockfileHash. Mismatch means the
// dependency tree the install resolved differs from what Safebox M-of-N
// signed off on.
//
// Tool → lockfile path inside the container. The workdir prefix is supplied
// by req._containerWorkdir.

const LOCKFILE_BY_TOOL = {
    npm:      'package-lock.json',
    pip:      'requirements.lock',  // pip-tools convention
    cargo:    'Cargo.lock',
    composer: 'composer.lock',
    // gem: Gemfile.lock — gem itself doesn't always produce one; bundler does.
    //      Left off the list deliberately; if needed, add later with the
    //      Gemfile.lock path and a note that the user must be using bundler.
    // git: no lockfile concept.
};

function verifyLockfileHash(entry, req) {
    const lockfilePath = LOCKFILE_BY_TOOL[req.tool];
    if (!lockfilePath) {
        // No lockfile concept for this tool — caller shouldn't have set
        // lockfileHash, but validateRequest already rejected that case.
        // Defensive: treat absence as a NO_LOCKFILE_DEFINED error.
        return Promise.resolve({ status: 'error', code: 'NO_LOCKFILE_DEFINED',
            message: `tool '${req.tool}' has no lockfile to verify` });
    }
    const fullPath = `${req._containerWorkdir}/${lockfilePath}`;
    const dockerArgv = [
        '/usr/bin/docker', 'exec',
        '--user', entry.runUser,
        '--workdir', req._containerWorkdir,
        entry.containerName,
        '/usr/bin/cat', '--', fullPath,
    ];
    return new Promise((resolve) => {
        execFile('/usr/bin/sudo', dockerArgv, {
            timeout: 30000,
            killSignal: 'SIGKILL',
            maxBuffer: 16 * 1024 * 1024,  // lockfiles can be large
            env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
        }, (err, stdout, stderr) => {
            if (err) {
                return resolve({ status: 'error', code: 'LOCKFILE_READ_FAILED',
                    message: `could not read ${lockfilePath} from container: ${(stderr || err.message).slice(0, 256)}` });
            }
            const actual = require('crypto').createHash('sha256').update(stdout).digest('hex');
            if (actual !== req.lockfileHash) {
                return resolve({ status: 'error', code: 'LOCKFILE_HASH_MISMATCH',
                    message: `lockfile hash mismatch: expected ${req.lockfileHash}, got ${actual}` });
            }
            resolve(null);  // verified, no error to return
        });
    });
}

// ── Handler ──────────────────────────────────────────────────────────────────
//
// Routing decision:
//
//   tool      | managedContainer | how it runs
//   ----------|------------------|-----------------------------------------
//   dnf       | _host (only)     | sudo dnf ...        (host-native)
//   migrate   | any              | env bash migrate.sh (host-native, uses workspace)
//   zfs-*     | any              | sudo zfs ...        (host-native)
//   npm,pip,  | any non-_host    | sudo docker exec --user U --workdir W
//   cargo,gem,                       <container> <tool> <args>
//   composer,
//   git
//
// validateRequest has already rejected impossible combinations (dnf from
// non-_host, container-tool with execContext='host', etc.) and stashed the
// resolved entry as req._entry.

async function handle(req) {
    validateRequest(req);

    const builder = TOOL_BUILDERS[req.tool];
    const built = builder(req, req.packages || []);
    if (!built) throw new BadRequest(`action '${req.action}' not supported by ${req.tool}`);
    const [toolBin, toolArgv] = built;

    const entry = req._entry;  // already resolved with defaults

    // Decide bin+argv based on execContext for THIS tool
    let bin, argv, cwd;
    if (HOST_NATIVE_TOOLS.has(req.tool)) {
        // Host-native tool: the builder already produced the right sudo argv
        // (for dnf/zfs) or env-bash argv (for migrate). Pass through.
        bin = toolBin;
        argv = toolArgv;
        cwd = req._resolvedWorkspace || '/tmp';
    } else if (CONTAINER_TOOLS.has(req.tool)) {
        // Container-routed: wrap in `sudo docker exec --user U --workdir W <name> ...`
        bin = '/usr/bin/sudo';
        argv = [
            '/usr/bin/docker', 'exec',
            '--user',    entry.runUser,
            '--workdir', req._containerWorkdir,
            entry.containerName,
            toolBin, ...toolArgv,
        ];
        cwd = '/tmp';
    } else {
        // Shouldn't reach here — validateRequest would have rejected.
        throw new BadRequest(`tool '${req.tool}' has no execution strategy`, 'INTERNAL_ERROR');
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (req.timeoutSeconds !== undefined) {
        if (!Number.isInteger(req.timeoutSeconds) || req.timeoutSeconds < 1 || req.timeoutSeconds * 1000 > MAX_TIMEOUT_MS) {
            throw new BadRequest('timeoutSeconds out of range');
        }
        timeoutMs = req.timeoutSeconds * 1000;
    }

    const result = await run(bin, argv, cwd, timeoutMs);

    // dnf check-update returns 100 to mean "updates available" — not failure
    if (req.tool === 'dnf' && req.action === 'check-update' && result.returncode === 100) {
        result.returncode = 0;
    }

    if (result.timedOut) {
        return { status: 'error', code: 'TIMEOUT', message: `tool exceeded ${timeoutMs/1000}s` };
    }
    if (result.returncode !== 0) {
        const code = `${req.tool.toUpperCase().replace(/-/g,'_')}_OP_FAILED`;
        return {
            status: 'error',
            code,
            message: `${result.stderr.slice(0, 1024)} (rc=${result.returncode})`,
        };
    }

    // Lockfile-hash check (optional, opt-in via req.lockfileHash). Only applies
    // to install/update of container-routed tools — validateRequest enforced.
    if (req.lockfileHash) {
        const lockErr = await verifyLockfileHash(entry, req);
        if (lockErr) return lockErr;
    }

    return {
        status: 'ok',
        data: {
            tool: req.tool,
            action: req.action,
            stdout: result.stdout,
            stderr: result.stderr,
            returncode: result.returncode,
            durationMs: result.durationMs,
            lockfileVerified: !!req.lockfileHash,
        },
    };
}

module.exports = {
    handle,
    BadRequest,
    // exposed for tests
    _sanitizeWorkdir: sanitizeWorkdir,
    _validateRequest: validateRequest,
    _HOST_NATIVE_TOOLS: HOST_NATIVE_TOOLS,
    _CONTAINER_TOOLS: CONTAINER_TOOLS,
    _LOCKFILE_BY_TOOL: LOCKFILE_BY_TOOL,
    _verifyLockfileHash: verifyLockfileHash,
};
