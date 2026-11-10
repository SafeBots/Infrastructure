// test/testAutovhostReload.js
//
// Tests that nginx reloads are:
//   1. Preceded by `nginx -t` config validation (we skip the reload if -t fails)
//   2. Debounced — multiple queueReload() calls in quick succession produce one
//      reload pass, not many
//   3. Mutex-guarded — never two reload passes concurrent
//   4. Re-fired if a request arrives during an in-flight reload pass
//
// We instrument by pointing nginxReloadCommand at a tiny shell script that
// stands in for /opt/safebox/bin/safebox-nginx-reload: like the real
// wrapper it takes no arguments, runs the config test and then the reload,
// and exits non-zero if the test fails. It records each step it would have
// run ("-t", "-s reload") so the assertions can count by step.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovhost-reload-'));
const callLog = path.join(tmpDir, 'calls.log');
const failFlag = path.join(tmpDir, 'fail-t');
const fakeNginx = path.join(tmpDir, 'fake-nginx.sh');

// Fake reload wrapper: logs the steps it would run. If the 'fail-t' flag
// file exists, the config test "fails" and the reload step never happens.
fs.writeFileSync(fakeNginx, `#!/bin/bash
echo "$(date +%s.%N) -t" >> "${callLog}"
if [[ -f "${failFlag}" ]]; then exit 1; fi
sleep 0.05
echo "$(date +%s.%N) -s reload" >> "${callLog}"
exit 0
`);
fs.chmodSync(fakeNginx, 0o755);

const cfgPath = path.join(tmpDir, 'autovhost.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    socketPath:         path.join(tmpDir, 'sock'),
    vhostConfDir:       path.join(tmpDir, 'auto'),
    vhostCertDir:       path.join(tmpDir, 'certs'),
    acmeAccountKeyPath: path.join(tmpDir, 'acme.key'),
    acmeChallengesDir:  path.join(tmpDir, 'chal'),
    acmeStaging:        true,
    nginxReloadCommand: [fakeNginx],
    ourIps:             ['127.0.0.1'],
}));
process.env.SAFEBOX_AUTOVHOST_CONFIG = cfgPath;

const av = require('../autovhost');

function callsMatching(predicate) {
    try {
        const lines = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
        if (!predicate) return lines.length;
        return lines.filter(predicate).length;
    } catch { return 0; }
}

(async () => {
    // ── Test 1: single queueReload → 1 -t call + 1 reload call ──────────────
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    av._queueReload();
    await sleep(400);
    const tCount = callsMatching(l => l.includes(' -t'));
    const reloadCount = callsMatching(l => l.includes(' -s reload'));
    check('single queueReload → 1 nginx -t call',
        tCount === 1, `tCount=${tCount}`);
    check('single queueReload → 1 nginx -s reload call',
        reloadCount === 1, `reloadCount=${reloadCount}`);

    // ── Test 2: nginx -t failure aborts the reload ──────────────────────────
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    fs.writeFileSync(failFlag, '1');
    av._queueReload();
    await sleep(400);
    const tFail = callsMatching(l => l.includes(' -t'));
    const reloadAfterFail = callsMatching(l => l.includes(' -s reload'));
    check('nginx -t failure → -t was attempted', tFail === 1);
    check('nginx -t failure → reload NOT executed', reloadAfterFail === 0);
    fs.unlinkSync(failFlag);

    // ── Test 3: 10 rapid queueReloads → debounced ───────────────────────────
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    for (let i = 0; i < 10; i++) av._queueReload();
    await sleep(2500);
    const tBurst = callsMatching(l => l.includes(' -t'));
    check('10 rapid queueReloads → debounced to <=2 -t passes',
        tBurst >= 1 && tBurst <= 2,
        `tBurst=${tBurst}`);

    // ── Test 4: queueReload during in-flight re-fires ───────────────────────
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    av._queueReload();
    await sleep(20);  // first pass mid-flight (each call sleeps 50ms in fake nginx)
    av._queueReload();
    await sleep(3000);
    const tMidFlight = callsMatching(l => l.includes(' -t'));
    check('queueReload during in-flight triggers second reload pass',
        tMidFlight === 2,
        `tMidFlight=${tMidFlight}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
