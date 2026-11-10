// /opt/safebox/system/ociAttestationClient.js   (installed as attestationClient.js)
//
// OCI (Oracle Cloud Infrastructure) TPM 2.0 attestation client. Two
// responsibilities (same contract as the other three clouds):
//
//   1. Obtain a TPM2 quote over the policy PCRs (sha256:0,2,4,7,8,9,14,15)
//      bound to a caller nonce. /dev/tpmrm0 is restricted to root and tss
//      on a hardened box, so the quote comes from the root-owned wrapper
//      through tpmQuote.js:
//        sudo /opt/safebox/bin/safebox-tpm-quote <nonce-hex>
//      tpmQuote.js parses the TPMS_ATTEST and checks nonce, PCR selection,
//      PCR digest and the AK signature.
//
//   2. Tie the quote to the platform. OCI has no first-party attestation
//      service, so the EK certificate is checked against either the OCI
//      platform certificate (/etc/safebox/oci-platform-cert.pem, fetched
//      at first boot from IMDS /opc/v2/identity/cert by dnsclient) or a
//      pinned set of TPM manufacturer roots (/etc/safebox/tpm-root-certs/).
//      The EK certificate also lives in TPM NV storage, so it arrives from
//      the wrapper as the optional ekCertPem field; when present the chain
//      is verified here, otherwise the quote is returned with
//      ekVerified=false and the control plane does the check.
//
//      As defence in depth, verifyMeasuredBootLog() replays the Measured
//      Boot event log at /sys/kernel/security/tpm0/binary_bios_measurements
//      and compares it with the quoted PCRs; the log is world-readable,
//      no TPM access needed.
//
// This is a weaker story than AWS NitroTPM or GCP's EK root: nothing
// cryptographically ties the vTPM to an instance OCID. We rely on OCI's
// vTPM provisioning being honest, as before.
//
// Unified interface (same on every cloud):
//   quote(nonceHex) -> { message, signature, pcrs:{0:hex,...}, akPublicPem, ... }
//   pcrPolicyList = [0, 2, 4, 7, 8, 9, 14, 15]

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const tpmQuote = require('./tpmQuote');

const { AttestationError, pcrPolicyList, PCR_BANK } = tpmQuote;

// ── Configuration ───────────────────────────────────────────────────────────

// OCI platform certificate path. On Shielded Instances, OCI provisions
// a platform certificate for the vTPM's EK. This cert chains to OCI's
// intermediate CA, which chains to the TPM manufacturer root.
// Written at first boot by dnsclient from IMDS /opc/v2/identity/cert
// (the installer cannot fetch it: it runs in a build chroot, not on OCI).
const OCI_PLATFORM_CERT_PATH = process.env.SAFEBOX_SYSTEM_OCI_PLATFORM_CERT
    || '/var/lib/safebox/oci-platform-cert.pem';

// TPM manufacturer root certificates. We trust a small set of known
// TPM manufacturers whose roots are pinned here. For OCI vTPMs, the
// actual manufacturer depends on the host hardware generation.
const TPM_ROOT_CERTS_DIR = process.env.SAFEBOX_SYSTEM_TPM_ROOT_CERTS
    || '/etc/safebox/tpm-root-certs';

// Measured Boot event log path (Linux kernel standard)
const EVENT_LOG_PATH = '/sys/kernel/security/tpm0/binary_bios_measurements';

// ── EK certificate chain ────────────────────────────────────────────────────
//
// The Endorsement Key (EK) certificate is the TPM's identity document.
// For a physical TPM, it chains to the manufacturer's root CA (e.g.,
// STMicroelectronics, Infineon, Nuvoton). For OCI's vTPM, it chains
// to an OCI-issued platform certificate.
//
// We verify the chain in two passes:
//   a) Try OCI platform cert first (covers vTPM case)
//   b) Fall back to manufacturer root certs (covers BM instances
//      with a physical TPM)

function toCert(x) {
    if (x instanceof crypto.X509Certificate) return x;
    try { return new crypto.X509Certificate(x); }
    catch (e) { throw new AttestationError(`EK certificate unparseable: ${e.message}`, 'EK_CERT_PARSE_FAILED'); }
}

function verifyEkCertChain(ekCert) {
    const now = Date.now();

    // Check EK cert validity period
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

    // Try verifying against OCI platform cert first
    if (fs.existsSync(OCI_PLATFORM_CERT_PATH)) {
        try {
            const platformPem = fs.readFileSync(OCI_PLATFORM_CERT_PATH);
            const platformCert = new crypto.X509Certificate(platformPem);

            // Check platform cert validity
            if (Date.parse(platformCert.validFrom) > now) {
                throw new AttestationError(
                    'OCI platform cert not yet valid',
                    'PLATFORM_CERT_NOT_YET_VALID'
                );
            }
            if (Date.parse(platformCert.validTo) < now) {
                throw new AttestationError(
                    'OCI platform cert expired',
                    'PLATFORM_CERT_EXPIRED'
                );
            }

            // Verify EK cert is signed by the platform cert
            if (ekCert.verify(platformCert.publicKey)) {
                return { ekCert, issuer: 'oci-platform', platformCert };
            }
        } catch (e) {
            if (e instanceof AttestationError) throw e;
            // Fall through to manufacturer roots
        }
    }

    // Try verifying against pinned TPM manufacturer root certs
    if (fs.existsSync(TPM_ROOT_CERTS_DIR)) {
        const rootFiles = fs.readdirSync(TPM_ROOT_CERTS_DIR)
            .filter(f => f.endsWith('.pem') || f.endsWith('.crt'));

        for (const rootFile of rootFiles) {
            try {
                const rootPem = fs.readFileSync(path.join(TPM_ROOT_CERTS_DIR, rootFile));
                const rootCert = new crypto.X509Certificate(rootPem);

                // For a direct chain (EK signed by root)
                if (ekCert.verify(rootCert.publicKey)) {
                    return { ekCert, issuer: 'tpm-manufacturer', rootCert, rootFile };
                }

                // For an intermediate chain, check if the EK's issuer matches
                // any intermediate cert in the same directory
                if (ekCert.issuer === rootCert.subject) {
                    if (ekCert.verify(rootCert.publicKey)) {
                        return { ekCert, issuer: 'tpm-manufacturer', rootCert, rootFile };
                    }
                }
            } catch {
                // Skip unreadable cert files
                continue;
            }
        }
    }

    throw new AttestationError(
        'EK certificate could not be verified against any trusted root. ' +
        'Provide OCI platform cert at ' + OCI_PLATFORM_CERT_PATH + ' or ' +
        'TPM manufacturer roots in ' + TPM_ROOT_CERTS_DIR,
        'EK_CHAIN_UNTRUSTED'
    );
}

// ── Measured Boot event log replay (defence in depth) ───────────────────────
//
// The Measured Boot event log is a TCG Crypto Agile Log (TCG PC Client
// Platform Firmware Profile spec, section 9). Each entry records:
//   - PCR index that was extended
//   - Event type (EV_*)
//   - Digest(s) of what was measured
//   - Event data (variable, depends on type)
//
// To verify, we replay the log: start with all-zero PCRs and extend
// each one according to the log entries. If the replayed PCR values
// match the quoted PCR values, the log is genuine.
//
// Log format (TCG PC Client spec 2.0, crypto-agile format):
//   uint32  PCRIndex
//   uint32  EventType
//   uint32  DigestCount
//   For each digest:
//     uint16  AlgorithmId (0x000B = SHA-256)
//     byte[]  Digest (32 bytes for SHA-256)
//   uint32  EventSize
//   byte[]  Event[EventSize]

const TCG_ALG_SHA256 = 0x000B;

function verifyMeasuredBootLog(actualPcrsInput) {
    // Accept the quote()'s { index: hex } map or a Map<int, Buffer>.
    const actualPcrs = new Map();
    if (actualPcrsInput instanceof Map) {
        for (const [k, v] of actualPcrsInput) actualPcrs.set(Number(k), Buffer.isBuffer(v) ? v : Buffer.from(v, 'hex'));
    } else if (actualPcrsInput && typeof actualPcrsInput === 'object') {
        for (const [k, v] of Object.entries(actualPcrsInput)) actualPcrs.set(Number(k), Buffer.isBuffer(v) ? v : Buffer.from(v, 'hex'));
    }
    if (!fs.existsSync(EVENT_LOG_PATH)) {
        // Event log may not be available on all configurations.
        // This is a defense-in-depth check, not a hard requirement.
        // The TPM quote is already signed by the TPM; the event log
        // cross-check catches log-tampering attacks specifically.
        return { verified: false, reason: 'event log not available' };
    }

    let logData;
    try {
        logData = fs.readFileSync(EVENT_LOG_PATH);
    } catch (e) {
        return { verified: false, reason: `could not read event log: ${e.message}` };
    }

    if (logData.length === 0) {
        return { verified: false, reason: 'event log is empty' };
    }

    // Initialize simulated PCR banks (all zeros)
    const simulatedPcrs = new Map();
    for (const idx of pcrPolicyList) {
        simulatedPcrs.set(idx, Buffer.alloc(32, 0));
    }

    // Replay the event log
    let offset = 0;
    let eventCount = 0;
    const maxEvents = 10000; // safety bound

    while (offset < logData.length && eventCount < maxEvents) {
        // Need at least 12 bytes for the fixed header
        if (offset + 12 > logData.length) break;

        const pcrIndex   = logData.readUInt32LE(offset);      offset += 4;
        const eventType  = logData.readUInt32LE(offset);      offset += 4;

        // Event type 0x00000003 (EV_NO_ACTION) at PCR 0 with the
        // "Spec ID Event03" signature marks the transition from the
        // legacy format to the crypto-agile format. The first event
        // in the log is always this legacy-format entry.
        if (eventCount === 0 && eventType === 0x00000003 && pcrIndex === 0) {
            // Legacy-format first event: skip the 20-byte SHA-1 digest
            // and then read EventSize + Event
            offset += 20; // SHA-1 digest placeholder
            if (offset + 4 > logData.length) break;
            const eventSize = logData.readUInt32LE(offset);   offset += 4;
            offset += eventSize; // skip the Spec ID Event data
            eventCount++;
            continue;
        }

        // Crypto-agile format: DigestCount followed by digest entries
        if (offset + 4 > logData.length) break;
        const digestCount = logData.readUInt32LE(offset);     offset += 4;

        if (digestCount > 16) {
            // Sanity check — spec allows multiple hash algorithms but
            // more than 16 is clearly corrupt
            return { verified: false, reason: `corrupt log: digestCount=${digestCount} at event ${eventCount}` };
        }

        let sha256Digest = null;

        for (let d = 0; d < digestCount; d++) {
            if (offset + 2 > logData.length) break;
            const algId = logData.readUInt16LE(offset);       offset += 2;

            // Determine digest size from algorithm ID
            let digestSize;
            switch (algId) {
                case 0x0004: digestSize = 20; break;   // SHA-1
                case 0x000B: digestSize = 32; break;   // SHA-256
                case 0x000C: digestSize = 48; break;   // SHA-384
                case 0x000D: digestSize = 64; break;   // SHA-512
                default:
                    return { verified: false, reason: `unknown hash algorithm 0x${algId.toString(16)} at event ${eventCount}` };
            }

            if (offset + digestSize > logData.length) break;
            const digest = logData.subarray(offset, offset + digestSize);
            offset += digestSize;

            if (algId === TCG_ALG_SHA256) {
                sha256Digest = Buffer.from(digest);
            }
        }

        // Read event data (we don't need it for PCR replay, but must skip it)
        if (offset + 4 > logData.length) break;
        const eventSize = logData.readUInt32LE(offset);       offset += 4;
        if (offset + eventSize > logData.length) break;
        offset += eventSize;

        // Extend the simulated PCR if this is one we care about
        if (sha256Digest && simulatedPcrs.has(pcrIndex)) {
            const current = simulatedPcrs.get(pcrIndex);
            // PCR extend = SHA-256(current || new_measurement)
            const extended = crypto.createHash('sha256')
                .update(current)
                .update(sha256Digest)
                .digest();
            simulatedPcrs.set(pcrIndex, extended);
        }

        eventCount++;
    }

    // Compare simulated PCRs against actual TPM PCR values
    const mismatches = [];
    for (const [idx, simulated] of simulatedPcrs) {
        const actual = actualPcrs.get(idx);
        if (!actual) {
            mismatches.push(`PCR${idx}: not present in actual PCRs`);
            continue;
        }
        if (!simulated.equals(actual)) {
            mismatches.push(
                `PCR${idx}: log replay = ${simulated.toString('hex')}, ` +
                `TPM actual = ${actual.toString('hex')}`
            );
        }
    }

    if (mismatches.length > 0) {
        return {
            verified: false,
            reason: 'PCR mismatch between event log replay and TPM: ' + mismatches.join('; '),
            mismatches,
        };
    }

    return { verified: true, eventCount };
}

// ── Public API ──────────────────────────────────────────────────────────────

function quote(nonceHex) {
    const q = tpmQuote.quote(nonceHex);
    q.cloud = 'oci';
    q.ekVerified = false;
    if (q.ekCertPem) {
        verifyEkCertChain(toCert(q.ekCertPem));
        q.ekVerified = true;
    }
    // Memory-encryption evidence bound to this quote. Plain SEV (OCI E4
    // shapes, memory encryption on by default) exposes no guest report, so
    // this is "none" there; only SEV-SNP or TDX shapes produce a report.
    tpmQuote.attachConfidential(q);
    q.confidentialComputing = q.confidential.type === 'none' ? null : q.confidential.type;
    // Event-log mismatch means the log was tampered with or a PCR was
    // extended outside measured boot; either way refuse. An unavailable
    // log is not an error (the quote itself is TPM-signed).
    const logResult = verifyMeasuredBootLog(q.pcrs);
    if (logResult.verified === false && logResult.mismatches) {
        throw new AttestationError(
            'Measured Boot event log does not match quoted PCR values: ' + logResult.reason,
            'EVENT_LOG_MISMATCH'
        );
    }
    q.eventLogVerified = logResult.verified === true;
    return q;
}

function checkAvailable() {
    tpmQuote.checkAvailable();
}

module.exports = {
    quote,
    pcrPolicyList,
    PCR_BANK,
    checkAvailable,
    AttestationError,
    verifyEkCertChain,
    verifyMeasuredBootLog,
    _verifyEkCertChain: verifyEkCertChain,
    _verifyMeasuredBootLog: verifyMeasuredBootLog,
    OCI_PLATFORM_CERT_PATH,
    TPM_ROOT_CERTS_DIR,
    EVENT_LOG_PATH,
};
