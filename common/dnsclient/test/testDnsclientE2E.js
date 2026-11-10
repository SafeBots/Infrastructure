// test/testDnsclientE2E.js
//
// End-to-end test: spin up a fake IMDS service, a fake DNS relay and a fake
// Safenet peer, run the dnsclient against them, and verify it:
//   1. Builds and delivers a safebox_announce claim on startup to both
//      destinations (relay: POST /announce; Safenet: POST /safenet/v1/gossip)
//   2. The claim passes common/attestation/verifyAnnounce.js against a
//      blessed set built from the fake PCRs
//   3. Persists its state, last-announce.json and the announced marker
//
// No registration: the box is identified by the Ed25519 key it generates
// on first run and the owner's signed launch authorization in its config.
// The attestation client is the fake in fakeAttestationClient.js, loaded
// through preload.js.

'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-e2e-'));

    // ── Fake IMDS server on 127.0.0.1:<port> ─────────────────────────────────
    // The dnsclient code hard-codes 169.254.169.254 — we override via env to
    // point at our fake. (See note below for how dnsclient supports this.)
    let currentIp = '203.0.113.10';
    const imdsServer = http.createServer((req, res) => {
        if (req.method === 'PUT' && req.url === '/latest/api/token') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('FAKE-IMDS-TOKEN');
            return;
        }
        if (req.method === 'GET' && req.url === '/latest/meta-data/public-ipv4') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(currentIp);
            return;
        }
        if (req.method === 'GET' && req.url === '/latest/dynamic/instance-identity/document') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ instanceId: 'i-test-abc', region: 'us-test-1' }));
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise(r => imdsServer.listen(0, '127.0.0.1', r));
    const imdsPort = imdsServer.address().port;

    // ── Fake relay and fake Safenet peer on 127.0.0.1 ──────────────────────
    const relayAnnounces = [];
    const gossips = [];
    const sink = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                if (req.method === 'POST' && req.url === '/v1/announce') {
                    relayAnnounces.push(payload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (req.method === 'POST' && req.url === '/safenet/v1/gossip') {
                    gossips.push(payload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ accepted: true }));
                    return;
                }
                res.writeHead(404); res.end();
            } catch (e) {
                res.writeHead(400); res.end(e.message);
            }
        });
    });
    await new Promise(r => sink.listen(0, '127.0.0.1', r));
    const sinkPort = sink.address().port;

    // ── Write dnsclient config and image defaults ────────────────────────────
    const ocp = require('../../attestation/ocpClaim');
    const ownerKey = crypto.generateKeyPairSync('ed25519');
    const ownerPubkey = ocp.publicKeyHexFromKey(ownerKey.privateKey);
    const nowSec = Math.floor(Date.now() / 1000);
    const auth = ocp.signClaim(ocp.buildLaunchAuthorization({
        safeboxId: 'e2e-test-12345', ownerPubkey, notBefore: nowSec - 60, expiresAt: nowSec + 3600,
    }), ownerKey.privateKey);
    const cfgPath = path.join(tmpDir, 'dnsclient.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
        safeboxId: 'e2e-test-12345',
        cloud: 'aws',
        ownerPubkey,
        launchAuthorization: ocp.encodeAuthorizationBase64(auth),
    }));
    const defaultsPath = path.join(tmpDir, 'defaults.json');
    fs.writeFileSync(defaultsPath, JSON.stringify({
        dnsRelays: [`https://127.0.0.1:${sinkPort}/v1`],
        safenetLogs: [`https://127.0.0.1:${sinkPort}`],
        allowUnencryptedMemory: false,
    }));
    const IMAGE_HASH = crypto.createHash('sha256').update('e2e-image').digest('hex');

    // ── Spawn the dnsclient as a child process ───────────────────────────────
    // To make the test work without HTTPS certs and without true IMDS, we
    // need dnsclient to (a) talk plain HTTP to our fake DNS API and
    // (b) talk to our fake IMDS on a different port. We do this by patching
    // the running process via NODE_OPTIONS with a small shim that intercepts
    // http.request and https.request.
    const shimPath = path.join(tmpDir, 'shim.js');
    fs.writeFileSync(shimPath, `
        const http = require('http');
        const https = require('https');
        const origHttpReq = http.request;
        const origHttpsReq = https.request;
        http.request = function(opts, cb) {
            if (opts && opts.host === '169.254.169.254') {
                opts = Object.assign({}, opts, { host: '127.0.0.1', port: ${imdsPort} });
            }
            return origHttpReq.call(this, opts, cb);
        };
        https.request = function(opts, cb) {
            // Test mode: rewrite https → http to our fake relay/peer.
            // Compare port loosely since the caller may pass it as a string.
            if (opts && opts.host === '127.0.0.1' && Number(opts.port) === ${sinkPort}) {
                return origHttpReq.call(this, opts, cb);
            }
            return origHttpsReq.call(this, opts, cb);
        };
    `);

    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // The box generates its identity key on first run; we only name the path.
    const identityKeyPath = path.join(stateDir, 'identity.key');

    const dnsclientPath = path.resolve(__dirname, '..', 'dnsclient.js');
    const preloadPath = path.join(__dirname, 'preload.js');
    const child = spawn(process.execPath, ['--require', preloadPath, '--require', shimPath, dnsclientPath], {
        env: Object.assign({}, process.env, {
            SAFEBOX_DNSCLIENT_STATE_DIR: stateDir,
            SAFEBOX_DNSCLIENT_CONFIG: cfgPath,
            SAFEBOX_DNSCLIENT_DEFAULTS: defaultsPath,
            SAFEBOX_DNSCLIENT_IDENTITY_KEY: identityKeyPath,
            SAFEBOX_DNSCLIENT_LAST_ANNOUNCE: path.join(stateDir, 'last-announce.json'),
            SAFEBOX_DNSCLIENT_ANNOUNCED_MARKER: path.join(stateDir, 'announced'),
            SAFEBOX_IMAGE_HASH: IMAGE_HASH,
            SAFEBOX_DNSCLIENT_STATE: path.join(stateDir, 'state.json'),
            SAFEBOX_DNSCLIENT_CHALLENGE_PORT: '0',  // bind to ephemeral; we won't test challenge here
        }),
        stdio: ['ignore', 'inherit', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (c) => childStderr += c);

    // ── Wait for the initial announce ────────────────────────────────────────
    let waited = 0;
    while ((relayAnnounces.length === 0 || gossips.length === 0) && waited < 8000) {
        await sleep(100); waited += 100;
    }

    check('announce arrived at the relay',
        relayAnnounces.length >= 1,
        `relay=${relayAnnounces.length}, stderr tail: ${childStderr.slice(-500)}`);
    check('announce arrived at the Safenet peer as gossip {claim, from, ttl}',
        gossips.length >= 1 && gossips[0].claim && typeof gossips[0].from === 'string' && Number.isInteger(gossips[0].ttl),
        JSON.stringify(gossips[0] || null).slice(0, 200));

    if (relayAnnounces.length >= 1) {
        const a = relayAnnounces[0];
        check('claim is a safebox_announce', a.stm && a.stm.type === 'safebox_announce');
        check('claim has safeboxId', a.stm.safeboxId === 'e2e-test-12345');
        check('claim has cloud', a.stm.cloud === 'aws');
        check('claim has publicIp from IMDS', a.stm.publicIp === '203.0.113.10');
        check('claim has ownerPubkey and the launch authorization', a.stm.ownerPubkey === ownerPubkey && a.stm.launchAuthorization.stm.nonce === auth.stm.nonce);
        check('claim has imageRootHash', a.stm.imageRootHash === IMAGE_HASH);
        check('first announce has prev = null', a.stm.prev === null);
        check('claim has a challenge nonce', typeof a.stm.challenge === 'string' && a.stm.challenge.length > 0);
        check('claim has a recent issuedAt',
            Number.isInteger(a.stm.issuedAt) && Math.abs(a.stm.issuedAt - Math.floor(Date.now() / 1000)) < 60);
        check('no accountToken, registrationToken or legacy fields',
            a.accountToken === undefined && a.registrationToken === undefined && a.stm.reportedIp === undefined);
        check('same claim went to the Safenet peer', gossips.length >= 1 && ocp.claimHash(gossips[0].claim) === ocp.claimHash(a));

        // The quote nonce is sha256(canonical(authorization)) on the launch link.
        check('quote nonce binds the launch authorization',
            a.stm.quote && a.stm.quote.nonce === ocp.announceNonce(a.stm.launchAuthorization, null), JSON.stringify(a.stm.quote && a.stm.quote.nonce));
        check('quote covers the policy PCRs', a.stm.quote && Array.isArray(a.stm.quote.pcrPolicyList) && a.stm.quote.pcrPolicyList.join(',') === '0,2,4,7,8,9,14,15');
        check('confidential report is beside the quote and bound to it',
            a.stm.confidential && a.stm.confidential.type === 'sev-snp' && a.stm.confidential.reportData.length === 128
                && a.stm.quote.confidential === undefined, JSON.stringify(a.stm.confidential && a.stm.confidential.type));

        // The identity key the child generated signs the claim.
        const keyPem = fs.readFileSync(identityKeyPath, 'utf8');
        const boxPubkey = ocp.publicKeyHexFromKey(crypto.createPrivateKey(keyPem));
        check('claim is Ed25519-signed by the generated identity key',
            a.stm.boxPubkey === boxPubkey && ocp.verifyClaim(a).ok && a.key[0] === boxPubkey);
        check('identity key is 0400', (fs.statSync(identityKeyPath).mode & 0o777) === 0o400);

        // A relying party verifies it against a blessed set for the fake PCRs.
        const fake = require('./fakeAttestationClient');
        const { verifyAnnounce } = require('../../attestation/verifyAnnounce');
        const blessedImages = { [IMAGE_HASH]: { pcrs: fake.pcrs() } };
        // The child process has its own fake VCEK; it travels in confidential.vcek
        // (on a real box: the cached VCEK the wrapper includes, which a real
        // relying party chains to the AMD root rather than trusting as sent).
        const v = verifyAnnounce(a, { blessedImages, fetchVcek: (c) => c.vcek });
        check('verifyAnnounce accepts the delivered claim', v.ok && v.chainVerified && v.launch && v.boxPubkey === boxPubkey, v.reasons.join(' | '));
        const v2 = verifyAnnounce(a, { blessedImages: { [IMAGE_HASH]: { pcrs: Object.assign(fake.pcrs(), { 9: 'f'.repeat(64) }) } } });
        check('verifyAnnounce rejects it under a different blessed PCR set', !v2.ok);
    }

    // ── Simulate IP change and verify re-announce ────────────────────────────
    currentIp = '203.0.113.99';
    // The dnsclient polls every 60s. We'd have to wait too long. Instead,
    // we just verify that the first announce captured the right IP — the
    // re-announce-on-change logic is tested separately at the unit level.

    // ── Verify state, last-announce and marker were written ─────────────────
    const stateFile = path.join(stateDir, 'state.json');
    await sleep(200);  // give it time to save
    let stateContent = null;
    try { stateContent = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    check('state file persisted',
        stateContent !== null &&
        stateContent.lastAnnouncedIp === '203.0.113.10' &&
        stateContent.announceCount >= 1 && stateContent.lastDelivered === 2,
        JSON.stringify(stateContent));
    let last = null;
    try { last = JSON.parse(fs.readFileSync(path.join(stateDir, 'last-announce.json'), 'utf8')); } catch {}
    check('last-announce.json holds the delivered claim',
        last && relayAnnounces.length >= 1 && ocp.claimHash(last) === ocp.claimHash(relayAnnounces[0]));
    check('announced marker touched after delivery', fs.existsSync(path.join(stateDir, 'announced')));
    check('no account.json or registered marker', !fs.existsSync(path.join(stateDir, 'account.json')) && !fs.existsSync(path.join(stateDir, 'registered')));

    // ── Cleanup ──────────────────────────────────────────────────────────────
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
    imdsServer.close();
    sink.close();
    await sleep(100);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
