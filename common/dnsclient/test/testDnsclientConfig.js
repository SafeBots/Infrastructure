#!/usr/bin/env node
// test/testDnsclientConfig.js
//
// config.js against the pool-resident layout: dnsclient.json
// {safeboxId, ownerPubkey, launchAuthorization, cloud} plus the image's
// defaults.json {dnsRelays, safenetLogs, allowUnencryptedMemory}. No
// registration token, no account file, no metadata fallback.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-cfg-'));
process.env.SAFEBOX_DNSCLIENT_STATE_DIR = tmp;
process.env.SAFEBOX_DNSCLIENT_CONFIG = path.join(tmp, 'dnsclient.json');
process.env.SAFEBOX_DNSCLIENT_DEFAULTS = path.join(tmp, 'defaults.json');

const ocp = require('../../attestation/ocpClaim');
const config = require('../config');

let passed = 0, total = 0;
function check(name, ok) {
    total++;
    if (ok) { passed++; console.log(`PASS ${name}`); }
    else    { console.log(`FAIL ${name}`); }
}
function writeCfg(obj) { fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(obj)); }
function writeDefaults(obj) { fs.writeFileSync(config.DEFAULTS_PATH, JSON.stringify(obj)); }
function loadErr() { try { config.load(); return null; } catch (e) { return e.message; } }

const owner = crypto.generateKeyPairSync('ed25519');
const ownerPubkey = ocp.publicKeyHexFromKey(owner.privateKey);
const now = Math.floor(Date.now() / 1000);
const auth = ocp.signClaim(ocp.buildLaunchAuthorization({
    safeboxId: 'sbx-abc-123', ownerPubkey, notBefore: now, expiresAt: now + 600,
}), owner.privateKey);
const good = { safeboxId: 'sbx-abc-123', ownerPubkey, launchAuthorization: auth, cloud: 'gcp' };
writeDefaults({ dnsRelays: ['https://relay-a.example/v1/', 'http://plain.example', 'https://relay-b.example'],
                safenetLogs: ['https://peer.example'], allowUnencryptedMemory: false });

writeCfg(good);
const cfg = config.load();
check('loads a valid config', cfg.safeboxId === 'sbx-abc-123' && cfg.cloud === 'gcp' && cfg.ownerPubkey === ownerPubkey);
check('launchAuthorization object passes through', cfg.launchAuthorization.stm.nonce === auth.stm.nonce);
check('dnsRelays from defaults, https only, trailing slash stripped',
    cfg.dnsRelays.length === 2 && cfg.dnsRelays[0] === 'https://relay-a.example/v1');
check('safenetLogs from defaults', cfg.safenetLogs.length === 1 && cfg.safenetLogs[0] === 'https://peer.example');

writeCfg(Object.assign({}, good, { launchAuthorization: ocp.encodeAuthorizationBase64(auth) }));
check('base64 launchAuthorization decoded', config.load().launchAuthorization.stm.safeboxId === 'sbx-abc-123');

writeCfg(Object.assign({}, good, { launchAuthorization: undefined }));
check('missing launchAuthorization rejected', /launchAuthorization/.test(loadErr() || ''));

writeCfg(Object.assign({}, good, { safeboxId: 'sbx_ABC' }));
check('old sbx_ id format rejected', /safeboxId/.test(loadErr() || ''));

writeCfg(Object.assign({}, good, { ownerPubkey: 'ABCD' }));
check('short ownerPubkey rejected', /ownerPubkey/.test(loadErr() || ''));

const otherOwner = ocp.publicKeyHexFromKey(crypto.generateKeyPairSync('ed25519').privateKey);
writeCfg(Object.assign({}, good, { ownerPubkey: otherOwner }));
check('authorization signed by another owner rejected', /ownerPubkey does not match|not signed/.test(loadErr() || ''));

const tampered = JSON.parse(JSON.stringify(auth)); tampered.stm.safeboxId = 'sbx-abc-124';
writeCfg(Object.assign({}, good, { launchAuthorization: tampered }));
check('tampered authorization rejected', /launchAuthorization/.test(loadErr() || ''));

const expired = ocp.signClaim(ocp.buildLaunchAuthorization({
    safeboxId: 'sbx-abc-123', ownerPubkey, notBefore: now - 7200, expiresAt: now - 3600 }), owner.privateKey);
writeCfg(Object.assign({}, good, { launchAuthorization: expired }));
check('expired authorization still loads (window is checked at announce time)', loadErr() === null);

writeCfg(Object.assign({}, good, { cloud: 'digitalocean' }));
check('unknown cloud rejected', /cloud/.test(loadErr() || ''));

writeCfg(Object.assign({}, good, { registrationToken: 'A'.repeat(40), dnsApiUrl: 'https://x.example' }));
const loaded = config.load();
check('legacy registrationToken/dnsApiUrl keys ignored', loaded.registrationToken === undefined && loaded.dnsApiUrl === undefined);

fs.rmSync(config.DEFAULTS_PATH);
writeCfg(good);
check('no defaults.json -> built-in relay list, no logs', config.load().dnsRelays[0] === config.DEFAULT_DNS_RELAYS[0] && config.load().safenetLogs.length === 0);

config.writeJsonAtomic(path.join(tmp, 'x.json'), { a: 1 }, 0o640);
check('writeJsonAtomic applies the mode', (fs.statSync(path.join(tmp, 'x.json')).mode & 0o777) === 0o640);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
