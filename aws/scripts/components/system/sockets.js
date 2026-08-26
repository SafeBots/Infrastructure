// /opt/safebox/system/sockets.js
//
// Manages the per-container Unix domain sockets the System component listens
// on. Replaces the single 127.0.0.1:7780 TCP listener with one socket per
// managed container plus one control socket for host-scope operations.
//
// Why per-container sockets:
//
//   The socket file at /run/safebox/containers/<name>.sock is bind-mounted
//   into ONLY that container at /run/safebox/system.sock. The container's
//   Safebox Node connects to a standard path; the host knows which
//   container is calling because each container has its own distinct
//   socket. Container identity is enforced by the kernel via the
//   filesystem topology — not trusted from the request body.
//
//   The control socket at /run/safebox/control.sock is NOT bind-mounted
//   into any container. It's reachable only from the host (mode 0660,
//   owner safebox-infra, group safebox-infra). It handles _host-scope
//   operations: dnf, /models, /containers (create/destroy).
//
// Identity model:
//
//   - Connection on /run/safebox/containers/<name>.sock
//       → request authenticated against per-container HMAC key for <name>
//       → managedContainer in request body MUST equal <name> (or be absent)
//   - Connection on /run/safebox/control.sock
//       → request authenticated against the master HMAC key
//       → managedContainer in request body MUST be '_host' (or absent for /containers)
//
// Lifecycle:
//
//   At startup, this module reads managed-containers.json, opens one
//   listener per declared container, and the control socket. On SIGHUP,
//   it closes listeners for removed containers and opens listeners for
//   new ones. Each listener calls the supplied requestHandler with
//   { socketIdentity } populated, so the request handler knows which
//   container (or '_host') is calling.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const config = require('./config');
const secret = require('./secret');

const SOCKET_DIR        = process.env.SAFEBOX_SYSTEM_SOCKET_DIR || '/run/safebox';
const CONTAINER_SOCKDIR = path.join(SOCKET_DIR, 'containers');
const CONTROL_SOCKET    = path.join(SOCKET_DIR, 'control.sock');
const KEY_DIR           = process.env.SAFEBOX_SYSTEM_KEY_DIR || '/etc/safebox/containers';

// Identity sentinel for the control socket. Not a real container name.
const CONTROL_IDENTITY = '_control';

// Active listeners: socketIdentity -> { server, sockPath, keyPath, hmacKey }
const listeners = new Map();

// The master HMAC key (set by start()). Used for the control socket and
// for deriving per-container keys.
let masterKey = null;

// The request handler to call for every parsed request. Wired by start().
let requestHandler = null;

// ── Filesystem setup ─────────────────────────────────────────────────────────

function ensureDirs() {
    fs.mkdirSync(SOCKET_DIR,        { recursive: true, mode: 0o750 });
    fs.mkdirSync(CONTAINER_SOCKDIR, { recursive: true, mode: 0o750 });
    fs.mkdirSync(KEY_DIR,           { recursive: true, mode: 0o750 });
}

function pathsFor(socketIdentity) {
    if (socketIdentity === CONTROL_IDENTITY) {
        return { sockPath: CONTROL_SOCKET, keyPath: null /* control uses master */ };
    }
    return {
        sockPath: path.join(CONTAINER_SOCKDIR, socketIdentity + '.sock'),
        keyPath:  path.join(KEY_DIR,           socketIdentity + '.hmac'),
    };
}

// Write the per-container HMAC key file atomically. We chmod explicitly
// after rename because umask is applied to the mode arg of writeFileSync,
// so the explicit chmod ensures we get 0640 regardless of the umask.
function writeContainerKey(keyPath, key) {
    const tmp = keyPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, key, { mode: 0o640 });
    fs.chmodSync(tmp, 0o640);
    fs.renameSync(tmp, keyPath);
    fs.chmodSync(keyPath, 0o640);
}

// ── Listener lifecycle ───────────────────────────────────────────────────────

function openListener(socketIdentity) {
    if (listeners.has(socketIdentity)) {
        return;  // already listening
    }

    const { sockPath, keyPath } = pathsFor(socketIdentity);

    // HMAC key: master for control, derived for containers
    let hmacKey;
    if (socketIdentity === CONTROL_IDENTITY) {
        hmacKey = masterKey;
    } else {
        const entry = config.resolved(socketIdentity);
        if (!entry || !entry.keyEpoch) {
            console.error(`[system] ERR cannot open listener for ${socketIdentity}: missing keyEpoch in config`);
            return;
        }
        hmacKey = secret.derivePerContainerKey(masterKey, socketIdentity, entry.keyEpoch);
        writeContainerKey(keyPath, hmacKey);
    }

    // Remove stale socket file from a previous run
    try { fs.unlinkSync(sockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }

    const server = http.createServer((req, res) => {
        // The request handler gets the identity that authenticates this connection.
        // It uses identity to look up the right HMAC key and to constrain what
        // managedContainer the request body can claim.
        requestHandler(req, res, { socketIdentity, hmacKey });
    });

    server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    server.listen({ path: sockPath }, () => {
        // Make the socket reachable for the bind-mount target. Mode 0660 so
        // both the System component (owner) and the future bind-mount target
        // (which docker will mediate access for) can read/write.
        try { fs.chmodSync(sockPath, 0o660); } catch (e) { /* ok */ }
        console.log(`[system] listening on ${sockPath}  (identity=${socketIdentity})`);
    });

    listeners.set(socketIdentity, { server, sockPath, keyPath, hmacKey });
}

function closeListener(socketIdentity) {
    const entry = listeners.get(socketIdentity);
    if (!entry) return Promise.resolve();
    // Synchronously remove from the live listeners map so that a re-add in
    // the same reconcile pass (or a rapid destroy/create cycle) opens a fresh
    // listener instead of being skipped by the listeners.has() guard.
    listeners.delete(socketIdentity);
    // Unlink the socket file immediately, BEFORE waiting for server.close().
    // This ensures any subsequent openListener() that's about to bind the
    // same path doesn't have its freshly-created socket file deleted by a
    // later-firing close callback. Stale unix sockets are inert once the
    // server's accept() fd is closed; clients see ECONNREFUSED.
    try { fs.unlinkSync(entry.sockPath); } catch {}
    return new Promise((resolve) => {
        entry.server.close(() => {
            // Note: we deliberately do NOT unlink here. See above.
            // The key file is also NOT removed — it survives across SIGHUP
            // reloads unless the container is genuinely being destroyed via
            // /containers/destroy, which calls destroyContainerKey() separately.
            console.log(`[system] closed listener for ${socketIdentity}`);
            resolve();
        });
    });
}

// ── Reconciliation with managed-containers.json ──────────────────────────────

function reconcile() {
    const desired = new Set([CONTROL_IDENTITY]);
    const cfg = config._raw ? config._raw() : null;
    if (cfg) {
        for (const name of Object.keys(cfg)) {
            if (name === '_host') continue;
            if (name.startsWith('_')) continue;
            const entry = config.resolved(name);
            if (!entry) continue;
            if (entry.execContext === 'host') continue;
            if (!entry.keyEpoch) {
                console.warn(`[system] WARN ignoring '${name}': missing keyEpoch (use /containers/create to register properly)`);
                continue;
            }
            desired.add(name);
        }
    }

    for (const id of listeners.keys()) {
        if (!desired.has(id)) closeListener(id);
    }
    for (const id of desired) {
        if (!listeners.has(id)) openListener(id);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

function start(master, handler) {
    if (!Buffer.isBuffer(master) || master.length !== 32) {
        throw new Error('start: masterKey must be a 32-byte Buffer');
    }
    if (typeof handler !== 'function') {
        throw new Error('start: handler must be a function');
    }
    masterKey = master;
    requestHandler = handler;
    ensureDirs();
    reconcile();
}

function shutdown() {
    const ids = Array.from(listeners.keys());
    return Promise.all(ids.map(closeListener));
}

// Remove a container's key file entirely (called when a container is destroyed
// via /containers/destroy on the control socket).
function destroyContainerKey(containerName) {
    if (containerName === CONTROL_IDENTITY || containerName === '_host') {
        throw new Error('cannot destroy control or _host key');
    }
    const { keyPath } = pathsFor(containerName);
    try { fs.unlinkSync(keyPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = {
    start,
    reconcile,
    shutdown,
    destroyContainerKey,
    // Expose for inspection / tests
    listeners,
    CONTROL_IDENTITY,
    SOCKET_DIR,
    CONTAINER_SOCKDIR,
    CONTROL_SOCKET,
    KEY_DIR,
};
