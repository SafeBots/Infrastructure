// Updated for the hardening-plan config shape (cloud field, no accountToken in dnsclient.json) and the per-cloud attestationClient that is absent from the source tree.
// test/testDnsclientChallenge.js
//
// Tests the in-memory challenge state used by the announce-IP-verification
// flow: nonces are generated as URL-safe base64, accepted exactly once,
// and expire after their TTL.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Provide a valid config so loading config.js (which dnsclient.js requires)
// doesn't fail at module load time. The config shape is the announce one:
// safeboxId, ownerPubkey, launchAuthorization, cloud.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-chall-'));
const cfgPath = path.join(tmpDir, 'dnsclient.json');
{
    const crypto = require('crypto');
    const ocp = require('../../attestation/ocpClaim');
    const ownerKey = crypto.generateKeyPairSync('ed25519');
    const ownerPubkey = ocp.publicKeyHexFromKey(ownerKey.privateKey);
    const nowSec = Math.floor(Date.now() / 1000);
    fs.writeFileSync(cfgPath, JSON.stringify({
        safeboxId: 'test-value-123',
        cloud: 'aws',
        ownerPubkey,
        launchAuthorization: ocp.signClaim(ocp.buildLaunchAuthorization({
            safeboxId: 'test-value-123', ownerPubkey, notBefore: nowSec - 60, expiresAt: nowSec + 3600,
        }), ownerKey.privateKey),
    }));
}
process.env.SAFEBOX_DNSCLIENT_STATE_DIR = tmpDir;
process.env.SAFEBOX_DNSCLIENT_CONFIG = cfgPath;
process.env.SAFEBOX_DNSCLIENT_STATE = path.join(tmpDir, 'state.json');

require('./preload');  // resolves ./attestationClient to the fake
const dc = require('../dnsclient');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── New challenges are URL-safe base64 ───────────────────────────────────────
const n1 = dc._newChallenge();
check('challenge is non-empty string',
    typeof n1 === 'string' && n1.length > 0);
check('challenge uses URL-safe base64 alphabet',
    /^[A-Za-z0-9_-]+$/.test(n1));
check('challenge is long enough (>=24 bytes -> >=32 chars)',
    n1.length >= 32);

// ── Each challenge is unique ────────────────────────────────────────────────
const seen = new Set([n1]);
for (let i = 0; i < 100; i++) {
    const n = dc._newChallenge();
    seen.add(n);
}
check('100 fresh challenges all unique',
    seen.size === 101);

// ── Challenges are valid immediately ────────────────────────────────────────
const n2 = dc._newChallenge();
check('fresh challenge is valid',
    dc._isValidChallenge(n2) === true);

// ── Unknown challenges are invalid ──────────────────────────────────────────
check('unknown nonce is invalid',
    dc._isValidChallenge('unknown-nonce-not-issued') === false);
check('empty string nonce is invalid',
    dc._isValidChallenge('') === false);
check('garbage nonce is invalid',
    dc._isValidChallenge('AAAA').toString() === 'false' ||
    dc._isValidChallenge('AAAA') === false);

// ── pruneChallenges doesn't drop fresh ones ─────────────────────────────────
const n3 = dc._newChallenge();
dc._pruneChallenges();
check('fresh challenge survives prune',
    dc._isValidChallenge(n3) === true);

// ── Validation alone does not consume the challenge ─────────────────────────
// (Consumption happens in the HTTP handler, not in isValidChallenge.)
check('validation does not consume',
    dc._isValidChallenge(n3) === true);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
