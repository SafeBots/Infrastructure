// common/attestation/ocpClaim.js  (installed to /opt/safebox/dnsclient/)
//
// Ed25519 OCP claims shared by dnsclient (which signs), verifyAnnounce.js
// (which verifies) and the reference relay. Pure Node, no dependencies.
//
// Wire format is the same OCP v1 envelope the system component verifies
// in ocpVerify.js:
//
//   { ocp: 1, iss, sub, stm, nbf, exp, key: [...], sig: [...] }
//
// with one difference in the key encoding: image blessings are ES256 with
// base64 SPKI keys (ocpVerify.verifyThreshold), while the two claim types
// here, launch_authorization and safebox_announce, are Ed25519 with the
// raw 32-byte public key as 64 lowercase hex characters in key[i] and the
// 64-byte signature as base64 in sig[i]. Signatures are over the RFC 8785
// canonical JSON of {ocp, iss, sub, stm, nbf, exp}, exactly as in
// ocpVerify.claimCanonical, so a relying party can mix the two kinds of
// claim in one trust store.
//
// Claim types (docs/HARDENING-PLAN.md "Decentralized announce"):
//
//   launch_authorization — signed by the owner's key; delivered through
//     instance metadata (base64 of the JSON) and carried inside every
//     announce. stm = {type, safeboxId, ownerPubkey, notBefore, expiresAt,
//     nonce}; expiresAt - notBefore <= 24h.
//
//   safebox_announce — signed by the box's key on every announce. stm =
//     {type, safeboxId, boxPubkey, ownerPubkey, launchAuthorization,
//     imageRootHash, cloud, publicIp, quote, confidential, issuedAt, prev}.

'use strict';

const crypto = require('crypto');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;
const SAFEBOX_ID_RE = /^[a-z0-9-]{3,64}$/;
const MAX_AUTHORIZATION_SECONDS = 24 * 60 * 60;

// ── RFC 8785 canonical JSON (same algorithm as ocpVerify.canonicalize) ──────

function canonicalize(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite number');
        return String(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    if (typeof value === 'object') {
        return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
            .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
    }
    throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

function claimCanonical(claim) {
    return canonicalize({
        ocp: claim.ocp, iss: claim.iss, sub: claim.sub, stm: claim.stm, nbf: claim.nbf, exp: claim.exp,
    });
}

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

// Hash of a whole signed claim (envelope plus key/sig), used as `prev` in
// the announce chain and as the relay's dedup key.
function claimHash(claim) {
    return sha256Hex(canonicalize(claim));
}

// Hash of the statement alone, which is what Safenet's transparency log
// (generateClaimHash) and ocpVerify.claimHash compute.
function stmHash(claim) {
    return sha256Hex(canonicalize(claim.stm));
}

// ── Ed25519 keys ────────────────────────────────────────────────────────────

function publicKeyHexFromKey(keyObject) {
    const pub = keyObject.type === 'private' ? crypto.createPublicKey(keyObject) : keyObject;
    const der = pub.export({ type: 'spki', format: 'der' });
    if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
        throw new Error('not an Ed25519 public key');
    }
    return der.subarray(12).toString('hex');
}

function publicKeyFromHex(hex) {
    if (typeof hex !== 'string' || !PUBKEY_HEX_RE.test(hex)) {
        throw new Error('public key must be 64 lowercase hex characters');
    }
    return crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
        format: 'der', type: 'spki',
    });
}

// ── Sign / verify ───────────────────────────────────────────────────────────

function signClaim(claim, privateKey) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signClaim: key is not Ed25519');
    const data = Buffer.from(claimCanonical(claim), 'utf8');
    const sig = crypto.sign(null, data, privateKey).toString('base64');
    return Object.assign({}, claim, { key: [publicKeyHexFromKey(privateKey)], sig: [sig] });
}

// Returns {ok, signers: [hex...], errors: [...]}. Every key[i] must verify
// sig[i]; a claim with any failing signature is not ok.
function verifyClaim(claim) {
    const errors = [];
    if (!claim || typeof claim !== 'object') return { ok: false, signers: [], errors: ['claim is not an object'] };
    if (claim.ocp !== 1) errors.push('ocp must be 1');
    if (!Array.isArray(claim.key) || !Array.isArray(claim.sig) || claim.key.length === 0
        || claim.key.length !== claim.sig.length) {
        return { ok: false, signers: [], errors: errors.concat('key and sig must be non-empty arrays of equal length') };
    }
    if (!claim.stm || typeof claim.stm !== 'object' || typeof claim.stm.type !== 'string') {
        return { ok: false, signers: [], errors: errors.concat('stm.type missing') };
    }
    let data;
    try { data = Buffer.from(claimCanonical(claim), 'utf8'); }
    catch (e) { return { ok: false, signers: [], errors: errors.concat(`canonicalize failed: ${e.message}`) }; }
    const signers = [];
    for (let i = 0; i < claim.key.length; i++) {
        try {
            const pub = publicKeyFromHex(claim.key[i]);
            const sig = Buffer.from(String(claim.sig[i]), 'base64');
            if (sig.length !== 64 || !crypto.verify(null, data, pub, sig)) {
                errors.push(`sig[${i}] does not verify`);
            } else {
                signers.push(claim.key[i]);
            }
        } catch (e) {
            errors.push(`key[${i}]: ${e.message}`);
        }
    }
    return { ok: errors.length === 0 && signers.length === claim.key.length, signers, errors };
}

// ── Launch authorization ────────────────────────────────────────────────────

function buildLaunchAuthorization({ safeboxId, ownerPubkey, notBefore, expiresAt, nonce }) {
    if (!SAFEBOX_ID_RE.test(String(safeboxId))) throw new Error('safeboxId must match ^[a-z0-9-]{3,64}$');
    if (!PUBKEY_HEX_RE.test(String(ownerPubkey))) throw new Error('ownerPubkey must be 64 hex characters');
    if (!Number.isInteger(notBefore) || !Number.isInteger(expiresAt)) throw new Error('notBefore/expiresAt must be unix seconds');
    if (expiresAt <= notBefore) throw new Error('expiresAt must be after notBefore');
    if (expiresAt - notBefore > MAX_AUTHORIZATION_SECONDS) throw new Error('authorization window exceeds 24h');
    return {
        ocp: 1,
        iss: 'safenet:owner:' + ownerPubkey,
        sub: 'safebox:' + safeboxId,
        stm: {
            type: 'launch_authorization',
            safeboxId, ownerPubkey, notBefore, expiresAt,
            nonce: nonce || crypto.randomBytes(16).toString('hex'),
        },
        nbf: notBefore,
        exp: expiresAt,
    };
}

// Structural and signature checks on a launch authorization. `now` is unix
// seconds; omit the window check by passing now = null (firstboot-time
// validation uses the box clock, which may be wrong before NTP).
function checkLaunchAuthorization(auth, { safeboxId, ownerPubkey, now } = {}) {
    const reasons = [];
    if (!auth || typeof auth !== 'object' || !auth.stm) return { ok: false, reasons: ['authorization is not a claim'] };
    const s = auth.stm;
    if (s.type !== 'launch_authorization') reasons.push('stm.type is not launch_authorization');
    if (!SAFEBOX_ID_RE.test(String(s.safeboxId))) reasons.push('stm.safeboxId invalid');
    if (!PUBKEY_HEX_RE.test(String(s.ownerPubkey))) reasons.push('stm.ownerPubkey invalid');
    if (!Number.isInteger(s.notBefore) || !Number.isInteger(s.expiresAt) || s.expiresAt <= s.notBefore) {
        reasons.push('stm.notBefore/expiresAt invalid');
    } else if (s.expiresAt - s.notBefore > MAX_AUTHORIZATION_SECONDS) {
        reasons.push('authorization window exceeds 24h');
    }
    if (typeof s.nonce !== 'string' || s.nonce.length < 8) reasons.push('stm.nonce missing');
    if (auth.nbf !== s.notBefore || auth.exp !== s.expiresAt) reasons.push('nbf/exp do not match stm');
    if (safeboxId !== undefined && s.safeboxId !== safeboxId) reasons.push('authorization is for a different safeboxId');
    if (ownerPubkey !== undefined && s.ownerPubkey !== ownerPubkey) reasons.push('authorization ownerPubkey does not match');
    if (auth.iss !== 'safenet:owner:' + s.ownerPubkey) reasons.push('iss does not match ownerPubkey');
    if (auth.sub !== 'safebox:' + s.safeboxId) reasons.push('sub does not match safeboxId');
    const v = verifyClaim(auth);
    if (!v.ok) reasons.push('owner signature: ' + v.errors.join('; '));
    else if (!v.signers.includes(s.ownerPubkey)) reasons.push('authorization is not signed by stm.ownerPubkey');
    if (Number.isInteger(now)) {
        if (now < s.notBefore) reasons.push('authorization not yet valid');
        if (now > s.expiresAt) reasons.push('authorization expired');
    }
    return { ok: reasons.length === 0, reasons };
}

// Metadata transport: base64 of the JSON. Returns the claim or throws.
function decodeAuthorizationBase64(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=_-]{64,8192}$/.test(b64)) {
        throw new Error('launch-authorization is not base64 of plausible length');
    }
    let json;
    try { json = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
    catch (e) { throw new Error(`launch-authorization base64: ${e.message}`); }
    let claim;
    try { claim = JSON.parse(json); } catch (e) { throw new Error(`launch-authorization is not JSON: ${e.message}`); }
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('launch-authorization is not an object');
    return claim;
}

function encodeAuthorizationBase64(auth) {
    return Buffer.from(JSON.stringify(auth), 'utf8').toString('base64');
}

// The TPM quote nonce for an announce: sha256 over the canonical signed
// authorization, followed by the previous announce's hash when there is
// one. A relying party rebuilds it from fields in the announce itself.
function announceNonce(authorization, prev) {
    return sha256Hex(canonicalize(authorization) + (prev || ''));
}

// ── Name claim ─────────────────────────────────────────────────────────────
//
// A name_claim maps a human-readable domain name (e.g. "yourbrand.safenet.org")
// to a safebox id and optional failover safebox id. Signed by the hub owner
// or a governance key. The zone compiler reads accepted name_claims from the
// registry and produces DNS A records.
//
//   stm = { type: "name_claim", name, safeboxId, failoverSafeboxId?,
//           governancePolicy?, issuedAt }
//
// The issuer is the owner pubkey (or governance key) that controls the name.

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function buildNameClaim({ name, safeboxId, failoverSafeboxId, governancePolicy, ownerPubkey }) {
    if (typeof name !== 'string' || !DOMAIN_RE.test(name)) {
        throw new Error('name must be a valid lowercase domain label (e.g. "myapp.safenet.org")');
    }
    if (!SAFEBOX_ID_RE.test(String(safeboxId))) throw new Error('safeboxId must match ^[a-z0-9-]{3,64}$');
    if (failoverSafeboxId !== undefined && failoverSafeboxId !== null) {
        if (!SAFEBOX_ID_RE.test(String(failoverSafeboxId))) throw new Error('failoverSafeboxId must match ^[a-z0-9-]{3,64}$');
    }
    if (!PUBKEY_HEX_RE.test(String(ownerPubkey))) throw new Error('ownerPubkey must be 64 hex characters');
    const now = Math.floor(Date.now() / 1000);
    return {
        ocp: 1,
        iss: 'safenet:owner:' + ownerPubkey,
        sub: 'safenet:name:' + name,
        stm: {
            type: 'name_claim',
            name,
            safeboxId,
            failoverSafeboxId: failoverSafeboxId || null,
            governancePolicy: governancePolicy || null,
            issuedAt: now,
        },
        nbf: now,
        exp: now + 365 * 24 * 60 * 60, // 1 year default; renewed by re-signing
    };
}

// Structural and signature checks on a name_claim.
function checkNameClaim(claim, { ownerPubkey } = {}) {
    const reasons = [];
    if (!claim || typeof claim !== 'object' || !claim.stm) return { ok: false, reasons: ['claim is not valid'] };
    const s = claim.stm;
    if (s.type !== 'name_claim') reasons.push('stm.type is not name_claim');
    if (typeof s.name !== 'string' || !DOMAIN_RE.test(s.name)) reasons.push('stm.name is not a valid domain');
    if (!SAFEBOX_ID_RE.test(String(s.safeboxId))) reasons.push('stm.safeboxId invalid');
    if (s.failoverSafeboxId !== null && s.failoverSafeboxId !== undefined) {
        if (!SAFEBOX_ID_RE.test(String(s.failoverSafeboxId))) reasons.push('stm.failoverSafeboxId invalid');
    }
    if (!Number.isInteger(s.issuedAt)) reasons.push('stm.issuedAt must be unix seconds');
    if (claim.iss !== 'safenet:owner:' + (s.ownerPubkey || '').slice(0, 64) &&
        claim.iss !== 'safenet:owner:' + ownerPubkey) {
        // Try to extract owner from iss
    }
    if (claim.sub !== 'safenet:name:' + s.name) reasons.push('sub does not match stm.name');
    const v = verifyClaim(claim);
    if (!v.ok) reasons.push('signature: ' + v.errors.join('; '));
    if (ownerPubkey && !v.signers.includes(ownerPubkey)) {
        reasons.push('claim is not signed by the expected ownerPubkey');
    }
    return { ok: reasons.length === 0, reasons };
}

module.exports = {
    canonicalize, claimCanonical, claimHash, stmHash, sha256Hex,
    publicKeyHexFromKey, publicKeyFromHex,
    signClaim, verifyClaim,
    buildLaunchAuthorization, checkLaunchAuthorization,
    decodeAuthorizationBase64, encodeAuthorizationBase64,
    announceNonce,
    buildNameClaim, checkNameClaim,
    PUBKEY_HEX_RE, SAFEBOX_ID_RE, MAX_AUTHORIZATION_SECONDS, DOMAIN_RE,
};
