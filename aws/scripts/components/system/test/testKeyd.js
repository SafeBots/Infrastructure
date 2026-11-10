// test/testKeyd.js
//
// safebox-keyd (common/keyd/safebox-keyd.js): derives the master from the
// seed, writes one key directory per declared tenant plus the operator key,
// removes directories of tenants that left the config, refuses symlink
// games, and agrees with secret.js on every derivation (the vectors the
// container side and the instance side both rely on).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-keyd-test-'));
const runDir = path.join(tmpDir, 'run');
const keysDir = path.join(runDir, 'keys');
const cfgPath = path.join(tmpDir, 'managed-containers.json');
const seedPath = path.join(tmpDir, 'hmac-seed');
const SEED = Buffer.alloc(32, 0x5a);
fs.writeFileSync(seedPath, SEED, { mode: 0o400 });

process.env.NODE_ENV = 'test';
process.env.SAFEBOX_KEYD_SEED = seedPath;
process.env.SAFEBOX_KEYD_CONFIG = cfgPath;
process.env.SAFEBOX_KEYD_RUN_DIR = runDir;
process.env.SAFEBOX_KEYD_KEYS_DIR = keysDir;
process.env.SAFEBOX_APP_GID = String(process.getgid());

function writeCfg(cfg) { fs.writeFileSync(cfgPath, JSON.stringify(cfg)); }
writeCfg({
    '_host': { imagePattern: '', execContext: 'host', allowedActions: ['dnf'] },
    'foo': { imagePattern: '^safebox-app-foo:', allowedActions: ['npm'], keyEpoch: 'a'.repeat(32), instanceUid: 20000 },
    'bar': { imagePattern: '^safebox-app-bar:', allowedActions: ['npm'], keyEpoch: 'b'.repeat(32), instanceUid: 20001 },
    'no-epoch': { imagePattern: '^x:', allowedActions: ['npm'], instanceUid: 20002 },
    'no-uid': { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'c'.repeat(32) },
    'bad-uid': { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'd'.repeat(32), instanceUid: 990 },
    'dup-uid': { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'e'.repeat(32), instanceUid: 20000 },
    'Bad Name': { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'f'.repeat(32), instanceUid: 20003 },
});

const keyd = require('../../../../../common/keyd/safebox-keyd.js');
const secret = require('../secret');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── Config filtering ────────────────────────────────────────────────────────
const tenants = keyd.readTenants();
check('only complete, valid tenants are keyed', tenants.map(t => t.name).sort().join(',') === 'bar,foo',
    tenants.map(t => t.name).join(','));

// ── Derivations agree with secret.js ────────────────────────────────────────
const master = keyd.deriveMaster(SEED);
check('master matches secret.deriveMaster', master.equals(secret.deriveMaster(SEED)));
check('operator key matches secret.deriveOperatorKey', keyd.deriveOperatorKey(master).equals(secret.deriveOperatorKey(master)));
check('tenant key matches secret.derivePerContainerKey',
    keyd.derivePerContainerKey(master, 'foo', 'a'.repeat(32)).equals(secret.derivePerContainerKey(master, 'foo', 'a'.repeat(32))));
check('operator key differs from every tenant key',
    !keyd.deriveOperatorKey(master).equals(keyd.derivePerContainerKey(master, 'foo', 'a'.repeat(32))));

// ── Materialise ─────────────────────────────────────────────────────────────
keyd.ensureRuntimeDirs();
let r = keyd.materialise(master);
check('two tenant keys written', r.written === 2);
check('runtime dirs created', fs.existsSync(path.join(runDir, 'containers')) && fs.existsSync(keysDir));
const dirMode = fs.statSync(path.join(runDir, 'containers')).mode & 0o7777;
check('containers dir is 1771 (sticky)', dirMode === 0o1771, 'got 0' + dirMode.toString(8));

for (const [name, epoch] of [['foo', 'a'.repeat(32)], ['bar', 'b'.repeat(32)]]) {
    const dir = path.join(keysDir, name);
    const sys = path.join(dir, 'system.hmac');
    const inst = path.join(dir, 'instance.hmac');
    const expected = secret.derivePerContainerKey(master, name, epoch);
    check(`${name}: system.hmac written with the per-container key`, fs.existsSync(sys) && fs.readFileSync(sys).equals(expected));
    check(`${name}: instance.hmac holds the same key`, fs.existsSync(inst) && fs.readFileSync(inst).equals(expected));
    check(`${name}: system.hmac is 0440`, (fs.statSync(sys).mode & 0o777) === 0o440);
    check(`${name}: instance.hmac is 0400`, (fs.statSync(inst).mode & 0o777) === 0o400);
    check(`${name}: dir is 0750`, (fs.statSync(dir).mode & 0o777) === 0o750);
    check(`${name}: no temp file left`, fs.readdirSync(dir).every(f => f === 'system.hmac' || f === 'instance.hmac'));
}
check('foo and bar keys differ', !fs.readFileSync(path.join(keysDir, 'foo', 'system.hmac')).equals(fs.readFileSync(path.join(keysDir, 'bar', 'system.hmac'))));
const opKey = path.join(keysDir, '_operator', 'control.hmac');
check('operator key written', fs.existsSync(opKey) && fs.readFileSync(opKey).equals(secret.deriveOperatorKey(master)));
check('operator key is 0400', (fs.statSync(opKey).mode & 0o777) === 0o400);
check('operator dir is 0700', (fs.statSync(path.dirname(opKey)).mode & 0o777) === 0o700);
for (const n of ['no-epoch', 'no-uid', 'bad-uid', 'dup-uid', 'Bad Name', '_host']) {
    check(`no key dir for '${n}'`, !fs.existsSync(path.join(keysDir, n)));
}

// ── Idempotent reload: same keys, no duplicates ─────────────────────────────
const before = fs.readFileSync(path.join(keysDir, 'foo', 'instance.hmac'));
r = keyd.materialise(master);
check('reload rewrites the same key', fs.readFileSync(path.join(keysDir, 'foo', 'instance.hmac')).equals(before) && r.removed === 0);

// ── Epoch rotation: destroy+create with the same name yields a new key ─────
let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.foo.keyEpoch = '1'.repeat(32);
writeCfg(cfg);
keyd.materialise(master);
check('new keyEpoch → new key', !fs.readFileSync(path.join(keysDir, 'foo', 'instance.hmac')).equals(before));

// ── Removal: a tenant that left the config loses its directory ──────────────
delete cfg.bar;
writeCfg(cfg);
r = keyd.materialise(master);
check('bar key dir removed', r.removed === 1 && !fs.existsSync(path.join(keysDir, 'bar')));
check('foo key dir kept', fs.existsSync(path.join(keysDir, 'foo', 'instance.hmac')));

// ── Symlink games ───────────────────────────────────────────────────────────
const evilTarget = path.join(tmpDir, 'evil-target');
fs.mkdirSync(evilTarget);
fs.symlinkSync(evilTarget, path.join(keysDir, 'evil'));
cfg.evil = { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'e'.repeat(32), instanceUid: 20009 };
writeCfg(cfg);
let threw = false;
try { r = keyd.materialise(master); } catch { threw = true; }
check('symlinked key dir refused, not followed, pass continues',
    !threw && fs.readdirSync(evilTarget).length === 0 && fs.existsSync(path.join(keysDir, 'foo', 'instance.hmac')));
delete cfg.evil;
writeCfg(cfg);
fs.unlinkSync(path.join(keysDir, 'evil'));

const victim = path.join(tmpDir, 'victim');
fs.writeFileSync(victim, 'untouched');
fs.mkdirSync(path.join(keysDir, 'link'), { mode: 0o750 });
fs.symlinkSync(victim, path.join(keysDir, 'link', 'instance.hmac'));
cfg.link = { imagePattern: '^x:', allowedActions: ['npm'], keyEpoch: 'f'.repeat(32), instanceUid: 20010 };
writeCfg(cfg);
keyd.materialise(master);
check('symlinked key file replaced by a regular file',
    !fs.lstatSync(path.join(keysDir, 'link', 'instance.hmac')).isSymbolicLink()
    && fs.readFileSync(path.join(keysDir, 'link', 'instance.hmac')).length === 32);
check('symlink target untouched', fs.readFileSync(victim, 'utf8') === 'untouched');

// ── A broken config keeps the keys of the last good one ─────────────────────
fs.writeFileSync(cfgPath, '{not json');
r = keyd.materialise(master);
check('invalid JSON: pass skipped, existing keys untouched',
    r.skipped === true && r.removed === 0 && fs.existsSync(path.join(keysDir, 'foo', 'instance.hmac')));
check('readTenants returns null on a broken file', keyd.readTenants() === null);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
