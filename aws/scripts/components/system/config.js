// /opt/safebox/system/config.js
//
// Loads managed-containers.json at startup; reloads on SIGHUP. Provides
// query helpers for the request handlers.
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
//     }
//   }

'use strict';

const fs = require('fs');

const CONFIG_PATH = process.env.SAFEBOX_SYSTEM_CONFIG || '/etc/safebox/managed-containers.json';

const DEFAULT_RUN_USER = 'safebox-app';
const DEFAULT_EXEC_CONTEXT = 'container';
const HOST_PSEUDO_CONTAINER = '_host';

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
    if (typeof parsed !== 'object' || parsed === null) {
        console.error(`[system] ERR ${CONFIG_PATH} root must be an object`);
        return null;
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
        // misc passthrough
        exponentialBackoff: !!entry.exponentialBackoff,
        defaultCommands:    entry.defaultCommands || {},
    };
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
    reload, get, resolved, actionAllowed, imageMatches, zfsVolume, installSighupReload,
    // exposed for tests
    DEFAULT_RUN_USER, DEFAULT_EXEC_CONTEXT, HOST_PSEUDO_CONTAINER,
    // exposed for sockets.js reconciliation
    _raw: () => config,
};
