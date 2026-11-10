#!/usr/bin/env node
// common/attestation/test/testVerifyAnnounce.js
//
// verifyAnnounce.js against synthetic claims: an owner key signs a launch
// authorization, dnsclient's real buildAnnounceClaim (with the fake
// attestation client from common/dnsclient/test) produces the announce, two
// auditor keys sign an image_blessing for the fake PCR set, and the
// verifier is run on the good claim and on one mutation per check.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-announce-'));
const ownerKey = crypto.generateKeyPairSync('ed25519');
const ocp = require('../ocpClaim');
const ownerPubkey = ocp.publicKeyHexFromKey(ownerKey.privateKey);
const SAFEBOX_ID = 'verify-test-1';
const IMAGE_HASH = crypto.createHash('sha256').update('fake-image').digest('hex');
const now = Math.floor(Date.now() / 1000);

const auth = ocp.signClaim(ocp.buildLaunchAuthorization({
    safeboxId: SAFEBOX_ID, ownerPubkey, notBefore: now - 60, expiresAt: now + 3600,
}), ownerKey.privateKey);

fs.writeFileSync(path.join(tmpDir, 'dnsclient.json'), JSON.stringify({
    safeboxId: SAFEBOX_ID, ownerPubkey, cloud: 'gcp', launchAuthorization: ocp.encodeAuthorizationBase64(auth),
}));
fs.writeFileSync(path.join(tmpDir, 'defaults.json'), JSON.stringify({ dnsRelays: [], safenetLogs: [], allowUnencryptedMemory: false }));
process.env.SAFEBOX_DNSCLIENT_STATE_DIR = tmpDir;
process.env.SAFEBOX_DNSCLIENT_CONFIG = path.join(tmpDir, 'dnsclient.json');
process.env.SAFEBOX_DNSCLIENT_DEFAULTS = path.join(tmpDir, 'defaults.json');
process.env.SAFEBOX_DNSCLIENT_STATE = path.join(tmpDir, 'state.json');
process.env.SAFEBOX_DNSCLIENT_IDENTITY_KEY = path.join(tmpDir, 'identity.key');
process.env.SAFEBOX_IMAGE_HASH = IMAGE_HASH;

require('../../dnsclient/test/preload');
const fake = require('../../dnsclient/test/fakeAttestationClient');
const config = require('../../dnsclient/config');
const dc = require('../../dnsclient/dnsclient');
const { verifyAnnounce, buildBlessedImages } = require('../verifyAnnounce');
const ocpVerify = require('../../../aws/scripts/components/system/ocpVerify');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── Auditors bless the fake image (ES256, ocpVerify format) ────────────────
function es256Signer() {
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { priv: k.privateKey, spki: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
const auditors = [es256Signer(), es256Signer(), es256Signer()];
function bless(imageHash, pcrs, signers, extra) {
    const claim = Object.assign({
        ocp: 1, iss: 'safenet:auditors', sub: 'safenet:image:' + imageHash,
        stm: { type: 'image_blessing', imageHash, version: '1.0.0', pcrs },
        nbf: now - 100, exp: now + 86400,
    }, extra || {});
    const data = Buffer.from(ocpVerify.canonicalize({ ocp: claim.ocp, iss: claim.iss, sub: claim.sub, stm: claim.stm, nbf: claim.nbf, exp: claim.exp }));
    claim.key = signers.map((s) => s.spki);
    claim.sig = signers.map((s) => crypto.sign('sha256', data, { key: s.priv, dsaEncoding: 'der' }).toString('base64'));
    return claim;
}
const trustedKeys = new Set(auditors.map((a) => a.spki));
const goodBlessing = bless(IMAGE_HASH, fake.pcrs(), auditors.slice(0, 2));
const underSigned = bless('b'.repeat(64), fake.pcrs(), auditors.slice(0, 1));
const untrusted = bless('c'.repeat(64), fake.pcrs(), [es256Signer(), es256Signer()]);
const blessed = buildBlessedImages([goodBlessing, underSigned, untrusted], { trustedKeys, minSigners: 2 });
check('blessing with 2 of 3 trusted signers accepted', !!blessed[IMAGE_HASH] && blessed[IMAGE_HASH].signers.length === 2);
check('blessing with 1 signer rejected under M=2', !blessed['b'.repeat(64)]);
check('blessing by untrusted keys rejected', !blessed['c'.repeat(64)]);

// ── The box announces ──────────────────────────────────────────────────────
const cfg = config.load();
const boxKey = dc._ensureIdentityKey();
const boxPubkey = ocp.publicKeyHexFromKey(boxKey);
const first = dc._buildAnnounceClaim(cfg, boxKey, '203.0.113.7', null);
const second = dc._buildAnnounceClaim(cfg, boxKey, '203.0.113.8', first);

const fetchVcek = () => fake.VCEK_PEM;
let r = verifyAnnounce(first, { blessedImages: blessed, now, fetchVcek });
check('launch announce verifies', r.ok, r.reasons.join(' | '));
check('result carries first-seen hints', r.safeboxId === SAFEBOX_ID && r.boxPubkey === boxPubkey && r.launch === true && r.prev === null);
check('sev-snp chain verified with fetchVcek', r.chainVerified === true);
check('announceHash is the claim hash', r.announceHash === ocp.claimHash(first));

r = verifyAnnounce(first, { blessedImages: blessed, now });
check('verifies without fetchVcek (chain unverified)', r.ok && r.chainVerified === false, r.reasons.join(' | '));

r = verifyAnnounce(second, { blessedImages: blessed, now });
check('chained announce verifies with prev = hash of the first', r.ok && r.prev === ocp.claimHash(first) && r.launch === false, r.reasons.join(' | '));

// Chained announce past the authorization window still verifies (window
// applies to the launch link only).
r = verifyAnnounce(second, { blessedImages: blessed, now: now + 2 * 86400, maxSkewSeconds: 3 * 86400 });
check('chained announce accepted after the authorization window', r.ok, r.reasons.join(' | '));
r = verifyAnnounce(first, { blessedImages: blessed, now: now + 2 * 86400, maxSkewSeconds: 3 * 86400 });
check('launch announce needs issuedAt inside the window', r.ok, r.reasons.join(' | '));

// ── Mutations ──────────────────────────────────────────────────────────────
function mutate(claim, fn) { const c = JSON.parse(JSON.stringify(claim)); fn(c); return c; }
function expectReason(name, claim, re, opts) {
    const res = verifyAnnounce(claim, Object.assign({ blessedImages: blessed, now }, opts || {}));
    check(name, !res.ok && res.reasons.some((x) => re.test(x)), res.reasons.join(' | '));
}

expectReason('tampered publicIp breaks the box signature',
    mutate(first, (c) => { c.stm.publicIp = '198.51.100.1'; }), /box signature/);
expectReason('claim signed by another key rejected',
    ocp.signClaim(mutate(first, (c) => { delete c.key; delete c.sig; }), crypto.generateKeyPairSync('ed25519').privateKey),
    /not signed by stm.boxPubkey|iss does not match/);
expectReason('authorization signed by a different owner rejected',
    (() => {
        const other = crypto.generateKeyPairSync('ed25519');
        const badAuth = ocp.signClaim(ocp.buildLaunchAuthorization({
            safeboxId: SAFEBOX_ID, ownerPubkey, notBefore: now - 60, expiresAt: now + 3600 }), other.privateKey);
        return ocp.signClaim(mutate(first, (c) => { c.stm.launchAuthorization = badAuth; delete c.key; delete c.sig; }), boxKey);
    })(), /launchAuthorization/);
expectReason('expired authorization on a launch announce rejected',
    (() => {
        const old = ocp.signClaim(ocp.buildLaunchAuthorization({
            safeboxId: SAFEBOX_ID, ownerPubkey, notBefore: now - 90000, expiresAt: now - 3600 }), ownerKey.privateKey);
        return ocp.signClaim(mutate(first, (c) => { c.stm.launchAuthorization = old; delete c.key; delete c.sig; }), boxKey);
    })(), /expired/);
expectReason('authorization for another safeboxId rejected',
    (() => {
        const otherAuth = ocp.signClaim(ocp.buildLaunchAuthorization({
            safeboxId: 'someone-else', ownerPubkey, notBefore: now - 60, expiresAt: now + 3600 }), ownerKey.privateKey);
        return ocp.signClaim(mutate(first, (c) => { c.stm.launchAuthorization = otherAuth; delete c.key; delete c.sig; }), boxKey);
    })(), /different safeboxId/);
expectReason('authorization window over 24h rejected',
    (() => {
        const long = mutate(auth, (a) => { a.stm.expiresAt = now + 90000; a.exp = now + 90000; delete a.key; delete a.sig; });
        const signed = ocp.signClaim(long, ownerKey.privateKey);
        return ocp.signClaim(mutate(first, (c) => { c.stm.launchAuthorization = signed; delete c.key; delete c.sig; }), boxKey);
    })(), /exceeds 24h/);
expectReason('quote nonce must bind the authorization',
    (() => {
        const wrongQuote = fake.quote('d'.repeat(64));
        return ocp.signClaim(mutate(first, (c) => {
            const q = Object.assign({}, wrongQuote); delete q.confidential;
            c.stm.quote = q; c.stm.confidential = wrongQuote.confidential; delete c.key; delete c.sig;
        }), boxKey);
    })(), /extraData does not equal/);
expectReason('AK signature over the quote is checked',
    ocp.signClaim(mutate(first, (c) => {
        const sig = Buffer.from(c.stm.quote.signature, 'base64'); sig[10] ^= 0xff;
        c.stm.quote.signature = sig.toString('base64'); delete c.key; delete c.sig;
    }), boxKey), /signature does not verify/);
expectReason('PCRs must equal the blessed set',
    first, /PCR0 differs|PCR8 differs|PCR\d+ differs/,
    { blessedImages: { [IMAGE_HASH]: { pcrs: Object.assign(fake.pcrs(), { 8: 'e'.repeat(64) }) } } });
expectReason('unblessed imageRootHash rejected',
    ocp.signClaim(mutate(first, (c) => { c.stm.imageRootHash = 'f'.repeat(64); delete c.key; delete c.sig; }), boxKey),
    /not a blessed image/);
expectReason('confidential type none rejected by default',
    ocp.signClaim(mutate(first, (c) => { c.stm.confidential = { type: 'none', report: null, reportData: c.stm.confidential.reportData }; delete c.key; delete c.sig; }), boxKey),
    /type is none/);
{
    const c = ocp.signClaim(mutate(first, (x) => { x.stm.confidential = { type: 'none', report: null, reportData: x.stm.confidential.reportData }; delete x.key; delete x.sig; }), boxKey);
    const res = verifyAnnounce(c, { blessedImages: blessed, now, allowUnencryptedMemory: true });
    check('confidential type none accepted only with allowUnencryptedMemory', res.ok, res.reasons.join(' | '));
}
expectReason('REPORT_DATA in the report bytes must bind the quote',
    ocp.signClaim(mutate(first, (c) => {
        const rep = Buffer.from(c.stm.confidential.report, 'base64'); rep[0x50] ^= 0xff;
        c.stm.confidential.report = rep.toString('base64'); delete c.key; delete c.sig;
    }), boxKey), /REPORT_DATA does not bind/);
expectReason('tampered report fails the VCEK signature',
    ocp.signClaim(mutate(first, (c) => {
        const rep = Buffer.from(c.stm.confidential.report, 'base64'); rep[0x100] ^= 0xff;
        c.stm.confidential.report = rep.toString('base64'); delete c.key; delete c.sig;
    }), boxKey), /does not verify under the VCEK/, { fetchVcek });
expectReason('blessed MEASUREMENT is compared when present',
    first, /MEASUREMENT does not match/,
    { blessedImages: { [IMAGE_HASH]: { pcrs: fake.pcrs(), measurement: '0'.repeat(96) } } });
expectReason('stale issuedAt rejected', first, /from now/, { now: now + 3600 });
expectReason('garbage claim rejected', { stm: { type: 'x' } }, /not safebox_announce/);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
