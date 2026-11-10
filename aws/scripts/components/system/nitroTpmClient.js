// /opt/safebox/system/nitroTpmClient.js   (installed as attestationClient.js)
//
// AWS attestation client for NitroTPM. Replaces nsmClient.js, which spoke
// to /dev/nsm — a device that exists only inside a Nitro Enclave and was
// never present on a safebox, so the old client always fell back to random
// bytes (docs/HARDENING-PLAN.md, "What the review found"). NitroTPM is a
// standard TPM 2.0 at /dev/tpmrm0 on every Nitro instance launched with
// the vTPM enabled, the same path the other three clouds use.
//
// Two responsibilities:
//
//   1. Obtain a quote over the policy PCRs (sha256:0,2,4,7,8,9,14,15) bound to
//      a caller nonce. /dev/tpmrm0 is restricted to root and tss, so the
//      quote comes from the root-owned wrapper through tpmQuote.js:
//        sudo /opt/safebox/bin/safebox-tpm-quote <nonce-hex>
//      tpmQuote.js parses the TPMS_ATTEST, checks nonce, selection, PCR
//      digest and the AK signature.
//
//   2. Tie the quote to AWS: NitroTPM's EK certificate chains to the AWS
//      Nitro root (the same root as Nitro Enclaves, published by AWS and
//      pinned by SHA-256 at /etc/safebox/aws-nitro-root.pem). When the
//      wrapper includes an ekCertPem field, the chain is verified here;
//      when it does not, the quote is returned with ekVerified=false and
//      the control plane performs the chain check from its own copy of
//      the EK certificate (it can read it from the instance's attestation
//      document at registration).
//
// Unified interface (same on every cloud):
//   quote(nonceHex) -> { message, signature, pcrs:{0:hex,...}, akPublicPem, ... }
//   pcrPolicyList = [0, 2, 4, 7, 8, 9, 14, 15]

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const tpmQuote = require('./tpmQuote');

const AWS_ROOT_PEM_PATH = process.env.SAFEBOX_SYSTEM_AWS_ROOT_PEM
    || '/etc/safebox/aws-nitro-root.pem';
// SHA-256 of the PEM file's bytes. Two independent AWS doc pages confirm:
//   docs.aws.amazon.com/enclaves/latest/user/verify-root.html
//   docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html
const AWS_ROOT_FINGERPRINT_HEX = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';

const { AttestationError, pcrPolicyList } = tpmQuote;

// ── Pinned AWS root ─────────────────────────────────────────────────────────

let rootCertCached = null;

function loadRootCert() {
    if (rootCertCached) return rootCertCached;
    let pem;
    try {
        pem = fs.readFileSync(AWS_ROOT_PEM_PATH);
    } catch (e) {
        throw new AttestationError(`AWS root cert missing at ${AWS_ROOT_PEM_PATH}: ${e.message}`, 'ROOT_PEM_MISSING');
    }
    const actualHash = crypto.createHash('sha256').update(pem).digest('hex');
    if (actualHash !== AWS_ROOT_FINGERPRINT_HEX) {
        throw new AttestationError(
            `AWS root cert fingerprint mismatch: expected ${AWS_ROOT_FINGERPRINT_HEX}, got ${actualHash}`,
            'ROOT_PEM_FINGERPRINT_MISMATCH'
        );
    }
    const cert = new crypto.X509Certificate(pem);
    rootCertCached = { pem, der: cert.raw, cert };
    return rootCertCached;
}

// ── EK certificate chain to the pinned AWS root ─────────────────────────────
//
// ekCert: X509Certificate or PEM/DER. intermediates: optional array of
// X509Certificate/PEM/DER (AWS issues the EK cert under regional
// intermediates). Walks issuer links until the pinned root; every hop's
// signature and validity window is checked.

function toCert(x, what) {
    if (x instanceof crypto.X509Certificate) return x;
    try { return new crypto.X509Certificate(x); }
    catch (e) { throw new AttestationError(`${what} unparseable: ${e.message}`, 'CHAIN_BAD_CERT'); }
}

function verifyEkCertChain(ekCertInput, intermediates) {
    const leaf = toCert(ekCertInput, 'EK certificate');
    const { cert: root } = loadRootCert();
    const pool = [leaf, ...(intermediates || []).map((c, i) => toCert(c, `intermediate[${i}]`)), root];
    const bySubject = new Map();
    for (const c of pool) bySubject.set(c.subject, c);

    const now = Date.now();
    let current = leaf;
    const MAX_CHAIN_LENGTH = 8;
    for (let hops = 0; hops < MAX_CHAIN_LENGTH; hops++) {
        if (Date.parse(current.validFrom) > now) {
            throw new AttestationError(`cert ${current.subject} not yet valid (validFrom=${current.validFrom})`, 'CHAIN_NOT_YET_VALID');
        }
        if (Date.parse(current.validTo) < now) {
            throw new AttestationError(`cert ${current.subject} expired (validTo=${current.validTo})`, 'CHAIN_EXPIRED');
        }
        if (current.subject === root.subject) {
            if (current.raw.equals(root.raw)) return leaf;
            throw new AttestationError('chain ends at a cert with the root subject but different bytes', 'CHAIN_BAD_SIGNATURE');
        }
        const issuer = bySubject.get(current.issuer);
        if (!issuer) {
            throw new AttestationError(`no issuer found for ${current.subject} (issuer=${current.issuer})`, 'CHAIN_BROKEN');
        }
        if (!current.verify(issuer.publicKey)) {
            throw new AttestationError(`signature verify failed: ${current.subject} not signed by ${issuer.subject}`, 'CHAIN_BAD_SIGNATURE');
        }
        current = issuer;
    }
    throw new AttestationError(`chain does not terminate at pinned AWS root after ${MAX_CHAIN_LENGTH} hops`, 'CHAIN_TOO_LONG');
}

// ── Public API ──────────────────────────────────────────────────────────────

function quote(nonceHex) {
    const q = tpmQuote.quote(nonceHex);
    q.cloud = 'aws';
    q.ekVerified = false;
    if (q.ekCertPem) {
        verifyEkCertChain(q.ekCertPem, q.ekIntermediatesPem || []);
        q.ekVerified = true;
    }
    // Memory-encryption evidence (SEV-SNP on m6a/c6a/r6a, on by default),
    // bound to this quote; "none" on an ordinary Nitro instance.
    tpmQuote.attachConfidential(q);
    q.confidentialComputing = q.confidential.type === 'none' ? null : q.confidential.type;
    return q;
}

function checkAvailable() {
    tpmQuote.checkAvailable();
    loadRootCert();
}

module.exports = {
    quote,
    pcrPolicyList,
    checkAvailable,
    AttestationError,
    verifyEkCertChain,
    _loadRootCert: loadRootCert,
    AWS_ROOT_FINGERPRINT_HEX,
    AWS_ROOT_PEM_PATH,
};
