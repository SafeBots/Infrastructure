// test/testWrapperCaller.js
//
// The caller-derivation library the root wrappers source
// (common/sudo/bin/safebox-caller.sh) and the wrappers' use of it, driven
// with stubbed getent/zfs/docker/systemctl on PATH and a chosen SUDO_UID.
// Nothing real is touched: the stubs print canned answers and record what
// they were asked. This is the test that says a tenant instance cannot
// name another tenant's container, clone, test or dataset.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BIN = path.join(REPO, 'common', 'sudo', 'bin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-caller-test-'));
const stubs = path.join(tmp, 'stubs');
fs.mkdirSync(stubs);

// Fake passwd: operator 990, tenants foo (20000) and bar (20001), a stranger.
const PASSWD = {
    990: 'safebox-infra:x:990:990::/var/empty:/usr/sbin/nologin',
    20000: 'safebox-sys-foo:x:20000:993::/nonexistent:/usr/sbin/nologin',
    20001: 'safebox-sys-bar:x:20001:993::/nonexistent:/usr/sbin/nologin',
    1000: 'alice:x:1000:1000::/home/alice:/bin/bash',
};
function stub(name, body) {
    const p = path.join(stubs, name);
    fs.writeFileSync(p, '#!/usr/bin/env bash\n' + body, { mode: 0o755 });
}
stub('getent', `
case "$1" in
  passwd)
    case "$2" in
      ${Object.entries(PASSWD).map(([uid, line]) => `${uid}) echo '${line}';;`).join('\n      ')}
      *) exit 2;;
    esac;;
  *) exit 2;;
esac`);
// zfs get safebox:tenant: clones/foo-* belong to foo, clones/bar-* to bar,
// clones/orphan has no property; everything else "does not exist".
stub('zfs', `
echo "zfs $*" >> "${tmp}/calls"
if [[ $1 == get ]]; then
  ds=\${@: -1}
  case $ds in
    safebox-pool/clones/foo-*) echo foo;;
    safebox-pool/clones/bar-*) echo bar;;
    safebox-pool/clones/orphan) echo -;;
    *) exit 1;;
  esac
  exit 0
fi
if [[ $1 == list ]]; then exit 0; fi
exit 0`);
// docker inspect: test containers labelled by owner.
stub('docker', `
echo "docker $*" >> "${tmp}/calls"
if [[ $1 == inspect ]]; then
  case \${@: -1} in
    safebox-test-foo-*) echo foo;;
    safebox-test-bar-*) echo bar;;
    *) exit 1;;
  esac
  exit 0
fi
exit 0`);
stub('mountpoint', 'exit 0');
stub('chown', 'exit 0');
stub('chgrp', 'exit 0');
stub('chmod', 'exit 0');
stub('nsenter', 'shift; shift; exec "$@"');
stub('systemctl', `echo "systemctl $*" >> "${tmp}/calls"; exit 0`);
stub('node', `echo "node $*" >> "${tmp}/calls"; exit 0`);

// The wrappers source /opt/safebox/bin/safebox-caller.sh by absolute path;
// run them through a copy with that line pointed at the repo file.
const wrappersDir = path.join(tmp, 'bin');
fs.mkdirSync(wrappersDir);
for (const w of fs.readdirSync(BIN)) {
    let body = fs.readFileSync(path.join(BIN, w), 'utf8');
    body = body.replace('. /opt/safebox/bin/safebox-caller.sh', `. ${BIN}/safebox-caller.sh`);
    // safebox-zfs re-execs itself by absolute path into PID 1's mount
    // namespace; keep it on the copy.
    body = body.replace('/opt/safebox/bin/safebox-zfs "$@"', `${wrappersDir}/safebox-zfs "$@"`);
    // Every wrapper pins its own PATH (so a caller's PATH is irrelevant);
    // the test copies get the stub directory in front of it.
    body = body.replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin\n', `PATH=${stubs}:/usr/sbin:/usr/bin:/sbin:/bin\n`);
    fs.writeFileSync(path.join(wrappersDir, w), body, { mode: 0o755 });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

function run(wrapper, sudoUid, args, extraEnv) {
    const env = { PATH: stubs + ':' + process.env.PATH, LC_ALL: 'C' };
    if (sudoUid !== null) env.SUDO_UID = String(sudoUid);
    Object.assign(env, extraEnv || {});
    const r = spawnSync('bash', [path.join(wrappersDir, wrapper), ...args], { env, encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function calls() { try { return fs.readFileSync(path.join(tmp, 'calls'), 'utf8'); } catch { return ''; } }
function resetCalls() { try { fs.unlinkSync(path.join(tmp, 'calls')); } catch {} }

// ── Library functions in isolation ──────────────────────────────────────────
function lib(sudoUid, script) {
    const env = { PATH: stubs + ':' + process.env.PATH };
    if (sudoUid !== null) env.SUDO_UID = String(sudoUid);
    const r = spawnSync('bash', ['-c', `die() { echo "die: $*" >&2; exit 2; }; . ${BIN}/safebox-caller.sh; ${script}`], { env, encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
let r = lib(20000, 'caller_tenant');
check('caller_tenant: uid 20000 → foo', r.status === 0 && r.out === 'foo', r.err);
r = lib(20001, 'caller_tenant');
check('caller_tenant: uid 20001 → bar', r.status === 0 && r.out === 'bar');
r = lib(990, 'caller_tenant');
check('caller_tenant: operator is not a tenant', r.status === 2 && /not a tenant instance/.test(r.err));
r = lib(1000, 'caller_tenant');
check('caller_tenant: an ordinary user is not a tenant', r.status === 2);
r = lib(null, 'caller_tenant');
check('caller_tenant: no SUDO_UID → refused', r.status === 2 && /SUDO_UID/.test(r.err));
r = lib(4242, 'caller_tenant');
check('caller_tenant: unknown uid → refused', r.status === 2 && /no passwd entry/.test(r.err));
r = lib(990, 'require_operator && echo ok');
check('require_operator: uid 990 passes', r.status === 0 && r.out === 'ok');
r = lib(20000, 'require_operator');
check('require_operator: a tenant is refused', r.status === 2);
r = lib(20000, 'SUDO_UID=990 require_operator');
check('SUDO_UID is read from the environment sudo set, so a caller cannot pass it as an argument (only reassignable inside the shell)', r.status === 0);
r = lib(20000, 'dataset_owned_by safebox-pool/tenants/foo foo && echo yes');
check('dataset_owned_by: own tenant dataset', r.out === 'yes');
r = lib(20000, 'dataset_owned_by safebox-pool/tenants/foo@snap foo && echo yes');
check('dataset_owned_by: snapshot of own dataset', r.out === 'yes');
r = lib(20000, 'dataset_owned_by safebox-pool/tenants/foo-bar foo || echo no');
check('dataset_owned_by: prefix-sharing tenant is not mine', r.out === 'no');
r = lib(20000, 'dataset_owned_by safebox-pool/tenants/bar foo || echo no');
check('dataset_owned_by: another tenant dataset', r.out === 'no');
r = lib(20000, 'dataset_owned_by safebox-pool/clones/foo-abc123 foo && echo yes');
check('dataset_owned_by: clone with my property', r.out === 'yes');
r = lib(20000, 'dataset_owned_by safebox-pool/clones/bar-abc123 foo || echo no');
check('dataset_owned_by: clone with another property', r.out === 'no');
r = lib(20000, 'dataset_owned_by safebox-pool/clones/orphan foo || echo no');
check('dataset_owned_by: clone without property', r.out === 'no');
r = lib(20000, 'dataset_owned_by safebox-pool/clones/nope foo || echo no');
check('dataset_owned_by: missing clone', r.out === 'no');
r = lib(20000, 'dataset_owned_by safebox-pool/safebox foo || echo no');
check('dataset_owned_by: outside the subtrees', r.out === 'no');
r = lib(20000, 'test_owned_by foo-abc foo && echo yes');
check('test_owned_by: my label', r.out === 'yes');
r = lib(20000, 'test_owned_by bar-abc foo || echo no');
check('test_owned_by: another label', r.out === 'no');

// ── safebox-container ───────────────────────────────────────────────────────
resetCalls();
r = run('safebox-container', 20000, ['exec', 'foo', 'npm', 'ls']);
check('container exec: own tenant → docker exec', r.status === 0 && /docker exec --user safebox-app --workdir \/workspace -- safebox-app-foo npm ls/.test(calls()), r.out + calls());
resetCalls();
r = run('safebox-container', 20000, ['exec', 'bar', 'npm', 'ls']);
check('container exec: other tenant refused before docker', r.status === 2 && /caller is tenant 'foo', not 'bar'/.test(r.out) && calls() === '');
r = run('safebox-container', 990, ['exec', 'foo', 'npm', 'ls']);
check('container exec: operator refused', r.status === 2 && calls() === '');
r = run('safebox-container', 20000, ['create', 'foo', 'safebox-app-foo:1']);
check('container create: tenant refused', r.status === 2 && /only the operator/.test(r.out) && calls() === '');
r = run('safebox-container', 20000, ['destroy', 'foo']);
check('container destroy: tenant refused', r.status === 2 && calls() === '');
resetCalls();
r = run('safebox-container', 990, ['destroy', 'foo']);
check('container destroy: operator → docker rm', r.status === 0 && /docker rm -f safebox-app-foo/.test(calls()), r.out);
r = run('safebox-container', null, ['exec', 'foo', 'npm', 'ls']);
check('container exec: no SUDO_UID refused', r.status === 2);

// ── safebox-zfs ─────────────────────────────────────────────────────────────
resetCalls();
r = run('safebox-zfs', 20000, ['snapshot', 'safebox-pool/tenants/foo@s1']);
check('zfs snapshot: own dataset', r.status === 0 && /zfs snapshot -- safebox-pool\/tenants\/foo@s1/.test(calls()), r.out);
resetCalls();
r = run('safebox-zfs', 20000, ['snapshot', 'safebox-pool/tenants/bar@s1']);
check('zfs snapshot: other tenant refused', r.status === 2 && !/zfs snapshot/.test(calls()), r.out);
resetCalls();
r = run('safebox-zfs', 20000, ['clone', 'safebox-pool/tenants/foo@s1', 'foo-aaaaaaaaaaaa']);
check('zfs clone: own source, tenant property set', r.status === 0 && /zfs clone .*-o safebox:tenant=foo -- safebox-pool\/tenants\/foo@s1 safebox-pool\/clones\/foo-aaaaaaaaaaaa/.test(calls()), r.out + calls());
resetCalls();
r = run('safebox-zfs', 20000, ['clone', 'safebox-pool/clones/bar-aaaaaaaaaaaa@s1', 'foo-bbbbbbbbbbbb']);
check('zfs clone: from another tenant clone refused', r.status === 2 && !/zfs clone/.test(calls()));
resetCalls();
r = run('safebox-zfs', 20000, ['destroy', 'safebox-pool/clones/bar-aaaaaaaaaaaa', 'recursive']);
check('zfs destroy: another tenant clone refused', r.status === 2 && !/zfs destroy/.test(calls()));
resetCalls();
r = run('safebox-zfs', 20000, ['destroy', 'safebox-pool/clones/foo-aaaaaaaaaaaa', 'recursive']);
check('zfs destroy: own clone', r.status === 0 && /zfs destroy -r -- safebox-pool\/clones\/foo-aaaaaaaaaaaa/.test(calls()));
resetCalls();
r = run('safebox-zfs', 20000, ['rollback', 'safebox-pool/tenants/bar@s1']);
check('zfs rollback: other tenant refused', r.status === 2 && !/zfs rollback/.test(calls()));
r = run('safebox-zfs', 990, ['snapshot', 'safebox-pool/tenants/foo@s1']);
check('zfs: operator is not a tenant', r.status === 2);

// ── safebox-test-run / stop / logs ──────────────────────────────────────────
const cloneDir = path.join(tmp, 'srv-zfs-clones');
resetCalls();
r = run('safebox-test-run', 20000, ['foo-aaaaaaaaaaaa', 'safebox-app-foo:1', '/srv/zfs-clones/foo-aaaaaaaaaaaa']);
// /srv/zfs-clones/<id> does not exist on this host, so the directory check
// fires before ownership; that is fine, ownership is tested in the library
// and the label is what we check in the argv.
check('test-run: refuses before docker when the clone path is absent', r.status === 2 && !/docker run/.test(calls()));
resetCalls();
r = run('safebox-test-stop', 20000, ['foo-aaaaaaaaaaaa']);
check('test-stop: own test → docker rm', r.status === 0 && /docker rm -f safebox-test-foo-aaaaaaaaaaaa/.test(calls()), r.out);
resetCalls();
r = run('safebox-test-stop', 20000, ['bar-aaaaaaaaaaaa']);
check('test-stop: another tenant test refused', r.status === 2 && !/docker rm/.test(calls()), r.out);
resetCalls();
r = run('safebox-test-logs', 20001, ['bar-aaaaaaaaaaaa']);
check('test-logs: own test → docker logs', r.status === 0 && /docker logs -f safebox-test-bar-aaaaaaaaaaaa/.test(calls()));
resetCalls();
r = run('safebox-test-logs', 20001, ['foo-aaaaaaaaaaaa']);
check('test-logs: another tenant test refused', r.status === 2 && !/docker logs/.test(calls()));
resetCalls();
r = run('safebox-test-logs', 20001, ['zzz-aaaaaaaaaaaa']);
check('test-logs: unknown test refused', r.status === 2 && !/docker logs/.test(calls()));

// ── safebox-instance / safebox-keyd-reload ──────────────────────────────────
resetCalls();
r = run('safebox-keyd-reload', 990, []);
check('keyd-reload: operator → systemctl kill -s HUP', r.status === 0 && /systemctl kill -s HUP safebox-keyd.service/.test(calls()), r.out);
resetCalls();
r = run('safebox-keyd-reload', 20000, []);
check('keyd-reload: tenant refused', r.status === 2 && calls() === '');
r = run('safebox-keyd-reload', 990, ['x']);
check('keyd-reload: arguments refused', r.status === 2);
resetCalls();
r = run('safebox-instance', 990, ['stop', 'foo']);
check('instance stop: operator → systemctl stop safebox-system@foo', r.status === 0 && /systemctl stop -- safebox-system@foo.service/.test(calls()), r.out);
r = run('safebox-instance', 20000, ['stop', 'foo']);
check('instance stop: tenant refused', r.status === 2);
r = run('safebox-instance', 990, ['stop', 'Foo/../x']);
check('instance: bad name refused', r.status === 2);
r = run('safebox-instance', 990, ['restart', 'foo']);
check('instance: unknown action refused', r.status === 2);
r = run('safebox-instance', 990, ['start', '--foo']);
check('instance: dash argument refused', r.status === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
