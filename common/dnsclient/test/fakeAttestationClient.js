// test/fakeAttestationClient.js
//
// Stand-in for the per-cloud attestationClient.js that install-system.sh
// places next to dnsclient.js on a built image. The source tree has no such
// file (it is <cloud>/scripts/components/dnsclient/<cloud>AttestationClient.js
// and needs a real /dev/tpmrm0), so the tests resolve dnsclient's
// require('./attestationClient') to this module instead; see preload.js.
//
// quote(nonceHex) returns a quote with the same shape a real client returns
// and that passes tpmQuote._verifyQuote(): a real TPMS_ATTEST structure over
// the policy PCRs with extraData = nonce, signed TPMT_SIGNATURE ECDSA P-256
// by a per-process fake AK. The PCR values are fixed per process so a test
// can bless them (see pcrs()). It is not a TPM quote: nothing ties the AK to
// hardware, and no production verifier would accept it. The confidential
// field mirrors tpmQuote.attachConfidential(): an SEV-SNP-shaped report
// (REPORT_DATA at 0x50, signed over the first 0x2A0 bytes by a fake VCEK,
// P-384) by default, or {type:'none'} when SAFEBOX_FAKE_CONFIDENTIAL=none.

'use strict';

const crypto = require('crypto');
const path = require('path');

const tpmQuote = require(path.join(__dirname, '..', '..', 'attestation', 'tpmQuote.js'));

const POLICY = tpmQuote.pcrPolicyList;
const ak = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const AK_PEM = ak.publicKey.export({ type: 'spki', format: 'pem' });
const vcek = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const VCEK_PEM = vcek.publicKey.export({ type: 'spki', format: 'pem' });

const PCR_SEED = process.env.SAFEBOX_FAKE_PCR_SEED || 'fake-pcr';
function pcrs() {
    const out = {};
    for (const i of POLICY) out[i] = crypto.createHash('sha256').update(PCR_SEED + '-' + i).digest('hex');
    return out;
}

function tpm2b(buf) {
    const len = Buffer.alloc(2); len.writeUInt16BE(buf.length);
    return Buffer.concat([len, buf]);
}

function buildTpmsAttest(nonceHex, pcrMap) {
    const parts = [];
    const magic = Buffer.alloc(4); magic.writeUInt32BE(0xFF544347); parts.push(magic);
    const type = Buffer.alloc(2); type.writeUInt16BE(0x8018); parts.push(type);
    parts.push(tpm2b(Buffer.from('000b' + 'ab'.repeat(32), 'hex')));   // qualifiedSigner (TPM2B_NAME)
    parts.push(tpm2b(Buffer.from(nonceHex, 'hex')));                     // extraData
    const clock = Buffer.alloc(8 + 4 + 4 + 1);
    clock.writeBigUInt64BE(BigInt(Date.now()), 0); clock.writeUInt32BE(1, 8); clock.writeUInt32BE(0, 12); clock[16] = 1;
    parts.push(clock);
    const fw = Buffer.alloc(8); fw.writeBigUInt64BE(0x20240101n); parts.push(fw);
    const count = Buffer.alloc(4); count.writeUInt32BE(1); parts.push(count);
    const bank = Buffer.alloc(3); bank.writeUInt16BE(0x000B, 0); bank[2] = 3;
    const bitmap = Buffer.alloc(3);
    for (const i of POLICY) bitmap[Math.floor(i / 8)] |= 1 << (i % 8);
    parts.push(bank, bitmap);
    const h = crypto.createHash('sha256');
    for (const i of POLICY) h.update(Buffer.from(pcrMap[i], 'hex'));
    parts.push(tpm2b(h.digest()));
    return Buffer.concat(parts);
}

// TPMT_SIGNATURE: sigAlg ECDSA (0x0018), hashAlg sha256, TPM2B r, TPM2B s.
function signTpmt(message) {
    const der = crypto.sign('sha256', message, { key: ak.privateKey, dsaEncoding: 'der' });
    // Parse DER SEQUENCE { INTEGER r, INTEGER s }
    let off = 2;
    const readInt = () => { off++; const len = der[off++]; let v = der.subarray(off, off + len); off += len;
        while (v.length > 32 && v[0] === 0) v = v.subarray(1); return v; };
    const r = readInt(), s = readInt();
    const hdr = Buffer.from('00180000', 'hex'); hdr.writeUInt16BE(0x000B, 2);
    return Buffer.concat([hdr, tpm2b(r), tpm2b(s)]);
}

// SEV-SNP-shaped report: 0x4A0 bytes, REPORT_DATA at 0x50, signature r||s
// (little-endian, 72 bytes each) at 0x2A0 over bytes [0, 0x2A0).
function fakeSnpReport(reportDataHex) {
    const report = Buffer.alloc(0x4A0, 0);
    report.writeUInt32LE(2, 0);                                   // version
    Buffer.from(reportDataHex, 'hex').copy(report, 0x50);
    crypto.createHash('sha384').update('fake-measurement').digest().copy(report, 0x90);  // MEASUREMENT
    const der = crypto.sign('sha384', report.subarray(0, 0x2A0), { key: vcek.privateKey, dsaEncoding: 'der' });
    let off = 2; if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);
    const readInt = () => { off++; let len = der[off++]; if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[off++]; }
        let v = der.subarray(off, off + len); off += len; while (v.length > 48 && v[0] === 0) v = v.subarray(1); return v; };
    const r = readInt(), s = readInt();
    Buffer.from(r).reverse().copy(report, 0x2A0);
    Buffer.from(s).reverse().copy(report, 0x2A0 + 72);
    return report.toString('base64');
}

function quote(nonceHex) {
    if (typeof nonceHex !== 'string' || !/^[0-9a-f]{64}$/.test(nonceHex)) {
        throw Object.assign(new Error('fake quote: nonce must be 64 hex chars'), { code: 'BAD_NONCE' });
    }
    const pcrMap = pcrs();
    const message = buildTpmsAttest(nonceHex, pcrMap);
    const raw = {
        message: message.toString('base64'),
        signature: signTpmt(message).toString('base64'),
        pcrs: pcrMap,
        akPublicPem: AK_PEM,
    };
    const q = tpmQuote._verifyQuote(raw, nonceHex);
    q.fake = true;
    const reportData = tpmQuote.confidentialReportData(q.nonce, q.message);
    q.confidential = process.env.SAFEBOX_FAKE_CONFIDENTIAL === 'none'
        ? { type: 'none', report: null, reportData, vcek: null, source: 'fake: no confidential compute device', runtimeData: null }
        : { type: 'sev-snp', report: fakeSnpReport(reportData), reportData, vcek: VCEK_PEM,
            source: 'fake: /dev/sev-guest SNP_GET_REPORT', runtimeData: null };
    return q;
}

module.exports = { quote, pcrs, AK_PEM, VCEK_PEM };
