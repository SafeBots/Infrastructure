// /opt/safebox/system/opsContainers.js
//
// Container lifecycle endpoints. Reachable ONLY from the control socket,
// which only the operator instance serves (server.js enforces this before
// calling handle()).
//
//   POST /containers/create     Add a managed container declaration
//   POST /containers/destroy    Remove a managed container declaration
//   GET  /containers            List current declarations
//
// Create, in order:
//   1. allocate an instanceUid (20000..29999, lowest free) and a keyEpoch,
//      add the entry to managed-containers.json and write the one-entry
//      copy the tenant instance reads (/var/lib/safebox/tenant-config/<name>.json);
//   2. sudo safebox-keyd-reload          keyd writes /run/safebox/keys/<name>/
//                                        (the operator never sees the key);
//   3. sudo safebox-instance start <name> root creates safebox-sys-<name> and
//                                        starts safebox-system@<name>, which
//                                        opens /run/safebox/containers/<name>.sock;
//   4. sudo safebox-container create <name> <image-ref>
//                                        docker run with the fixed argv.
// Any failure rolls the earlier steps back. Destroy runs the same steps in
// reverse. Container metadata (no keys) is kept at
// /var/lib/safebox/containers/<name>.json on the pool.
//
// At operator startup, startDeclaredInstances() runs step 3 for every
// declared container, since the instances are not enabled units and /etc
// (where their users live) is rebuilt every boot.
//
// Trust:
//   Adding a container expands the trust surface (a new entity that can
//   speak HMAC to its own system-component instance). Safebox is expected
//   to apply a high-quorum M-of-N policy to /containers/create requests.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const config = require('./config');
const sockets = require('./sockets');

const CONFIG_PATH = config.CONFIG_PATH;
const CONTAINERS_META_DIR = process.env.SAFEBOX_SYSTEM_CONTAINERS_DIR || '/var/lib/safebox/containers';
const TENANT_CONFIG_DIR = config.TENANT_CONFIG_DIR;
const CONTAINER_WRAPPER = '/opt/safebox/bin/safebox-container';
const INSTANCE_WRAPPER  = '/opt/safebox/bin/safebox-instance';
const KEYD_RELOAD_WRAPPER = '/opt/safebox/bin/safebox-keyd-reload';
const SUDO = '/usr/bin/sudo';

// Instance uids: one per tenant, fixed for the life of the declaration,
// recorded in managed-containers.json and recreated as safebox-sys-<name>
// every boot by safebox-users. The range is keyd's and safebox-users.sh's
// too; the three must agree.
const INSTANCE_UID_MIN = 20000;
const INSTANCE_UID_MAX = 29999;

class BadRequest extends Error {
    constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

// Names must satisfy the wrapper's pattern (^[a-z0-9-]{1,40}$): the wrapper
// is the authority, this is the client-side copy so a bad name is rejected
// with a 400 instead of a wrapper error.
const CONTAINER_NAME_RE = /^[a-z0-9-]{1,40}$/;
// Image refs the wrapper accepts: safebox-app-<x>:<tag>.
const IMAGE_REF_RE = /^safebox-app-[a-z0-9-]+:[a-z0-9.-]+$/;

// ── Config mutation helpers ──────────────────────────────────────────────────

function readConfigFile() {
    let raw;
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
    catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
    }
    return JSON.parse(raw);
}

function writeConfigFile(obj) {
    const tmp = CONFIG_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o640 });
    fs.renameSync(tmp, CONFIG_PATH);
}

// The one-entry copy a tenant instance reads. 0644: the instance runs as
// another uid and the declaration holds nothing secret (keyEpoch is a salt,
// the key itself is derived by keyd from the master this process does not
// have).
function writeTenantConfig(name, entry) {
    fs.mkdirSync(TENANT_CONFIG_DIR, { recursive: true, mode: 0o751 });
    const p = config.tenantConfigPath(name);
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ [name]: entry }, null, 2) + '\n', { mode: 0o644 });
    fs.renameSync(tmp, p);
}

function removeTenantConfig(name) {
    try { fs.unlinkSync(config.tenantConfigPath(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Lowest uid in the range not used by any declaration.
function allocateInstanceUid(cfg) {
    const used = new Set();
    for (const entry of Object.values(cfg)) {
        if (entry && Number.isInteger(entry.instanceUid)) used.add(entry.instanceUid);
    }
    for (let uid = INSTANCE_UID_MIN; uid <= INSTANCE_UID_MAX; uid++) {
        if (!used.has(uid)) return uid;
    }
    throw new BadRequest('no free instance uid: too many managed containers', 'TOO_MANY_CONTAINERS');
}

// ── Container metadata (no keys) under /var/lib/safebox/containers ───────────

function metaPath(name) {
    return path.join(CONTAINERS_META_DIR, name + '.json');
}

function writeMeta(name, meta) {
    fs.mkdirSync(CONTAINERS_META_DIR, { recursive: true, mode: 0o750 });
    const p = metaPath(name);
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o640 });
    fs.renameSync(tmp, p);
}

function readMeta(name) {
    try { return JSON.parse(fs.readFileSync(metaPath(name), 'utf8')); }
    catch { return null; }
}

function removeMeta(name) {
    try { fs.unlinkSync(metaPath(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// ── Wrapper invocation ───────────────────────────────────────────────────────
// execFile with an argv array: no shell, no interpolation. sudoers permits
// exactly /opt/safebox/bin/safebox-container; the wrapper validates.

function runSudo(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(SUDO, ['-n', bin, ...args], {
            timeout: timeoutMs || 120000,
            killSignal: 'SIGKILL',
            maxBuffer: 1024 * 1024,
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
        }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(`${path.basename(bin)} ${args[0] || ''} failed: ${(stderr || err.message).toString().slice(0, 1024)}`);
                e.cause = err;
                return reject(e);
            }
            resolve({ stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
        });
    });
}

function runWrapper(args, timeoutMs) { return runSudo(CONTAINER_WRAPPER, args, timeoutMs); }
function keydReload()               { return runSudo(KEYD_RELOAD_WRAPPER, [], 30000); }
function instanceStart(name)        { return runSudo(INSTANCE_WRAPPER, ['start', name], 60000); }
function instanceStop(name)         { return runSudo(INSTANCE_WRAPPER, ['stop', name], 60000); }

// ── Validators ───────────────────────────────────────────────────────────────

const ALLOWED_ACTIONS_WHITELIST = new Set([
    'start', 'stop', 'status', 'restart',
    'npm', 'pip', 'cargo', 'gem', 'composer', 'git',
    'test', 'migrate',  // 'dnf' is gone: packages change only by image rotation
    'zfs-snapshot', 'zfs-rollback',
    'model-load', 'model-unload', 'cache-flush',
    'nginx-config', 'nginx-cert',
    'embed',  // /embed family on per-container sockets
]);

function validateCreate(body) {
    if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
    const name = body.containerName;
    if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name)) {
        throw new BadRequest('containerName must match ^[a-z0-9-]{1,40}$');
    }
    if (name === '_host' || name.startsWith('_')) {
        throw new BadRequest('containerName must not start with "_" (reserved)');
    }

    if (typeof body.imagePattern !== 'string' || body.imagePattern.length === 0 || body.imagePattern.length > 512) {
        throw new BadRequest('imagePattern is required (non-empty string ≤512 chars)');
    }
    let imageRe;
    try { imageRe = new RegExp(body.imagePattern); }
    catch (e) { throw new BadRequest('imagePattern is not a valid regex: ' + e.message); }

    // imageRef is what safebox-container create runs. It must satisfy the
    // wrapper's pattern and the declared imagePattern.
    if (typeof body.imageRef !== 'string' || !IMAGE_REF_RE.test(body.imageRef) || body.imageRef.length > 255) {
        throw new BadRequest('imageRef is required and must match ^safebox-app-[a-z0-9-]+:[a-z0-9.-]+$');
    }
    if (!imageRe.test(body.imageRef)) {
        throw new BadRequest('imageRef does not match imagePattern', 'IMAGE_NOT_ALLOWED');
    }

    if (!Array.isArray(body.allowedActions) || body.allowedActions.length === 0) {
        throw new BadRequest('allowedActions must be a non-empty array');
    }
    for (const a of body.allowedActions) {
        if (typeof a !== 'string' || !ALLOWED_ACTIONS_WHITELIST.has(a)) {
            throw new BadRequest(`allowedActions contains unknown action: ${a}`);
        }
    }

    if (body.runUser !== undefined) {
        if (typeof body.runUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,32}$/.test(body.runUser)) {
            throw new BadRequest('runUser must match POSIX username format');
        }
    }
    if (body.execContext !== undefined && body.execContext !== 'container') {
        throw new BadRequest("execContext must be 'container' (or omitted); 'host' is reserved for _host");
    }
    if (body.maxConcurrentTestsPerContainer !== undefined) {
        const v = body.maxConcurrentTestsPerContainer;
        if (!Number.isInteger(v) || v < 1 || v > 64) {
            throw new BadRequest('maxConcurrentTestsPerContainer must be an integer 1..64');
        }
    }
    if (body.zfsVolumes !== undefined) {
        if (typeof body.zfsVolumes !== 'object' || body.zfsVolumes === null || Array.isArray(body.zfsVolumes)) {
            throw new BadRequest('zfsVolumes must be an object');
        }
        const labels = Object.keys(body.zfsVolumes);
        if (labels.length > 32) {
            throw new BadRequest('zfsVolumes exceeds 32 entries');
        }
        for (const label of labels) {
            if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(label)) {
                throw new BadRequest(`zfsVolumes label '${label}' invalid`);
            }
            const ds = body.zfsVolumes[label];
            // Dataset paths are slash-separated, like 'safebox/data/users'.
            // No leading slash, no '..', no whitespace, no shell metachars.
            if (typeof ds !== 'string' || ds.length === 0 || ds.length > 256) {
                throw new BadRequest(`zfsVolumes[${label}] must be a string 1-256 chars`);
            }
            if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(ds)) {
                throw new BadRequest(`zfsVolumes[${label}] '${ds}' has invalid characters`);
            }
            // Segment-level check: reject '.' and '..'
            for (const seg of ds.split('/')) {
                if (seg === '.' || seg === '..' || seg === '') {
                    throw new BadRequest(`zfsVolumes[${label}] '${ds}' has invalid segment`);
                }
            }
        }
    }

    if (body.defaultCommands !== undefined) {
        if (typeof body.defaultCommands !== 'object' || body.defaultCommands === null || Array.isArray(body.defaultCommands)) {
            throw new BadRequest('defaultCommands must be an object');
        }
        const dcKeys = Object.keys(body.defaultCommands);
        if (dcKeys.length > 32) throw new BadRequest('defaultCommands exceeds 32 entries');
        for (const k of dcKeys) {
            if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(k)) {
                throw new BadRequest(`defaultCommands key '${k}' invalid`);
            }
            const v = body.defaultCommands[k];
            // Values may be a string (single command) or an array of argv strings
            if (typeof v === 'string') {
                if (v.length > 4096) throw new BadRequest(`defaultCommands[${k}] string >4096 chars`);
            } else if (Array.isArray(v)) {
                if (v.length > 64) throw new BadRequest(`defaultCommands[${k}] array >64 entries`);
                for (const a of v) {
                    if (typeof a !== 'string' || a.length > 4096) {
                        throw new BadRequest(`defaultCommands[${k}] elements must be strings ≤4096 chars`);
                    }
                }
            } else {
                throw new BadRequest(`defaultCommands[${k}] must be a string or array of strings`);
            }
        }
    }
}

function validateDestroy(body) {
    if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
    const name = body.containerName;
    if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name)) {
        throw new BadRequest('containerName invalid');
    }
    if (name === '_host' || name.startsWith('_')) {
        throw new BadRequest('cannot destroy reserved name');
    }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleCreate(body) {
    validateCreate(body);
    const name = body.containerName;

    const cfg = readConfigFile();
    if (cfg[name]) {
        return { status: 'error', code: 'ALREADY_EXISTS',
            message: `container '${name}' already declared` };
    }

    // Generate a fresh 32-hex-char epoch for the per-container key derivation.
    // Forgotten on /containers/destroy, so re-creating with the same name
    // produces a NEW key. Compromise of an old container's key does not
    // authenticate against a freshly-created container with the same name.
    const keyEpoch = require('crypto').randomBytes(16).toString('hex');
    const instanceUid = allocateInstanceUid(cfg);

    cfg[name] = {
        imagePattern:   body.imagePattern,
        containerName:  name,
        runUser:        body.runUser || 'safebox-app',
        execContext:    'container',
        allowedActions: body.allowedActions,
        keyEpoch:       keyEpoch,
        instanceUid:    instanceUid,
    };
    if (body.zfsVolumes) cfg[name].zfsVolumes = body.zfsVolumes;
    if (body.exponentialBackoff !== undefined) cfg[name].exponentialBackoff = !!body.exponentialBackoff;
    if (body.defaultCommands) cfg[name].defaultCommands = body.defaultCommands;
    if (body.maxConcurrentTestsPerContainer !== undefined) {
        cfg[name].maxConcurrentTestsPerContainer = body.maxConcurrentTestsPerContainer;
    }

    // Order matters (see the header): declaration, then the key (keyd),
    // then the instance (which opens the socket), then the container
    // (whose wrapper refuses to start without socket and key).
    writeConfigFile(cfg);
    writeTenantConfig(name, cfg[name]);
    config.reload();

    const rollback = async (stopInstance) => {
        if (stopInstance) await instanceStop(name).catch(() => {});
        delete cfg[name];
        writeConfigFile(cfg);
        removeTenantConfig(name);
        config.reload();
        await keydReload().catch(() => {});
    };

    try {
        await keydReload();
    } catch (e) {
        await rollback(false);
        return { status: 'error', code: 'KEYD_RELOAD_FAILED', message: e.message.slice(0, 1024) };
    }
    try {
        await instanceStart(name);
    } catch (e) {
        await rollback(true);
        return { status: 'error', code: 'INSTANCE_START_FAILED', message: e.message.slice(0, 1024) };
    }
    try {
        await runWrapper(['create', name, body.imageRef]);
    } catch (e) {
        // Roll the declaration back so a wrapper refusal leaves nothing
        // half-made: no config entry, no instance, no key on tmpfs.
        await rollback(true);
        return { status: 'error', code: 'CONTAINER_CREATE_FAILED', message: e.message.slice(0, 1024) };
    }

    const { sockPath, keyPath } = sockets.pathsFor(name);
    const meta = {
        containerName: name,
        dockerName:    'safebox-app-' + name,
        imageRef:      body.imageRef,
        imagePattern:  body.imagePattern,
        createdAt:     Math.floor(Date.now() / 1000),
        socketPath:    sockPath,
        keyPath:       keyPath,   // path only; the key itself is never recorded here
        instanceUid:   instanceUid,
        instanceUnit:  `safebox-system@${name}.service`,
    };
    writeMeta(name, meta);

    return {
        status: 'ok',
        data: {
            containerName: name,
            dockerName:    meta.dockerName,
            imageRef:      body.imageRef,
            socketPath:    sockPath,
            keyPath:       keyPath,
            keyPathInContainer: sockets.KEY_PATH_IN_CONTAINER,
            instanceUid:   instanceUid,
            instanceUnit:  meta.instanceUnit,
        },
    };
}

async function handleDestroy(body) {
    validateDestroy(body);
    const name = body.containerName;

    const cfg = readConfigFile();
    if (!cfg[name]) {
        return { status: 'error', code: 'NOT_FOUND',
            message: `container '${name}' not declared` };
    }

    // Stop the tenant's instance first: its shutdown path tears down the
    // tests it owns (opsTest.shutdownAll in that process), and its socket
    // goes with it. Then forget the declaration, let keyd drop the key, and
    // remove the docker container.
    let instanceStopped = true;
    let instanceError = null;
    try { await instanceStop(name); }
    catch (e) { instanceStopped = false; instanceError = e.message.slice(0, 512); }

    delete cfg[name];
    writeConfigFile(cfg);
    removeTenantConfig(name);
    config.reload();
    let keyRemoved = true;
    try { await keydReload(); } catch { keyRemoved = false; }

    let containerRemoved = true;
    let wrapperError = null;
    try {
        await runWrapper(['destroy', name]);
    } catch (e) {
        // The declaration and key are already gone; report the docker side
        // separately so the caller can retry it.
        containerRemoved = false;
        wrapperError = e.message.slice(0, 512);
    }
    removeMeta(name);

    return { status: 'ok', data: { containerName: name, destroyed: true, instanceStopped, instanceError, keyRemoved, containerRemoved, wrapperError } };
}

// Operator startup: bring up one instance per declared container. Each
// failure is logged and the next one is tried; a tenant whose instance
// will not start is unreachable until the next create/destroy or restart,
// not a reason to keep every other tenant down.
async function startDeclaredInstances() {
    const cfg = config._raw();
    const started = [];
    const failed = [];
    for (const [name, entry] of Object.entries(cfg)) {
        if (name.startsWith('_') || !entry || entry.execContext === 'host') continue;
        if (!CONTAINER_NAME_RE.test(name) || !Number.isInteger(entry.instanceUid)) {
            console.warn(`[system] WARN not starting instance for '${name}': no instanceUid (re-create it through /containers/create)`);
            continue;
        }
        try {
            // Keep the tenant copy current in case the operator's file was
            // edited by hand or restored from an older pool.
            writeTenantConfig(name, entry);
            await instanceStart(name);
            started.push(name);
        } catch (e) {
            console.error(`[system] ERR instance for '${name}' did not start: ${e.message}`);
            failed.push(name);
        }
    }
    return { started, failed };
}

function handleList() {
    const cfg = require('./config')._raw();
    const containers = [];
    for (const [name, entry] of Object.entries(cfg)) {
        if (name === '_host') continue;
        const meta = readMeta(name);
        const { sockPath } = sockets.pathsFor(name);
        // The socket belongs to the tenant's own instance; "listening" here
        // means its socket file is present in the shared directory.
        let listening = false;
        try { listening = fs.statSync(sockPath).isSocket(); } catch { /* absent */ }
        containers.push({
            containerName:  name,
            imagePattern:   entry.imagePattern,
            imageRef:       meta ? meta.imageRef : null,
            createdAt:      meta ? meta.createdAt : null,
            runUser:        entry.runUser || 'safebox-app',
            allowedActions: entry.allowedActions,
            instanceUid:    Number.isInteger(entry.instanceUid) ? entry.instanceUid : null,
            instanceUnit:   `safebox-system@${name}.service`,
            listening,
            socketPath:     listening ? sockPath : null,
        });
    }
    return { status: 'ok', data: { containers } };
}

// ── Router ───────────────────────────────────────────────────────────────────

async function handle(method, pathname, body) {
    if (method === 'POST' && pathname === '/containers/create')  return await handleCreate(body);
    if (method === 'POST' && pathname === '/containers/destroy') return await handleDestroy(body);
    if (method === 'GET'  && pathname === '/containers')         return handleList();
    return { status: 'error', code: 'NOT_FOUND',
        message: 'no such /containers endpoint', _http: 404 };
}

module.exports = {
    handle, startDeclaredInstances, BadRequest, CONTAINERS_META_DIR,
    INSTANCE_UID_MIN, INSTANCE_UID_MAX,
    _runWrapper: runWrapper, _allocateInstanceUid: allocateInstanceUid,
    _writeTenantConfig: writeTenantConfig, _removeTenantConfig: removeTenantConfig,
};
