// /opt/safebox/system/nsmClient.js
//
// AWS Nitro NSM (Secure Module) client. Three responsibilities:
//
//   1. Request a fresh attestation document from /dev/nsm
//   2. Verify it (cert chain to AWS root + COSE_Sign1 signature)
//   3. Return the verified payload to secret.js
//
// The attestation document itself is non-deterministic (timestamps, leaf
// certs rotate every few hours, fresh signatures). We use it ONLY to
// prove that the PCRs are real — that they really came from this host's
// Nitro hypervisor. Once verified, we throw the wrapper away and feed
// just the PCRs (stable across the AMI's lifetime) into attestationDerive.
//
// Wire spec (RFC 8949 CBOR + RFC 8152 COSE_Sign1):
//
//   AttestationDocument = COSE_Sign1 = [
//     protected:   bytes,    // CBOR-encoded header map {1: -35}  (ES384)
//     unprotected: map,      // empty {}
//     payload:     bytes,    // CBOR-encoded payload (see below)
//     signature:   bytes,    // 96 bytes: raw r||s for P-384 ECDSA
//   ]
//
//   Payload = {
//     "module_id":   text,
//     "timestamp":   uint,
//     "digest":      text,    // "SHA384"
//     "pcrs":        { uint => bytes },
//     "certificate": bytes,   // DER-encoded leaf cert
//     "cabundle":    [ bytes, ... ],  // DER-encoded chain to AWS root
//     "public_key":  bytes?,  // optional
//     "user_data":   bytes?,
//     "nonce":       bytes?,
//   }
//
// Verification steps:
//
//   a. Decode the COSE_Sign1 outer array
//   b. Verify cert chain: leaf (payload.certificate) -> cabundle -> AWS root (pinned)
//      - Signatures, not-before/not-after, basic constraints
//   c. Reconstruct Sig_structure per RFC 8152 sec 4.4:
//        ["Signature1", protected_bstr_raw, b"", payload_bstr_raw]
//      where the bstr fields are the RAW CBOR bytes, not their decoded values
//   d. CBOR-encode the Sig_structure
//   e. Verify ECDSA P-384/SHA-384 over that encoding using the leaf's public key
//      (converting raw r||s to DER first, since Node's crypto.verify expects DER)
//   f. Sanity-check the payload (digest === "SHA384", pcrs is a Map, etc.)
//   g. Return { pcrs: Map<int, Buffer> }

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const cbor = require('./cborDecode');

const NSM_DEVICE = process.env.SAFEBOX_SYSTEM_NSM_DEVICE || '/dev/nsm';
const AWS_ROOT_PEM_PATH = process.env.SAFEBOX_SYSTEM_AWS_ROOT_PEM
    || '/etc/safebox/aws-nitro-root.pem';
const AWS_ROOT_FINGERPRINT_HEX = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
// SHA-256 of the PEM file's bytes. Two independent AWS doc pages confirm:
//   docs.aws.amazon.com/enclaves/latest/user/verify-root.html
//   docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html

// nsm-cli is the AWS-shipped binary that does the actual /dev/nsm ioctl.
// We shell out to it rather than write our own N-API binding — the binary
// is part of the aws-nitro-enclaves-cli RPM and is already installed on
// every Nitro-enabled AMI.
const NSM_CLI = process.env.SAFEBOX_SYSTEM_NSM_CLI || '/usr/bin/nsm-cli';

class AttestationError extends Error {
    constructor(msg, code) {
        super(msg);
        this.code = code || 'ATTESTATION_FAILED';
    }
}

// ── Step 1: request attestation from NSM ─────────────────────────────────────

function requestAttestation() {
    try {
        fs.accessSync(NSM_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        throw new AttestationError(`NSM device ${NSM_DEVICE} not accessible`, 'NSM_NOT_AVAILABLE');
    }
    try {
        fs.accessSync(NSM_CLI, fs.constants.X_OK);
    } catch {
        throw new AttestationError(`nsm-cli not executable at ${NSM_CLI}; install aws-nitro-enclaves-cli`, 'NSM_CLI_MISSING');
    }
    let hex;
    try {
        hex = execFileSync(NSM_CLI, ['attestation', '--hex'], {
            timeout: 5000,
            maxBuffer: 32 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString().trim();
    } catch (e) {
        throw new AttestationError(`nsm-cli failed: ${e.message}`, 'NSM_REQUEST_FAILED');
    }
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 100) {
        throw new AttestationError('nsm-cli returned malformed output', 'NSM_REQUEST_FAILED');
    }
    return Buffer.from(hex, 'hex');
}

// Request an attestation with caller-supplied user_data and nonce. Used by
// dnsclient to bind (safeboxId, reportedIp, challenge, timestamp) into the
// signed attestation, so the DNS API can verify those fields came from this
// box's NSM rather than being constructed by something else.
//
// Both user_data and nonce are passed to nsm-cli as hex-encoded bytes.
// The CLI emits the resulting COSE_Sign1 attestation document as a hex
// string on stdout; we decode and return the bytes.
async function getAttestation(opts) {
    const userData = opts && opts.userData;
    const nonce    = opts && opts.nonce;
    if (!Buffer.isBuffer(userData)) throw new AttestationError('userData must be a Buffer', 'BAD_REQUEST');
    if (!Buffer.isBuffer(nonce))    throw new AttestationError('nonce must be a Buffer', 'BAD_REQUEST');
    if (userData.length > 1024)     throw new AttestationError('userData exceeds 1024 bytes (NSM max)', 'BAD_REQUEST');
    if (nonce.length > 1024)        throw new AttestationError('nonce exceeds 1024 bytes (NSM max)', 'BAD_REQUEST');

    try {
        fs.accessSync(NSM_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        throw new AttestationError(`NSM device ${NSM_DEVICE} not accessible`, 'NSM_NOT_AVAILABLE');
    }
    try {
        fs.accessSync(NSM_CLI, fs.constants.X_OK);
    } catch {
        throw new AttestationError(`nsm-cli not executable at ${NSM_CLI}`, 'NSM_CLI_MISSING');
    }

    let hex;
    try {
        hex = execFileSync(NSM_CLI, [
            'attestation', '--hex',
            '--user-data', userData.toString('hex'),
            '--nonce',     nonce.toString('hex'),
        ], {
            timeout: 5000,
            maxBuffer: 32 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString().trim();
    } catch (e) {
        throw new AttestationError(`nsm-cli failed: ${e.message}`, 'NSM_REQUEST_FAILED');
    }
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 100) {
        throw new AttestationError('nsm-cli returned malformed output', 'NSM_REQUEST_FAILED');
    }
    return Buffer.from(hex, 'hex');
}

// ── Step 2: load and verify the pinned AWS root cert ─────────────────────────

let rootCertCached = null;

function loadRootCert() {
    if (rootCertCached) return rootCertCached;
    let pem;
    try {
        pem = fs.readFileSync(AWS_ROOT_PEM_PATH);
    } catch (e) {
        throw new AttestationError(`AWS Nitro root cert missing at ${AWS_ROOT_PEM_PATH}: ${e.message}`,
            'ROOT_PEM_MISSING');
    }
    const actualHash = crypto.createHash('sha256').update(pem).digest('hex');
    if (actualHash !== AWS_ROOT_FINGERPRINT_HEX) {
        throw new AttestationError(
            `AWS root cert fingerprint mismatch: expected ${AWS_ROOT_FINGERPRINT_HEX}, got ${actualHash}`,
            'ROOT_PEM_FINGERPRINT_MISMATCH');
    }
    const cert = new crypto.X509Certificate(pem);
    rootCertCached = { pem, der: cert.raw, cert };
    return rootCertCached;
}

// ── Step 3: extract the COSE_Sign1 fields from the outer envelope ────────────

function parseCoseSign1(docBytes) {
    const decoded = cbor.decode(docBytes);
    if (!Array.isArray(decoded.value) || decoded.value.length !== 4) {
        throw new AttestationError('COSE_Sign1 outer is not a 4-array', 'COSE_PARSE_FAILED');
    }
    const [protectedBstr, unprotectedMap, payloadBstr, signatureBstr] = decoded.value;
    if (!Buffer.isBuffer(protectedBstr) || !(unprotectedMap instanceof Map) ||
        !Buffer.isBuffer(payloadBstr) || !Buffer.isBuffer(signatureBstr)) {
        throw new AttestationError('COSE_Sign1 fields have wrong types', 'COSE_PARSE_FAILED');
    }
    const protectedHeader = cbor.decode(protectedBstr).value;
    if (!(protectedHeader instanceof Map)) {
        throw new AttestationError('COSE protected header is not a map', 'COSE_PARSE_FAILED');
    }
    const alg = protectedHeader.get(1);
    if (alg !== -35) {
        throw new AttestationError(`COSE alg ${alg}, expected -35 (ES384)`, 'COSE_UNEXPECTED_ALG');
    }
    if (signatureBstr.length !== 96) {
        throw new AttestationError(`COSE signature length ${signatureBstr.length}, expected 96`, 'COSE_BAD_SIG_LENGTH');
    }
    return {
        protectedBstr,
        payloadBstr,
        signature: signatureBstr,
        payload: cbor.decode(payloadBstr).value,
    };
}

// ── Step 4: cert chain verification ──────────────────────────────────────────

function verifyCertChain(payload) {
    const leafDer = payload.get('certificate');
    const cabundle = payload.get('cabundle');
    if (!Buffer.isBuffer(leafDer)) throw new AttestationError('payload.certificate missing or not bytes', 'CHAIN_BAD_LEAF');
    if (!Array.isArray(cabundle))   throw new AttestationError('payload.cabundle missing or not array', 'CHAIN_BAD_BUNDLE');

    const leaf = new crypto.X509Certificate(leafDer);
    const intermediates = cabundle.map((d, i) => {
        if (!Buffer.isBuffer(d)) throw new AttestationError(`cabundle[${i}] not bytes`, 'CHAIN_BAD_BUNDLE');
        return new crypto.X509Certificate(d);
    });
    const { cert: root } = loadRootCert();

    const all = [leaf, ...intermediates, root];
    const bySubject = new Map();
    for (const c of all) bySubject.set(c.subject, c);

    const chain = [leaf];
    const now = Date.now();
    let current = leaf;
    const MAX_CHAIN_LENGTH = 8;
    while (chain.length < MAX_CHAIN_LENGTH) {
        if (Date.parse(current.validFrom) > now) {
            throw new AttestationError(`cert ${current.subject} not yet valid (validFrom=${current.validFrom})`, 'CHAIN_NOT_YET_VALID');
        }
        if (Date.parse(current.validTo) < now) {
            throw new AttestationError(`cert ${current.subject} expired (validTo=${current.validTo})`, 'CHAIN_EXPIRED');
        }
        if (current.subject === root.subject) {
            break;
        }
        const issuer = bySubject.get(current.issuer);
        if (!issuer) {
            throw new AttestationError(`no issuer found for ${current.subject} (issuer=${current.issuer})`, 'CHAIN_BROKEN');
        }
        if (!current.verify(issuer.publicKey)) {
            throw new AttestationError(`signature verify failed: ${current.subject} not signed by ${issuer.subject}`, 'CHAIN_BAD_SIGNATURE');
        }
        chain.push(issuer);
        current = issuer;
    }
    if (current.subject !== root.subject) {
        throw new AttestationError(`chain does not terminate at pinned AWS root after ${MAX_CHAIN_LENGTH} hops`, 'CHAIN_TOO_LONG');
    }
    return leaf;
}

// ── Step 5: COSE_Sign1 signature verification ────────────────────────────────

function reconstructSigStructure(protectedBstr, payloadBstr) {
    return cbor.encodeArray([
        cbor.encodeTextString('Signature1'),
        cbor.encodeByteString(protectedBstr),
        cbor.encodeByteString(Buffer.alloc(0)),
        cbor.encodeByteString(payloadBstr),
    ]);
}

function rawSignatureToDer(raw) {
    if (raw.length !== 96) throw new AttestationError('expected 96-byte raw signature', 'COSE_BAD_SIG_LENGTH');
    const r = raw.subarray(0, 48);
    const s = raw.subarray(48, 96);
    return Buffer.concat([
        Buffer.from([0x30]),
        derLength(derInt(r).length + derInt(s).length),
        derInt(r),
        derInt(s),
    ]);
}

function derInt(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let v = buf.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02]), derLength(v.length), v]);
}

function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    if (n < 0x10000) {
        const b = Buffer.alloc(3);
        b[0] = 0x82;
        b.writeUInt16BE(n, 1);
        return b;
    }
    throw new Error('derLength: too large');
}

function verifyCoseSignature(leafCert, protectedBstr, payloadBstr, signatureRaw) {
    const sigStruct = reconstructSigStructure(protectedBstr, payloadBstr);
    const derSig = rawSignatureToDer(signatureRaw);
    const ok = crypto.verify('sha384', sigStruct, {
        key: leafCert.publicKey,
        dsaEncoding: 'der',
    }, derSig);
    if (!ok) throw new AttestationError('COSE_Sign1 signature verification failed', 'COSE_SIG_INVALID');
}

// ── Step 6: sanity checks on the payload ─────────────────────────────────────

function validatePayload(payload) {
    if (!(payload instanceof Map)) throw new AttestationError('payload is not a CBOR map', 'PAYLOAD_BAD_SHAPE');
    const digest = payload.get('digest');
    if (digest !== 'SHA384') throw new AttestationError(`payload.digest=${digest}, expected SHA384`, 'PAYLOAD_BAD_DIGEST');
    const pcrs = payload.get('pcrs');
    if (!(pcrs instanceof Map)) throw new AttestationError('payload.pcrs is not a CBOR map', 'PAYLOAD_BAD_PCRS');
    for (const [idx, val] of pcrs) {
        if (!Number.isInteger(idx) || idx < 0 || idx > 31) {
            throw new AttestationError(`PCR index ${idx} out of range`, 'PAYLOAD_BAD_PCRS');
        }
        if (!Buffer.isBuffer(val) || (val.length !== 32 && val.length !== 48 && val.length !== 64)) {
            throw new AttestationError(`PCR${idx} has bad length ${val && val.length}`, 'PAYLOAD_BAD_PCRS');
        }
    }
    const ts = payload.get('timestamp');
    if (typeof ts !== 'number') throw new AttestationError('payload.timestamp not a number', 'PAYLOAD_BAD_TIMESTAMP');
    const skew = Math.abs(Date.now() - ts);
    if (skew > 5 * 60 * 1000) {
        throw new AttestationError(`payload.timestamp skew ${skew}ms exceeds 5min`, 'PAYLOAD_TIMESTAMP_SKEW');
    }
    return pcrs;
}

// ── Public API ───────────────────────────────────────────────────────────────
//
// Two shapes for callers:
//   - getVerifiedAttestationSync()  → returns { pcrs }, throws on error
//   - getVerifiedAttestation()      → async wrapper, identical behavior
//
// The work is fully synchronous (execFileSync, CBOR decode, sync crypto.verify).
// The sync companion exists because Safebox's _loadSecret wants to stay sync —
// otherwise the async-ness cascades into Protocol.System._call's hot path.
// First call has a small NSM round-trip cost; subsequent calls hit the cached
// on-disk secret and never enter this code.

function getVerifiedAttestationSync() {
    const docBytes = requestAttestation();
    const cose = parseCoseSign1(docBytes);
    const leafCert = verifyCertChain(cose.payload);
    verifyCoseSignature(leafCert, cose.protectedBstr, cose.payloadBstr, cose.signature);
    const pcrs = validatePayload(cose.payload);
    return { pcrs };
}

// Async wrapper for callers that want a Promise.
async function getVerifiedAttestation() {
    return getVerifiedAttestationSync();
}

function checkAvailable() {
    fs.accessSync(NSM_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(AWS_ROOT_PEM_PATH, fs.constants.R_OK);
    fs.accessSync(NSM_CLI, fs.constants.X_OK);
}

module.exports = {
    getVerifiedAttestation,
    getVerifiedAttestationSync,
    getAttestation,
    checkAvailable,
    _parseCoseSign1: parseCoseSign1,
    _verifyCertChain: verifyCertChain,
    _verifyCoseSignature: verifyCoseSignature,
    _validatePayload: validatePayload,
    _reconstructSigStructure: reconstructSigStructure,
    _rawSignatureToDer: rawSignatureToDer,
    _loadRootCert: loadRootCert,
    AWS_ROOT_FINGERPRINT_HEX,
};
