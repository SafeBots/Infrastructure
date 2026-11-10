// /opt/safebox/system/server.js
//
// HTTP server for the Safebox System component over one Unix domain
// socket. The same program runs in two roles, chosen by the unit that
// starts it (docs/HARDENING-PLAN.md, "Per-tenant isolation"):
//
//   • Tenant instance (safebox-system@<name>.service, SAFEBOX_TENANT=<name>,
//     uid safebox-sys-<name>): serves /run/safebox/containers/<name>.sock,
//     bind-mounted into that container at /run/safebox/system.sock.
//     Authenticated with the per-container key read from
//     /run/safebox/keys/<name>/instance.hmac. Handles /system, /test and
//     /embed for that one tenant and refuses every control route.
//
//   • Operator instance (safebox-system.service, no SAFEBOX_TENANT, uid
//     safebox-infra): serves /run/safebox/control.sock — host-only, not
//     bind-mounted into any container. Authenticated with the operator key
//     from /run/safebox/keys/_operator/control.hmac. Handles the _host-scope
//     operations: /models, /containers lifecycle, /volumes, /succession,
//     and starts one tenant instance per declared container.
//
// Neither role holds the HMAC seed or the master; those are safebox-keyd's.
// The socket the connection arrived on determines the calling identity, and
// the request body's managedContainer is validated against it — they must
// agree, or the request is rejected. The routing, validation and audit
// logic is the same in both roles; the role decides which socket exists and
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
const opsVolumes = require('./opsVolumes');
const succession = require('./succession');
const instanceIdentity = require('./instanceIdentity');
const transparency = require('./transparency');
const secret = require('./secret');
const sockets = require('./sockets');
const ocpVerify = require('./ocpVerify');
const governanceKeys = require('./governanceKeys');

const MAX_BODY_BYTES = 1024 * 1024;  // 1 MiB
const IS_TENANT = sockets.IS_TENANT;
const TENANT = sockets.TENANT;

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

// ── Governance gate ─────────────────────────────────────────────────────────
//
// Operations that expand or modify the trust surface require an OCP claim
// signed by M-of-N governance signers. The claim is in body.ocpClaim.
// Returns null for HMAC-only operations, { ok: true } for governance-passed,
// or { ok: false, code, message } for governance-rejected.

// Map of (method, path-prefix) to the governance operation name used to
// look up the threshold in governance-keys.json. Entries not listed here
// are HMAC-only (no governance required).
const GOVERNANCE_OPERATIONS = [
    { method: 'POST', prefix: '/system',             operation: 'system' },
    { method: 'POST', prefix: '/containers/create',  operation: 'containers/create' },
    { method: 'POST', prefix: '/containers/destroy',  operation: 'containers/destroy' },
    { method: 'POST', prefix: '/models/install',      operation: 'models/install' },
    { method: 'POST', prefix: '/volumes/install',     operation: 'volumes/install' },
    { method: 'POST', prefix: '/succession/',         operation: 'succession/initiate' },
];

function governanceOperationFor(method, pathname) {
    for (const entry of GOVERNANCE_OPERATIONS) {
        if (method === entry.method && (pathname === entry.prefix || pathname.startsWith(entry.prefix + '/'))) {
            return entry.operation;
        }
    }
    return null;
}

function checkGovernance(method, pathname, body) {
    const operation = governanceOperationFor(method, pathname);
    if (!operation) return null;  // HMAC-only — no governance required

    // Governance keys may not be loaded yet (first boot, dev mode).
    // If no registry is available, reject all governed operations.
    let trustedKeys, threshold;
    try {
        trustedKeys = governanceKeys.getTrustedKeys();
        threshold = governanceKeys.getThreshold(operation);
    } catch (e) {
        return { ok: false, code: 'GOVERNANCE_UNAVAILABLE',
            message: 'governance key registry not loaded: ' + e.message };
    }

    const claim = body && body.ocpClaim;
    if (!claim) {
        return { ok: false, code: 'GOVERNANCE_REQUIRED',
            message: `operation '${operation}' requires an OCP governance claim` };
    }

    const result = ocpVerify.verifyThreshold(claim, threshold.m, trustedKeys);
    if (!result.ok) {
        return { ok: false, code: 'GOVERNANCE_REJECTED',
            message: `governance verification failed for '${operation}': ${result.message || result.code}` };
    }

    return { ok: true };
}

// ── Router ───────────────────────────────────────────────────────────────────

const TEST_KEEPALIVE = /^\/test\/([a-zA-Z0-9_-]+)\/keepalive$/;
const TEST_YIELDS    = /^\/test\/([a-zA-Z0-9_-]+)\/yields$/;
const TEST_STOP      = /^\/test\/([a-zA-Z0-9_-]+)\/stop$/;
const TEST_STATUS    = /^\/test\/([a-zA-Z0-9_-]+)$/;

// Endpoints reachable ONLY from the control socket
const CONTROL_ONLY_PREFIXES = ['/models', '/containers', '/volumes', '/succession'];

async function route(method, pathname, query, body, socketIdentity) {
    const isControl = socketIdentity === sockets.CONTROL_IDENTITY;

    // Role guard. A tenant instance never serves the control socket and the
    // operator never serves a per-container socket; sockets.js cannot open
    // the other role's listener, so this is belt and braces.
    if (IS_TENANT && isControl) {
        return { status: 'error', code: 'WRONG_SOCKET', message: 'tenant instance has no control socket', _http: 403 };
    }
    if (!IS_TENANT && !isControl) {
        return { status: 'error', code: 'WRONG_SOCKET', message: 'operator instance serves the control socket only', _http: 403 };
    }

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

    // /volumes — volume management, control-only
    if (pathname.startsWith('/volumes')) {
        if (!isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/volumes/* only reachable from control socket', _http: 403 };
        return await opsVolumes.handle(method, pathname, body);
    }

    // /succession — succession/failover/recovery, control-only
    if (pathname.startsWith('/succession')) {
        if (!isControl) return { status: 'error', code: 'WRONG_SOCKET',
            message: '/succession/* only reachable from control socket', _http: 403 };
        return succession.handle(method, pathname, body);
    }

    // /attestation — public endpoints (no HMAC required)
    // Note: these are handled before HMAC verification in handleRequest
    // for unauthenticated access. When reached here, the caller already
    // passed HMAC (authenticated query from a container).
    if (pathname.startsWith('/attestation')) {
        return handleAttestationRoute(method, pathname, body);
    }

    // /transparency — public read-only log (no HMAC required)
    // Same dual-path as /attestation.
    if (pathname.startsWith('/transparency')) {
        return handleTransparencyRoute(method, pathname);
    }

    return { status: 'error', code: 'NOT_FOUND', message: 'no such endpoint', _http: 404 };
}

// The transparency log is operator state (/var/lib/safebox/transparency,
// 0750 safebox-infra); a tenant instance neither reads nor appends to it.
function handleTransparencyRoute(method, pathname) {
    if (IS_TENANT) {
        return { status: 'error', code: 'NOT_SUPPORTED',
            message: 'the transparency log is served by the operator instance', _http: 404 };
    }
    return transparency.handle(method, pathname);
}

// ── Attestation route helper ────────────────────────────────────────────────

function handleAttestationRoute(method, pathname, body) {
    if (method === 'GET' && pathname === '/attestation') {
        const claim = instanceIdentity.issueAttestationClaim();
        return { status: 'ok', data: claim };
    }
    if (method === 'POST' && pathname === '/attestation/challenge') {
        if (!body || typeof body.nonce !== 'string') {
            return { status: 'error', code: 'BAD_REQUEST', message: 'nonce required', _http: 400 };
        }
        const response = instanceIdentity.handleChallenge(body.nonce);
        return { status: 'ok', data: response };
    }
    return { status: 'error', code: 'NOT_FOUND', message: 'no such attestation endpoint', _http: 404 };
}

// ── Public endpoints (no HMAC required) ─────────────────────────────────────
// /attestation and /transparency are public read-only endpoints, accessible
// without HMAC authentication. They are handled before the HMAC check.

const PUBLIC_PREFIXES = ['/attestation', '/transparency'];

function isPublicEndpoint(pathname) {
    return PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
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

    // Public endpoints bypass HMAC authentication
    if (isPublicEndpoint(pathname)) {
        let pubBody = null;
        if (bodyStr) {
            try { pubBody = JSON.parse(bodyStr); } catch { pubBody = null; }
        }
        let pubResult;
        if (pathname.startsWith('/attestation')) {
            pubResult = handleAttestationRoute(method, pathname, pubBody);
        } else if (pathname.startsWith('/transparency')) {
            pubResult = handleTransparencyRoute(method, pathname);
        } else {
            pubResult = { status: 'error', code: 'NOT_FOUND', message: 'no such endpoint', _http: 404 };
        }
        const pubHttp = pubResult._http || statusFromCode(pubResult.code);
        delete pubResult._http;
        sendJson(res, pubHttp, pubResult);
        audit({ event: 'request', identity: 'public', method, path: req.url, status: pubHttp, durationMs: Date.now() - startedMs });
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

    // ── Governance gate ─────────────────────────────────────────────────
    // Privileged operations require an OCP claim signed by M-of-N
    // governance signers. The claim must be present in body.ocpClaim,
    // verified against the governance key registry, and its stm must
    // bind to the requested operation. HMAC-only operations skip this.
    const govResult = checkGovernance(method, pathname, body);
    if (govResult && !govResult.ok) {
        sendJson(res, 403, { status: 'error', code: govResult.code, message: govResult.message });
        audit({ event: 'governance_fail', identity: socketIdentity, method, path: req.url, reason: govResult.code, durationMs: Date.now() - startedMs });
        return;
    }

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
    // The one key this role may read: the tenant's instance key or the
    // operator's control key, both written by safebox-keyd.
    const key = await secret.load();
    config.reload();

    // Load governance key registry (best-effort — dev environments may
    // not have one). If loading fails, governed operations are rejected
    // until a valid registry appears and SIGHUP triggers a reload. Both
    // roles need it: /system is governed and runs in the tenant instance.
    try { governanceKeys.load(); }
    catch (e) { console.warn(`[system] WARN governance keys not loaded: ${e.message}`); }

    // Initialize instance identity (ephemeral P-256 keypair, RAM-only).
    // Each process has its own; a tenant's /attestation answers for that
    // tenant's instance.
    instanceIdentity.init();

    if (!IS_TENANT) {
        // Initialize transparency log (append-only); operator state.
        try { transparency.init(); }
        catch (e) { console.warn(`[system] WARN transparency log init failed: ${e.message}`); }

        // Succession escrows the operator's key: it is the only key this
        // process has. The master stays in keyd and is reconstructed on a
        // successor from the sealed seed, never from an escrow.
        try { succession.init({ masterSecret: key }); }
        catch (e) { console.warn(`[system] WARN succession init failed: ${e.message}`); }
    }

    sockets.start(key, handleRequest);

    if (IS_TENANT) {
        // Clean up any test docker containers left over from a previous
        // instance that crashed before it could shut them down. Best-effort.
        try { await opsTest.startupCleanup(); }
        catch (e) { console.warn('[system] startup cleanup error:', e.message); }

        // Fork the embeddings worker subprocess. Eager fork lets
        // `/embed/health` answer truthfully from the moment the server starts
        // taking traffic, and catches transformers init errors at startup
        // instead of at first use. /embed is per-container, so only a
        // tenant instance runs a worker.
        opsEmbed.startWorker();
    } else {
        // Bring up one safebox-system@<name> per declared container. They
        // are not enabled units: their users are recreated each boot and
        // the operator is what knows the list.
        try {
            const r = await opsContainers.startDeclaredInstances();
            audit({ event: 'instances', started: r.started, failed: r.failed });
        } catch (e) { console.warn('[system] starting tenant instances failed:', e.message); }
    }

    process.on('SIGHUP', () => {
        console.log('[system] SIGHUP — reloading config, governance keys, and reconciling sockets');
        config.reload();
        try { governanceKeys.reload(); }
        catch (e) { console.warn(`[system] WARN governance keys reload failed: ${e.message}`); }
        sockets.reconcile();
    });

    audit({ event: 'startup', role: IS_TENANT ? 'tenant' : 'operator', tenant: TENANT || undefined,
        listeners: Array.from(sockets.listeners.keys()) });
}

function shutdown(signal) {
    console.log(`[system] received ${signal}; shutting down`);
    audit({ event: 'shutdown', signal, role: IS_TENANT ? 'tenant' : 'operator' });
    if (IS_TENANT) {
        opsTest.shutdownAll();
        opsEmbed.shutdownWorker();
    }
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

module.exports = { start, handleRequest, IS_TENANT, TENANT };
