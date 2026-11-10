// /opt/safebox/system/secret.js
//
// Key loading for the two roles the system component runs in. Neither
// role sees the HMAC seed or the master: both live in safebox-keyd
// (common/keyd/safebox-keyd.js, root), which derives one key per tenant and
// one for the operator and writes them to tmpfs. This module reads the one
// file its own role is allowed to open and nothing else.
//
//   Tenant instance (SAFEBOX_TENANT=<name>, uid safebox-sys-<name>):
//     /run/safebox/keys/<name>/instance.hmac — 32 bytes, 0400, owned by
//     this uid. It is the per-container key the container also holds (as
//     system.hmac, group-readable by the mapped app gid), so the instance
//     verifies the container's requests with it. Every other tenant's
//     directory is 0750 under another uid and unreadable here.
//
//   Operator instance (no SAFEBOX_TENANT, uid safebox-infra):
//     /run/safebox/keys/_operator/control.hmac — 32 bytes, 0400, owned by
//     uid 990. Authenticates the control socket. The operator holds no
//     tenant key.
//
// The derivations, for the record (they happen in keyd, and the test
// helpers below reproduce them so a test can predict a key from a seed):
//
//   master   = HKDF-SHA256(ikm = seed, salt = 32 zero bytes,
//                          info = "safebox-gateway-hmac-v2", L = 32)
//   tenant   = HKDF-SHA256(ikm = master, salt = bytes(keyEpoch),
//                          info = "safebox-container-<name>-v1", L = 32)
//   operator = HKDF-SHA256(ikm = master, salt = 32 zero bytes,
//                          info = "safebox-operator-control-v1", L = 32)
//
// Any deviation from the contract (missing file, wrong size, wrong mode,
// wrong owner) is a refusal to start: there is no on-disk key, no
// attestation-derived key and no random key. A missing tenant key is
// retried for a few seconds first, because keyd writes it on the SIGHUP
// the operator sends just before starting the instance.
//
// Test override: when NODE_ENV=test, SAFEBOX_SYSTEM_SECRET may name a seed
// file; the operator key is then derived from it in-process (so tests need
// no keyd), SAFEBOX_SYSTEM_KEYS_DIR relocates the key directory, and the
// owner/mode checks are skipped. All of it is ignored in every other
// NODE_ENV so a stray environment variable cannot redirect a production box
// to an attacker-chosen key.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEGACY_SEED_PATH = '/run/safebox/hmac-seed';
const CREDENTIAL_NAME = 'hmac-seed';
const KEY_BYTES = 32;
const IS_TEST = process.env.NODE_ENV === 'test';

const TENANT = process.env.SAFEBOX_TENANT || null;
const TENANT_NAME_RE = /^[a-z0-9-]{1,40}$/;
if (TENANT !== null && !TENANT_NAME_RE.test(TENANT)) {
    throw new Error(`[system] SAFEBOX_TENANT '${TENANT}' is not a valid tenant name`);
}

const SOCKET_DIR = process.env.SAFEBOX_SYSTEM_SOCKET_DIR || '/run/safebox';
const KEYS_DIR = process.env.SAFEBOX_SYSTEM_KEYS_DIR || path.join(SOCKET_DIR, 'keys');
const OPERATOR_KEY_PATH = path.join(KEYS_DIR, '_operator', 'control.hmac');
const INSTANCE_KEY_FILENAME = 'instance.hmac';
const TENANT_KEY_WAIT_MS = 10000;

const MASTER_INFO = Buffer.from('safebox-gateway-hmac-v2', 'utf8');
const OPERATOR_INFO = Buffer.from('safebox-operator-control-v1', 'utf8');
const ZERO_SALT = Buffer.alloc(32);

// RFC 5869 HKDF-SHA256. Node >= 15 has crypto.hkdfSync; keep the manual
// expansion so the function is self-contained for older runtimes.
function hkdfSha256(ikm, salt, info, L) {
    if (typeof crypto.hkdfSync === 'function') {
        return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, L));
    }
    var prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    var out = Buffer.alloc(0);
    var t = Buffer.alloc(0);
    var counter = 1;
    while (out.length < L) {
        t = crypto.createHmac('sha256', prk)
            .update(Buffer.concat([t, info, Buffer.from([counter])]))
            .digest();
        out = Buffer.concat([out, t]);
        counter++;
    }
    return out.slice(0, L);
}

// ── Key-file reader shared by both roles ─────────────────────────────────────

function readKeyFile(p, what) {
    let st;
    try {
        st = fs.lstatSync(p);
    } catch (e) {
        const err = new Error(`[system] ${what} missing at ${p} (${e.code}); is safebox-keyd running and reloaded? Refusing to start.`);
        err.code = e.code;
        throw err;
    }
    if (!st.isFile()) throw new Error(`[system] ${what} ${p} is not a regular file. Refusing to start.`);
    if (st.size !== KEY_BYTES) throw new Error(`[system] ${what} ${p} has size ${st.size}, expected ${KEY_BYTES}. Refusing to start.`);
    if (!IS_TEST) {
        const mode = st.mode & 0o777;
        if (mode !== 0o400) throw new Error(`[system] ${what} ${p} has mode 0${mode.toString(8)}, expected 0400. Refusing to start.`);
        const uid = (typeof process.getuid === 'function') ? process.getuid() : -1;
        if (st.uid !== uid) throw new Error(`[system] ${what} ${p} is owned by uid ${st.uid}, expected ${uid}. Refusing to start.`);
    }
    const buf = fs.readFileSync(p);
    if (buf.length !== KEY_BYTES) throw new Error(`[system] ${what} ${p} read ${buf.length} bytes, expected ${KEY_BYTES}. Refusing to start.`);
    return buf;
}

// ── Test-only seed path (reproduces keyd's derivation in-process) ────────────

function resolveSeedPath() {
    if (IS_TEST && process.env.SAFEBOX_SYSTEM_SECRET) return process.env.SAFEBOX_SYSTEM_SECRET;
    const credDir = process.env.CREDENTIALS_DIRECTORY;
    if (typeof credDir === 'string' && credDir.length > 0) return path.join(credDir, CREDENTIAL_NAME);
    if (IS_TEST) return LEGACY_SEED_PATH;
    return null;
}

const SEED_PATH = resolveSeedPath();

// Kept for tests and for keyd's reference derivation; server.js never calls
// it. Outside NODE_ENV=test no unit hands this process a credential, so it
// fails with a message naming keyd as the holder.
function readSeed() {
    if (SEED_PATH === null) {
        throw new Error('[system] no seed: the HMAC seed is consumed by safebox-keyd.service alone, ' +
            'the system component reads only its own derived key from /run/safebox/keys.');
    }
    return readKeyFile(SEED_PATH, 'HMAC seed');
}

function deriveMaster(seed) {
    if (!Buffer.isBuffer(seed) || seed.length !== KEY_BYTES) {
        throw new Error('deriveMaster: seed must be a 32-byte Buffer');
    }
    return hkdfSha256(seed, ZERO_SALT, MASTER_INFO, KEY_BYTES);
}

function deriveOperatorKey(master) {
    if (!Buffer.isBuffer(master) || master.length !== KEY_BYTES) {
        throw new Error('deriveOperatorKey: master must be a 32-byte Buffer');
    }
    return hkdfSha256(master, ZERO_SALT, OPERATOR_INFO, KEY_BYTES);
}

// ── Role loaders ─────────────────────────────────────────────────────────────

function tenantKeyPath(name) {
    return path.join(KEYS_DIR, name, INSTANCE_KEY_FILENAME);
}

async function loadTenantKey(name) {
    if (typeof name !== 'string' || !TENANT_NAME_RE.test(name)) {
        throw new Error('loadTenantKey: invalid tenant name');
    }
    const p = tenantKeyPath(name);
    const deadline = Date.now() + TENANT_KEY_WAIT_MS;
    for (;;) {
        try {
            const key = readKeyFile(p, `tenant key for '${name}'`);
            console.log(`[system] secret: tenant key for '${name}' loaded from ${p}`);
            return key;
        } catch (e) {
            if (e.code !== 'ENOENT' || Date.now() >= deadline) throw e;
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}

async function loadOperatorKey() {
    if (IS_TEST && process.env.SAFEBOX_SYSTEM_SECRET) {
        const seed = readSeed();
        const master = deriveMaster(seed);
        seed.fill(0);
        const key = deriveOperatorKey(master);
        master.fill(0);
        console.log(`[system] secret: operator key derived from test seed ${SEED_PATH}`);
        return key;
    }
    const key = readKeyFile(OPERATOR_KEY_PATH, 'operator key');
    console.log(`[system] secret: operator key loaded from ${OPERATOR_KEY_PATH}`);
    return key;
}

// Loads whichever key this process's role needs.
async function load() {
    return TENANT ? loadTenantKey(TENANT) : loadOperatorKey();
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-container key derivation — the reference the Safebox side and keyd
// both implement. The system component itself no longer derives any
// tenant key (it has no master); this stays for tests and for keyd's
// shared test vector.
//
// keyEpoch is a per-create random hex string stored in managed-containers.json
// and forgotten on /containers/destroy. It goes in as the HKDF salt, so
// re-creating a container with the same name yields a new key: a leaked key
// from an old container does not authenticate against its namesake.
// ─────────────────────────────────────────────────────────────────────────────

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
    var INFO = Buffer.from('safebox-container-' + containerName + '-v1', 'utf8');
    var SALT = Buffer.from(keyEpoch, 'hex');
    return hkdfSha256(masterSecret, SALT, INFO, KEY_BYTES);
}

module.exports = {
    load, loadTenantKey, loadOperatorKey, readSeed, deriveMaster, deriveOperatorKey, derivePerContainerKey,
    tenantKeyPath,
    TENANT, SEED_PATH, CREDENTIAL_NAME, KEY_BYTES, KEYS_DIR, OPERATOR_KEY_PATH, INSTANCE_KEY_FILENAME,
};
