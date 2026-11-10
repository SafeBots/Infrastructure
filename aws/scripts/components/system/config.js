// /opt/safebox/system/config.js
//
// Loads managed-containers.json at startup; reloads on SIGHUP. Provides
// query helpers for the request handlers.
//
// The file lives at /var/lib/safebox/managed-containers.json, on the
// encrypted pool (dataset safebox-pool/safebox). The root filesystem is
// read-only verity, so it cannot hold mutable state. The image ships a
// seed at /usr/lib/safebox/managed-containers.seed.json which the unit's
// ExecStartPre copies into place on first boot if the real file is absent.
//
// Roles. The operator instance reads and writes managed-containers.json
// (0640 safebox-infra). A tenant instance (SAFEBOX_TENANT=<name>) runs as
// its own uid and cannot read that file; it reads
// /var/lib/safebox/tenant-config/<name>.json instead, a one-entry copy of
// its own declaration that the operator writes (0644) on create and removes
// on destroy, and whatever that file says, only the entry named <name> is
// kept in memory. A tenant instance therefore never learns another
// tenant's declaration.
//
// managed-containers.json shape (already used by Infrastructure):
//   {
//     "<container-name>": {
//       "imagePattern":    "<regex>",
//       "allowedActions":  ["npm", "git", "test", ...],
//       "zfsVolumes":      { "<label>": "<dataset-path>", ... },
//
//       // Optional per-container execution model. Defaults preserve
//       // existing behavior (every real app container runs tools inside
//       // itself via docker exec; only "_host" runs on the host).
//       "containerName":   "<docker-name>",   // default: the key
//       "runUser":         "<inside-user>",   // default: "safebox-app"
//       "execContext":     "container"|"host" // default: "container"
//                                             // ("_host" must set "host")
//
//       // Cap on live /test environments per container (each is a ZFS
//       // clone plus a 2 GiB test container). Integer 1..64.
//       "maxConcurrentTestsPerContainer": 2   // default: 2
//     }
//   }

'use strict';

const fs = require('fs');

const TENANT = process.env.SAFEBOX_TENANT || null;
const TENANT_CONFIG_DIR = process.env.SAFEBOX_SYSTEM_TENANT_CONFIG_DIR || '/var/lib/safebox/tenant-config';
const OPERATOR_CONFIG_PATH = '/var/lib/safebox/managed-containers.json';
const CONFIG_PATH = process.env.SAFEBOX_SYSTEM_CONFIG
    || (TENANT ? require('path').join(TENANT_CONFIG_DIR, TENANT + '.json') : OPERATOR_CONFIG_PATH);

// The per-tenant file a tenant instance reads (what the operator writes
// for it on create).
function tenantConfigPath(name) {
    return require('path').join(TENANT_CONFIG_DIR, name + '.json');
}

const DEFAULT_RUN_USER = 'safebox-app';
const DEFAULT_EXEC_CONTEXT = 'container';
const HOST_PSEUDO_CONTAINER = '_host';
const DEFAULT_MAX_CONCURRENT_TESTS = 2;
const MAX_MAX_CONCURRENT_TESTS = 64;

let config = {};
let imagePatternsCompiled = {};  // containerName -> RegExp

function loadFile() {
    let raw;
    try {
        raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.warn(`[system] WARN ${CONFIG_PATH} not found; system will deny all requests`);
            return {};
        }
        throw e;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error(`[system] ERR ${CONFIG_PATH} is not valid JSON: ${e.message}`);
        // Don't replace good config with broken config on a SIGHUP-triggered reload
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error(`[system] ERR ${CONFIG_PATH} root must be an object`);
        return null;
    }
    if (TENANT) {
        // Tenant mode: whatever the file holds, this process is one tenant.
        const own = parsed[TENANT];
        if (!own || typeof own !== 'object') {
            console.warn(`[system] WARN ${CONFIG_PATH} has no entry for tenant '${TENANT}'; denying all requests`);
            return {};
        }
        return { [TENANT]: own };
    }
    return parsed;
}

function compilePatterns(cfg) {
    const out = {};
    for (const [name, entry] of Object.entries(cfg)) {
        if (entry && typeof entry.imagePattern === 'string' && entry.imagePattern.length > 0) {
            try {
                out[name] = new RegExp(entry.imagePattern);
            } catch (e) {
                console.warn(`[system] WARN bad imagePattern for ${name}: ${e.message}`);
            }
        }
    }
    return out;
}

function reload() {
    const next = loadFile();
    if (next === null) {
        console.warn('[system] reload aborted; keeping previous config');
        return;
    }
    config = next;
    imagePatternsCompiled = compilePatterns(config);
    console.log(`[system] config loaded: ${Object.keys(config).length} managed containers`);
}

function get(containerName) {
    return config[containerName] || null;
}

// Returns the entry with defaults filled in. Returns null if the container
// is not declared. Callers should use this rather than get() when they need
// containerName/runUser/execContext — get() returns the raw declaration,
// resolved() returns the declaration with defaults applied.
function resolved(containerName) {
    const entry = get(containerName);
    if (!entry) return null;
    const isHost = (containerName === HOST_PSEUDO_CONTAINER);
    return {
        // raw fields
        imagePattern:   entry.imagePattern || '',
        allowedActions: Array.isArray(entry.allowedActions) ? entry.allowedActions : [],
        zfsVolumes:     entry.zfsVolumes || {},
        // execution model (with defaults)
        containerName:  entry.containerName || containerName,
        runUser:        entry.runUser || DEFAULT_RUN_USER,
        execContext:    entry.execContext || (isHost ? 'host' : DEFAULT_EXEC_CONTEXT),
        // per-container HMAC key epoch (set by /containers/create; absent for
        // _host because _host doesn't have a per-container key — it uses master)
        keyEpoch:       entry.keyEpoch || null,
        // uid of the tenant's own system-component instance (safebox-sys-<name>,
        // 20000..29999; set by /containers/create, null for _host)
        instanceUid:    Number.isInteger(entry.instanceUid) ? entry.instanceUid : null,
        // misc passthrough
        exponentialBackoff: !!entry.exponentialBackoff,
        defaultCommands:    entry.defaultCommands || {},
        maxConcurrentTestsPerContainer: maxConcurrentTests(containerName),
    };
}

// Per-container cap on concurrent /test environments. Falls back to the
// default when the key is absent or not a sane positive integer; an
// out-of-range value is clamped rather than trusted.
function maxConcurrentTests(containerName) {
    const entry = get(containerName);
    const v = entry ? entry.maxConcurrentTestsPerContainer : undefined;
    if (!Number.isInteger(v) || v < 1) return DEFAULT_MAX_CONCURRENT_TESTS;
    return Math.min(v, MAX_MAX_CONCURRENT_TESTS);
}

function actionAllowed(containerName, action) {
    const entry = get(containerName);
    if (!entry) return false;
    const allowed = entry.allowedActions;
    return Array.isArray(allowed) && allowed.includes(action);
}

function imageMatches(containerName, imageRef) {
    const re = imagePatternsCompiled[containerName];
    if (!re) return false;
    return re.test(imageRef);
}

function zfsVolume(containerName, label) {
    const entry = get(containerName);
    if (!entry || !entry.zfsVolumes) return null;
    return entry.zfsVolumes[label] || null;
}

function installSighupReload() {
    process.on('SIGHUP', () => {
        console.log('[system] SIGHUP — reloading config');
        reload();
    });
}

module.exports = {
    reload, get, resolved, actionAllowed, imageMatches, zfsVolume, maxConcurrentTests, installSighupReload,
    // Remote inference: when falsy (default), a Safebox that doesn't have
    // a model locally will attempt to route the request to an attested
    // Safenet peer that does.  Set to true to disable this behavior.
    disableRemoteInference: !!process.env.SAFEBOX_DISABLE_REMOTE_INFERENCE,
    // exposed for tests
    DEFAULT_RUN_USER, DEFAULT_EXEC_CONTEXT, HOST_PSEUDO_CONTAINER, DEFAULT_MAX_CONCURRENT_TESTS,
    // exposed for sockets.js reconciliation
    _raw: () => config,
    CONFIG_PATH, TENANT, TENANT_CONFIG_DIR, OPERATOR_CONFIG_PATH, tenantConfigPath,
};
