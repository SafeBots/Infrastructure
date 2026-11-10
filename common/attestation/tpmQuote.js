// /opt/safebox/system/tpmQuote.js  (also installed to /opt/safebox/dnsclient/)
//
// Cloud-neutral TPM 2.0 quote client. The four per-cloud attestation
// clients (nitroTpmClient.js, gceAttestationClient.js,
// azureAttestationClient.js, ociAttestationClient.js) all obtain their
// quote through this module and add only their cloud's certificate-chain
// helpers on top.
//
// /dev/tpmrm0 is reachable only by root and tss on a hardened box, and
// safebox-infra is neither, so the quote is produced by the root-owned
// wrapper (docs/HARDENING-PLAN.md, "Sudoers and wrappers"):
//
//   sudo -n /opt/safebox/bin/safebox-tpm-quote <nonce-hex>
//
// which runs tpm2_quote over the policy PCRs and prints one JSON object:
//
//   {
//     "message":     base64(TPMS_ATTEST bytes, tpm2_quote -m),
//     "signature":   base64(TPMT_SIGNATURE bytes, tpm2_quote -s),
//     "pcrs":        {"0": "<hex>", "2": "<hex>", ...}
//                    — or a base64 string holding that JSON object, or
//                    holding tpm2_pcrread's text output ("  0 : 0x..."),
//     "akPublicPem": the AK public key as PEM, or base64 of that PEM,
//     "ekCertPem":   (optional) EK certificate PEM for cloud chain checks,
//     "snpReport":   (optional, Azure CVM) base64 SEV-SNP report bytes
//   }
//
// This module parses the TPMS_ATTEST structure, checks that the quote is
// over exactly the policy PCRs in the sha256 bank, that extraData equals
// the caller's nonce, that the PCR digest matches the reported PCR values,
// and that the signature verifies under the AK public key. What it cannot
// do is tie the AK to the platform: that is the per-cloud client's job
// (EK certificate chain, MAA, VCEK), done with the optional ekCertPem /
// snpReport fields when the wrapper provides them.
//
// Unified interface exported by every attestation client:
//
//   quote(nonceHex) -> {
//       message:     base64 string,
//       signature:   base64 string,
//       pcrs:        { 0: hex, 2: hex, 4: hex, 7: hex, 8: hex, 9: hex, 14: hex },
//       akPublicPem: string,
//       nonce:       nonceHex,
//       pcrPolicyList: [0, 2, 4, 7, 8, 9, 14, 15],
//       verified:    true,
//       ekCertPem:   string | null,
//       confidential: { type: "sev-snp"|"tdx"|"none", report: base64|null,
//                       reportData: hex(64 bytes), vcek: pem|null, ... }
//                    (from safebox-confidential-report, see confidentialReport)
//   }
//   pcrPolicyList = [0, 2, 4, 7, 8, 9, 14, 15]
//
// TPMS_ATTEST layout (TPM 2.0 Library Part 2, 10.12.8), all big-endian:
//
//   UINT32          magic             0xFF544347 (TPM_GENERATED_VALUE)
//   UINT16          type              0x8018     (TPM_ST_ATTEST_QUOTE)
//   TPM2B_NAME      qualifiedSigner   UINT16 size + bytes
//   TPM2B_DATA      extraData         UINT16 size + bytes   (our nonce)
//   TPMS_CLOCK_INFO clockInfo         UINT64 clock, UINT32 resetCount,
//                                     UINT32 restartCount, UINT8 safe
//   UINT64          firmwareVersion
//   TPMS_QUOTE_INFO attested:
//     TPML_PCR_SELECTION pcrSelect    UINT32 count, then per bank:
//                                       UINT16 hash, UINT8 sizeofSelect,
//                                       BYTE pcrSelect[sizeofSelect]
//     TPM2B_DIGEST       pcrDigest    UINT16 size + bytes
//
// TPMT_SIGNATURE (Part 2, 11.3.4): UINT16 sigAlg, then the scheme's
// signature: RSASSA/RSAPSS = UINT16 hashAlg + TPM2B sig;
// ECDSA = UINT16 hashAlg + TPM2B r + TPM2B s.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SUDO = '/usr/bin/sudo';
const QUOTE_WRAPPER = process.env.SAFEBOX_TPM_QUOTE_WRAPPER || '/opt/safebox/bin/safebox-tpm-quote';
const CONFIDENTIAL_WRAPPER = process.env.SAFEBOX_CONFIDENTIAL_REPORT_WRAPPER
    || '/opt/safebox/bin/safebox-confidential-report';

// The seal policy PCRs. docs/HARDENING-PLAN.md "PCR policy": sha256:0,2,4,7,8,9,14,15.
const pcrPolicyList = Object.freeze([0, 2, 4, 7, 8, 9, 14, 15]);
const PCR_BANK = 'sha256';

const TPM_GENERATED_VALUE   = 0xFF544347;
const TPM_ST_ATTEST_QUOTE   = 0x8018;
const TPM_ALG_SHA256        = 0x000B;
const TPM_ALG_RSASSA        = 0x0014;
const TPM_ALG_RSAPSS        = 0x0016;
const TPM_ALG_ECDSA         = 0x0018;
const MAX_NONCE_HEX         = 128;   // TPM2B_DATA extraData is at most 64 bytes

class AttestationError extends Error {
    constructor(msg, code) {
        super(msg);
        this.code = code || 'ATTESTATION_FAILED';
    }
}

// ── Nonce ───────────────────────────────────────────────────────────────────

// The wrapper (common/sudo/bin/safebox-tpm-quote) accepts exactly
// ^[0-9a-f]{64}$: a sha256 digest. Every caller hashes its challenge
// (nonceFromString / sha256Hex) so the same rule is applied here, before
// sudo is invoked, with a readable error.
function validateNonceHex(nonceHex) {
    if (typeof nonceHex !== 'string' || nonceHex.length !== MAX_NONCE_HEX / 2
        || !/^[0-9a-f]{64}$/.test(nonceHex)) {
        throw new AttestationError('nonceHex must be exactly 32 bytes (64 chars) of lowercase hex; hash the challenge with nonceFromString()', 'BAD_NONCE');
    }
    return nonceHex;
}

// ── Wrapper call ────────────────────────────────────────────────────────────

function checkAvailable() {
    fs.accessSync(SUDO, fs.constants.X_OK);
    fs.accessSync(QUOTE_WRAPPER, fs.constants.X_OK);
    fs.accessSync(CONFIDENTIAL_WRAPPER, fs.constants.X_OK);
}

function runWrapper(nonceHex) {
    let out;
    try {
        out = execFileSync(SUDO, ['-n', QUOTE_WRAPPER, nonceHex], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
        });
    } catch (e) {
        const stderr = e.stderr ? e.stderr.toString().slice(0, 512) : '';
        throw new AttestationError(`safebox-tpm-quote failed: ${e.message} ${stderr}`.trim(), 'QUOTE_REQUEST_FAILED');
    }
    let parsed;
    try { parsed = JSON.parse(out.toString('utf8')); }
    catch (e) { throw new AttestationError(`safebox-tpm-quote output is not JSON: ${e.message}`, 'QUOTE_BAD_OUTPUT'); }
    if (!parsed || typeof parsed !== 'object') {
        throw new AttestationError('safebox-tpm-quote output is not an object', 'QUOTE_BAD_OUTPUT');
    }
    return parsed;
}

// ── Confidential compute (memory encryption) report ────────────────────────
//
// sudo -n /opt/safebox/bin/safebox-confidential-report <report-data-hex(128)>
//
// prints {type: "sev-snp"|"tdx"|"none", report: base64|null, reportData: hex,
// vcek: pem|null, source, runtimeData?}. Every cloud client attaches it to
// its quote() result as `confidential`, with reportData =
// sha256(nonce) || sha256(quote.message) so the hardware report is bound to
// the TPM quote it travels with. The wrapper never fails for lack of a
// device: a box without SEV-SNP or TDX gets type "none", and dnsclient
// decides (allowUnencryptedMemory) whether that is acceptable.

const CONFIDENTIAL_TYPES = ['sev-snp', 'tdx', 'none'];

function confidentialReportData(nonceHex, quoteMessageB64) {
    validateNonceHex(nonceHex);
    const a = crypto.createHash('sha256').update(Buffer.from(nonceHex, 'hex')).digest();
    const b = crypto.createHash('sha256').update(Buffer.from(String(quoteMessageB64), 'base64')).digest();
    return Buffer.concat([a, b]).toString('hex');
}

function confidentialReport(reportDataHex) {
    if (typeof reportDataHex !== 'string' || !/^[0-9a-f]{128}$/.test(reportDataHex)) {
        throw new AttestationError('reportDataHex must be exactly 64 bytes (128 chars) of lowercase hex', 'BAD_REPORT_DATA');
    }
    let out;
    try {
        out = execFileSync(SUDO, ['-n', CONFIDENTIAL_WRAPPER, reportDataHex], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' },
        });
    } catch (e) {
        const stderr = e.stderr ? e.stderr.toString().slice(0, 512) : '';
        throw new AttestationError(`safebox-confidential-report failed: ${e.message} ${stderr}`.trim(), 'CONFIDENTIAL_REQUEST_FAILED');
    }
    let parsed;
    try { parsed = JSON.parse(out.toString('utf8')); }
    catch (e) { throw new AttestationError(`safebox-confidential-report output is not JSON: ${e.message}`, 'CONFIDENTIAL_BAD_OUTPUT'); }
    if (!parsed || typeof parsed !== 'object' || !CONFIDENTIAL_TYPES.includes(parsed.type)) {
        throw new AttestationError('safebox-confidential-report output has no valid type', 'CONFIDENTIAL_BAD_OUTPUT');
    }
    if (parsed.type !== 'none') {
        if (typeof parsed.report !== 'string' || Buffer.from(parsed.report, 'base64').length < 64) {
            throw new AttestationError(`confidential report of type ${parsed.type} has no report bytes`, 'CONFIDENTIAL_BAD_OUTPUT');
        }
        if (parsed.reportData !== reportDataHex) {
            throw new AttestationError('confidential report reportData does not match the request', 'CONFIDENTIAL_BAD_OUTPUT');
        }
    }
    return {
        type: parsed.type,
        report: typeof parsed.report === 'string' ? parsed.report : null,
        reportData: reportDataHex,
        vcek: typeof parsed.vcek === 'string' && parsed.vcek.includes('-----BEGIN') ? parsed.vcek : null,
        source: typeof parsed.source === 'string' ? parsed.source : null,
        runtimeData: typeof parsed.runtimeData === 'string' ? parsed.runtimeData : null,
    };
}

// Attach the confidential report to a verified quote (used by every cloud
// client's quote()).
function attachConfidential(q) {
    q.confidential = confidentialReport(confidentialReportData(q.nonce, q.message));
    return q;
}

// ── Field decoding ──────────────────────────────────────────────────────────

function b64(field, name) {
    if (typeof field !== 'string' || field.length === 0) {
        throw new AttestationError(`quote.${name} missing`, 'QUOTE_BAD_OUTPUT');
    }
    const buf = Buffer.from(field, 'base64');
    if (buf.length === 0) throw new AttestationError(`quote.${name} is not base64`, 'QUOTE_BAD_OUTPUT');
    return buf;
}

// PEM fields may arrive as PEM text or as base64 of the PEM text.
function pemField(field, name, required) {
    if (field === undefined || field === null || field === '') {
        if (required) throw new AttestationError(`quote.${name} missing`, 'QUOTE_BAD_OUTPUT');
        return null;
    }
    if (typeof field !== 'string') throw new AttestationError(`quote.${name} must be a string`, 'QUOTE_BAD_OUTPUT');
    if (field.includes('-----BEGIN')) return field;
    const decoded = Buffer.from(field, 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN')) {
        throw new AttestationError(`quote.${name} is neither PEM nor base64 PEM`, 'QUOTE_BAD_OUTPUT');
    }
    return decoded;
}

// Normalise the pcrs field into { index: hexString }.
function decodePcrs(field) {
    let obj = field;
    if (typeof field === 'string') {
        const bin = Buffer.from(field, 'base64');
        const text = bin.toString('utf8');
        try {
            obj = JSON.parse(text);
        } catch {
            // tpm2_pcrread text: lines like "    0 : 0xABCD..."
            obj = {};
            for (const line of text.split('\n')) {
                const m = line.match(/^\s*(\d+)\s*:\s*0x([0-9a-fA-F]+)\s*$/);
                if (m) obj[m[1]] = m[2];
            }
            // tpm2_quote -F values: the policy PCRs' digests concatenated in
            // selection order, 32 bytes each, no framing at all.
            if (Object.keys(obj).length === 0 && bin.length === 32 * pcrPolicyList.length) {
                pcrPolicyList.forEach((idx, i) => { obj[idx] = bin.subarray(i * 32, (i + 1) * 32).toString('hex'); });
            }
        }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new AttestationError('quote.pcrs is not a map of index to hex', 'QUOTE_BAD_OUTPUT');
    }
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const idx = parseInt(k, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx > 23) {
            throw new AttestationError(`quote.pcrs has bad index ${k}`, 'PCR_BAD_INDEX');
        }
        let hex;
        if (typeof v === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(v)) {
            hex = v.replace(/^0x/, '').toLowerCase();
        } else if (typeof v === 'string' && Buffer.from(v, 'base64').length === 32) {
            hex = Buffer.from(v, 'base64').toString('hex');
        } else {
            throw new AttestationError(`quote.pcrs[${idx}] is not a 32-byte digest`, 'PCR_BAD_LENGTH');
        }
        out[idx] = hex;
    }
    return out;
}

// ── TPMS_ATTEST parsing ─────────────────────────────────────────────────────

function parseTpmsAttest(buf) {
    if (!Buffer.isBuffer(buf)) throw new AttestationError('message must be a Buffer', 'QUOTE_BAD_MESSAGE');
    let off = 0;
    const need = (n, what) => {
        if (off + n > buf.length) throw new AttestationError(`TPMS_ATTEST truncated at ${what}`, 'QUOTE_BAD_MESSAGE');
    };
    const u8  = () => { need(1, 'u8');  const v = buf.readUInt8(off);      off += 1; return v; };
    const u16 = () => { need(2, 'u16'); const v = buf.readUInt16BE(off);   off += 2; return v; };
    const u32 = () => { need(4, 'u32'); const v = buf.readUInt32BE(off);   off += 4; return v; };
    const u64 = () => { need(8, 'u64'); const v = buf.readBigUInt64BE(off); off += 8; return v; };
    const tpm2b = (what) => {
        const size = u16();
        need(size, what);
        const v = buf.subarray(off, off + size);
        off += size;
        return Buffer.from(v);
    };

    const magic = u32();
    if (magic !== TPM_GENERATED_VALUE) {
        throw new AttestationError(`TPMS_ATTEST magic 0x${magic.toString(16)} != TPM_GENERATED_VALUE`, 'QUOTE_BAD_MAGIC');
    }
    const type = u16();
    if (type !== TPM_ST_ATTEST_QUOTE) {
        throw new AttestationError(`TPMS_ATTEST type 0x${type.toString(16)} != TPM_ST_ATTEST_QUOTE`, 'QUOTE_BAD_TYPE');
    }
    const qualifiedSigner = tpm2b('qualifiedSigner');
    const extraData = tpm2b('extraData');
    const clockInfo = {
        clock: u64(),
        resetCount: u32(),
        restartCount: u32(),
        safe: u8(),
    };
    const firmwareVersion = u64();

    const count = u32();
    if (count < 1 || count > 16) throw new AttestationError(`pcrSelect count ${count} out of range`, 'QUOTE_BAD_MESSAGE');
    const pcrSelect = [];
    for (let i = 0; i < count; i++) {
        const hashAlg = u16();
        const sizeofSelect = u8();
        need(sizeofSelect, 'pcrSelect bitmap');
        const bitmap = buf.subarray(off, off + sizeofSelect);
        off += sizeofSelect;
        const pcrs = [];
        for (let byte = 0; byte < bitmap.length; byte++) {
            for (let bit = 0; bit < 8; bit++) {
                if (bitmap[byte] & (1 << bit)) pcrs.push(byte * 8 + bit);
            }
        }
        pcrSelect.push({ hashAlg, pcrs });
    }
    const pcrDigest = tpm2b('pcrDigest');
    if (off !== buf.length) {
        throw new AttestationError(`TPMS_ATTEST has ${buf.length - off} trailing bytes`, 'QUOTE_BAD_MESSAGE');
    }
    return { magic, type, qualifiedSigner, extraData, clockInfo, firmwareVersion, pcrSelect, pcrDigest };
}

// ── TPMT_SIGNATURE → something crypto.verify understands ────────────────────

function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    const b = Buffer.alloc(3);
    b[0] = 0x82;
    b.writeUInt16BE(n, 1);
    return b;
}

function derInt(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let v = buf.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02]), derLength(v.length), v]);
}

function ecdsaRawToDer(r, s) {
    const ri = derInt(r);
    const si = derInt(s);
    return Buffer.concat([Buffer.from([0x30]), derLength(ri.length + si.length), ri, si]);
}

function hashName(alg) {
    if (alg === TPM_ALG_SHA256) return 'sha256';
    if (alg === 0x000C) return 'sha384';
    if (alg === 0x000D) return 'sha512';
    if (alg === 0x0004) return 'sha1';
    return null;
}

// Returns { hash, sig, padding } ready for crypto.verify, or null when the
// blob does not look like a TPMT_SIGNATURE (then the caller tries it raw).
function parseTpmtSignature(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 6) return null;
    const sigAlg = buf.readUInt16BE(0);
    const hashAlg = buf.readUInt16BE(2);
    const hash = hashName(hashAlg);
    if (!hash) return null;
    if (sigAlg === TPM_ALG_RSASSA || sigAlg === TPM_ALG_RSAPSS) {
        const size = buf.readUInt16BE(4);
        if (6 + size !== buf.length) return null;
        return {
            hash,
            sig: buf.subarray(6),
            padding: sigAlg === TPM_ALG_RSAPSS ? crypto.constants.RSA_PKCS1_PSS_PADDING : crypto.constants.RSA_PKCS1_PADDING,
            scheme: sigAlg === TPM_ALG_RSAPSS ? 'rsapss' : 'rsassa',
        };
    }
    if (sigAlg === TPM_ALG_ECDSA) {
        let off = 4;
        const rSize = buf.readUInt16BE(off); off += 2;
        if (off + rSize + 2 > buf.length) return null;
        const r = buf.subarray(off, off + rSize); off += rSize;
        const sSize = buf.readUInt16BE(off); off += 2;
        if (off + sSize !== buf.length) return null;
        const s = buf.subarray(off, off + sSize);
        return { hash, sig: ecdsaRawToDer(r, s), scheme: 'ecdsa' };
    }
    return null;
}

function verifySignature(message, signature, akPublicPem) {
    let key;
    try { key = crypto.createPublicKey(akPublicPem); }
    catch (e) { throw new AttestationError(`akPublicPem unparseable: ${e.message}`, 'AK_BAD_PEM'); }

    const parsed = parseTpmtSignature(signature);
    const attempts = [];
    if (parsed) {
        attempts.push(parsed);
    } else {
        // Raw signature (tpm2_quote -f plain). Try the common schemes.
        attempts.push({ hash: 'sha256', sig: signature, padding: crypto.constants.RSA_PKCS1_PADDING, scheme: 'rsassa-raw' });
        attempts.push({ hash: 'sha256', sig: signature, scheme: 'ecdsa-der-raw' });
        if (signature.length === 64) {
            attempts.push({ hash: 'sha256', sig: ecdsaRawToDer(signature.subarray(0, 32), signature.subarray(32)), scheme: 'ecdsa-rs-raw' });
        }
    }
    for (const a of attempts) {
        try {
            const opts = { key };
            if (a.padding !== undefined) {
                opts.padding = a.padding;
                if (a.padding === crypto.constants.RSA_PKCS1_PSS_PADDING) {
                    opts.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST;
                }
            } else {
                opts.dsaEncoding = 'der';
            }
            if (crypto.verify(a.hash, message, opts, a.sig)) return a.scheme;
        } catch {
            // wrong key type for this scheme; try the next
        }
    }
    throw new AttestationError('quote signature does not verify under akPublicPem', 'QUOTE_SIG_INVALID');
}

// ── Whole-quote verification ────────────────────────────────────────────────

function verifyQuote(raw, nonceHex) {
    validateNonceHex(nonceHex);
    const message = b64(raw.message, 'message');
    const signature = b64(raw.signature, 'signature');
    const akPublicPem = pemField(raw.akPublicPem, 'akPublicPem', true);
    const ekCertPem = pemField(raw.ekCertPem, 'ekCertPem', false);
    const pcrs = decodePcrs(raw.pcrs);

    const attest = parseTpmsAttest(message);

    // Nonce binding
    if (!attest.extraData.equals(Buffer.from(nonceHex, 'hex'))) {
        throw new AttestationError('quote extraData does not equal the requested nonce', 'QUOTE_NONCE_MISMATCH');
    }

    // Exactly one bank, sha256, exactly the policy PCRs
    if (attest.pcrSelect.length !== 1) {
        throw new AttestationError(`quote selects ${attest.pcrSelect.length} banks, expected 1`, 'QUOTE_BAD_SELECTION');
    }
    const sel = attest.pcrSelect[0];
    if (sel.hashAlg !== TPM_ALG_SHA256) {
        throw new AttestationError(`quote bank 0x${sel.hashAlg.toString(16)} is not sha256`, 'QUOTE_BAD_SELECTION');
    }
    const want = pcrPolicyList.join(',');
    const got = sel.pcrs.join(',');
    if (want !== got) {
        throw new AttestationError(`quote covers PCRs [${got}], policy is [${want}]`, 'QUOTE_BAD_SELECTION');
    }

    // Every policy PCR reported, 32 bytes each; digest over them in order
    const h = crypto.createHash('sha256');
    const outPcrs = {};
    for (const idx of pcrPolicyList) {
        const hex = pcrs[idx];
        if (!hex) throw new AttestationError(`PCR${idx} missing from quote.pcrs`, 'PCR_MISSING');
        const val = Buffer.from(hex, 'hex');
        if (val.length !== 32) throw new AttestationError(`PCR${idx} has length ${val.length}, expected 32`, 'PCR_BAD_LENGTH');
        h.update(val);
        outPcrs[idx] = hex;
    }
    const digest = h.digest();
    if (!digest.equals(attest.pcrDigest)) {
        throw new AttestationError('quote pcrDigest does not match the reported PCR values', 'QUOTE_PCR_DIGEST_MISMATCH');
    }
    // Firmware must have extended PCR0 and PCR7 on any UEFI Secure Boot VM.
    for (const idx of [0, 7]) {
        if (Buffer.from(outPcrs[idx], 'hex').every((b) => b === 0)) {
            throw new AttestationError(`PCR${idx} is all zeros; measured boot is not active`, 'PCR_NOT_EXTENDED');
        }
    }

    const scheme = verifySignature(message, signature, akPublicPem);

    return {
        message: message.toString('base64'),
        signature: signature.toString('base64'),
        pcrs: outPcrs,
        akPublicPem,
        ekCertPem,
        snpReport: (typeof raw.snpReport === 'string' && raw.snpReport) ? raw.snpReport : null,
        nonce: nonceHex,
        pcrPolicyList: pcrPolicyList.slice(),
        pcrBank: PCR_BANK,
        signatureScheme: scheme,
        clockInfo: {
            clock: attest.clockInfo.clock.toString(),
            resetCount: attest.clockInfo.resetCount,
            restartCount: attest.clockInfo.restartCount,
            safe: attest.clockInfo.safe,
        },
        firmwareVersion: attest.firmwareVersion.toString(16),
        verified: true,
    };
}

// ── Public API ──────────────────────────────────────────────────────────────

function quote(nonceHex) {
    validateNonceHex(nonceHex);
    const raw = runWrapper(nonceHex);
    return verifyQuote(raw, nonceHex);
}

// Convenience for callers that hold a non-hex challenge: nonce = sha256(input).
function nonceFromString(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

module.exports = {
    quote,
    confidentialReport,
    confidentialReportData,
    attachConfidential,
    CONFIDENTIAL_WRAPPER,
    pcrPolicyList,
    PCR_BANK,
    checkAvailable,
    nonceFromString,
    AttestationError,
    QUOTE_WRAPPER,
    // exposed for the per-cloud clients and tests
    _verifyQuote: verifyQuote,
    _parseTpmsAttest: parseTpmsAttest,
    _parseTpmtSignature: parseTpmtSignature,
    _verifySignature: verifySignature,
    _decodePcrs: decodePcrs,
    _validateNonceHex: validateNonceHex,
    _ecdsaRawToDer: ecdsaRawToDer,
};
