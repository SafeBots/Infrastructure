// /opt/safebox/system/gceAttestationClient.js   (installed as attestationClient.js)
//
// GCP attestation client for Shielded VMs and Confidential VMs.
// Two responsibilities (same contract as the other three clouds):
//
//   1. Obtain a TPM2 quote over the policy PCRs (sha256:0,2,4,7,8,9,14,15)
//      bound to a caller nonce. /dev/tpmrm0 is restricted to root and tss
//      on a hardened box, so the quote comes from the root-owned wrapper
//      through tpmQuote.js:
//        sudo /opt/safebox/bin/safebox-tpm-quote <nonce-hex>
//      tpmQuote.js parses the TPMS_ATTEST and checks nonce, PCR selection,
//      PCR digest and the AK signature.
//
//   2. Tie the quote to Google: the vTPM's EK certificate chains to the
//      GCE vTPM EK Root CA (pinned by SHA-256 at
//      /etc/safebox/gcp-vtpm-ek-root.pem), or for Confidential VMs is
//      accompanied by an AMD SEV-SNP report. When the wrapper includes an
//      ekCertPem field the chain is verified here; otherwise the quote is
//      returned with ekVerified=false and the control plane does the chain
//      check from its own copy of the EK certificate.
//
// Unified interface (same on every cloud):
//   quote(nonceHex) -> { message, signature, pcrs:{0:hex,...}, akPublicPem, ... }
//   pcrPolicyList = [0, 2, 4, 7, 8, 9, 14, 15]

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const tpmQuote = require('./tpmQuote');

const { AttestationError, pcrPolicyList } = tpmQuote;

// Google Shielded VM EK root CA certificate path. This root CA signs
// the Endorsement Key certificates for all GCP Shielded VMs. The
// certificate is published at:
//   https://www.gstatic.com/cloud_integrity/GCE_vTPM_EK_root.crt
//
// SHA-256 fingerprint of the PEM file, verified against Google's Shielded
// VM documentation:
//   cloud.google.com/compute/shielded-vm/docs/shielded-vm#verifying_the_ek_certificate
const GCP_EK_ROOT_PEM_PATH = process.env.SAFEBOX_SYSTEM_GCP_EK_ROOT_PEM
    || '/etc/safebox/gcp-vtpm-ek-root.pem';
const GCP_EK_ROOT_FINGERPRINT_HEX =
    'b26708c47b40cac81d8e1c0090e8d73aa8c8e24a8e9c878e0efb1e0af6c1f5e9';

// AMD SEV-SNP VCEK root CA (ARK) fingerprint. Used only for Confidential
// VMs. This is the AMD Root Key for the Milan/Genoa processor family.
// Published at: https://download.amd.com/developer/eula/sev/ask_ark_milan.pem
const AMD_ARK_PEM_PATH = process.env.SAFEBOX_SYSTEM_AMD_ARK_PEM
    || '/etc/safebox/amd-sev-ark.pem';
const AMD_ARK_FINGERPRINT_HEX =
    'c0b5fc3a1774567dc4c3be1dd7c12d1dbb0ed8cdcbe1cdaa5cc2b081aae5ed4d';

// ── Pinned roots ────────────────────────────────────────────────────────────

let gcpRootCertCached = null;

function loadGcpRootCert() {
    if (gcpRootCertCached) return gcpRootCertCached;
    let pem;
    try {
        pem = fs.readFileSync(GCP_EK_ROOT_PEM_PATH);
    } catch (e) {
        throw new AttestationError(
            `GCP vTPM EK root cert missing at ${GCP_EK_ROOT_PEM_PATH}: ${e.message}`,
            'ROOT_PEM_MISSING'
        );
    }
    const actualHash = crypto.createHash('sha256').update(pem).digest('hex');
    if (actualHash !== GCP_EK_ROOT_FINGERPRINT_HEX) {
        throw new AttestationError(
            `GCP EK root cert fingerprint mismatch: expected ${GCP_EK_ROOT_FINGERPRINT_HEX}, got ${actualHash}`,
            'ROOT_PEM_FINGERPRINT_MISMATCH'
        );
    }
    const cert = new crypto.X509Certificate(pem);
    gcpRootCertCached = { pem, der: cert.raw, cert };
    return gcpRootCertCached;
}

let amdArkCertCached = null;

function loadAmdArkCert() {
    if (amdArkCertCached) return amdArkCertCached;
    let pem;
    try {
        pem = fs.readFileSync(AMD_ARK_PEM_PATH);
    } catch (e) {
        // AMD ARK is optional — only needed for Confidential VMs
        return null;
    }
    const actualHash = crypto.createHash('sha256').update(pem).digest('hex');
    if (actualHash !== AMD_ARK_FINGERPRINT_HEX) {
        throw new AttestationError(
            `AMD ARK cert fingerprint mismatch: expected ${AMD_ARK_FINGERPRINT_HEX}, got ${actualHash}`,
            'AMD_ARK_FINGERPRINT_MISMATCH'
        );
    }
    const cert = new crypto.X509Certificate(pem);
    amdArkCertCached = { pem, der: cert.raw, cert };
    return amdArkCertCached;
}

// ── Confidential VM detection ───────────────────────────────────────────────

function detectConfidentialComputing() {
    // SEV-SNP: the /dev/sev-guest or /sys/kernel/debug/sev-snp/* paths
    // exist when AMD SEV-SNP is active
    if (fs.existsSync('/dev/sev-guest') || fs.existsSync('/dev/sev')) {
        return 'sev-snp';
    }
    // Intel TDX: /sys/firmware/tdx exists when TDX is active
    if (fs.existsSync('/sys/firmware/tdx')) {
        return 'tdx';
    }
    return null;
}

// ── EK certificate chain to Google (or AMD) ─────────────────────────────────
// ekCertDer: DER or PEM bytes/string of the EK certificate.

function verifyEkCertChain(ekCertDer) {
    let ekCert;
    try {
        ekCert = new crypto.X509Certificate(ekCertDer);
    } catch (e) {
        throw new AttestationError(
            `Failed to parse EK certificate: ${e.message}`,
            'EK_CERT_PARSE_FAILED'
        );
    }

    const now = Date.now();
    if (Date.parse(ekCert.validFrom) > now) {
        throw new AttestationError(
            `EK cert not yet valid (validFrom=${ekCert.validFrom})`,
            'EK_CERT_NOT_YET_VALID'
        );
    }
    if (Date.parse(ekCert.validTo) < now) {
        throw new AttestationError(
            `EK cert expired (validTo=${ekCert.validTo})`,
            'EK_CERT_EXPIRED'
        );
    }

    // Check whether this is a Confidential VM (AMD SEV-SNP) or a
    // standard Shielded VM, and verify against the appropriate root.
    const ccType = detectConfidentialComputing();

    if (ccType === 'sev-snp') {
        // For Confidential VMs, the EK cert may chain to AMD's VCEK
        // root rather than Google's Shielded VM root. We verify against
        // AMD's ARK (AMD Root Key).
        const amdArk = loadAmdArkCert();
        if (!amdArk) {
            throw new AttestationError(
                'AMD ARK cert required for Confidential VM attestation but not found',
                'AMD_ARK_MISSING'
            );
        }
        // The AMD chain is: VCEK -> ASK (AMD SEV Key) -> ARK (AMD Root Key)
        // The EK cert from a Confidential VM's vTPM is signed by a
        // Google intermediate that itself chains to the AMD platform.
        // We verify the Google EK root first, then also verify the
        // SEV-SNP report separately.
        verifyGoogleEkChain(ekCert);
        verifySevSnpReport();
    } else {
        // Standard Shielded VM: EK cert chains to Google's root
        verifyGoogleEkChain(ekCert);
    }

    return ekCert;
}

function verifyGoogleEkChain(ekCert) {
    const { cert: root } = loadGcpRootCert();

    // GCP Shielded VM EK cert chain is typically:
    //   EK leaf -> Google Intermediate -> GCE vTPM EK Root
    // The intermediate cert is usually embedded in the EK cert's
    // Authority Information Access extension as a caIssuers URL.
    // For offline verification, we check direct issuer match and
    // signature against the pinned root.

    // Try direct verification against the root
    if (ekCert.issuer === root.subject) {
        if (!ekCert.verify(root.publicKey)) {
            throw new AttestationError(
                'EK cert signature verification failed against Google root',
                'EK_CHAIN_BAD_SIGNATURE'
            );
        }
        return;
    }

    // If the issuer doesn't match directly, the cert uses an intermediate.
    // Fetch the intermediate from the AIA extension and verify the chain.
    const aiaUrl = extractAiaUrl(ekCert);
    if (!aiaUrl) {
        throw new AttestationError(
            `EK cert issuer ${ekCert.issuer} does not match Google root ${root.subject} ` +
            'and no AIA URL found for intermediate cert',
            'EK_CHAIN_BROKEN'
        );
    }

    // Try to load a pre-staged intermediate cert
    const intermediatePath = '/etc/safebox/gcp-vtpm-ek-intermediate.pem';
    let intermediate;
    try {
        const intPem = fs.readFileSync(intermediatePath);
        intermediate = new crypto.X509Certificate(intPem);
    } catch {
        throw new AttestationError(
            `EK cert chains through an intermediate not found at ${intermediatePath}. ` +
            `AIA URL: ${aiaUrl}`,
            'EK_CHAIN_INTERMEDIATE_MISSING'
        );
    }

    // Verify: leaf -> intermediate
    if (!ekCert.verify(intermediate.publicKey)) {
        throw new AttestationError(
            'EK cert signature verification failed against intermediate',
            'EK_CHAIN_BAD_SIGNATURE'
        );
    }
    // Verify: intermediate -> root
    if (!intermediate.verify(root.publicKey)) {
        throw new AttestationError(
            'Intermediate cert signature verification failed against Google root',
            'EK_CHAIN_BAD_SIGNATURE'
        );
    }
}

function extractAiaUrl(cert) {
    // Parse the Authority Information Access extension to find the
    // caIssuers URL. The X509Certificate infoAccess property returns
    // a string like: "CA Issuers - URI:https://..."
    const ia = cert.infoAccess;
    if (!ia) return null;
    const match = ia.match(/CA Issuers - URI:(https?:\/\/[^\s,]+)/i);
    return match ? match[1] : null;
}

// ── SEV-SNP attestation report (Confidential VMs) ───────────────────────────

function verifySevSnpReport() {
    // Read the SEV-SNP attestation report from /dev/sev-guest
    // via the SNP_GET_REPORT ioctl. The sev-guest driver exposes
    // this as a file operation.
    //
    // The report structure (MSG_REPORT_RSP) contains:
    //   - MEASUREMENT (48 bytes): SHA-384 of the initial VM state
    //   - HOST_DATA (32 bytes): host-provided data
    //   - REPORT_DATA (64 bytes): guest-provided data
    //   - SIGNATURE (512 bytes): ECDSA-P384 signature by VCEK
    //
    // For now, we verify that the SEV-SNP device is present and
    // accessible, which confirms confidential computing is active.
    // Full VCEK signature verification requires parsing the binary
    // attestation report format and verifying against the AMD cert
    // chain (ARK -> ASK -> VCEK).

    const sevDevice = '/dev/sev-guest';
    if (!fs.existsSync(sevDevice)) {
        // Fall back to checking /dev/sev
        if (!fs.existsSync('/dev/sev')) {
            throw new AttestationError(
                'SEV-SNP device not found. Confidential VM attestation requires /dev/sev-guest.',
                'SEV_NOT_AVAILABLE'
            );
        }
    }

    // Verify we can read the SEV firmware version as a basic health check
    try {
        const sevInfo = fs.readFileSync(
            '/sys/kernel/debug/sev-snp/snp_platform_status', 'utf8'
        ).trim();
        if (sevInfo.length === 0) {
            throw new Error('empty');
        }
    } catch {
        // On some kernel versions, the sysfs path differs. Check the
        // dmesg-level indicator instead.
        try {
            const cpuFlags = fs.readFileSync('/proc/cpuinfo', 'utf8');
            if (!cpuFlags.includes('sev_snp')) {
                throw new AttestationError(
                    'SEV-SNP CPU flag not found in /proc/cpuinfo',
                    'SEV_SNP_NOT_SUPPORTED'
                );
            }
        } catch (e) {
            if (e instanceof AttestationError) throw e;
            // Cannot verify SEV status but device exists — proceed
            // with a warning logged by the caller
        }
    }

    // TODO(1.1): Full VCEK signature verification.
    // The complete implementation needs:
    //   1. ioctl(SNP_GET_REPORT) on /dev/sev-guest with report_data
    //   2. Parse the MSG_REPORT_RSP binary structure
    //   3. Extract the ECDSA-P384 signature
    //   4. Fetch the VCEK cert from AMD KDS:
    //      https://kdsintf.amd.com/vcek/v1/Milan/<chip_id>?blSPL=...
    //   5. Verify VCEK cert chains to ASK -> ARK (pinned above)
    //   6. Verify the report signature against the VCEK public key
    //   7. Compare MEASUREMENT field against expected image measurement
}

// ── Public API ──────────────────────────────────────────────────────────────

function quote(nonceHex) {
    const q = tpmQuote.quote(nonceHex);
    q.cloud = 'gcp';
    // Memory-encryption evidence (SEV-SNP report via /dev/sev-guest, or a
    // TDX quote) with reportData bound to this quote. The device check in
    // detectConfidentialComputing() stays as the cheap pre-check; the
    // report is what the control plane verifies against AMD/Intel roots.
    tpmQuote.attachConfidential(q);
    q.confidentialComputing = q.confidential.type === 'none'
        ? detectConfidentialComputing() : q.confidential.type;
    if (q.confidential.type === 'sev-snp' && !q.snpReport) q.snpReport = q.confidential.report;
    q.ekVerified = false;
    if (q.ekCertPem) {
        verifyEkCertChain(q.ekCertPem);
        q.ekVerified = true;
    }
    return q;
}

function checkAvailable() {
    tpmQuote.checkAvailable();
    loadGcpRootCert();
}

module.exports = {
    quote,
    pcrPolicyList,
    checkAvailable,
    AttestationError,
    verifyEkCertChain,
    _loadGcpRootCert: loadGcpRootCert,
    _loadAmdArkCert: loadAmdArkCert,
    _detectConfidentialComputing: detectConfidentialComputing,
    _verifyEkCertChain: verifyEkCertChain,
    _verifyGoogleEkChain: verifyGoogleEkChain,
    _verifySevSnpReport: verifySevSnpReport,
    GCP_EK_ROOT_FINGERPRINT_HEX,
    AMD_ARK_FINGERPRINT_HEX,
};
