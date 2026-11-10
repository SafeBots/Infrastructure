// /opt/safebox/system/opsSystem.js
//
// Synchronous tool invocation. The HTTP handler awaits the result and
// returns it in the response.
//
// Build the argv on this side, never construct a shell string. execFile
// passes argv directly to the kernel; no shell interpretation.
//
// Privileged operations go through the root-owned wrappers in
// /opt/safebox/bin (docs/HARDENING-PLAN.md, "Sudoers and wrappers"):
//
//   sudo /opt/safebox/bin/safebox-container exec <name> <tool> <args...>
//   sudo /opt/safebox/bin/safebox-zfs snapshot|rollback <args...>
//
// The wrappers validate every argument and add `--` before pass-through
// args themselves. dnf is not a tool any more: system packages change only
// by image rotation, and the handler answers NOT_SUPPORTED.
//
// Nothing here runs code from a tenant workspace on the host. `migrate`
// used to exec the workspace's migrate.sh as uid 990 on the host; it now
// goes through the wrapper like every other per-app tool and runs inside
// the tenant's own container (`safebox-container exec <name> migrate
// <action>`), where the wrapper fixes the script path to
// /workspace/migrate.sh. The workspace itself is never an input: it is
// implied by the socket the request arrived on (managedContainer), and a
// workspaceRoot field in the body is rejected unless it names exactly
// /srv/safebox/tenants/<managedContainer>.

'use strict';

const { execFile } = require('child_process');
const config = require('./config');

const WORKSPACE_PREFIX = process.env.SAFEBOX_SYSTEM_WORKSPACE_PREFIX || '/srv/safebox/tenants/';
const SUDO = '/usr/bin/sudo';
const CONTAINER_WRAPPER = '/opt/safebox/bin/safebox-container';
const ZFS_WRAPPER = '/opt/safebox/bin/safebox-zfs';
const NOT_SUPPORTED_MSG = 'System packages change only by image rotation; see docs/HARDENING-PLAN.md';
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
        if (action === 'install')  return ['npm', ['install', '--save-exact', '--ignore-scripts', '--', ...packages]];
        if (action === 'remove')   return ['npm', ['uninstall', '--ignore-scripts', '--', ...packages]];
        if (action === 'update')   return ['npm', ['update', '--ignore-scripts', '--', ...packages]];
        if (action === 'list')     return ['npm', ['ls', '--json', '--depth=0']];
        if (action === 'outdated') return ['npm', ['outdated', '--json']];
        return null;
    },
    pip: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['pip', ['install', '--', ...packages]];
        if (action === 'update')   return ['pip', ['install', '--upgrade', '--', ...packages]];
        if (action === 'remove')   return ['pip', ['uninstall', '-y', '--', ...packages]];
        if (action === 'list')     return ['pip', ['list', '--format=json']];
        if (action === 'outdated') return ['pip', ['list', '--outdated', '--format=json']];
        return null;
    },
    cargo: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['cargo', ['add', '--', ...packages]];
        if (action === 'remove')   return ['cargo', ['remove', '--', ...packages]];
        if (action === 'update')   return ['cargo', ['update', '--', ...packages]];
        if (action === 'list')     return ['cargo', ['tree', '--depth', '1']];
        if (action === 'outdated') return ['cargo', ['outdated', '--format', 'json']];
        return null;
    },
    gem: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['gem', ['install',   '--', ...packages]];
        if (action === 'remove')   return ['gem', ['uninstall', '--', ...packages]];
        if (action === 'update')   return ['gem', ['update',    '--', ...packages]];
        if (action === 'list')     return ['gem', ['list']];
        if (action === 'outdated') return ['gem', ['outdated']];
        return null;
    },
    composer: (req, packages) => {
        const action = req.action;
        if (action === 'install')  return ['composer', ['require',  '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'remove')   return ['composer', ['remove',   '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'update')   return ['composer', ['update',   '--no-scripts', '--no-interaction', '--', ...packages]];
        if (action === 'list')     return ['composer', ['show',     '--format=json']];
        if (action === 'outdated') return ['composer', ['outdated', '--format=json']];
        return null;
    },
    dnf: () => null,  // NOT_SUPPORTED; handled before the builder runs
    git: (req) => {
        const action = req.action;
        // Inside the container the wrapper sets --workdir /workspace, so git
        // runs in the workspace without -C. containerWorkdir is accepted for
        // validation only (see sanitizeWorkdir) and must stay under /workspace.
        const base = ['git', []];
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
            // url already validated; clone into ./clone under /workspace
            return ['git', ['clone', '--depth', '1', '--', req.url, 'clone']];
        }
        return null;
    },
    migrate: (req) => {
        // Runs INSIDE the tenant's container through the wrapper, which maps
        // the pseudo-tool `migrate` to `/bin/bash /workspace/migrate.sh
        // <action> [target]`. The host never executes the script.
        const args = [req.action];
        if (req.target) args.push(req.target);
        return ['migrate', args];
    },
    'zfs-snapshot': (req) => {
        // Privileged: via the safebox-zfs wrapper, which pins the dataset to
        // safebox-pool/(tenants|clones)/ and adds its own flags.
        const snap = `${req.dataset}@${req.snapshotName}`;
        return [SUDO, ['-n', ZFS_WRAPPER, 'snapshot', snap]];
    },
    'zfs-rollback': (req) => {
        const args = ['-n', ZFS_WRAPPER, 'rollback', req.snapshot];
        if (req.force === true) args.push('recursive');
        return [SUDO, args];
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
    // The safebox-zfs wrapper's pattern, copied here so bad input is a 400
    // rather than a wrapper refusal: safebox-pool/(tenants|clones)/<name>[@snap]
    dataset:     /^safebox-pool\/(tenants|clones)\/[a-z0-9-]{1,40}$/,
    snapshot:    /^safebox-pool\/(tenants|clones)\/[a-z0-9-]{1,40}@[a-z0-9-]{1,40}$/,
    snapshotName:/^[a-z0-9-]{1,40}$/,
    migrateTarget:/^[a-zA-Z0-9._-]{1,256}$/,
    // containerWorkdir: absolute path under /workspace, no traversal, no
    // shell metachars. 1-255 chars, allowed chars [a-zA-Z0-9._/-]. The
    // wrapper fixes --workdir /workspace; anything else is rejected here.
    containerWorkdir: /^\/workspace(\/[a-zA-Z0-9._-]+)*\/?$/,
};

// Which tools are per-app (container-routed) vs host-scope.
// zfs-snapshot/zfs-rollback build their own argv — they operate on
// host-side ZFS datasets (through the wrapper), not inside a container.
// dnf is listed only so validateRequest routes it; handle() answers
// NOT_SUPPORTED before it runs. migrate is container-routed: the wrapper
// runs /workspace/migrate.sh inside the caller's container.
const HOST_NATIVE_TOOLS = new Set(['dnf', 'zfs-snapshot', 'zfs-rollback']);
const CONTAINER_TOOLS   = new Set(['npm', 'pip', 'cargo', 'gem', 'composer', 'git', 'migrate']);
const MIGRATE_ACTIONS   = ['run', 'rollback', 'status'];

// The only workdir the wrapper runs tools in
const DEFAULT_CONTAINER_WORKDIR = '/workspace';

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
        throw new BadRequest('containerWorkdir must be /workspace or a path under it');
    }
    // Reject path traversal even though the regex would catch ".."
    // (defense in depth: belt-and-suspenders).
    if (workdir.includes('..')) {
        throw new BadRequest('containerWorkdir must not contain ".."');
    }
    // The wrapper fixes --workdir /workspace. A sub-directory is accepted
    // from callers for forward compatibility but cannot be honoured yet.
    if (workdir.replace(/\/+$/, '') !== DEFAULT_CONTAINER_WORKDIR) {
        throw new BadRequest('containerWorkdir other than /workspace is not supported', 'NOT_SUPPORTED');
    }
    return DEFAULT_CONTAINER_WORKDIR;
}

// The workspace a per-container tool acts on is the caller's own, full
// stop: /srv/safebox/tenants/<managedContainer>, which the wrapper mounts as
// /workspace inside that container. The field is optional and purely
// declarative; it is never resolved on the host (no realpath, no stat: a
// tenant-controlled path must not steer host-side filesystem access), and
// any value other than the caller's own canonical workspace is rejected.
function expectedWorkspace(managedContainer) {
    return WORKSPACE_PREFIX + managedContainer;
}

function checkWorkspaceRoot(req) {
    const ws = req.workspaceRoot;
    if (ws === undefined || ws === null) return;
    if (typeof ws !== 'string') throw new BadRequest('workspaceRoot must be a string');
    if (ws.replace(/\/+$/, '') !== expectedWorkspace(req.managedContainer)) {
        throw new BadRequest('workspaceRoot must be the caller\'s own workspace', 'FORBIDDEN_WORKSPACE');
    }
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
        checkWorkspaceRoot(req);
    }
    if (['npm','pip','cargo','gem','composer'].includes(tool)) {
        if (['install','remove','update'].includes(req.action)) validatePackages(req.packages);
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
        if (!MIGRATE_ACTIONS.includes(req.action)) throw new BadRequest('migrate action must be run|rollback|status');
        if (req.target !== undefined && req.target !== null) {
            if (typeof req.target !== 'string' || !RE.migrateTarget.test(req.target)) throw new BadRequest('invalid migrate target');
        }
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
    // Read the lockfile through the wrapper. The wrapper's tool list is
    // npm/pip/cargo/gem/composer/git only, so the file is read with
    // `git show :<path>` — which returns the INDEX copy. Callers that want
    // the hash check must `git add` the lockfile first (the install/update
    // flow does not stage it; the Safebox side runs git add before the
    // verify step). An unstaged lockfile fails closed as LOCKFILE_READ_FAILED.
    const wrapperArgv = [
        '-n', CONTAINER_WRAPPER, 'exec', entry.containerName.replace(/^safebox-app-/, ''),
        'git', 'show', ':' + lockfilePath,
    ];
    return new Promise((resolve) => {
        execFile(SUDO, wrapperArgv, {
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
//   dnf       | any              | NOT_SUPPORTED (image rotation only)
//   zfs-*     | any              | sudo safebox-zfs ...        (wrapper)
//   npm,pip,  | any non-_host    | sudo safebox-container exec <name> <tool> <args>
//   cargo,gem,                       (wrapper runs docker exec --user safebox-app
//   composer,                         --workdir /workspace safebox-app-<name> ...)
//   git,
//   migrate                          (wrapper runs /bin/bash /workspace/migrate.sh
//                                     <action> inside the container)
//
// validateRequest has already rejected impossible combinations (container
// tool with execContext='host', etc.) and stashed the resolved entry as
// req._entry.

async function handle(req) {
    // dnf is refused outright, whatever the container or action: on a verity
    // root there is nothing to install into.
    if (req && typeof req === 'object' && req.tool === 'dnf') {
        return { status: 'error', code: 'NOT_SUPPORTED', message: NOT_SUPPORTED_MSG };
    }
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
        // (for zfs). Pass through.
        bin = toolBin;
        argv = toolArgv;
        cwd = '/tmp';
    } else if (CONTAINER_TOOLS.has(req.tool)) {
        // Container-routed: `sudo safebox-container exec <name> <tool> <args...>`.
        // The wrapper adds `--user safebox-app --workdir /workspace`, maps
        // <name> to docker container safebox-app-<name>, and inserts `--`
        // before the args. The managed-container key is the name; strip a
        // legacy safebox-app- prefix from containerName if one is declared.
        const wrapperName = entry.containerName.replace(/^safebox-app-/, '');
        if (!/^[a-z0-9-]{1,40}$/.test(wrapperName)) {
            throw new BadRequest(`containerName '${entry.containerName}' is not a wrapper-valid name`, 'BAD_REQUEST');
        }
        bin = SUDO;
        argv = ['-n', CONTAINER_WRAPPER, 'exec', wrapperName, toolBin, ...toolArgv];
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
    _checkWorkspaceRoot: checkWorkspaceRoot,
    _TOOL_BUILDERS: TOOL_BUILDERS,
    _MIGRATE_ACTIONS: MIGRATE_ACTIONS,
    _HOST_NATIVE_TOOLS: HOST_NATIVE_TOOLS,
    _CONTAINER_TOOLS: CONTAINER_TOOLS,
    _LOCKFILE_BY_TOOL: LOCKFILE_BY_TOOL,
    _verifyLockfileHash: verifyLockfileHash,
    NOT_SUPPORTED_MSG,
};
