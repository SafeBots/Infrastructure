// test/testDnsclientMemoryGate.js
//
// The memory-encryption gate (docs/HARDENING-PLAN.md fix 8): a quote whose
// confidential.type is "none" is refused with MEMORY_NOT_ENCRYPTED when the
// announce claim is built, unless the image's defaults.json says
// allowUnencryptedMemory: true. Uses the fake attestation client in
// "none" mode (SAFEBOX_FAKE_CONFIDENTIAL=none) and a temp defaults.json.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-memgate-'));
const cfgPath = path.join(tmpDir, 'dnsclient.json');
const defaultsPath = path.join(tmpDir, 'defaults.json');
const ocp = require('../../attestation/ocpClaim');
const ownerKey = crypto.generateKeyPairSync('ed25519');
const ownerPubkey = ocp.publicKeyHexFromKey(ownerKey.privateKey);
const now = Math.floor(Date.now() / 1000);
const auth = ocp.signClaim(ocp.buildLaunchAuthorization({
    safeboxId: 'memgate-test-1', ownerPubkey, notBefore: now - 60, expiresAt: now + 3600,
}), ownerKey.privateKey);
fs.writeFileSync(cfgPath, JSON.stringify({
    safeboxId: 'memgate-test-1', cloud: 'gcp', ownerPubkey, launchAuthorization: auth,
}));
fs.writeFileSync(defaultsPath, JSON.stringify({ dnsRelays: [], allowUnencryptedMemory: false }));
process.env.SAFEBOX_DNSCLIENT_STATE_DIR = tmpDir;
process.env.SAFEBOX_DNSCLIENT_CONFIG = cfgPath;
process.env.SAFEBOX_DNSCLIENT_DEFAULTS = defaultsPath;
process.env.SAFEBOX_DNSCLIENT_STATE = path.join(tmpDir, 'state.json');
process.env.SAFEBOX_DNSCLIENT_IDENTITY_KEY = path.join(tmpDir, 'identity.key');
process.env.SAFEBOX_IMAGE_HASH = 'a'.repeat(64);
process.env.SAFEBOX_FAKE_CONFIDENTIAL = 'none';

require('./preload');
const config = require('../config');
const dc = require('../dnsclient');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const privateKey = dc._ensureIdentityKey();

(async () => {
    // allowUnencryptedMemory: false → refused.
    let cfg = config.load();
    check('config reads allowUnencryptedMemory=false from defaults.json', cfg.allowUnencryptedMemory === false);

    let err = null;
    try { dc._buildAnnounceClaim(cfg, privateKey, '203.0.113.9', null); } catch (e) { err = e; }
    check('announce claim refused with MEMORY_NOT_ENCRYPTED', err && err.code === 'MEMORY_NOT_ENCRYPTED', err && err.message);
    check('no last-announce written after refusal', !fs.existsSync(dc.LAST_ANNOUNCE_PATH));
    check('no announced marker after refusal', !fs.existsSync(dc.ANNOUNCED_MARKER));

    // Missing defaults.json → still refused (falsy default).
    fs.rmSync(defaultsPath);
    cfg = config.load();
    check('missing defaults.json means allowUnencryptedMemory=false', cfg.allowUnencryptedMemory === false);
    check('missing defaults.json keeps the built-in relay list', cfg.dnsRelays.length === 1 && cfg.dnsRelays[0] === config.DEFAULT_DNS_RELAYS[0]);

    // Non-boolean true-ish value → still refused.
    fs.writeFileSync(defaultsPath, JSON.stringify({ allowUnencryptedMemory: 'true' }));
    check('string "true" is not accepted', config.load().allowUnencryptedMemory === false);

    // allowUnencryptedMemory: true → the gate passes; the claim is built.
    fs.writeFileSync(defaultsPath, JSON.stringify({ allowUnencryptedMemory: true }));
    cfg = config.load();
    check('config reads allowUnencryptedMemory=true', cfg.allowUnencryptedMemory === true);
    err = null;
    let claim = null;
    try { claim = dc._buildAnnounceClaim(cfg, privateKey, '203.0.113.9', null); } catch (e) { err = e; }
    check('announce claim built when unencrypted memory is allowed',
        !err && claim && claim.stm.confidential.type === 'none' && claim.stm.type === 'safebox_announce', err && err.message);

    // A quote with no confidential field at all is refused too.
    err = null;
    try { dc._requireEncryptedMemory(cfg, { nonce: 'x' }, 'announce'); } catch (e) { err = e; }
    check('quote without confidential field refused even when allowed', err && err.code === 'MEMORY_NOT_ENCRYPTED');

    // With the fake in its default (sev-snp) mode the gate passes under the strict default.
    delete process.env.SAFEBOX_FAKE_CONFIDENTIAL;
    fs.writeFileSync(defaultsPath, JSON.stringify({ allowUnencryptedMemory: false }));
    cfg = config.load();
    err = null;
    try { claim = dc._buildAnnounceClaim(cfg, privateKey, '203.0.113.9', null); } catch (e) { err = e; }
    check('sev-snp report passes the gate under the strict default',
        !err && claim.stm.confidential.type === 'sev-snp' && claim.stm.confidential.reportData.length === 128,
        err && err.message);
    check('claim quote carries no nested confidential copy', !err && claim.stm.quote.confidential === undefined);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})();
