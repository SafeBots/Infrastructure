// common/attestation/verifyAnnounce.js
//
// Relying-party verification of a safebox_announce claim. Pure Node, no
// dependencies beyond ./ocpClaim and ./tpmQuote (parsing only; nothing here
// touches a TPM). Anyone who wants to act on a box's announce (set a DNS
// record, route traffic to it, show it in a dashboard) runs this against
// their own set of blessed images and decides for themselves. There is no
// control plane to ask (docs/HARDENING-PLAN.md, "Decentralized announce").
//
//   const { verifyAnnounce, buildBlessedImages } = require('./verifyAnnounce');
//   const blessed = buildBlessedImages(blessingClaims, { trustedKeys, minSigners });
//   const r = verifyAnnounce(claim, { blessedImages: blessed, now, fetchVcek });
//   if (r.ok) ...  // r.safeboxId, r.boxPubkey, r.publicIp, r.launch, r.prev
//
// What verifyAnnounce checks, in order; every failure is appended to
// reasons[] and ok is false if there is any:
//
//   1. shape: stm.type, safeboxId, boxPubkey, ownerPubkey, iss/sub
//   2. box signature: Ed25519 over the claim by stm.boxPubkey
//   3. launchAuthorization: structure, owner signature by stm.ownerPubkey,
//      same safeboxId; on a launch announce (prev == null) the validity
//      window must contain the announce's issuedAt
//   4. issuedAt within maxSkewSeconds of `now`
//   5. quote: TPMS_ATTEST parses, covers exactly the policy PCRs, extraData
//      equals sha256(canonical(launchAuthorization) || prev), pcrDigest
//      matches the reported PCRs, AK signature verifies (tpmQuote)
//   6. PCRs equal the blessed set for stm.imageRootHash
//   7. confidential: type sev-snp or tdx (none only when the caller passes
//      allowUnencryptedMemory), reportData == sha256(nonce)||sha256(message),
//      the report bytes carry that REPORT_DATA (or, on Azure CVMs, the
//      paravisor's REPORT_DATA = sha256(runtimeData) and runtimeData names
//      the AK), and when fetchVcek is given the SEV-SNP signature verifies
//      under the returned VCEK; a blessed `measurement` is compared too
//
// What it cannot check: whether this boxPubkey is the first one seen under
// this safeboxId. That is state the relying party keeps; the result returns
// safeboxId and boxPubkey so the caller can apply the first-seen rule, and
// `prev` so it can follow the chain.

'use strict';

const crypto = require('crypto');
const path = require('path');
const ocp = require('./ocpClaim');
const tpmQuote = require('./tpmQuote');

const DEFAULT_MAX_SKEW_SECONDS = 15 * 60;
const SNP_REPORT_DATA_OFFSET = 0x50;
const SNP_MEASUREMENT_OFFSET = 0x90;
const SNP_SIGNED_LENGTH = 0x2A0;
const SNP_SIGNATURE_OFFSET = 0x2A0;
const SNP_REPORT_MIN_LENGTH = 0x4A0;
const TDX_REPORT_DATA_OFFSET = 568;   // quote header (48) + TD report body offset 520

// ── Blessed images ──────────────────────────────────────────────────────────
//
// An image_blessing claim (Safenet Claims.imageBlessing) is signed by the
// auditors who rebuilt the image and confirmed its PCR values on hardware:
// stm = {type: 'image_blessing', imageHash, version, pcrs: {idx: hex},
// measurement?}. M-of-N of the relying party's trusted auditor keys must
// have signed it (ocpVerify.verifyThreshold). The result maps imageHash
// to {pcrs, measurement, version, blessingClaim}.

function defaultVerifyThreshold() {
    const p = path.join(__dirname, '..', '..', 'aws', 'scripts', 'components', 'system', 'ocpVerify.js');
    return require(p).verifyThreshold;
}

function buildBlessedImages(blessingClaims, opts) {
    const o = opts || {};
    if (!(o.trustedKeys instanceof Set) || o.trustedKeys.size === 0) {
        throw new Error('buildBlessedImages: trustedKeys must be a non-empty Set of base64 SPKI keys');
    }
    const minSigners = Number.isInteger(o.minSigners) ? o.minSigners : 1;
    const verifyThreshold = o.verifyThreshold || defaultVerifyThreshold();
    const out = {};
    const rejected = [];
    for (const claim of blessingClaims || []) {
        const stm = claim && claim.stm;
        if (!stm || stm.type !== 'image_blessing' || !/^[0-9a-f]{64}$/.test(String(stm.imageHash))) {
            rejected.push({ claim, reason: 'not an image_blessing with a 64-hex imageHash' });
            continue;
        }
        const v = verifyThreshold(claim, minSigners, o.trustedKeys);
        if (!v.ok) { rejected.push({ claim, reason: v.code + ': ' + v.message }); continue; }
        const pcrs = {};
        if (!stm.pcrs || typeof stm.pcrs !== 'object') {
            rejected.push({ claim, reason: 'blessing has no pcrs' });
            continue;
        }
        let bad = false;
        for (const [k, val] of Object.entries(stm.pcrs)) {
            if (!/^\d+$/.test(k) || !/^[0-9a-f]{64}$/.test(String(val))) { bad = true; break; }
            pcrs[parseInt(k, 10)] = String(val);
        }
        if (bad) { rejected.push({ claim, reason: 'blessing pcrs malformed' }); continue; }
        out[stm.imageHash] = {
            pcrs,
            measurement: /^[0-9a-f]{96}$/.test(String(stm.measurement)) ? stm.measurement : null,
            version: stm.version || null,
            signers: v.signers,
            blessingClaim: claim,
        };
    }
    Object.defineProperty(out, '_rejected', { value: rejected, enumerable: false });
    return out;
}

// ── Confidential report ─────────────────────────────────────────────────────

function derIntFromRaw(raw) {
    let v = raw;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}

function snpSignatureDer(report) {
    const r = Buffer.from(report.subarray(SNP_SIGNATURE_OFFSET, SNP_SIGNATURE_OFFSET + 72)).reverse();
    const s = Buffer.from(report.subarray(SNP_SIGNATURE_OFFSET + 72, SNP_SIGNATURE_OFFSET + 144)).reverse();
    const ri = derIntFromRaw(r), si = derIntFromRaw(s);
    return Buffer.concat([Buffer.from([0x30, ri.length + si.length]), ri, si]);
}

function checkConfidential(stm, nonceHex, reasons, opts, blessed) {
    const c = stm.confidential;
    if (!c || typeof c !== 'object' || typeof c.type !== 'string') {
        reasons.push('confidential report missing');
        return { chainVerified: false };
    }
    if (c.type === 'none') {
        if (!opts.allowUnencryptedMemory) reasons.push('confidential report type is none (memory not encrypted)');
        return { chainVerified: false };
    }
    if (c.type !== 'sev-snp' && c.type !== 'tdx') {
        reasons.push(`confidential report type ${c.type} unknown`);
        return { chainVerified: false };
    }
    const expected = tpmQuote.confidentialReportData(nonceHex, stm.quote && stm.quote.message);
    if (c.reportData !== expected) reasons.push('confidential reportData is not sha256(nonce)||sha256(quote.message)');
    let report;
    try { report = Buffer.from(String(c.report), 'base64'); } catch { report = Buffer.alloc(0); }
    if (report.length < 64) { reasons.push('confidential report bytes missing'); return { chainVerified: false }; }

    const offset = c.type === 'sev-snp' ? SNP_REPORT_DATA_OFFSET : TDX_REPORT_DATA_OFFSET;
    if (report.length < offset + 64) { reasons.push('confidential report too short for REPORT_DATA'); return { chainVerified: false }; }
    const inReport = report.subarray(offset, offset + 64);
    const expectedBytes = Buffer.from(expected, 'hex');
    if (!inReport.equals(expectedBytes)) {
        // Azure CVM: REPORT_DATA is fixed by the paravisor to sha256 of the
        // HCL runtime data, which carries the vTPM AK; the binding to the
        // quote then runs through the AK.
        let bound = false;
        if (typeof c.runtimeData === 'string' && c.runtimeData.length > 0) {
            const rd = Buffer.from(c.runtimeData, 'base64');
            const h = crypto.createHash('sha256').update(rd).digest();
            if (inReport.subarray(0, 32).equals(h)) {
                try {
                    const parsed = JSON.parse(rd.toString('utf8'));
                    const ak = crypto.createPublicKey(stm.quote.akPublicPem).export({ format: 'jwk' });
                    const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
                    bound = keys.some((k) => k && ((k.n && ak.n && k.n === ak.n) || (k.x && ak.x && k.x === ak.x && k.y === ak.y)));
                } catch { bound = false; }
            }
        }
        if (!bound) reasons.push('confidential REPORT_DATA does not bind the quote');
    }

    let chainVerified = false;
    if (c.type === 'sev-snp') {
        if (report.length < SNP_REPORT_MIN_LENGTH) reasons.push('sev-snp report shorter than 0x4A0');
        if (blessed && blessed.measurement) {
            const m = report.subarray(SNP_MEASUREMENT_OFFSET, SNP_MEASUREMENT_OFFSET + 48).toString('hex');
            if (m !== blessed.measurement) reasons.push('sev-snp MEASUREMENT does not match the blessed image');
        }
        if (typeof opts.fetchVcek === 'function' && report.length >= SNP_REPORT_MIN_LENGTH) {
            let pem = null;
            try { pem = opts.fetchVcek(c, report); } catch (e) { reasons.push(`fetchVcek failed: ${e.message}`); }
            if (typeof pem === 'string' && pem.includes('-----BEGIN')) {
                try {
                    const ok = crypto.verify('sha384', report.subarray(0, SNP_SIGNED_LENGTH),
                        { key: crypto.createPublicKey(pem), dsaEncoding: 'der' }, snpSignatureDer(report));
                    if (ok) chainVerified = true; else reasons.push('sev-snp report signature does not verify under the VCEK');
                } catch (e) { reasons.push(`sev-snp signature check error: ${e.message}`); }
            } else if (pem !== null) {
                reasons.push('fetchVcek returned no certificate');
            }
        }
    } else if (typeof opts.verifyTdxQuote === 'function') {
        try {
            const r = opts.verifyTdxQuote(report, c);
            if (r && r.ok) chainVerified = true; else reasons.push('tdx quote chain: ' + ((r && r.reason) || 'rejected'));
        } catch (e) { reasons.push(`tdx quote check error: ${e.message}`); }
    }
    return { chainVerified };
}

// ── The verifier ────────────────────────────────────────────────────────────

function verifyAnnounce(claim, options) {
    const opts = options || {};
    const reasons = [];
    const now = Number.isInteger(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
    const maxSkew = Number.isInteger(opts.maxSkewSeconds) ? opts.maxSkewSeconds : DEFAULT_MAX_SKEW_SECONDS;
    const result = { ok: false, reasons, safeboxId: null, boxPubkey: null, ownerPubkey: null,
                     publicIp: null, imageRootHash: null, announceHash: null, prev: null, launch: false,
                     chainVerified: false, issuedAt: null };

    // 1. shape
    if (!claim || typeof claim !== 'object' || !claim.stm || typeof claim.stm !== 'object') {
        reasons.push('claim is not an object with stm');
        return result;
    }
    const stm = claim.stm;
    if (stm.type !== 'safebox_announce') reasons.push('stm.type is not safebox_announce');
    if (!ocp.SAFEBOX_ID_RE.test(String(stm.safeboxId))) reasons.push('stm.safeboxId invalid');
    if (!ocp.PUBKEY_HEX_RE.test(String(stm.boxPubkey))) reasons.push('stm.boxPubkey invalid');
    if (!ocp.PUBKEY_HEX_RE.test(String(stm.ownerPubkey))) reasons.push('stm.ownerPubkey invalid');
    if (claim.iss !== 'safebox:key:' + stm.boxPubkey) reasons.push('iss does not match boxPubkey');
    if (claim.sub !== 'safebox:' + stm.safeboxId) reasons.push('sub does not match safeboxId');
    if (!/^[0-9a-f]{64}$/.test(String(stm.imageRootHash))) reasons.push('stm.imageRootHash invalid');
    if (typeof stm.publicIp !== 'string' || !/^(\d{1,3})(\.\d{1,3}){3}$/.test(stm.publicIp)) reasons.push('stm.publicIp invalid');
    if (!['aws', 'gcp', 'azure', 'oci'].includes(stm.cloud)) reasons.push('stm.cloud invalid');
    if (!Number.isInteger(stm.issuedAt)) reasons.push('stm.issuedAt missing');
    if (stm.prev !== null && stm.prev !== undefined && !/^[0-9a-f]{64}$/.test(String(stm.prev))) reasons.push('stm.prev invalid');
    const prev = (typeof stm.prev === 'string') ? stm.prev : null;
    Object.assign(result, {
        safeboxId: typeof stm.safeboxId === 'string' ? stm.safeboxId : null,
        boxPubkey: typeof stm.boxPubkey === 'string' ? stm.boxPubkey : null,
        ownerPubkey: typeof stm.ownerPubkey === 'string' ? stm.ownerPubkey : null,
        publicIp: typeof stm.publicIp === 'string' ? stm.publicIp : null,
        imageRootHash: typeof stm.imageRootHash === 'string' ? stm.imageRootHash : null,
        prev, launch: prev === null, issuedAt: Number.isInteger(stm.issuedAt) ? stm.issuedAt : null,
    });
    if (reasons.length) return result;
    try { result.announceHash = ocp.claimHash(claim); } catch (e) { reasons.push(`claim hash: ${e.message}`); return result; }

    // 2. box signature
    const sig = ocp.verifyClaim(claim);
    if (!sig.ok) reasons.push('box signature: ' + sig.errors.join('; '));
    else if (!sig.signers.includes(stm.boxPubkey)) reasons.push('claim is not signed by stm.boxPubkey');

    // 3. launch authorization
    const auth = stm.launchAuthorization;
    const authCheck = ocp.checkLaunchAuthorization(auth, {
        safeboxId: stm.safeboxId, ownerPubkey: stm.ownerPubkey,
        now: prev === null ? stm.issuedAt : null,
    });
    if (!authCheck.ok) reasons.push('launchAuthorization: ' + authCheck.reasons.join('; '));

    // 4. freshness
    if (Math.abs(now - stm.issuedAt) > maxSkew) reasons.push(`issuedAt is ${Math.abs(now - stm.issuedAt)}s from now (max ${maxSkew})`);

    // 5. quote
    let nonceHex = null;
    let quote = null;
    if (authCheck.ok) {
        nonceHex = ocp.announceNonce(auth, prev);
        try {
            quote = tpmQuote._verifyQuote(stm.quote || {}, nonceHex);
        } catch (e) {
            reasons.push(`quote: ${e.message}`);
        }
    } else {
        reasons.push('quote not checked (authorization invalid, nonce undefined)');
    }

    // 6. blessed PCRs
    const blessedImages = opts.blessedImages || {};
    const blessed = blessedImages[stm.imageRootHash] || null;
    if (!blessed) {
        reasons.push(`imageRootHash ${stm.imageRootHash.slice(0, 16)}… is not a blessed image`);
    } else if (quote) {
        for (const idx of tpmQuote.pcrPolicyList) {
            const want = blessed.pcrs[idx];
            if (want === undefined) { reasons.push(`blessing has no PCR${idx}`); continue; }
            if (quote.pcrs[idx] !== want) reasons.push(`PCR${idx} differs from the blessed image`);
        }
    }

    // 7. confidential report
    if (quote && nonceHex) {
        const c = checkConfidential(stm, nonceHex, reasons, opts, blessed);
        result.chainVerified = c.chainVerified;
    }

    result.ok = reasons.length === 0;
    return result;
}

module.exports = { verifyAnnounce, buildBlessedImages, DEFAULT_MAX_SKEW_SECONDS };
