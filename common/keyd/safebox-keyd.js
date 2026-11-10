// /opt/safebox/keyd/safebox-keyd.js
//
// safebox-keyd: the only process on a running safebox that holds the HMAC
// master. It runs as root, reads the 32-byte seed through systemd's
// LoadCredential= ($CREDENTIALS_DIRECTORY/hmac-seed), derives the master in
// memory, and materialises one key file per managed container on tmpfs:
//
//   /run/safebox/keys/<name>/system.hmac    0440 <instance uid>:<app gid>
//                                           read by the tenant's container
//                                           through the read-only bind mount
//                                           at /run/safebox/keys/system.hmac
//   /run/safebox/keys/<name>/instance.hmac  0400 <instance uid>
//                                           read by safebox-system@<name>
//                                           (the tenant's own instance of the
//                                           system component)
//   /run/safebox/keys/_operator/control.hmac 0400 safebox-infra
//                                           the control-socket key of the
//                                           operator instance
//
// Both tenant files hold the same value: HKDF(master, salt = keyEpoch,
// info = "safebox-container-<name>-v1"), the per-container key the design has
// always used. The operator key is HKDF(master, zero salt,
// info = "safebox-operator-control-v1"). The master itself never leaves this
// process: there is no socket, no API and no file that carries it. Keyd
// writes derived keys and nothing else.
//
// Keyd reads /var/lib/safebox/managed-containers.json at start and again on
// SIGHUP (the operator instance sends one, through the root wrapper
// safebox-keyd-reload, after every /containers/create and /containers/destroy).
// A container that has left the file has its key directory removed; a
// container that lacks instanceUid or keyEpoch gets no key.
//
// Why this exists: before per-tenant isolation one process (uid 990) held
// the master and every tenant's key. An RCE in that process through any
// tenant's request handed the attacker every other tenant. Now each tenant's
// instance runs as its own uid and can read exactly one key, the operator
// instance can read exactly one key, and the master is in a process that
// takes no input from any of them. See docs/HARDENING-PLAN.md,
// "Per-tenant isolation".
//
// Test override: with NODE_ENV=test, SAFEBOX_KEYD_SEED names the seed file,
// SAFEBOX_KEYD_CONFIG the config file and SAFEBOX_KEYD_KEYS_DIR the key
// directory, chown is skipped (the test is not root), and the owner/mode
// checks on the seed are skipped. None of these are honoured in any other
// NODE_ENV.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_TEST = process.env.NODE_ENV === 'test';
const KEY_BYTES = 32;
const CREDENTIAL_NAME = 'hmac-seed';
const LEGACY_SEED_PATH = '/run/safebox/hmac-seed';

const CONFIG_PATH = (IS_TEST && process.env.SAFEBOX_KEYD_CONFIG) || '/var/lib/safebox/managed-containers.json';
const RUN_DIR     = (IS_TEST && process.env.SAFEBOX_KEYD_RUN_DIR) || '/run/safebox';
const KEYS_DIR    = (IS_TEST && process.env.SAFEBOX_KEYD_KEYS_DIR) || path.join(RUN_DIR, 'keys');
const SOCKETS_DIR = path.join(RUN_DIR, 'containers');

const OPERATOR_DIR_NAME = '_operator';
const OPERATOR_KEY_FILE = 'control.hmac';
const CONTAINER_KEY_FILE = 'system.hmac';
const INSTANCE_KEY_FILE = 'instance.hmac';

// Fixed ids from install-base.sh.
const OPERATOR_UID = 990;   // safebox-infra
const SYS_GID      = 993;   // safebox-sys: group of every tenant instance uid
const APP_ID       = 991;   // safebox-app inside the container
const TENANT_UID_MIN = 20000;
const TENANT_UID_MAX = 29999;

const NAME_RE  = /^[a-z0-9-]{1,40}$/;
const EPOCH_RE = /^[a-f0-9]{16,128}$/;

const MASTER_INFO   = Buffer.from('safebox-gateway-hmac-v2', 'utf8');
const OPERATOR_INFO = Buffer.from('safebox-operator-control-v1', 'utf8');
const ZERO_SALT = Buffer.alloc(32);

function log(msg) { process.stdout.write(`[keyd] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[keyd] WARN ${msg}\n`); }

// ── HKDF-SHA256 (RFC 5869), same construction as secret.js ──────────────────

function hkdfSha256(ikm, salt, info, L) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, L));
}

function deriveMaster(seed) {
    return hkdfSha256(seed, ZERO_SALT, MASTER_INFO, KEY_BYTES);
}

function derivePerContainerKey(master, name, keyEpoch) {
    if (!NAME_RE.test(name)) throw new Error(`invalid container name '${name}'`);
    if (!EPOCH_RE.test(keyEpoch)) throw new Error(`invalid keyEpoch for '${name}'`);
    return hkdfSha256(master, Buffer.from(keyEpoch, 'hex'),
        Buffer.from('safebox-container-' + name + '-v1', 'utf8'), KEY_BYTES);
}

function deriveOperatorKey(master) {
    return hkdfSha256(master, ZERO_SALT, OPERATOR_INFO, KEY_BYTES);
}

// ── Seed ────────────────────────────────────────────────────────────────────

function resolveSeedPath() {
    if (IS_TEST && process.env.SAFEBOX_KEYD_SEED) return process.env.SAFEBOX_KEYD_SEED;
    const credDir = process.env.CREDENTIALS_DIRECTORY;
    if (typeof credDir === 'string' && credDir.length > 0) return path.join(credDir, CREDENTIAL_NAME);
    return null;
}

function readSeed() {
    const seedPath = resolveSeedPath();
    if (seedPath === null) {
        throw new Error('CREDENTIALS_DIRECTORY is not set: safebox-keyd.service must carry ' +
            `LoadCredential=${CREDENTIAL_NAME}:${LEGACY_SEED_PATH}. Refusing to start.`);
    }
    const st = fs.lstatSync(seedPath);
    if (!st.isFile()) throw new Error(`${seedPath} is not a regular file`);
    if (st.size !== KEY_BYTES) throw new Error(`${seedPath} has size ${st.size}, expected ${KEY_BYTES}`);
    if (!IS_TEST) {
        if ((st.mode & 0o777) !== 0o400) throw new Error(`${seedPath} has mode 0${(st.mode & 0o777).toString(8)}, expected 0400`);
        if (st.uid !== process.getuid()) throw new Error(`${seedPath} is owned by uid ${st.uid}, expected ${process.getuid()}`);
    }
    const buf = fs.readFileSync(seedPath);
    if (buf.length !== KEY_BYTES) throw new Error(`${seedPath} read ${buf.length} bytes`);
    return buf;
}

// ── Mapped app gid (same rule as sockets.js and the wrappers) ───────────────

function resolveAppGid() {
    if (IS_TEST && process.env.SAFEBOX_APP_GID) return parseInt(process.env.SAFEBOX_APP_GID, 10);
    try {
        const line = fs.readFileSync('/etc/subgid', 'utf8').split('\n').find((l) => l.startsWith('dockremap:'));
        if (line) {
            const [, base, count] = line.trim().split(':');
            if (/^\d+$/.test(base) && /^\d+$/.test(count) && parseInt(count, 10) > APP_ID) {
                return parseInt(base, 10) + APP_ID;
            }
        }
    } catch { /* no subgid */ }
    return APP_ID;
}

// ── Config ──────────────────────────────────────────────────────────────────

// Returns [{ name, keyEpoch, instanceUid }] for every entry that is a real
// tenant with a complete declaration. Anything else is reported and skipped.
// An absent file means no tenants (first boot, before the operator seeds
// it). An unreadable or unparseable file returns null: the caller then
// leaves every key as it is, because a half-written config must not take
// a running tenant's key away.
function readTenants() {
    let raw;
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); }
    catch (e) {
        if (e.code === 'ENOENT') { warn(`${CONFIG_PATH} not found; no tenant keys`); return []; }
        warn(`${CONFIG_PATH} unreadable: ${e.message}`); return null;
    }
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { warn(`${CONFIG_PATH} is not valid JSON: ${e.message}; keys left as they are`); return null; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { warn(`${CONFIG_PATH} root is not an object; keys left as they are`); return null; }
    const out = [];
    const seenUids = new Set();
    for (const [name, entry] of Object.entries(cfg)) {
        if (name.startsWith('_')) continue;
        if (!entry || typeof entry !== 'object') continue;
        if (entry.execContext === 'host') continue;
        if (!NAME_RE.test(name)) { warn(`ignoring '${name}': not a wrapper-valid name`); continue; }
        if (typeof entry.keyEpoch !== 'string' || !EPOCH_RE.test(entry.keyEpoch)) { warn(`ignoring '${name}': missing keyEpoch`); continue; }
        const uid = entry.instanceUid;
        if (!Number.isInteger(uid) || uid < TENANT_UID_MIN || uid > TENANT_UID_MAX) { warn(`ignoring '${name}': instanceUid must be ${TENANT_UID_MIN}..${TENANT_UID_MAX}`); continue; }
        if (seenUids.has(uid)) { warn(`ignoring '${name}': instanceUid ${uid} is already used`); continue; }
        seenUids.add(uid);
        out.push({ name, keyEpoch: entry.keyEpoch, instanceUid: uid });
    }
    return out;
}

// ── Filesystem ──────────────────────────────────────────────────────────────

function chownMaybe(fdOrPath, uid, gid, isFd) {
    if (IS_TEST) return;
    if (isFd) fs.fchownSync(fdOrPath, uid, gid);
    else fs.lchownSync(fdOrPath, uid, gid);
}

// lstat, never stat: a symlink planted where a directory should be is an
// error, not a path to follow.
function assertRealDir(dir) {
    let st;
    try { st = fs.lstatSync(dir); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`${dir} exists and is not a directory; refusing to write a key there`);
    }
    return true;
}

function ensureDir(dir, mode, uid, gid) {
    if (!assertRealDir(dir)) fs.mkdirSync(dir, { mode });
    fs.chmodSync(dir, mode);
    chownMaybe(dir, uid, gid, false);
}

// O_CREAT|O_EXCL|O_NOFOLLOW on a temp name, then rename over the final name:
// a pre-existing entry at the temp name fails the open, and a symlink at the
// final name is replaced, not followed.
function writeKeyFile(dir, filename, key, mode, uid, gid) {
    const finalPath = path.join(dir, filename);
    const tmp = path.join(dir, `.${filename}.tmp-${process.pid}-${Date.now()}`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(tmp, flags, mode);
    try {
        fs.writeSync(fd, key, 0, key.length);
        chownMaybe(fd, uid, gid, true);
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        throw e;
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, finalPath);
}

function removeKeyDir(dir) {
    for (const f of [CONTAINER_KEY_FILE, INSTANCE_KEY_FILE, OPERATOR_KEY_FILE]) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith('.') && f.includes('.tmp-')) fs.unlinkSync(path.join(dir, f));
        }
    } catch { /* absent */ }
    try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') warn(`could not remove ${dir}: ${e.message}`); }
}

// The runtime directories every instance relies on. /run/safebox itself is
// created 0700 root by the initramfs; it becomes 0751 so the instance uids
// can traverse it (the seed inside stays 0400 root). containers/ is 1771
// root:safebox-sys: every instance creates its own socket there, the sticky
// bit stops one instance unlinking another's, and the operator (not in
// safebox-sys) can still stat a socket to wait for it. keys/ is 0751 root:
// each subdirectory carries its own owner.
function ensureRuntimeDirs() {
    ensureDir(RUN_DIR, 0o751, 0, 0);
    ensureDir(SOCKETS_DIR, 0o1771, 0, SYS_GID);
    ensureDir(KEYS_DIR, 0o751, 0, 0);
}

// ── Reconcile ───────────────────────────────────────────────────────────────

function materialise(master) {
    const appGid = resolveAppGid();
    const tenants = readTenants();
    if (tenants === null) return { written: 0, removed: 0, tenants: null, skipped: true };
    const wanted = new Set([OPERATOR_DIR_NAME]);

    // Operator key.
    try {
        const opDir = path.join(KEYS_DIR, OPERATOR_DIR_NAME);
        ensureDir(opDir, 0o700, OPERATOR_UID, OPERATOR_UID);
        writeKeyFile(opDir, OPERATOR_KEY_FILE, deriveOperatorKey(master), 0o400, OPERATOR_UID, OPERATOR_UID);
    } catch (e) {
        warn(`operator key: ${e.message}`);
    }

    // Tenant keys.
    let written = 0;
    for (const t of tenants) {
        wanted.add(t.name);
        try {
            const dir = path.join(KEYS_DIR, t.name);
            const key = derivePerContainerKey(master, t.name, t.keyEpoch);
            ensureDir(dir, 0o750, t.instanceUid, appGid);
            writeKeyFile(dir, CONTAINER_KEY_FILE, key, 0o440, t.instanceUid, appGid);
            writeKeyFile(dir, INSTANCE_KEY_FILE, key, 0o400, t.instanceUid, SYS_GID);
            key.fill(0);
            written++;
        } catch (e) {
            warn(`tenant '${t.name}': ${e.message}`);
        }
    }

    // Keys of containers that are no longer declared.
    let removed = 0;
    for (const entry of fs.readdirSync(KEYS_DIR)) {
        if (wanted.has(entry)) continue;
        const p = path.join(KEYS_DIR, entry);
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (!st.isDirectory()) { warn(`unexpected entry ${p} in key directory; left alone`); continue; }
        removeKeyDir(p);
        removed++;
    }
    log(`keys: ${written} tenant key(s) written, ${removed} stale director(ies) removed, operator key in place`);
    return { written, removed, tenants: tenants.map((t) => t.name) };
}

// ── Main ────────────────────────────────────────────────────────────────────

function start() {
    const seed = readSeed();
    const master = deriveMaster(seed);
    seed.fill(0);
    ensureRuntimeDirs();
    materialise(master);

    let reloading = false;
    process.on('SIGHUP', () => {
        if (reloading) return;
        reloading = true;
        try { materialise(master); }
        catch (e) { warn(`reload failed: ${e.message}`); }
        finally { reloading = false; }
    });
    const stop = (sig) => {
        log(`${sig}: exiting; key files stay on tmpfs for the running instances`);
        master.fill(0);
        process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    // The unit is Type=notify with NotifyAccess=all, so the instances that
    // order After= this unit start only once the key files exist, not when
    // the process forks. Node has no AF_UNIX datagram socket, so the READY=1
    // goes through systemd-notify (a child in the same cgroup).
    if (!IS_TEST && process.env.NOTIFY_SOCKET) {
        const r = require('child_process').spawnSync('/usr/bin/systemd-notify', ['--ready'], { stdio: 'ignore' });
        if (r.status !== 0) warn('systemd-notify --ready failed; dependants may start before the keys exist');
    }
    log(`running; config ${CONFIG_PATH}, keys under ${KEYS_DIR}`);
}

if (require.main === module) {
    try { start(); }
    catch (e) {
        process.stderr.write(`[keyd] startup failed: ${e.message}\n`);
        process.exit(1);
    }
}

module.exports = {
    deriveMaster, derivePerContainerKey, deriveOperatorKey, readTenants, materialise, ensureRuntimeDirs,
    CONFIG_PATH, KEYS_DIR, RUN_DIR, SOCKETS_DIR,
    OPERATOR_DIR_NAME, OPERATOR_KEY_FILE, CONTAINER_KEY_FILE, INSTANCE_KEY_FILE,
    TENANT_UID_MIN, TENANT_UID_MAX, SYS_GID, OPERATOR_UID,
};
