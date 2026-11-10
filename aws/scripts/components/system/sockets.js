// /opt/safebox/system/sockets.js
//
// The one Unix domain socket this process listens on. Which one depends on
// the role the process was started in:
//
//   Tenant instance (SAFEBOX_TENANT=<name>, safebox-system@<name>.service,
//   uid safebox-sys-<name>): /run/safebox/containers/<name>.sock, bind-mounted
//   into ONLY that container at /run/safebox/system.sock. Authenticated with
//   the per-container key the instance reads from
//   /run/safebox/keys/<name>/instance.hmac (written by safebox-keyd; the
//   container holds the same value as system.hmac). Container identity is
//   enforced by the kernel via the filesystem topology, and process identity
//   by the uid: this process cannot open any other tenant's socket, key or
//   state.
//
//   Operator instance (no SAFEBOX_TENANT, safebox-system.service, uid
//   safebox-infra): /run/safebox/control.sock, NOT bind-mounted into any
//   container, 0600 safebox-infra. Authenticated with the operator key
//   /run/safebox/keys/_operator/control.hmac (also from keyd). Handles the
//   _host-scope operations: /models, /containers, /volumes, /succession.
//   It serves no per-container socket and holds no per-container key.
//
// Before per-tenant isolation this module opened every socket from one
// process that also derived every key. Now keys are keyd's business
// (common/keyd/safebox-keyd.js), sockets are one per process, and
// reconcile() only makes sure this process's own listener is up. The
// directory /run/safebox/containers is 1771 root:safebox-sys (keyd creates
// it): each instance creates its own socket there and the sticky bit keeps
// it from touching another instance's.
//
// Identity model:
//
//   - Connection on /run/safebox/containers/<name>.sock
//       → request authenticated against the per-container key for <name>
//       → managedContainer in request body MUST equal <name> (or be absent)
//   - Connection on /run/safebox/control.sock
//       → request authenticated against the operator key
//       → managedContainer in request body MUST be '_host' (or absent for /containers)

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const secret = require('./secret');

const SOCKET_DIR        = process.env.SAFEBOX_SYSTEM_SOCKET_DIR || '/run/safebox';
const CONTAINER_SOCKDIR = path.join(SOCKET_DIR, 'containers');
const CONTROL_SOCKET    = path.join(SOCKET_DIR, 'control.sock');

// Per-container keys live on tmpfs under <KEYS_DIR>/<name>/, written by
// safebox-keyd: system.hmac (0440 <instance uid>:<app gid>, what the
// container reads through its read-only bind mount) and instance.hmac
// (0400 <instance uid>, what this process reads in tenant mode). Nothing
// under /etc or /var holds a key. See docs/HARDENING-PLAN.md fix 1 and
// "Per-tenant isolation".
const KEYS_DIR          = secret.KEYS_DIR;
const KEY_FILENAME      = 'system.hmac';
const INSTANCE_KEY_FILENAME = secret.INSTANCE_KEY_FILENAME;
const KEY_DIR_IN_CONTAINER = '/run/safebox/keys';
const KEY_PATH_IN_CONTAINER = KEY_DIR_IN_CONTAINER + '/' + KEY_FILENAME;

// The container's app user is fixed at uid/gid 991 per the contract, but
// the docker daemon runs with userns-remap=default, so on the HOST that
// user is gid <dockremap base>+991 (100991 on every image). The
// per-container socket is group-owned by that host gid so the app user
// inside the container can connect to it; the tenant instance is a member
// of safebox-app-ns, the group at that gid (SupplementaryGroups= in the
// template unit), so an unprivileged chgrp to it is allowed. On a host
// without a dockremap range (dev box, tests) this falls back to the
// unmapped gid 991. SAFEBOX_APP_GID overrides either. safebox-container
// create (root) applies the same ownership as a backstop before docker run.
const APP_GID           = resolveAppGid();

function resolveAppGid() {
    if (process.env.SAFEBOX_APP_GID) return parseInt(process.env.SAFEBOX_APP_GID, 10);
    const APP_ID = 991;
    try {
        const line = fs.readFileSync('/etc/subgid', 'utf8').split('\n')
            .find((l) => l.startsWith('dockremap:'));
        if (line) {
            const [, base, count] = line.trim().split(':');
            if (/^\d+$/.test(base) && /^\d+$/.test(count) && parseInt(count, 10) > APP_ID) {
                return parseInt(base, 10) + APP_ID;
            }
        }
    } catch { /* no subgid: unmapped host */ }
    return APP_ID;
}

// Identity sentinel for the control socket. Not a real container name.
const CONTROL_IDENTITY = '_control';

// The role of this process. TENANT is the container name in tenant mode,
// null in operator mode.
const TENANT = secret.TENANT;
const IS_TENANT = TENANT !== null;

// Active listeners: socketIdentity -> { server, sockPath, keyPath, hmacKey }.
// Holds at most one entry; it is a Map for the sake of the callers that
// enumerate it.
const listeners = new Map();

// The key this process authenticates with (set by start()).
let roleKey = null;

// The request handler to call for every parsed request. Wired by start().
let requestHandler = null;

// ── Filesystem setup ─────────────────────────────────────────────────────────

function ensureDirs() {
    // In production keyd (root) creates these before any instance starts:
    // /run/safebox 0751, containers/ 1771 root:safebox-sys, keys/ 0751.
    // mkdirSync is then a no-op; on a dev box they are ours.
    fs.mkdirSync(SOCKET_DIR,        { recursive: true, mode: 0o750 });
    fs.mkdirSync(CONTAINER_SOCKDIR, { recursive: true, mode: 0o750 });
}

function pathsFor(socketIdentity) {
    if (socketIdentity === CONTROL_IDENTITY) {
        return { sockPath: CONTROL_SOCKET, keyPath: secret.OPERATOR_KEY_PATH, instanceKeyPath: null };
    }
    return {
        sockPath:        path.join(CONTAINER_SOCKDIR, socketIdentity + '.sock'),
        keyPath:         path.join(KEYS_DIR, socketIdentity, KEY_FILENAME),
        instanceKeyPath: path.join(KEYS_DIR, socketIdentity, INSTANCE_KEY_FILENAME),
    };
}

// The identity this process serves.
function ownIdentity() {
    return IS_TENANT ? TENANT : CONTROL_IDENTITY;
}

// ── Listener lifecycle ───────────────────────────────────────────────────────

function openListener(socketIdentity) {
    if (listeners.has(socketIdentity)) {
        return;  // already listening
    }
    if (socketIdentity !== ownIdentity()) {
        throw new Error(`refusing to open listener for '${socketIdentity}': this process serves '${ownIdentity()}' only`);
    }

    const { sockPath, keyPath } = pathsFor(socketIdentity);
    const hmacKey = roleKey;

    // Remove a stale socket file from a previous run of this same instance.
    // In the sticky directory only our own uid's file can be unlinked, so a
    // squatter under another uid makes listen() fail rather than be removed.
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
        // Make the socket reachable for the bind-mount target: group-owned by
        // the host gid the container's app user maps to (APP_GID), mode 0660
        // so both this instance (owner) and that user can connect. The
        // control socket is not bind-mounted and nothing in this repository
        // connects to it at runtime; it is 0600 safebox-infra so only that
        // user (and root) can reach it.
        if (socketIdentity !== CONTROL_IDENTITY) {
            try { fs.chownSync(sockPath, -1, APP_GID); } catch (e) {
                console.warn(`[system] WARN could not chgrp ${sockPath} to gid ${APP_GID}: ${e.message}`);
            }
        }
        const mode = socketIdentity === CONTROL_IDENTITY ? 0o600 : 0o660;
        try { fs.chmodSync(sockPath, mode); } catch (e) { /* ok */ }
        console.log(`[system] listening on ${sockPath}  (identity=${socketIdentity})`);
    });

    listeners.set(socketIdentity, { server, sockPath, keyPath, hmacKey });
}

function closeListener(socketIdentity) {
    const entry = listeners.get(socketIdentity);
    if (!entry) return Promise.resolve();
    listeners.delete(socketIdentity);
    // Unlink the socket file immediately, BEFORE waiting for server.close(),
    // so a reopen in the same tick does not have its fresh file removed by a
    // later-firing close callback. Stale unix sockets are inert once the
    // server's accept() fd is closed; clients see ECONNREFUSED.
    try { fs.unlinkSync(entry.sockPath); } catch {}
    return new Promise((resolve) => {
        entry.server.close(() => {
            console.log(`[system] closed listener for ${socketIdentity}`);
            resolve();
        });
    });
}

// ── Reconciliation ───────────────────────────────────────────────────────────
//
// This process serves exactly one socket, so there is nothing to add or
// remove on a config change: reconcile() makes sure its own listener is up.
// Kept as the SIGHUP entry point so server.js is role-agnostic.

function reconcile() {
    const own = ownIdentity();
    for (const id of listeners.keys()) {
        if (id !== own) closeListener(id);
    }
    if (!listeners.has(own)) openListener(own);
}

// ── Public API ───────────────────────────────────────────────────────────────

function start(key, handler) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new Error('start: key must be a 32-byte Buffer');
    }
    if (typeof handler !== 'function') {
        throw new Error('start: handler must be a function');
    }
    roleKey = key;
    requestHandler = handler;
    ensureDirs();
    reconcile();
}

function shutdown() {
    const ids = Array.from(listeners.keys());
    return Promise.all(ids.map(closeListener));
}

module.exports = {
    start,
    reconcile,
    shutdown,
    // Expose for inspection / tests
    listeners,
    ownIdentity,
    CONTROL_IDENTITY,
    TENANT,
    IS_TENANT,
    SOCKET_DIR,
    CONTAINER_SOCKDIR,
    CONTROL_SOCKET,
    KEYS_DIR,
    KEY_FILENAME,
    INSTANCE_KEY_FILENAME,
    KEY_DIR_IN_CONTAINER,
    KEY_PATH_IN_CONTAINER,
    APP_GID,
    pathsFor,
};
