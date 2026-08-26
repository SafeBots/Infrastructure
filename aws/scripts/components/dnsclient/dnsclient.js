// /opt/safebox/dnsclient/dnsclient.js
//
// Safebox DNS client. Runs as its own systemd unit alongside the System
// component, but does not share state or processes with it.
//
// What it does:
//   1. On boot, reads safeboxId + accountToken from /etc/safebox/dnsclient.json
//      (which is populated by cloud-init from the launch user-data field).
//   2. Discovers its current public IP via the EC2 instance metadata service
//      (IMDSv2 with token-protected calls).
//   3. Generates a Nitro attestation document with safeboxId + reportedIp
//      embedded in user_data.
//   4. POSTs the attestation to the configured DNS API endpoint (e.g.,
//      https://dns-api.safebots.org/v1/announce).
//   5. Listens for IP changes on a 60-second polling loop (cheap; instance
//      metadata is local). Re-announces when the IP changes.
//   6. Re-attests every hour even without IP change, so the DNS API knows
//      this box is still alive and can age out stale records.
//   7. Serves an HTTPS challenge endpoint on port 8443 at
//      /.well-known/safebox-announce-challenge/<token> so the DNS API can
//      verify that the reported IP actually belongs to a box that knows
//      the attestation's claimed safeboxId.
//
// Why a separate unit (not part of safebox-system):
//   - dnsclient writes to the network on a timer; safebox-system serves
//     a Unix socket. Different operational shapes.
//   - dnsclient does not need the master HMAC key (which safebox-system
//     holds in memory). Running it as a separate UID would let us drop
//     the worry that dnsclient bugs reach safebox-system's heap.
//     For v1 they run as the same UID (safebox-infra) since they're
//     both trusted Anthropic code, but the separation is structural for
//     when we tighten that.
//   - Independent restart: a dnsclient crash should not affect the
//     embeddings worker or the per-container sockets.
//
// What it does NOT do:
//   - It does not manage TLS certificates for the customer-facing vhosts.
//     That's autohost's job.
//   - It does not register custom domains. The DNS API handles those
//     via the dashboard; dnsclient only announces the box's primary
//     <safeboxId>.safebots.org name.
//   - It does not handle SAFEBUX accounting, redundancy work, or any
//     network-level state. Those are separate (currently future) systems.

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');

const nsmClient = require('./nsmClient');
const config    = require('./config');

const STATE_PATH = process.env.SAFEBOX_DNSCLIENT_STATE
    || '/var/lib/safebox/dnsclient/state.json';
const CHALLENGE_PORT  = parseInt(process.env.SAFEBOX_DNSCLIENT_CHALLENGE_PORT || '8443', 10);
const IP_POLL_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const ANNOUNCE_TIMEOUT_MS = 30_000;
const IMDS_TIMEOUT_MS = 5_000;

// ── Audit logging via stderr (captured by systemd → journald) ────────────────

function audit(entry) {
    try {
        process.stderr.write('[dnsclient] ' + JSON.stringify(entry) + '\n');
    } catch { /* ignore */ }
}

// ── IMDSv2: token-protected instance metadata access ────────────────────────
//
// IMDSv2 requires a PUT to /latest/api/token with X-aws-ec2-metadata-token-ttl-seconds
// to get a token, which is then sent as X-aws-ec2-metadata-token on subsequent
// GETs. This protects against SSRF through poorly-validated proxy code.
//
// We use a per-call token rather than caching across calls — token TTL is
// short and we make at most one IMDS request per polling interval.

function imdsCall(method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method,
            host: '169.254.169.254',
            path: urlPath,
            headers: headers || {},
            timeout: IMDS_TIMEOUT_MS,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`IMDS ${method} ${urlPath} returned ${res.statusCode}`));
                    return;
                }
                resolve(buf);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('IMDS timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function getImdsToken() {
    return imdsCall('PUT', '/latest/api/token',
        { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
}

async function getPublicIp() {
    const token = await getImdsToken();
    const ip = await imdsCall('GET', '/latest/meta-data/public-ipv4',
        { 'X-aws-ec2-metadata-token': token });
    const trimmed = ip.trim();
    if (!/^[0-9.]+$/.test(trimmed)) {
        throw new Error(`IMDS returned unexpected IP format: ${trimmed.slice(0, 64)}`);
    }
    return trimmed;
}

async function getInstanceIdentity() {
    // Returns the EC2 instance identity document; useful as a cross-check
    // against the Nitro attestation but not strictly necessary.
    const token = await getImdsToken();
    const raw = await imdsCall('GET', '/latest/dynamic/instance-identity/document',
        { 'X-aws-ec2-metadata-token': token });
    return JSON.parse(raw);
}

// ── Challenge state ──────────────────────────────────────────────────────────
//
// When we POST an announce to the DNS API, we include a fresh random nonce.
// The DNS API verifies our claimed IP by GETting
// https://<reportedIp>:8443/.well-known/safebox-announce-challenge/<nonce>
// and expecting back the nonce itself (or a derived response). We hold the
// nonce in memory; expire after 5 minutes.

const activeChallenges = new Map();  // nonce -> expiryMs
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function newChallenge() {
    const nonce = crypto.randomBytes(24).toString('base64url');
    activeChallenges.set(nonce, Date.now() + CHALLENGE_TTL_MS);
    return nonce;
}

function pruneChallenges() {
    const now = Date.now();
    for (const [nonce, expiry] of activeChallenges) {
        if (expiry <= now) activeChallenges.delete(nonce);
    }
}

function isValidChallenge(nonce) {
    pruneChallenges();
    return activeChallenges.has(nonce);
}

// ── Persistent state (last-announced IP, last-attestation timestamp) ─────────

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return { lastAnnouncedIp: null, lastAttestationMs: 0, announceCount: 0 };
    }
}

function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        const tmp = STATE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
        audit({ event: 'state_save_failed', message: e.message });
    }
}

// ── Announce protocol ────────────────────────────────────────────────────────

async function buildAnnouncePayload(cfg, reportedIp, instanceIdentity) {
    const challenge = newChallenge();

    // The attestation embeds (safeboxId, reportedIp, challenge, timestamp)
    // in user_data. The DNS API verifies the attestation signature, decodes
    // user_data, cross-checks all fields, and uses challenge to GET the
    // challenge endpoint at reportedIp.
    const userData = JSON.stringify({
        safeboxId:  cfg.safeboxId,
        reportedIp,
        challenge,
        timestamp:  Math.floor(Date.now() / 1000),
        instanceId: instanceIdentity && instanceIdentity.instanceId,
        region:     instanceIdentity && instanceIdentity.region,
    });

    // nsmClient.getAttestation(userData, nonce) returns the COSE_Sign1 bytes.
    // We pass the challenge as the NSM nonce so it's also bound at the
    // attestation-signature level. If NSM is unavailable (running outside
    // an enclave), we fall back to a self-signed mode for testing — but
    // production deployments enforce NSM presence.
    let attestationBytes;
    try {
        attestationBytes = await nsmClient.getAttestation({
            userData: Buffer.from(userData, 'utf8'),
            nonce:    Buffer.from(challenge, 'utf8'),
        });
    } catch (e) {
        if (cfg.allowUnattested) {
            // Dev mode: post the user_data unsigned. DNS API in dev mode
            // accepts unsigned payloads; production never enables this.
            audit({ event: 'attestation_unavailable_dev', message: e.message });
            attestationBytes = null;
        } else {
            throw e;
        }
    }

    return {
        safeboxId:    cfg.safeboxId,
        accountToken: cfg.accountToken,
        reportedIp,
        challenge,
        userData,
        attestation:  attestationBytes ? attestationBytes.toString('base64') : null,
    };
}

function postAnnounce(cfg, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const url = new URL(cfg.dnsApiUrl);
        const req = https.request({
            method: 'POST',
            host:   url.hostname,
            port:   url.port || 443,
            path:   url.pathname + (url.search || '') + (url.pathname.endsWith('/announce') ? '' : '/announce'),
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent':     'safebox-dnsclient/1.0',
            },
            timeout: ANNOUNCE_TIMEOUT_MS,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(buf); } catch { /* keep raw */ }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, body: parsed || buf });
                } else {
                    reject(Object.assign(new Error(
                        `announce returned ${res.statusCode}: ${(parsed && parsed.message) || buf.slice(0, 256)}`),
                        { code: 'ANNOUNCE_FAILED', httpStatus: res.statusCode }));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('announce timeout')); });
        req.write(body);
        req.end();
    });
}

async function announce(cfg, state, reason) {
    let reportedIp;
    let instanceIdentity = null;
    try {
        reportedIp = await getPublicIp();
        try { instanceIdentity = await getInstanceIdentity(); } catch { /* IMDS quirk; not fatal */ }
    } catch (e) {
        audit({ event: 'announce_skipped_no_ip', reason, message: e.message });
        return { ok: false, code: 'IMDS_UNAVAILABLE' };
    }

    let payload;
    try {
        payload = await buildAnnouncePayload(cfg, reportedIp, instanceIdentity);
    } catch (e) {
        audit({ event: 'announce_skipped_no_attestation', reason, message: e.message });
        return { ok: false, code: 'ATTESTATION_FAILED' };
    }

    try {
        const result = await postAnnounce(cfg, payload);
        state.lastAnnouncedIp   = reportedIp;
        state.lastAttestationMs = Date.now();
        state.announceCount     = (state.announceCount || 0) + 1;
        saveState(state);
        audit({ event: 'announce_ok', reason, ip: reportedIp, status: result.status,
                announceCount: state.announceCount });
        return { ok: true, ip: reportedIp };
    } catch (e) {
        audit({ event: 'announce_failed', reason, ip: reportedIp,
                message: e.message, code: e.code, httpStatus: e.httpStatus });
        return { ok: false, code: e.code || 'ANNOUNCE_FAILED' };
    }
}

// ── Challenge HTTP server ────────────────────────────────────────────────────
//
// The DNS API calls back to https://<reportedIp>:8443/.well-known/safebox-announce-challenge/<nonce>
// to confirm we control the claimed IP. We respond 200 with the nonce body if
// the nonce is one we recently generated; 404 otherwise.
//
// Note on TLS: for v1 we accept plain HTTP on this port to avoid the chicken-
// and-egg problem of needing a cert before the first announce can succeed.
// The challenge itself does not need TLS confidentiality — the nonce is single-
// use and the DNS API discards it after verification. Production-hardened v2
// could use a self-signed cert with HPKP-equivalent pinning by the DNS API.
// For now: clear-text HTTP on 8443.

function startChallengeServer() {
    const server = http.createServer((req, res) => {
        const m = req.url && req.url.match(/^\/\.well-known\/safebox-announce-challenge\/([A-Za-z0-9_-]{1,64})$/);
        if (!m) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        const nonce = m[1];
        if (!isValidChallenge(nonce)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('challenge expired or unknown');
            audit({ event: 'challenge_unknown', noncePrefix: nonce.slice(0, 8) });
            return;
        }
        // Consume the challenge — single-use
        activeChallenges.delete(nonce);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(nonce);
        audit({ event: 'challenge_ok', noncePrefix: nonce.slice(0, 8) });
    });
    server.listen(CHALLENGE_PORT, () => {
        audit({ event: 'challenge_server_listening', port: CHALLENGE_PORT });
    });
    server.on('error', (e) => {
        audit({ event: 'challenge_server_error', message: e.message });
    });
    return server;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
    const cfg = config.load();
    audit({ event: 'startup', safeboxId: cfg.safeboxId,
            dnsApiUrl: cfg.dnsApiUrl, hasToken: !!cfg.accountToken });

    const state = loadState();
    startChallengeServer();

    // Initial announce (don't fail startup if it fails; we'll retry)
    await announce(cfg, state, 'startup');

    // Periodic heartbeat
    setInterval(async () => {
        await announce(cfg, state, 'heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    // IP change watcher (more frequent than heartbeat)
    setInterval(async () => {
        let currentIp;
        try { currentIp = await getPublicIp(); }
        catch { return; }
        if (currentIp !== state.lastAnnouncedIp) {
            audit({ event: 'ip_changed', from: state.lastAnnouncedIp, to: currentIp });
            await announce(cfg, state, 'ip_changed');
        }
    }, IP_POLL_INTERVAL_MS);

    // Periodic challenge GC (belt-and-suspenders; isValidChallenge also prunes)
    setInterval(pruneChallenges, 60_000);
}

// Crash hygiene
process.on('uncaughtException', (e) => {
    audit({ event: 'uncaught_exception', message: e.message, stack: e.stack });
    process.exit(1);
});
process.on('unhandledRejection', (e) => {
    audit({ event: 'unhandled_rejection', message: e && e.message });
    process.exit(1);
});

if (require.main === module) {
    main().catch((e) => {
        audit({ event: 'main_failed', message: e.message, stack: e.stack });
        process.exit(1);
    });
}

module.exports = {
    // exported for tests
    _newChallenge:     newChallenge,
    _isValidChallenge: isValidChallenge,
    _pruneChallenges:  pruneChallenges,
    _buildAnnouncePayload: buildAnnouncePayload,
    _getPublicIp:      getPublicIp,
};
