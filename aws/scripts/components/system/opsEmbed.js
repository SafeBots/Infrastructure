// /opt/safebox/system/opsEmbed.js
//
// Parent-side handler for /embed. Forks and supervises the embeddings
// subprocess (embeddingsWorker.js), proxies requests over IPC, and
// returns responses to the HTTP layer.
//
// Why a subprocess: the embeddings worker loads @huggingface/transformers
// and runs ONNX Runtime native code. Keeping it out of the System
// component's process means:
//   - Master HMAC key never reachable from inference code
//   - ONNX crash / model parser bug doesn't kill /system or /containers
//   - Subprocess gets its own systemd-managed memory cgroup
//   - We can restart the worker independently for upgrades
//
// On worker death the parent auto-respawns it. In-flight requests at the
// moment of death return EMBEDDINGS_WORKER_RESTART; new requests trigger
// a fresh fork.

'use strict';

const { fork } = require('child_process');
const crypto   = require('crypto');
const path     = require('path');

const config = require('./config');

const REMOTE_INFERENCE_TIMEOUT_MS = parseInt(process.env.REMOTE_INFERENCE_TIMEOUT_MS || '60000', 10);
const WORKER_SCRIPT = path.join(__dirname, 'embeddingsWorker.js');
const REQUEST_TIMEOUT_MS = parseInt(process.env.EMBEDDINGS_REQUEST_TIMEOUT_MS || '120000', 10);
const RESPAWN_BACKOFF_MS = 2000;

// Worker lifecycle state:
//   worker          — the live ChildProcess, or null
//   respawnTimer    — setTimeout handle if a respawn is scheduled, or null
//   shuttingDown    — true once shutdownWorker() is called; suppresses respawns permanently
//                     until the process exits
let worker       = null;
let respawnTimer = null;
let shuttingDown = false;

// SafenetNode reference for remote inference routing.
// Set via setSafenetNode() when the Safenet subsystem starts.
let safenetNode = null;

// In-flight requests: requestId -> { resolve, reject, timeoutHandle }
const pending = new Map();

function audit(entry) {
    try { process.stderr.write('[embeddings] ' + JSON.stringify(entry) + '\n'); } catch {}
}

// ── Worker lifecycle ─────────────────────────────────────────────────────────

function startWorker() {
    if (worker) return;
    if (shuttingDown) return;
    // If a respawn was scheduled, cancel it — we're starting NOW, not later.
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }

    audit({ event: 'worker_start' });

    const env = Object.assign({}, process.env, {
        SAFEBOX_MODELS_ROOT:         process.env.SAFEBOX_MODELS_ROOT         || '/srv/safebox/models',
        EMBEDDINGS_MEMORY_BUDGET_MB: process.env.EMBEDDINGS_MEMORY_BUDGET_MB || '2048',
        EMBEDDINGS_THREADS:          process.env.EMBEDDINGS_THREADS          || '4',
    });

    worker = fork(WORKER_SCRIPT, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env,
        execArgv: [],
    });

    worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log') {
            audit({ event: 'worker_log', level: msg.level, message: msg.message });
            return;
        }
        if (typeof msg.id !== 'string') return;
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timeoutHandle);
        pending.delete(msg.id);
        if (msg.status === 'ok')         p.resolve(msg.data);
        else                              p.reject(Object.assign(new Error(msg.message || 'worker error'),
                                                                  { code: msg.code || 'INTERNAL_ERROR' }));
    });

    worker.on('exit', (code, signal) => {
        audit({ event: 'worker_exit', code, signal, pendingCount: pending.size });
        worker = null;
        // Fail all in-flight requests
        for (const [, p] of pending) {
            clearTimeout(p.timeoutHandle);
            p.reject(Object.assign(new Error('embeddings worker exited mid-request'),
                                    { code: 'EMBEDDINGS_WORKER_RESTART' }));
        }
        pending.clear();
        // Schedule a respawn unless we're shutting down or one is already
        // scheduled. Concurrent crashes still result in only one timer.
        if (!shuttingDown && !respawnTimer) {
            respawnTimer = setTimeout(() => {
                respawnTimer = null;
                startWorker();
            }, RESPAWN_BACKOFF_MS);
        }
    });

    worker.on('error', (e) => {
        audit({ event: 'worker_error', message: e.message });
    });
}

function shutdownWorker() {
    shuttingDown = true;
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (worker) {
        try { worker.kill('SIGTERM'); } catch {}
    }
}

// ── Request proxy ────────────────────────────────────────────────────────────

function sendToWorker(message) {
    if (!worker) startWorker();
    // Capture the worker reference NOW so a concurrent crash that nulls
    // `worker` doesn't turn our send into a TypeError. If the captured
    // worker is dead by the time we send, .send() throws ERR_IPC_CHANNEL_CLOSED
    // which we catch.
    const w = worker;
    return new Promise((resolve, reject) => {
        if (!w) {
            return reject(Object.assign(new Error('embeddings worker not available'),
                { code: 'EMBEDDINGS_WORKER_UNAVAILABLE' }));
        }
        const id = crypto.randomBytes(12).toString('hex');
        const timeoutHandle = setTimeout(() => {
            pending.delete(id);
            reject(Object.assign(new Error('embeddings request timed out'),
                                  { code: 'EMBEDDINGS_TIMEOUT' }));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeoutHandle });
        try {
            w.send(Object.assign({ id }, message));
        } catch (e) {
            clearTimeout(timeoutHandle);
            pending.delete(id);
            reject(Object.assign(new Error(`could not send to embeddings worker: ${e.message}`),
                                  { code: 'EMBEDDINGS_WORKER_UNAVAILABLE' }));
        }
    });
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

class BadRequest extends Error {
    constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

function checkAllowed(managedContainer) {
    if (!managedContainer) throw new BadRequest('managedContainer required');
    const entry = config.resolved(managedContainer);
    if (!entry) throw new BadRequest('managedContainer not found', 'BAD_REQUEST');
    if (!config.actionAllowed(managedContainer, 'embed')) {
        throw new BadRequest(`'embed' not in allowedActions for ${managedContainer}`, 'FORBIDDEN_ACTION');
    }
}

async function handleEmbed(body) {
    try {
        if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
        checkAllowed(body.managedContainer);
    } catch (e) {
        if (e instanceof BadRequest) {
            return { status: 'error', code: e.code, message: e.message,
                _http: e.code === 'FORBIDDEN_ACTION' ? 403 : 400 };
        }
        throw e;
    }
    try {
        const data = await sendToWorker({
            type:      'embed',
            model:     body.model,
            task:      body.task,
            inputs:    body.inputs,
            pooling:   body.pooling,
            normalize: body.normalize,
        });
        return { status: 'ok', data };
    } catch (e) {
        // If the model isn't installed locally, try remote inference
        if (e.code === 'MODEL_NOT_INSTALLED' && !config.disableRemoteInference && safenetNode) {
            return await _tryRemoteInference(body);
        }

        const httpStatus = (e.code === 'EMBEDDINGS_TIMEOUT')                  ? 504 :
                           (e.code === 'EMBEDDINGS_WORKER_RESTART')           ? 503 :
                           (e.code === 'EMBEDDINGS_WORKER_UNAVAILABLE')       ? 503 :
                           (e.code === 'MODEL_NOT_INSTALLED')                 ? 404 :
                           (e.code === 'MODEL_EXCEEDS_BUDGET')                ? 507 :
                           (e.code === 'BAD_REQUEST')                         ? 400 :
                           500;
        return { status: 'error', code: e.code || 'INTERNAL_ERROR',
                 message: e.message, _http: httpStatus };
    }
}

/**
 * Attempt to route an inference request to a remote attested Safenet peer.
 *
 * Looks up peers by manifest hash (64-char hex model identifier) or by
 * model name.  Tries up to 2 peers before giving up.
 *
 * @param {object} body - Original request body
 * @returns {Promise<object>} Response object with status, data, and _http
 * @private
 */
async function _tryRemoteInference(body) {
    const model = body.model;
    if (!model) {
        return { status: 'error', code: 'MODEL_NOT_INSTALLED',
                 message: 'No model specified', _http: 404 };
    }

    // Find peers: by manifest hash if it looks like one, otherwise by name
    let peers;
    if (/^[0-9a-f]{64}$/.test(model)) {
        peers = safenetNode.findModelPeers(model);
    } else {
        peers = safenetNode.findModelPeersByName(model);
    }

    if (!peers || peers.length === 0) {
        audit({ event: 'remote_inference_no_peers', model });
        return { status: 'error', code: 'MODEL_UNAVAILABLE',
                 message: 'No attested peer has model: ' + model, _http: 503 };
    }

    // Try up to 2 peers (shuffle for load distribution)
    const shuffled = peers.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    const attempts = Math.min(shuffled.length, 2);

    for (let i = 0; i < attempts; i++) {
        const peer = shuffled[i];
        try {
            audit({ event: 'remote_inference_attempt', model, peer: peer.endpoint, attempt: i + 1 });
            const result = await _postJSONWithTimeout(peer.endpoint + '/embed', {
                model:     body.model,
                task:      body.task,
                inputs:    body.inputs,
                pooling:   body.pooling,
                normalize: body.normalize,
                // Do NOT forward managedContainer — the remote peer uses its own auth
            }, REMOTE_INFERENCE_TIMEOUT_MS);

            if (result && result.status === 'ok') {
                audit({ event: 'remote_inference_ok', model, peer: peer.endpoint });
                return { status: 'ok', data: result.data, _remote: peer.endpoint };
            }
            // Peer returned an error — try next
            audit({ event: 'remote_inference_peer_error', model, peer: peer.endpoint,
                    code: result && result.code, message: result && result.message });
        } catch (err) {
            audit({ event: 'remote_inference_peer_fail', model, peer: peer.endpoint,
                    message: err.message });
        }
    }

    return { status: 'error', code: 'REMOTE_INFERENCE_FAILED',
             message: 'All remote peers failed for model: ' + model, _http: 502 };
}

/**
 * POST JSON to a peer with a timeout.
 *
 * Uses Node.js https (TEE-to-TEE, attestation replaces TLS PKI).
 *
 * @param {string} urlStr
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 * @private
 */
function _postJSONWithTimeout(urlStr, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const parsed = new URL(urlStr);
        const payload = JSON.stringify(body);

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            rejectUnauthorized: false, // TEE-to-TEE: attestation replaces TLS PKI
            timeout: timeoutMs
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch (_) {
                    reject(new Error('Invalid JSON from remote peer'));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Remote inference request timed out'));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function handleUnload(body) {
    try {
        if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
        checkAllowed(body.managedContainer);
    } catch (e) {
        if (e instanceof BadRequest) {
            return { status: 'error', code: e.code, message: e.message,
                _http: e.code === 'FORBIDDEN_ACTION' ? 403 : 400 };
        }
        throw e;
    }
    try {
        const data = await sendToWorker({ type: 'unload', model: body.model });
        return { status: 'ok', data };
    } catch (e) {
        return { status: 'error', code: e.code || 'INTERNAL_ERROR', message: e.message };
    }
}

async function handleList(body) {
    try {
        checkAllowed(body && body.managedContainer);
    } catch (e) {
        if (e instanceof BadRequest) {
            return { status: 'error', code: e.code, message: e.message,
                _http: e.code === 'FORBIDDEN_ACTION' ? 403 : 400 };
        }
        throw e;
    }
    try {
        const data = await sendToWorker({ type: 'list' });
        return { status: 'ok', data };
    } catch (e) {
        return { status: 'error', code: e.code || 'INTERNAL_ERROR', message: e.message };
    }
}

async function handleHealth(body) {
    try {
        checkAllowed(body && body.managedContainer);
    } catch (e) {
        if (e instanceof BadRequest) {
            return { status: 'error', code: e.code, message: e.message,
                _http: e.code === 'FORBIDDEN_ACTION' ? 403 : 400 };
        }
        throw e;
    }
    if (!worker) return { status: 'ok', data: { running: false } };
    try {
        const data = await sendToWorker({ type: 'health' });
        return { status: 'ok', data: Object.assign({ running: true }, data) };
    } catch (e) {
        return { status: 'error', code: e.code || 'INTERNAL_ERROR', message: e.message };
    }
}

// ── Router ───────────────────────────────────────────────────────────────────

async function handle(method, pathname, body) {
    if (method === 'POST' && pathname === '/embed')           return await handleEmbed(body);
    if (method === 'POST' && pathname === '/embed/unload')    return await handleUnload(body);
    if (method === 'GET'  && pathname === '/embed/models')    return await handleList(body);
    if (method === 'GET'  && pathname === '/embed/health')    return await handleHealth(body);
    return { status: 'error', code: 'NOT_FOUND',
             message: 'no such /embed endpoint', _http: 404 };
}

/**
 * Set the SafenetNode reference for remote inference routing.
 * Called once when the Safenet subsystem initializes.
 *
 * @param {import('../safenet/lib/SafenetNode')} node
 */
function setSafenetNode(node) {
    safenetNode = node;
}

module.exports = {
    handle,
    startWorker,
    shutdownWorker,
    setSafenetNode,
    // exposed for tests
    _pending: pending,
    _isWorkerRunning: () => worker !== null,
    _getSafenetNode: () => safenetNode,
};
