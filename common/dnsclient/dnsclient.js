// /opt/safebox/dnsclient/dnsclient.js
//
// Safebox DNS client. Runs as its own systemd unit alongside the System
// component, but does not share state or processes with it. Identical on
// all four clouds; the only cloud-specific parts are the public-IP lookup
// (a branch on config.cloud) and the attestation client, which each cloud's
// install-system.sh installs as attestationClient.js.
//
// What it does (docs/HARDENING-PLAN.md, "Decentralized announce" and
// first-boot steps 4 and 5):
//
//   1. Reads safeboxId, ownerPubkey, launchAuthorization and cloud from
//      /var/lib/safebox/dns/dnsclient.json, written by safebox-firstboot.service
//      from the metadata service; dnsRelays and safenetLogs come from the
//      image's /etc/safebox/defaults.json.
//
//   2. On first run generates an Ed25519 identity keypair (private key to
//      /var/lib/safebox/dns/identity.key, 0400). There is no registration and
//      no credential: the box's public key is its identity, and the owner's
//      signed launch_authorization is what ties that key to an owner.
//
//   3. Announce: discovers the public IP from the cloud metadata service,
//      obtains a TPM quote over the policy PCRs with nonce =
//      sha256(canonical(launchAuthorization) || prev) and the memory-
//      encryption report bound to that quote, builds a safebox_announce OCP
//      claim {safeboxId, boxPubkey, ownerPubkey, launchAuthorization,
//      imageRootHash, cloud, publicIp, quote, confidential, issuedAt, prev}
//      signed by the box key, stores it at
//      /var/lib/safebox/dns/last-announce.json, and delivers it to every
//      Safenet transparency log in safenetLogs (POST <log>/safenet/v1/gossip)
//      and to every relying party in dnsRelays (POST <relay>/announce).
//      Delivery failures are logged and retried on the hourly heartbeat;
//      `prev` is the hash of the previous announce, so a relying party can
//      follow one box's chain. Re-announces on IP change (60 s poll).
//      Nobody approves an announce: each relying party runs
//      common/attestation/verifyAnnounce.js against its own blessed-image
//      set and decides for itself.
//
//   4. Serves the challenge endpoint on port 8443 at
//      /.well-known/safebox-announce-challenge/<token> so a relying party
//      can verify the announced IP actually belongs to this box.
//
// What it does NOT do: manage TLS for customer vhosts (autovhost), register
// custom domains (dashboard), or hold the HMAC master (safebox-system).
// There is no unattested mode: a failed quote is a failed announce, and a
// quote without a memory-encryption report is refused unless the image was
// built with allowUnencryptedMemory.

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const crypto = require('crypto');

const attestationClient = require('./attestationClient');
const config = require('./config');
// Installed beside this file by install-dnsclient.sh; in the source tree it
// lives in common/attestation/.
const ocp = (() => {
    try { return require('./ocpClaim'); }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return require('../attestation/ocpClaim'); }
})();

const STATE_DIR  = config.STATE_DIR;
const STATE_PATH = process.env.SAFEBOX_DNSCLIENT_STATE
    || path.join(STATE_DIR, 'dnsclient', 'state.json');
const IDENTITY_KEY_PATH  = process.env.SAFEBOX_DNSCLIENT_IDENTITY_KEY
    || path.join(STATE_DIR, 'identity.key');
const LAST_ANNOUNCE_PATH = process.env.SAFEBOX_DNSCLIENT_LAST_ANNOUNCE
    || path.join(STATE_DIR, 'last-announce.json');
// Touched after the first announce has been delivered somewhere; its
// presence is what stops safebox-firstboot.service from running again
// (ConditionPathExists=!/var/lib/safebox/dns/announced).
const ANNOUNCED_MARKER   = process.env.SAFEBOX_DNSCLIENT_ANNOUNCED_MARKER
    || path.join(STATE_DIR, 'announced');
const OCI_PLATFORM_CERT_PATH = path.join(STATE_DIR, 'oci-platform-cert.pem');
const IMAGE_HASH_PATH = '/etc/safebox/image-hash';

const CHALLENGE_PORT  = parseInt(process.env.SAFEBOX_DNSCLIENT_CHALLENGE_PORT || '8443', 10);
const IP_POLL_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour; also the retry interval for failed deliveries
const ANNOUNCE_TIMEOUT_MS = 30_000;
const IMDS_TIMEOUT_MS = 5_000;
const IMDS_HOST = '169.254.169.254';

// ── Audit logging via stderr (captured by systemd → journald) ────────────────

function audit(entry) {
    try {
        process.stderr.write('[dnsclient] ' + JSON.stringify(entry) + '\n');
    } catch { /* ignore */ }
}

// ── Metadata service, per cloud ──────────────────────────────────────────────
//
// Only the public IP (and on OCI, once, the platform certificate) is read.
// safebox-id, owner-pubkey and launch-authorization are read by safebox-firstboot.sh, not
// here. The metadata address is reachable only by root, safebox-infra and
// safebox-dns (nftables rule, fix 6), never by containers.

function imdsCall(method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method,
            host: IMDS_HOST,
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

async function awsPublicIp() {
    // IMDSv2: PUT for a short-lived token, then GET with it.
    const token = await imdsCall('PUT', '/latest/api/token',
        { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
    return imdsCall('GET', '/latest/meta-data/public-ipv4',
        { 'X-aws-ec2-metadata-token': token });
}

async function gcpPublicIp() {
    return imdsCall('GET',
        '/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
        { 'Metadata-Flavor': 'Google' });
}

async function azurePublicIp() {
    return imdsCall('GET',
        '/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text',
        { 'Metadata': 'true' });
}

async function ociPublicIp() {
    const raw = await imdsCall('GET', '/opc/v2/vnics/',
        { 'Authorization': 'Bearer Oracle' });
    let vnics;
    try { vnics = JSON.parse(raw); }
    catch (e) { throw new Error(`OCI vnics is not JSON: ${e.message}`); }
    if (!Array.isArray(vnics) || vnics.length === 0 || typeof vnics[0].publicIp !== 'string') {
        throw new Error('OCI vnics[0].publicIp missing');
    }
    return vnics[0].publicIp;
}

const PUBLIC_IP_BY_CLOUD = { aws: awsPublicIp, gcp: gcpPublicIp, azure: azurePublicIp, oci: ociPublicIp };

async function getPublicIp(cloud) {
    const fn = PUBLIC_IP_BY_CLOUD[cloud];
    if (!fn) throw new Error(`no public IP lookup for cloud '${cloud}'`);
    const ip = (await fn()).trim();
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(ip)) {
        throw new Error(`metadata returned unexpected IP format: ${ip.slice(0, 64)}`);
    }
    return ip;
}

// OCI only: the vTPM platform certificate used by ociAttestationClient to
// verify the EK chain comes from IMDS. The installer cannot fetch it (it
// runs in a build chroot), so it is fetched here once and kept on the pool.
async function ensureOciPlatformCert() {
    if (fs.existsSync(OCI_PLATFORM_CERT_PATH)) return;
    try {
        const pem = await imdsCall('GET', '/opc/v2/identity/cert', { 'Authorization': 'Bearer Oracle' });
        if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new Error('not a PEM certificate');
        new crypto.X509Certificate(pem);  // parse check
        const tmp = OCI_PLATFORM_CERT_PATH + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, pem, { mode: 0o640 });
        fs.renameSync(tmp, OCI_PLATFORM_CERT_PATH);
        audit({ event: 'oci_platform_cert_stored', path: OCI_PLATFORM_CERT_PATH });
    } catch (e) {
        audit({ event: 'oci_platform_cert_unavailable', message: e.message });
    }
}

// ── Challenge state ──────────────────────────────────────────────────────────
//
// Every announce carries a fresh random challenge nonce. A relying party
// that wants to verify the announced IP GETs
// http://<reportedIp>:8443/.well-known/safebox-announce-challenge/<nonce>
// and expecting back the nonce itself. We hold the nonce in memory; expire
// after 5 minutes.

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
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o750 });
        const tmp = STATE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o640 });
        fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
        audit({ event: 'state_save_failed', message: e.message });
    }
}

// ── Ed25519 identity ─────────────────────────────────────────────────────────

function canonicalize(value) { return ocp.canonicalize(value); }

function loadIdentityKey() {
    const pem = fs.readFileSync(IDENTITY_KEY_PATH, 'utf8');
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('identity.key is not an Ed25519 key');
    return key;
}

// Generate the identity keypair on first run. The private key never leaves
// the pool (0400 safebox-dns). An existing key is always reused: the box's
// public key is its identity, and a relying party that has seen it once
// treats a different key under the same safeboxId as a second box.
function ensureIdentityKey() {
    try {
        return loadIdentityKey();
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const tmp = IDENTITY_KEY_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, pem, { mode: 0o400 });
    fs.chmodSync(tmp, 0o400);
    fs.renameSync(tmp, IDENTITY_KEY_PATH);
    audit({ event: 'identity_key_generated', path: IDENTITY_KEY_PATH,
            boxPubkey: ocp.publicKeyHexFromKey(privateKey) });
    return privateKey;
}

// ── Image root hash ──────────────────────────────────────────────────────────
//
// The dm-verity root hash of the running image. The build stamps it at
// /etc/safebox/image-hash on the verity root (the same file
// instanceIdentity.js reads); the kernel command line carries it as
// roothash=<hex> and GRUB measures that line into PCR 8, so the two agree
// on a box that booted the image it claims. The relying party does not
// trust this field: it is the lookup key into its blessed-image set, whose
// PCR values the quote must then match.

function readImageRootHash() {
    if (process.env.SAFEBOX_IMAGE_HASH) return String(process.env.SAFEBOX_IMAGE_HASH).trim();
    try {
        const v = fs.readFileSync(IMAGE_HASH_PATH, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(v)) return v;
    } catch { /* fall through to the command line */ }
    try {
        const m = fs.readFileSync('/proc/cmdline', 'utf8').match(/\broothash=([0-9a-f]{64})\b/);
        if (m) return m[1];
    } catch { /* no cmdline */ }
    throw Object.assign(new Error('image root hash unavailable (no /etc/safebox/image-hash, no roothash= on the command line)'),
        { code: 'NO_IMAGE_HASH' });
}

// ── HTTPS POST ───────────────────────────────────────────────────────────────

function postJson(baseUrl, endpoint, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const url = new URL(baseUrl + endpoint);
        const req = https.request({
            method: 'POST',
            host:   url.hostname,
            port:   url.port || 443,
            path:   url.pathname + (url.search || ''),
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent':     'safebox-dnsclient/3.0',
            },
            timeout: timeoutMs || ANNOUNCE_TIMEOUT_MS,
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
                        `${endpoint} returned ${res.statusCode}: ${(parsed && parsed.message) || buf.slice(0, 256)}`),
                        { code: 'API_FAILED', httpStatus: res.statusCode }));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${endpoint} timeout`)); });
        req.write(body);
        req.end();
    });
}

// ── Memory-encryption gate ───────────────────────────────────────────────────
//
// Fix 8 of the hardening plan: a hypervisor insider can read a box's memory
// unless it runs under SEV-SNP or TDX. The attestation client attaches the
// hardware report to every quote; a box without one is refused here unless
// the image was built with allowUnencryptedMemory (a build-time choice, not
// something the metadata or the pool can flip).

function requireEncryptedMemory(cfg, quote, phase) {
    const c = quote && quote.confidential;
    if (!c || typeof c.type !== 'string') {
        throw Object.assign(new Error('quote carries no confidential-compute field'),
            { code: 'MEMORY_NOT_ENCRYPTED' });
    }
    if (c.type === 'none' && !cfg.allowUnencryptedMemory) {
        audit({ event: 'memory_not_encrypted', phase, cloud: cfg.cloud, source: c.source || null,
                message: 'this box was launched without confidential compute (no SEV-SNP or TDX report); '
                       + 'the image refuses to ' + phase + ' because allowUnencryptedMemory is false. '
                       + 'Relaunch on a confidential shape (confidential compute is on by default; '
                       + 'check that skip_confidential_compute is not set to true) or rebuild the image '
                       + 'with allowUnencryptedMemory for non-confidential shapes.' });
        throw Object.assign(new Error(`${phase} refused: memory is not encrypted and allowUnencryptedMemory is false`),
            { code: 'MEMORY_NOT_ENCRYPTED' });
    }
    if (c.type === 'none') {
        audit({ event: 'memory_not_encrypted_allowed', phase, cloud: cfg.cloud,
                message: 'no confidential-compute report; proceeding because the image was built with allowUnencryptedMemory' });
    }
}

// ── Last announce (the chain) ────────────────────────────────────────────────

function loadLastAnnounce() {
    try { return JSON.parse(fs.readFileSync(LAST_ANNOUNCE_PATH, 'utf8')); }
    catch { return null; }
}

function saveLastAnnounce(claim) {
    config.writeJsonAtomic(LAST_ANNOUNCE_PATH, claim, 0o640);
}

// ── Announce claim ───────────────────────────────────────────────────────────
//
// Everything a relying party verifies is inside the signed statement. The
// quote nonce binds the quote to the owner's authorization (and, after the
// first announce, to the previous link of this box's chain); the
// confidential report is bound to the quote by its REPORT_DATA; the box
// signature covers all of it. A replayed claim carries a stale issuedAt and
// a prev the relying party has already seen.

function buildAnnounceClaim(cfg, privateKey, publicIp, prevClaim) {
    const auth = cfg.launchAuthorization;
    const nowSec = Math.floor(Date.now() / 1000);
    // The authorization's validity window (at most 24 h) governs the launch
    // announce, the first link of the chain. Later links reuse the same
    // authorization past its window: a relying party admits the box at
    // launch and then follows the chain by boxPubkey and prev.
    const authCheck = ocp.checkLaunchAuthorization(auth, {
        safeboxId: cfg.safeboxId, ownerPubkey: cfg.ownerPubkey, now: prevClaim ? null : nowSec,
    });
    if (!authCheck.ok) {
        throw Object.assign(new Error('launch authorization rejected: ' + authCheck.reasons.join('; ')),
            { code: 'AUTHORIZATION_INVALID' });
    }
    const imageRootHash = readImageRootHash();
    const prev = prevClaim ? ocp.claimHash(prevClaim) : null;
    const quote = attestationClient.quote(ocp.announceNonce(auth, prev));
    requireEncryptedMemory(cfg, quote, 'announce');
    const confidential = quote.confidential;
    const quoteOnly = Object.assign({}, quote);
    delete quoteOnly.confidential;

    const boxPubkey = ocp.publicKeyHexFromKey(privateKey);
    const claim = {
        ocp: 1,
        iss: 'safebox:key:' + boxPubkey,
        sub: 'safebox:' + cfg.safeboxId,
        stm: {
            type: 'safebox_announce',
            safeboxId: cfg.safeboxId,
            boxPubkey,
            ownerPubkey: cfg.ownerPubkey,
            launchAuthorization: auth,
            imageRootHash,
            cloud: cfg.cloud,
            publicIp,
            challenge: newChallenge(),
            quote: quoteOnly,
            confidential,
            issuedAt: nowSec,
            prev,
        },
        nbf: nowSec,
    };
    return ocp.signClaim(claim, privateKey);
}

// Deliver one claim to every configured destination. The Safenet
// transparency log is reached through the peer's gossip intake,
// POST <peer>/safenet/v1/gossip {claim, from, ttl} (PROTOCOL.md 8.2 and
// 11.2); a peer that does not yet know the safebox_announce type answers
// 200 with accepted:false, which is logged, not fatal. Relays take the
// bare claim at POST <relay>/announce (tools/dns-relay). Nothing here waits
// on any single destination, and a total failure is retried on the next
// heartbeat.
async function deliverTo(cfg, claim) {
    const attempts = [];
    for (const base of cfg.safenetLogs) {
        attempts.push(postJson(base, '/safenet/v1/gossip', { claim, from: claim.iss, ttl: 8 })
            .then((r) => ({ kind: 'safenet', url: base, ok: true, status: r.status,
                            accepted: !(r.body && r.body.accepted === false), reason: r.body && r.body.reason }))
            .catch((e) => ({ kind: 'safenet', url: base, ok: false, message: e.message, httpStatus: e.httpStatus })));
    }
    for (const base of cfg.dnsRelays) {
        attempts.push(postJson(base, '/announce', claim)
            .then((r) => ({ kind: 'relay', url: base, ok: true, status: r.status,
                            accepted: !(r.body && r.body.ok === false), reason: r.body && (r.body.reasons || r.body.message) }))
            .catch((e) => ({ kind: 'relay', url: base, ok: false, message: e.message, httpStatus: e.httpStatus })));
    }
    const results = await Promise.all(attempts);
    for (const r of results) {
        audit(Object.assign({ event: r.ok ? (r.accepted ? 'deliver_ok' : 'deliver_rejected') : 'deliver_failed' }, r));
    }
    return results;
}

async function announce(ctx, reason) {
    const { cfg, privateKey, state } = ctx;
    let publicIp;
    try {
        publicIp = await getPublicIp(cfg.cloud);
    } catch (e) {
        audit({ event: 'announce_skipped_no_ip', reason, message: e.message });
        return { ok: false, code: 'IMDS_UNAVAILABLE' };
    }

    let claim;
    try {
        claim = buildAnnounceClaim(cfg, privateKey, publicIp, ctx.lastAnnounce);
    } catch (e) {
        audit({ event: 'announce_skipped', reason, message: e.message, code: e.code });
        const code = ['MEMORY_NOT_ENCRYPTED', 'AUTHORIZATION_INVALID', 'NO_IMAGE_HASH'].includes(e.code)
            ? e.code : 'ATTESTATION_FAILED';
        return { ok: false, code };
    }

    // The chain advances as soon as the claim exists: a relying party that
    // missed one link still sees prev pointing at it.
    try { saveLastAnnounce(claim); ctx.lastAnnounce = claim; }
    catch (e) { audit({ event: 'last_announce_save_failed', message: e.message }); }

    const results = await deliverTo(cfg, claim);
    const delivered = results.filter((r) => r.ok && r.accepted).length;
    state.lastAnnouncedIp   = publicIp;
    state.lastAttestationMs = Date.now();
    state.announceCount     = (state.announceCount || 0) + 1;
    state.lastAnnounceHash  = ocp.claimHash(claim);
    state.lastDelivered     = delivered;
    saveState(state);
    if (delivered > 0 && !fs.existsSync(ANNOUNCED_MARKER)) {
        try { fs.writeFileSync(ANNOUNCED_MARKER, new Date().toISOString() + '\n', { mode: 0o640 }); }
        catch (e) { audit({ event: 'announced_marker_failed', message: e.message }); }
    }
    audit({ event: delivered > 0 ? 'announce_ok' : 'announce_undelivered', reason, ip: publicIp,
            delivered, destinations: results.length, announceCount: state.announceCount,
            hash: state.lastAnnounceHash, retryInMs: delivered > 0 ? null : HEARTBEAT_INTERVAL_MS });
    return { ok: delivered > 0, ip: publicIp, claim, results, code: delivered > 0 ? undefined : 'ANNOUNCE_UNDELIVERED' };
}

// ── Challenge HTTP server ────────────────────────────────────────────────────
//
// A relying party calls back to http://<publicIp>:8443/.well-known/safebox-announce-challenge/<nonce>
// to confirm we control the claimed IP. We respond 200 with the nonce body if
// the nonce is one we recently generated; 404 otherwise. Clear-text HTTP: the
// nonce is single-use and discarded after verification.

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
    audit({ event: 'startup', safeboxId: cfg.safeboxId, cloud: cfg.cloud, ownerPubkey: cfg.ownerPubkey,
            dnsRelays: cfg.dnsRelays, safenetLogs: cfg.safenetLogs,
            authorizationExpiresAt: cfg.launchAuthorization.stm.expiresAt });

    if (cfg.cloud === 'oci') await ensureOciPlatformCert();

    // Identity: generated on the first run, reused forever after. Nothing is
    // exchanged for it; the announce below is the box's whole introduction.
    const privateKey = ensureIdentityKey();
    const state = loadState();
    const ctx = { cfg, privateKey, state, lastAnnounce: loadLastAnnounce() };
    startChallengeServer();

    // Initial announce (don't fail startup if it fails; the heartbeat retries)
    await announce(ctx, ctx.lastAnnounce ? 'startup' : 'first_announce');

    // Periodic heartbeat; also the retry for undelivered announces
    setInterval(async () => {
        await announce(ctx, 'heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    // IP change watcher (more frequent than heartbeat)
    setInterval(async () => {
        let currentIp;
        try { currentIp = await getPublicIp(cfg.cloud); }
        catch { return; }
        if (currentIp !== state.lastAnnouncedIp) {
            audit({ event: 'ip_changed', from: state.lastAnnouncedIp, to: currentIp });
            await announce(ctx, 'ip_changed');
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
    _buildAnnounceClaim: buildAnnounceClaim,
    _canonicalize:     canonicalize,
    _getPublicIp:      getPublicIp,
    _requireEncryptedMemory: requireEncryptedMemory,
    _ensureIdentityKey: ensureIdentityKey,
    _readImageRootHash: readImageRootHash,
    _deliverTo:        deliverTo,
    IDENTITY_KEY_PATH,
    LAST_ANNOUNCE_PATH,
    ANNOUNCED_MARKER,
};
