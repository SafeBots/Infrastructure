// /opt/safebox/system/opsContainers.js
//
// Container lifecycle endpoints. Reachable ONLY from the control socket
// (server.js enforces this before calling handle()).
//
//   POST /containers/create     Add a managed container declaration
//   POST /containers/destroy    Remove a managed container declaration
//   GET  /containers            List current declarations
//
// These mutate the running config and the per-container HMAC key files.
// They do NOT spawn docker containers — that's a separate responsibility
// (whoever orchestrates docker runs reads the socket path and key path
// produced by /containers/create and bind-mounts them in).
//
// Trust:
//   Adding a container expands the trust surface (a new entity that can
//   speak HMAC to the System component). Safebox is expected to apply
//   a high-quorum M-of-N policy to /containers/create requests.

'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const sockets = require('./sockets');

const CONFIG_PATH = process.env.SAFEBOX_SYSTEM_CONFIG || '/etc/safebox/managed-containers.json';

class BadRequest extends Error {
    constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

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

// ── Validators ───────────────────────────────────────────────────────────────

const ALLOWED_ACTIONS_WHITELIST = new Set([
    'start', 'stop', 'status', 'restart',
    'npm', 'pip', 'cargo', 'gem', 'composer', 'git',
    'dnf', 'test', 'migrate',
    'zfs-snapshot', 'zfs-rollback',
    'model-load', 'model-unload', 'cache-flush',
    'nginx-config', 'nginx-cert',
    'embed',  // /embed family on per-container sockets
]);

function validateCreate(body) {
    if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
    const name = body.containerName;
    if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name)) {
        throw new BadRequest('containerName must match [a-zA-Z0-9_][a-zA-Z0-9_.-]*');
    }
    if (name === '_host' || name.startsWith('_')) {
        throw new BadRequest('containerName must not start with "_" (reserved)');
    }
    if (name.length > 64) throw new BadRequest('containerName too long (>64 chars)');

    if (typeof body.imagePattern !== 'string' || body.imagePattern.length === 0 || body.imagePattern.length > 512) {
        throw new BadRequest('imagePattern is required (non-empty string ≤512 chars)');
    }
    try { new RegExp(body.imagePattern); }
    catch (e) { throw new BadRequest('imagePattern is not a valid regex: ' + e.message); }

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

    cfg[name] = {
        imagePattern:   body.imagePattern,
        containerName:  name,
        runUser:        body.runUser || 'safebox-app',
        execContext:    'container',
        allowedActions: body.allowedActions,
        keyEpoch:       keyEpoch,
    };
    if (body.zfsVolumes) cfg[name].zfsVolumes = body.zfsVolumes;
    if (body.exponentialBackoff !== undefined) cfg[name].exponentialBackoff = !!body.exponentialBackoff;
    if (body.defaultCommands) cfg[name].defaultCommands = body.defaultCommands;

    writeConfigFile(cfg);
    config.reload();
    sockets.reconcile();  // opens the new socket and writes the per-container key

    const { sockPath, keyPath } = require('./sockets').listeners.get(name) || {};
    return {
        status: 'ok',
        data: {
            containerName: name,
            socketPath:    sockPath,
            keyPath:       keyPath,
            // Bind-mount hints for whoever runs docker:
            bindMounts: {
                socket: `${sockPath}:/run/safebox/system.sock`,
                key:    `${keyPath}:/etc/safebox/system.hmac:ro`,
            },
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

    // Kill any tests owned by this container BEFORE removing the listener and
    // key. Otherwise they outlive the container declaration as orphan docker
    // containers/ZFS clones until the keepalive watchdog fires, AND a quick
    // re-create with the same name could inherit them.
    const opsTest = require('./opsTest');
    const killedTests = opsTest.cleanupForContainer(name);

    delete cfg[name];
    writeConfigFile(cfg);
    config.reload();
    sockets.reconcile();
    sockets.destroyContainerKey(name);

    return { status: 'ok', data: { containerName: name, destroyed: true, killedTests } };
}

function handleList() {
    const cfg = require('./config')._raw();
    const containers = [];
    for (const [name, entry] of Object.entries(cfg)) {
        if (name === '_host') continue;
        const listener = sockets.listeners.get(name);
        containers.push({
            containerName:  name,
            imagePattern:   entry.imagePattern,
            runUser:        entry.runUser || 'safebox-app',
            allowedActions: entry.allowedActions,
            listening:      !!listener,
            socketPath:     listener ? listener.sockPath : null,
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

module.exports = { handle, BadRequest };
