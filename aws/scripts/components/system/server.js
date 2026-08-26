// /opt/safebox/system/server.js
//
// Multi-socket HTTP server for the Safebox System component.
//
//   • One Unix domain socket per managed container at
//     /run/safebox/containers/<name>.sock — bind-mounted into that container
//     at /run/safebox/system.sock. Authenticated with a per-container HMAC
//     key derived from the master via HKDF.
//
//   • One control socket at /run/safebox/control.sock — host-only, not
//     bind-mounted into any container. Authenticated with the master HMAC
//     key. Handles _host-scope operations: dnf, /models, /containers
//     lifecycle.
//
// The socket the connection arrived on determines the calling identity.
// The request body's managedContainer is validated against the socket
// identity — they must agree, or the request is rejected.
//
// All listeners share the same routing, validation, and audit logic; the
// only difference is which HMAC key the request is verified against and
// which scope of operations is permitted.

'use strict';

const url = require('url');
const { spawn } = require('child_process');

const auth = require('./auth');
const config = require('./config');
const opsSystem = require('./opsSystem');
const opsTest = require('./opsTest');
const opsModels = require('./opsModels');
const opsContainers = require('./opsContainers');
const opsEmbed = require('./opsEmbed');
const secret = require('./secret');
const sockets = require('./sockets');

const MAX_BODY_BYTES = 1024 * 1024;  // 1 MiB

let auditProc = null;
let auditFallback = false;

// ── Audit via journald ───────────────────────────────────────────────────────

function ensureAuditProc() {
    if (auditFallback) return null;
    if (auditProc && !auditProc.killed && auditProc.stdin && auditProc.stdin.writable) return auditProc;
    try {
        auditProc = spawn('/usr/bin/systemd-cat', ['-t', 'safebox-system', '-p', 'info'], {
            stdio: ['pipe', 'ignore', 'ignore'],
        });
    } catch {
        auditFallback = true;
        return null;
    }
    auditProc.on('error', () => { auditProc = null; });
    if (auditProc.stdin) auditProc.stdin.on('error', () => { auditProc = null; });
    auditProc.on('exit', (code) => {
        if (code !== 0 && code !== null) auditFallback = true;
        auditProc = null;
    });
    return auditProc;
}

function audit(entry) {
    const p = ensureAuditProc();
    if (p && p.stdin && p.stdin.writable) {
        try { p.stdin.write(JSON.stringify(entry) + '\n'); return; }
        catch { /* fall through */ }
    }
    try { process.stderr.write('[audit] ' + JSON.stringify(entry) + '\n'); } catch {}
}

// ── Body reader ──────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        req.on('data', (c) => {
            total += c.length;
            if (total > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('body too large'), { httpStatus: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ── Response helpers ─────────────────────────────────────────────────────────

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
    });
    res.end(text);
}

function statusFromCode(code) {
    if (!code) return 200;
    if (code === 'BAD_REQUEST') return 400;
    if (code === 'FORBIDDEN_ACTION' || code === 'IMAGE_NOT_ALLOWED' || code === 'WRONG_SOCKET') return 403;
    if (code === 'TEST_NOT_FOUND' || code === 'WORKSPACE_NOT_FOUND') return 404;
    return 200;
}

// ── Socket-identity / request-body consistency ───────────────────────────────
//
// The socket the connection arrived on says who's calling. The request
// body's managedContainer field is then constrained:
//
//   socketIdentity = '_control' → managedContainer ∈ { '_host', undefined }
//                                  (undefined OK for /containers/* lifecycle)
//   socketIdentity = '<name>'   → managedContainer ∈ { '<name>', undefined }
//                                  (we set it to <name> if absent, so handlers don't need to think about it)

function reconcileIdentity(socketIdentity, bodyRef) {
    // Normalize: if the body parsed to something that isn't a plain object
    // (an array, string, number, or null), replace it with a fresh empty
    // object before reconciliation. Downstream handlers consistently
    // assume body is an object with `.managedContainer` and other fields;
    // arrays/strings/numbers don't have those fields and would produce
    // confusing errors deep in the handler instead of a clean rejection.
    const isPlainObject = bodyRef.body && typeof bodyRef.body === 'object'
                          && !Array.isArray(bodyRef.body);
    if (!isPlainObject) bodyRef.body = null;

    if (socketIdentity === sockets.CONTROL_IDENTITY) {
        // Control socket: managedContainer must be '_host' or undefined
        if (bodyRef.body && bodyRef.body.managedContainer !== undefined &&
            bodyRef.body.managedContainer !== '_host') {
            return { ok: false, code: 'WRONG_SOCKET',
                message: `control socket cannot act on managedContainer='${bodyRef.body.managedContainer}'` };
        }
        if (!bodyRef.body) bodyRef.body = { managedContainer: '_host' };
        else if (bodyRef.body.managedContainer === undefined) bodyRef.body.managedContainer = '_host';
        return { ok: true };
    }
    // Per-container socket: managedContainer must match, or be filled in
    if (bodyRef.body && bodyRef.body.managedContainer !== undefined &&
        bodyRef.body.managedContainer !== socketIdentity) {
        return { ok: false, code: 'WRONG_SOCKET',
            message: `socket for '${socketIdentity}' cannot act on managedContainer='${bodyRef.body.managedContainer}'` };
    }
    if (!bodyRef.body) bodyRef.body = { managedContainer: socketIdentity };
    else if (bodyRef.body.managedContainer === undefined) bodyRef.body.managedContainer = socketIdentity;
    return { ok: true };
}

// ── Router ───────────────────────────────────────────────────────────────────

const TEST_KEEPALIVE = /^\/test\/([a-zA-Z0-9_-]+)\/keepalive$/;
const TEST_YIELDS    = /^\/test\/([a-zA-Z0-9_-]+)\/yields$/;
const TEST_STOP      = /^\/test\/([a-zA-Z0-9_-]+)\/stop$/;
const TEST_STATUS    = /^\/test\/([a-zA-Z0-9_-]+)$/;

// Endpoints reachable ONLY from the control socket
const CONTROL_ONLY_PREFIXES = ['/models', '/containers'];

async function route(method, pathname, query, body, socketIdentity) {
    const isControl = socketIdentity === sockets.CONTROL_IDENTITY;

    // Healthz: any socket can ask
    if (method === 'GET' && pathname === '/healthz') {
        return { status: 'ok', data: { uptime: process.uptime(), identity: socketIdentity } };
    }

    // /containers — lifecycle, control-only
    if (pathname.startsWith('/containers')) {
        if (!isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/containers/* only reachable from control socket', _http: 403 };
        return await opsContainers.handle(method, pathname, body);
    }

    // /models — host-scope, control-only
    if (pathname.startsWith('/models')) {
        if (!isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/models/* only reachable from control socket', _http: 403 };
        const r = await opsModels.handle(method, pathname, body);
        if (r !== null) return r;
        return { status: 'error', code: 'NOT_FOUND', message: 'no such models endpoint', _http: 404 };
    }

    // /system — works on both: control socket dispatches host-scope tools (dnf, etc.),
    // per-container socket dispatches container-scope tools (npm, pip, etc.)
    if (method === 'POST' && pathname === '/system') {
        return await opsSystem.handle(body);
    }

    // /test — only on per-container sockets (a test runs in a clone of THAT
    // container's data)
    if (method === 'POST' && pathname === '/test') {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/test only reachable from per-container sockets', _http: 403 };
        return await opsTest.handleCreate(body);
    }
    let m;
    if (method === 'POST' && (m = pathname.match(TEST_KEEPALIVE))) {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET', message: 'control socket cannot manage tests', _http: 403 };
        return opsTest.handleKeepalive(m[1], socketIdentity);
    }
    if (method === 'GET' && (m = pathname.match(TEST_YIELDS))) {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET', message: 'control socket cannot manage tests', _http: 403 };
        const since = parseInt(query.since || '0', 10) || 0;
        return opsTest.handleYields(m[1], since, socketIdentity);
    }
    if (method === 'POST' && (m = pathname.match(TEST_STOP))) {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET', message: 'control socket cannot manage tests', _http: 403 };
        return await opsTest.handleStop(m[1], socketIdentity);
    }
    if (method === 'GET' && (m = pathname.match(TEST_STATUS))) {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET', message: 'control socket cannot manage tests', _http: 403 };
        return opsTest.handleStatus(m[1], socketIdentity);
    }

    // /embed — per-container only. Inference happens in a forked subprocess
    // (embeddingsWorker.js) that holds the models. The System component
    // itself never imports transformers — keeps the master HMAC key out
    // of reach of any ONNX runtime or model-parser issue.
    if (pathname === '/embed' || pathname.startsWith('/embed/')) {
        if (isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/embed only reachable from per-container sockets', _http: 403 };
        return await opsEmbed.handle(method, pathname, body);
    }

    return { status: 'error', code: 'NOT_FOUND', message: 'no such endpoint', _http: 404 };
}

// ── Request handler ──────────────────────────────────────────────────────────
//
// Called by sockets.js for every incoming request, with the socketIdentity
// and matching HMAC key for the listener that received the connection.

async function handleRequest(req, res, { socketIdentity, hmacKey }) {
    const startedMs = Date.now();
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const query = parsed.query || {};
    const method = req.method;

    let bodyStr = '';
    try {
        bodyStr = await readBody(req);
    } catch (e) {
        sendJson(res, e.httpStatus || 400, { status: 'error', code: 'BAD_REQUEST', message: e.message });
        audit({ event: 'request', identity: socketIdentity, method, path: req.url, status: e.httpStatus || 400, durationMs: Date.now() - startedMs, error: 'body_read' });
        return;
    }

    // HMAC verify with the per-socket key
    const v = auth.verify(hmacKey, req.headers, method, req.url, bodyStr);
    if (!v.ok) {
        sendJson(res, 401, { status: 'error', code: 'UNAUTHORIZED', message: v.message });
        audit({ event: 'auth_fail', identity: socketIdentity, method, path: req.url, reason: v.code, durationMs: Date.now() - startedMs });
        return;
    }

    // Parse JSON body (if any) so we can do identity reconciliation
    let body = null;
    if (bodyStr) {
        try { body = JSON.parse(bodyStr); }
        catch {
            sendJson(res, 400, { status: 'error', code: 'BAD_REQUEST', message: 'invalid JSON' });
            audit({ event: 'request', identity: socketIdentity, method, path: req.url, status: 400, durationMs: Date.now() - startedMs, error: 'json_parse' });
            return;
        }
    }

    // Reconcile socket identity against request body. We pass a holder
    // ({body: ...}) so reconcileIdentity can REPLACE body entirely when
    // there wasn't one (GETs typically have no body) — every downstream
    // handler then sees `body.managedContainer` reliably.
    const bodyRef = { body };
    const ident = reconcileIdentity(socketIdentity, bodyRef);
    if (!ident.ok) {
        sendJson(res, 403, { status: 'error', code: ident.code, message: ident.message });
        audit({ event: 'identity_mismatch', identity: socketIdentity, method, path: req.url, claimedContainer: body && body.managedContainer, durationMs: Date.now() - startedMs });
        return;
    }
    body = bodyRef.body;

    let result;
    try {
        result = await route(method, pathname, query, body, socketIdentity);
    } catch (e) {
        if (e.code === 'BAD_REQUEST' || e.name === 'BadRequest') {
            result = { status: 'error', code: e.code || 'BAD_REQUEST', message: e.message };
        } else if (e instanceof SyntaxError) {
            result = { status: 'error', code: 'BAD_REQUEST', message: 'invalid JSON' };
        } else if (e && e.code && typeof e.code === 'string') {
            result = { status: 'error', code: e.code, message: e.message };
        } else {
            console.error('[system] unexpected error:', e);
            result = { status: 'error', code: 'INTERNAL_ERROR', message: 'system error' };
        }
    }

    const httpStatus = result._http || statusFromCode(result.code);
    delete result._http;
    sendJson(res, httpStatus, result);

    const entry = {
        event: 'request',
        identity: socketIdentity,
        method, path: req.url, status: httpStatus,
        durationMs: Date.now() - startedMs,
    };
    // Cap any body-derived field to a small length so a malicious caller
    // can't blow up audit log size with a huge tool/action string. These
    // fields are normally enum-like; >128 chars is already abnormal.
    const trim = (v) => (typeof v === 'string' && v.length > 0)
        ? (v.length > 128 ? v.slice(0, 128) + '…' : v) : undefined;
    if (body) {
        const mc = trim(body.managedContainer); if (mc) entry.managedContainer = mc;
        const tl = trim(body.tool);              if (tl) entry.tool = tl;
        const ac = trim(body.action);            if (ac) entry.action = ac;
        const cn = trim(body.container);         if (cn) entry.container = cn;
        const av = trim(body.allowlistVersion);  if (av) entry.allowlistVersion = av;
        const th = trim(body.tenantHint);        if (th) entry.tenantHint = th;
    }
    if (result.status === 'error') entry.errorCode = result.code;
    audit(entry);
}

// ── Startup / shutdown ───────────────────────────────────────────────────────

async function start() {
    const master = await secret.load();
    config.reload();
    sockets.start(master, handleRequest);

    // Clean up any test docker containers left over from a previous System
    // instance that crashed before it could shut them down. Best-effort —
    // failures here are logged but don't prevent startup.
    try { await opsTest.startupCleanup(); }
    catch (e) { console.warn('[system] startup cleanup error:', e.message); }

    // Fork the embeddings worker subprocess. Lazy-fork would also work
    // (first /embed call), but eager fork lets `/embed/health` answer
    // truthfully from the moment the server starts taking traffic, and
    // catches transformers init errors at startup instead of at first use.
    opsEmbed.startWorker();

    process.on('SIGHUP', () => {
        console.log('[system] SIGHUP — reloading config and reconciling sockets');
        config.reload();
        sockets.reconcile();
    });

    audit({ event: 'startup', listeners: Array.from(sockets.listeners.keys()) });
}

function shutdown(signal) {
    console.log(`[system] received ${signal}; shutting down`);
    audit({ event: 'shutdown', signal });
    opsTest.shutdownAll();
    opsEmbed.shutdownWorker();
    sockets.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 30000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

if (require.main === module) {
    start().catch((e) => {
        console.error('[system] startup failed:', e);
        process.exit(1);
    });
}

module.exports = { start, handleRequest };
