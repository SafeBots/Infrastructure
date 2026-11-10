// /opt/safebox/system/azureAttestationClient.js   (installed as attestationClient.js)
//
// Azure vTPM + SEV-SNP attestation client. Two responsibilities (same
// contract as the other three clouds):
//
//   1. Obtain a TPM2 quote over the policy PCRs (sha256:0,2,4,7,8,9,14,15)
//      bound to a caller nonce. /dev/tpmrm0 is restricted to root and tss
//      on a hardened box, so the quote comes from the root-owned wrapper
//      through tpmQuote.js:
//        sudo /opt/safebox/bin/safebox-tpm-quote <nonce-hex>
//      tpmQuote.js parses the TPMS_ATTEST and checks nonce, PCR selection,
//      PCR digest and the AK signature.
//
//   2. Tie the quote to Azure. On Confidential VMs (DCasv5 / ECasv5) the
//      hypervisor writes the AMD SEV-SNP attestation report into the
//      vTPM's NVRAM at index 0x01400001. Reading NVRAM also needs the TPM
//      device, so the report arrives from the wrapper as the optional
//      snpReport field (base64). When present it can be verified with
//      verifySnpReport(): MAA (Microsoft Azure Attestation) first, direct
//      AMD VCEK chain as the fallback. On Trusted Launch VMs there is no
//      SNP report and the vTPM quote alone is the attestation; the
//      control plane checks the EK certificate (ekCertPem, when the
//      wrapper supplies it) against Microsoft's vTPM CA.
//
// Unified interface (same on every cloud):
//   quote(nonceHex) -> { message, signature, pcrs:{0:hex,...}, akPublicPem, ... }
//   pcrPolicyList = [0, 2, 4, 7, 8, 9, 14, 15]
//
// SEV-SNP Report Structure (AMD SEV Firmware ABI, Table 21):
//
//   Offset  Size  Field
//   0x000   4     version         (must be 2)
//   0x004   4     guest_svn       (guest security version)
//   0x008   8     policy          (guest policy flags)
//   0x010   16    family_id
//   0x020   16    image_id
//   0x030   4     vmpl            (VM privilege level, 0 for most uses)
//   0x034   4     signature_algo  (1 = ECDSA P-384 with SHA-384)
//   0x038   8     platform_version (TCB version)
//   0x040   8     platform_info
//   0x048   4     flags           (author key used, etc.)
//   0x04C   4     reserved
//   0x050   48    report_data     (first 48 bytes of caller-supplied data)
//   0x080   48    measurement     (launch digest)
//   0x0B0   32    host_data       (host-provided data, set at VM launch)
//   0x0D0   48    id_key_digest
//   0x100   48    author_key_digest
//   0x130   32    report_id
//   0x150   32    report_id_ma
//   0x170   8     reported_tcb
//   0x178   24    reserved2
//   0x190   64    chip_id
//   0x1D0   8     committed_tcb
//   0x1D8   1     current_build
//   0x1D9   1     current_minor
//   0x1DA   1     current_major
//   0x1DB   1     reserved3
//   0x1DC   1     committed_build
//   0x1DD   1     committed_minor
//   0x1DE   1     committed_major
//   0x1DF   1     reserved4
//   0x1E0   8     launch_tcb
//   0x1E8   168   reserved5
//   0x2A0   512   signature       (ECDSA P-384, r || s, zero-padded to 512; AMD SEV-SNP ABI Table 22)
//
//   Total: 0x4A0 (1184) bytes
//
// Return shape (same as nsmClient.js):
//   { pcrs: Map<int, Buffer> }

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const tpmQuote = require('./tpmQuote');

const { AttestationError, pcrPolicyList } = tpmQuote;

// ── Configuration ───────────────────────────────────────────────────────────

// vTPM NVRAM index where Azure writes the SEV-SNP report (read by the wrapper)
const SNP_REPORT_NVRAM_INDEX = '0x01400001';

// MAA endpoint — region is detected from IMDS at runtime
const MAA_API_VERSION = '2022-08-01';
const MAA_ATTEST_PATH = '/attest/SevSnpVm';

// AMD Key Distribution Service for direct VCEK verification
const AMD_KDS_HOST = 'kdsintf.amd.com';
const AMD_KDS_VCEK_PATH = '/vcek/v1/Milan';  // Milan = EPYC 7003 series
const AMD_KDS_CERT_CHAIN_PATH = '/vcek/v1/Milan/cert_chain';

// SNP report constants
const SNP_REPORT_SIZE = 0x4A0;  // 1184 bytes (AMD SEV-SNP ABI spec, ATTESTATION_REPORT)
const SNP_REPORT_VERSION = 2;
const SNP_SIG_ALGO_ECDSA_P384 = 1;
const SNP_SIGNATURE_OFFSET = 0x2A0;
const SNP_SIGNATURE_SIZE = 512;  // r (48) + s (48) zero-padded to 512

// MAA JWKS cache TTL
const JWKS_CACHE_TTL_MS = 3600 * 1000;  // 1 hour

// ── SEV-SNP report parsing ──────────────────────────────────────────────────

function parseSnpReport(reportBuf) {
    const version = reportBuf.readUInt32LE(0x000);
    if (version !== SNP_REPORT_VERSION) {
        throw new AttestationError(
            `SNP report version ${version}, expected ${SNP_REPORT_VERSION}`,
            'SNP_BAD_VERSION'
        );
    }
    const signatureAlgo = reportBuf.readUInt32LE(0x034);
    if (signatureAlgo !== SNP_SIG_ALGO_ECDSA_P384) {
        throw new AttestationError(
            `SNP signature algorithm ${signatureAlgo}, expected ${SNP_SIG_ALGO_ECDSA_P384} (ECDSA P-384)`,
            'SNP_BAD_SIG_ALGO'
        );
    }

    return {
        version,
        guestSvn:         reportBuf.readUInt32LE(0x004),
        policy:           reportBuf.readBigUInt64LE(0x008),
        familyId:         reportBuf.subarray(0x010, 0x020),
        imageId:          reportBuf.subarray(0x020, 0x030),
        vmpl:             reportBuf.readUInt32LE(0x030),
        signatureAlgo,
        platformVersion:  reportBuf.readBigUInt64LE(0x038),
        platformInfo:     reportBuf.readBigUInt64LE(0x040),
        flags:            reportBuf.readUInt32LE(0x048),
        reportData:       reportBuf.subarray(0x050, 0x080),
        measurement:      reportBuf.subarray(0x080, 0x0B0),
        hostData:         reportBuf.subarray(0x0B0, 0x0D0),
        idKeyDigest:      reportBuf.subarray(0x0D0, 0x100),
        authorKeyDigest:  reportBuf.subarray(0x100, 0x130),
        reportId:         reportBuf.subarray(0x130, 0x150),
        reportIdMa:       reportBuf.subarray(0x150, 0x170),
        reportedTcb:      reportBuf.readBigUInt64LE(0x170),
        chipId:           reportBuf.subarray(0x190, 0x1D0),
        committedTcb:     reportBuf.readBigUInt64LE(0x1D0),
        currentBuild:     reportBuf.readUInt8(0x1D8),
        currentMinor:     reportBuf.readUInt8(0x1D9),
        currentMajor:     reportBuf.readUInt8(0x1DA),
        committedBuild:   reportBuf.readUInt8(0x1DC),
        committedMinor:   reportBuf.readUInt8(0x1DD),
        committedMajor:   reportBuf.readUInt8(0x1DE),
        launchTcb:        reportBuf.readBigUInt64LE(0x1E0),
        // Signature: ECDSA P-384, r||s each 48 bytes, zero-padded to 512 total
        signatureR:       reportBuf.subarray(SNP_SIGNATURE_OFFSET, SNP_SIGNATURE_OFFSET + 48),
        signatureS:       reportBuf.subarray(SNP_SIGNATURE_OFFSET + 48, SNP_SIGNATURE_OFFSET + 96),
        // The signed portion is everything before the signature
        signedData:       reportBuf.subarray(0, SNP_SIGNATURE_OFFSET),
    };
}

// ── MAA verification path ───────────────────────────────────────────────────

// Detect the Azure region from IMDS (Instance Metadata Service)
let cachedRegion = null;
function getAzureRegion() {
    if (cachedRegion) return cachedRegion;
    try {
        const resp = execFileSync('/usr/bin/curl', [
            '-sfH', 'Metadata:true',
            '--noproxy', '*',
            'http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text',
        ], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
        cachedRegion = resp.toString().trim();
        return cachedRegion;
    } catch (e) {
        throw new AttestationError(
            `Failed to detect Azure region from IMDS: ${e.message}`,
            'IMDS_UNAVAILABLE'
        );
    }
}

// JWKS cache for MAA signing keys
let jwksCache = null;
let jwksCacheTime = 0;

function httpsGetJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new AttestationError(
                    `HTTP ${res.statusCode} from ${url}`,
                    'HTTP_ERROR'
                ));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                } catch (e) {
                    reject(new AttestationError(`Invalid JSON from ${url}: ${e.message}`, 'JSON_PARSE_FAILED'));
                }
            });
        });
        req.on('error', (e) => reject(new AttestationError(`Request to ${url} failed: ${e.message}`, 'HTTP_ERROR')));
        req.on('timeout', () => { req.destroy(); reject(new AttestationError(`Timeout fetching ${url}`, 'HTTP_TIMEOUT')); });
    });
}

function httpsPost(url, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
            timeout: timeoutMs,
        };
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new AttestationError(
                        `HTTP ${res.statusCode} from ${url}: ${text.substring(0, 200)}`,
                        'MAA_REQUEST_FAILED'
                    ));
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch {
                    // MAA may return the JWT as a raw string
                    resolve({ token: text });
                }
            });
        });
        req.on('error', (e) => reject(new AttestationError(`POST to ${url} failed: ${e.message}`, 'MAA_REQUEST_FAILED')));
        req.on('timeout', () => { req.destroy(); reject(new AttestationError(`Timeout posting to ${url}`, 'MAA_TIMEOUT')); });
        req.write(body);
        req.end();
    });
}

async function fetchMaaSigningKeys(region) {
    const now = Date.now();
    if (jwksCache && (now - jwksCacheTime) < JWKS_CACHE_TTL_MS) {
        return jwksCache;
    }
    const jwksUrl = `https://${region}.attest.azure.net/certs`;
    const jwks = await httpsGetJson(jwksUrl, 10000);
    if (!jwks.keys || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new AttestationError('MAA JWKS response has no keys', 'MAA_JWKS_EMPTY');
    }
    jwksCache = jwks;
    jwksCacheTime = now;
    return jwks;
}

function base64urlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64');
}

function verifyMaaJwt(token, jwks) {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new AttestationError('MAA JWT does not have 3 parts', 'MAA_JWT_MALFORMED');
    }
    const header = JSON.parse(base64urlDecode(parts[0]).toString());
    const payload = JSON.parse(base64urlDecode(parts[1]).toString());

    if (header.alg !== 'RS256') {
        throw new AttestationError(`MAA JWT alg=${header.alg}, expected RS256`, 'MAA_JWT_BAD_ALG');
    }

    // Find the signing key by kid
    const kid = header.kid;
    if (!kid) {
        throw new AttestationError('MAA JWT header missing kid', 'MAA_JWT_NO_KID');
    }
    const jwk = jwks.keys.find(k => k.kid === kid);
    if (!jwk) {
        throw new AttestationError(`MAA signing key ${kid} not found in JWKS`, 'MAA_JWT_KEY_NOT_FOUND');
    }

    // Build the public key from the JWK
    const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });

    // Verify the signature
    const signedContent = parts[0] + '.' + parts[1];
    const signature = base64urlDecode(parts[2]);
    const ok = crypto.verify('sha256', Buffer.from(signedContent), pubKey, signature);
    if (!ok) {
        throw new AttestationError('MAA JWT signature verification failed', 'MAA_JWT_SIG_INVALID');
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new AttestationError(
            `MAA JWT expired at ${new Date(payload.exp * 1000).toISOString()}`,
            'MAA_JWT_EXPIRED'
        );
    }
    if (payload.nbf && payload.nbf > now + 300) {
        throw new AttestationError(
            `MAA JWT not valid until ${new Date(payload.nbf * 1000).toISOString()}`,
            'MAA_JWT_NOT_YET_VALID'
        );
    }

    return payload;
}

async function verifyViaMaa(reportBuf) {
    const region = getAzureRegion();
    const maaUrl = `https://${region}.attest.azure.net${MAA_ATTEST_PATH}?api-version=${MAA_API_VERSION}`;

    // MAA expects the report as base64url-encoded in a JSON envelope
    const requestBody = JSON.stringify({
        report: reportBuf.toString('base64url'),
    });

    const response = await httpsPost(maaUrl, requestBody, {
        'Content-Type': 'application/json',
    }, 15000);

    const token = response.token || response;
    if (typeof token !== 'string' || token.split('.').length !== 3) {
        throw new AttestationError('MAA response does not contain a valid JWT', 'MAA_RESPONSE_INVALID');
    }

    // Fetch MAA signing keys and verify the JWT
    const jwks = await fetchMaaSigningKeys(region);
    const claims = verifyMaaJwt(token, jwks);

    return claims;
}

// ── Direct VCEK verification path ───────────────────────────────────────────

async function fetchVcekCert(chipId, reportedTcb) {
    // TCB version is packed as 8 bytes: boot_loader, tee, reserved, snp,
    // microcode (each 1 byte), plus padding
    const tcbBuf = Buffer.alloc(8);
    tcbBuf.writeBigUInt64LE(reportedTcb);

    const blSpl  = tcbBuf[0];
    const teeSpl = tcbBuf[1];
    const snpSpl = tcbBuf[3];
    const ucSpl  = tcbBuf[4];

    const chipIdHex = chipId.toString('hex');
    const vcekUrl = `https://${AMD_KDS_HOST}${AMD_KDS_VCEK_PATH}` +
        `/${chipIdHex}?blSPL=${blSpl}&teeSPL=${teeSpl}&snpSPL=${snpSpl}&ucodeSPL=${ucSpl}`;

    return new Promise((resolve, reject) => {
        https.get(vcekUrl, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new AttestationError(
                    `AMD KDS returned HTTP ${res.statusCode} for VCEK`,
                    'VCEK_FETCH_FAILED'
                ));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const certDer = Buffer.concat(chunks);
                try {
                    resolve(new crypto.X509Certificate(certDer));
                } catch (e) {
                    reject(new AttestationError(`VCEK cert parse failed: ${e.message}`, 'VCEK_PARSE_FAILED'));
                }
            });
        }).on('error', (e) => {
            reject(new AttestationError(`VCEK fetch failed: ${e.message}`, 'VCEK_FETCH_FAILED'));
        });
    });
}

async function fetchAmdCertChain() {
    const chainUrl = `https://${AMD_KDS_HOST}${AMD_KDS_CERT_CHAIN_PATH}`;
    return new Promise((resolve, reject) => {
        https.get(chainUrl, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new AttestationError(
                    `AMD KDS returned HTTP ${res.statusCode} for cert chain`,
                    'AMD_CHAIN_FETCH_FAILED'
                ));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const pemData = Buffer.concat(chunks).toString();
                // The chain PEM contains ASK (AMD SEV Key) + ARK (AMD Root Key)
                const certs = pemData.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
                if (!certs || certs.length < 2) {
                    reject(new AttestationError(
                        'AMD cert chain does not contain at least 2 certificates (ASK + ARK)',
                        'AMD_CHAIN_INCOMPLETE'
                    ));
                    return;
                }
                resolve({
                    ask: new crypto.X509Certificate(certs[0]),
                    ark: new crypto.X509Certificate(certs[1]),
                });
            });
        }).on('error', (e) => {
            reject(new AttestationError(`AMD cert chain fetch failed: ${e.message}`, 'AMD_CHAIN_FETCH_FAILED'));
        });
    });
}

function rawP384SignatureToDer(r, s) {
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

async function verifyViaVcek(report, reportBuf) {
    // Fetch the VCEK cert for this specific chip and TCB version
    const vcek = await fetchVcekCert(report.chipId, report.reportedTcb);

    // Fetch the AMD cert chain (ASK + ARK) and verify VCEK chains to ARK
    const { ask, ark } = await fetchAmdCertChain();

    // Verify chain: VCEK -> ASK -> ARK (self-signed)
    if (!vcek.verify(ask.publicKey)) {
        throw new AttestationError('VCEK not signed by AMD ASK', 'VCEK_CHAIN_BROKEN');
    }
    if (!ask.verify(ark.publicKey)) {
        throw new AttestationError('AMD ASK not signed by AMD ARK', 'AMD_CHAIN_BROKEN');
    }
    if (!ark.verify(ark.publicKey)) {
        throw new AttestationError('AMD ARK is not self-signed', 'AMD_ARK_NOT_SELF_SIGNED');
    }

    // Verify cert validity
    const now = Date.now();
    for (const [name, cert] of [['VCEK', vcek], ['ASK', ask], ['ARK', ark]]) {
        if (Date.parse(cert.validFrom) > now) {
            throw new AttestationError(`${name} not yet valid`, 'CERT_NOT_YET_VALID');
        }
        if (Date.parse(cert.validTo) < now) {
            throw new AttestationError(`${name} expired`, 'CERT_EXPIRED');
        }
    }

    // Verify the SNP report signature against the VCEK public key
    const derSig = rawP384SignatureToDer(report.signatureR, report.signatureS);
    const ok = crypto.verify('sha384', report.signedData, {
        key: vcek.publicKey,
        dsaEncoding: 'der',
    }, derSig);
    if (!ok) {
        throw new AttestationError('SNP report signature verification failed against VCEK', 'SNP_SIG_INVALID');
    }
}

// ── SNP report verification (either path) ───────────────────────────────────
// reportInput: Buffer or base64 string of the raw report bytes.

async function verifySnpReport(reportInput) {
    const reportBuf = Buffer.isBuffer(reportInput) ? reportInput : Buffer.from(String(reportInput), 'base64');
    if (reportBuf.length < SNP_REPORT_SIZE) {
        throw new AttestationError(
            `SNP report too short: got ${reportBuf.length} bytes, expected ${SNP_REPORT_SIZE}`,
            'SNP_READ_FAILED'
        );
    }
    const report = parseSnpReport(reportBuf.subarray(0, SNP_REPORT_SIZE));
    try {
        return { via: 'maa', claims: await verifyViaMaa(reportBuf) };
    } catch (maaErr) {
        try {
            await verifyViaVcek(report, reportBuf);
            return { via: 'vcek', report };
        } catch (vcekErr) {
            throw new AttestationError(
                `Both MAA and VCEK verification failed.\n` +
                `  MAA:  ${maaErr.message}\n` +
                `  VCEK: ${vcekErr.message}`,
                'ATTESTATION_BOTH_FAILED'
            );
        }
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

function quote(nonceHex) {
    const q = tpmQuote.quote(nonceHex);
    q.cloud = 'azure';
    // Memory-encryption evidence: on a Confidential VM the wrapper reads the
    // SNP report from vTPM NV 0x01400001 (there is no /dev/sev-guest under
    // the paravisor). The same bytes feed verifySnpReport() through the
    // legacy snpReport field when the wrapper did not already supply it.
    tpmQuote.attachConfidential(q);
    q.confidentialComputing = q.confidential.type === 'none'
        ? (fs.existsSync('/dev/sev-guest') ? 'sev-snp' : null) : q.confidential.type;
    if (q.confidential.type === 'sev-snp' && !q.snpReport) q.snpReport = q.confidential.report;
    q.ekVerified = false;  // Azure vTPM EK chain is checked by the control plane
    return q;
}

function checkAvailable() {
    tpmQuote.checkAvailable();
}

module.exports = {
    quote,
    pcrPolicyList,
    checkAvailable,
    AttestationError,
    verifySnpReport,
    _parseSnpReport: parseSnpReport,
    _verifyViaMaa: verifyViaMaa,
    _verifyViaVcek: verifyViaVcek,
    _rawP384SignatureToDer: rawP384SignatureToDer,
    _verifyMaaJwt: verifyMaaJwt,
    SNP_REPORT_NVRAM_INDEX,
    SNP_REPORT_SIZE,
};
