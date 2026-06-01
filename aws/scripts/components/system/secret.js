// /opt/safebox/system/secret.js
//
// Loads the shared HMAC secret. Three sources, in order of preference:
//
//   1. Existing on-disk key at /etc/safebox/system.hmac, if present and
//      32 bytes. Both processes (Safebox Node and the System component) check this
//      first so that on warm restarts neither process touches NSM.
//
//   2. Derived from a verified Nitro attestation document. The deterministic
//      derivation function (attestationDerive) is COPIED VERBATIM from
//      Safebox's classes/Safebox/Protocol/System.js — see banner below.
//      Both processes derive the same 32 bytes from the same attestation
//      payload, then race to write the file with O_EXCL. Whoever wins,
//      writes; whoever loses, re-reads bit-identical bytes.
//
//   3. Random 32 bytes for non-Nitro hosts (dev environments). Logged
//      loudly so operators notice. NOT bound to host attestation; do not
//      use in production.
//
// The Safebox NSM client and the verification chain (COSE_Sign1 signature
// against aws.nitro-enclaves-root-G1.pem, certificate chain validation,
// CBOR decode) live in nsmClient.js. attestationDerive only sees a
// verified payload.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const SECRET_PATH = process.env.SAFEBOX_SYSTEM_SECRET || '/etc/safebox/system.hmac';
const KEY_BYTES = 32;

// ─────────────────────────────────────────────────────────────────────────────
// BEGIN VERBATIM COPY — DO NOT EDIT
//
// Source of truth: Safebox repo, classes/Safebox/Protocol/System.js
// Any change here MUST be coordinated with the Safebox-side copy or the two
// processes will derive silently different keys and authentication breaks.
// Test vector (must match on both sides):
//   PCR0 = 0xaa × 48,  PCR1 = 0xbb × 48,  PCR4 = 0xcc × 48
//   → ac39caf5fadb5c00cfee415f7de54007aeb3a86c8b5c1315dd86d537fdb036eb
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the 32-byte HMAC secret from a verified Nitro attestation
 * document. Pure function: given the same `verifiedPayload`, returns
 * exactly the same 32 bytes on both Safebox Node and the System component.
 *
 * @param {object} verifiedPayload   The CBOR-decoded payload of a Nitro
 *                                   attestation document, AFTER the COSE_Sign1
 *                                   signature has been verified against the
 *                                   AWS Nitro Enclaves root certificate.
 * @return {Buffer}  32 bytes
 * @throws {Error}   if any required PCR is missing or has unexpected size
 */
function attestationDerive(verifiedPayload) {
    // The PCR set we bind to. Chosen for:
    //   PCR0 — Enclave image file. Changes when the AMI is rebuilt.
    //   PCR1 — Linux kernel + bootstrap. Changes on kernel updates.
    //   PCR4 — Parent EC2 instance ID. Changes when moved to a
    //          different EC2 instance, defeating disk-image-copy attacks.
    // PCR2 (application) is DELIBERATELY EXCLUDED so that redeploying the
    // Safebox application doesn't rotate the HMAC. Operators can force
    // rotation by deleting the secret file; both processes will re-derive
    // from a fresh attestation on next request.
    var PCR_INDICES = [0, 1, 4];

    function getPcr(idx) {
        if (!verifiedPayload || !verifiedPayload.pcrs) {
            throw new Error('attestationDerive: verifiedPayload.pcrs missing');
        }
        var pcrs = verifiedPayload.pcrs;
        var v = (typeof pcrs.get === 'function')
            ? pcrs.get(idx)
            : (pcrs[idx] !== undefined ? pcrs[idx] : pcrs[String(idx)]);
        if (!v) {
            throw new Error('attestationDerive: PCR' + idx + ' missing from verified payload');
        }
        if (Buffer.isBuffer(v)) return v;
        if (v instanceof Uint8Array) return Buffer.from(v);
        if (typeof v === 'string') return Buffer.from(v, 'hex');
        throw new Error('attestationDerive: PCR' + idx + ' has unexpected type ' + typeof v);
    }

    var chunks = [];
    for (var i = 0; i < PCR_INDICES.length; i++) {
        var idx = PCR_INDICES[i];
        var pcrBytes = getPcr(idx);
        if (pcrBytes.length === 0 || pcrBytes.length > 65535) {
            throw new Error('attestationDerive: PCR' + idx + ' has invalid length '
                + pcrBytes.length);
        }
        var header = Buffer.alloc(3);
        header.writeUInt8(idx, 0);
        header.writeUInt16BE(pcrBytes.length, 1);
        chunks.push(header);
        chunks.push(pcrBytes);
    }
    var ikm = Buffer.concat(chunks);

    var SALT = Buffer.alloc(32);  // 32 zero bytes
    var INFO = Buffer.from('safebox-gateway-hmac-v1', 'utf8');
    var L    = 32;

    if (typeof crypto.hkdfSync === 'function') {
        return Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, INFO, L));
    }

    // RFC 5869 fallback for Node < 15.0
    var prk = crypto.createHmac('sha256', SALT).update(ikm).digest();
    var out = Buffer.alloc(0);
    var t = Buffer.alloc(0);
    var counter = 1;
    while (out.length < L) {
        t = crypto.createHmac('sha256', prk)
            .update(Buffer.concat([t, INFO, Buffer.from([counter])]))
            .digest();
        out = Buffer.concat([out, t]);
        counter++;
    }
    return out.slice(0, L);
}

// ─────────────────────────────────────────────────────────────────────────────
// END VERBATIM COPY
// ─────────────────────────────────────────────────────────────────────────────

function readExisting() {
    try {
        const buf = fs.readFileSync(SECRET_PATH);
        if (buf.length === KEY_BYTES) return buf;
        console.warn(`[system] WARN ${SECRET_PATH} has wrong length ${buf.length} (expected ${KEY_BYTES}); will re-derive`);
        return null;
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn(`[system] WARN reading ${SECRET_PATH}: ${e.message}`);
        }
        return null;
    }
}

// Write with O_EXCL. If another process won the race, fall through to
// re-reading what they wrote. Both processes derive deterministically from
// the same attestation, so what's on disk equals what we would have written.
function writeSecretExclusive(buf) {
    try {
        fs.writeFileSync(SECRET_PATH, buf, { mode: 0o640, flag: 'wx' });
        return { wrote: true };
    } catch (e) {
        if (e.code === 'EEXIST') return { wrote: false, raced: true };
        throw e;
    }
}

async function load() {
    // 1. Existing on-disk key (warm restart path)
    const existing = readExisting();
    if (existing) {
        console.log('[system] secret: loaded from /etc/safebox/system.hmac');
        return existing;
    }

    // 2. Derive from Nitro attestation
    let nsmClient = null;
    try {
        nsmClient = require('./nsmClient');
    } catch (e) {
        console.warn(`[system] WARN nsmClient not loadable: ${e.message}`);
    }

    if (nsmClient) {
        try {
            const verifiedPayload = nsmClient.getVerifiedAttestationSync();
            const derived = attestationDerive(verifiedPayload);
            const result = writeSecretExclusive(derived);
            if (result.wrote) {
                console.log('[system] secret: derived from Nitro attestation, wrote to disk');
                return derived;
            } else {
                // Race lost — re-read. Bit-identical because derivation is deterministic.
                const reread = readExisting();
                if (reread && reread.equals(derived)) {
                    console.log('[system] secret: derived from Nitro attestation; lost write race, re-read identical bytes');
                    return reread;
                }
                throw new Error('secret on disk does not match derived value after race; refuse to start');
            }
        } catch (e) {
            console.warn(`[system] WARN NSM attestation derivation failed: ${e.message}`);
            // Fall through to random for non-Nitro environments
        }
    }

    // 3. Random fallback (dev / non-Nitro)
    console.warn('[system] WARN no on-disk key and no Nitro NSM available');
    console.warn('[system] WARN generating random 32 bytes — NOT bound to host attestation; dev mode only');
    const rand = crypto.randomBytes(KEY_BYTES);
    const result = writeSecretExclusive(rand);
    if (result.wrote) return rand;
    // Race lost in the random path means another process generated its OWN random
    // bytes — keys won't match. Re-read and trust the file (they got there first).
    const reread = readExisting();
    if (reread) {
        console.warn('[system] WARN lost random-key write race; using bytes written by other process');
        return reread;
    }
    throw new Error('could not write or re-read secret file');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-container key derivation
//
// Each container has its own HMAC key, derived deterministically from the
// master secret by HKDF. The info string includes the container name so that
// every container's key is cryptographically independent: leaking one
// container's key tells you nothing about any other container's key.
//
// The System component holds the master, derives per-container keys at
// startup (and on SIGHUP when containers are added), writes each to disk
// at /etc/safebox/containers/<containerName>.hmac, and ensures the file
// is owned by safebox-infra mode 0640.
//
// At container-creation time, that key file is bind-mounted read-only into
// the container at /etc/safebox/system.hmac, where the container's
// Safebox Node finds it via the conventional path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a per-container HMAC key from the master secret.
 *
 * The info string includes the container name AND a per-container "key
 * epoch" — a random hex string generated at /containers/create time and
 * stored in managed-containers.json. The epoch is forgotten on
 * /containers/destroy, so re-creating a container with the same name
 * yields a NEW key. Compromise of an old container's key does not
 * authenticate against a freshly-created container with the same name.
 *
 * @param {Buffer} masterSecret    32-byte master from attestationDerive()
 * @param {string} containerName   container key in managed-containers.json
 * @param {string} keyEpoch        per-create random hex string (16-128 chars)
 * @return {Buffer}                32 bytes, deterministic per (master, name, epoch)
 */
function derivePerContainerKey(masterSecret, containerName, keyEpoch) {
    if (!Buffer.isBuffer(masterSecret) || masterSecret.length !== KEY_BYTES) {
        throw new Error('derivePerContainerKey: masterSecret must be a 32-byte Buffer');
    }
    if (typeof containerName !== 'string' || containerName.length === 0 || containerName.length > 128) {
        throw new Error('derivePerContainerKey: containerName must be a non-empty string ≤128 chars');
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(containerName)) {
        throw new Error(`derivePerContainerKey: containerName has invalid characters: ${containerName}`);
    }
    if (typeof keyEpoch !== 'string' || !/^[a-f0-9]{16,128}$/.test(keyEpoch)) {
        throw new Error('derivePerContainerKey: keyEpoch must be 16-128 lowercase hex chars');
    }

    var INFO = Buffer.from('safebox-container-' + containerName + '-' + keyEpoch + '-v2', 'utf8');
    var SALT = Buffer.alloc(32);
    var L = KEY_BYTES;

    if (typeof crypto.hkdfSync === 'function') {
        return Buffer.from(crypto.hkdfSync('sha256', masterSecret, SALT, INFO, L));
    }
    var prk = crypto.createHmac('sha256', SALT).update(masterSecret).digest();
    var out = Buffer.alloc(0);
    var t = Buffer.alloc(0);
    var counter = 1;
    while (out.length < L) {
        t = crypto.createHmac('sha256', prk)
            .update(Buffer.concat([t, INFO, Buffer.from([counter])]))
            .digest();
        out = Buffer.concat([out, t]);
        counter++;
    }
    return out.slice(0, L);
}

// Exported for unit testing.
module.exports = { load, attestationDerive, derivePerContainerKey, SECRET_PATH };
