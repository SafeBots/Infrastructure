// test/testDnsclientConfig.js
//
// Validates the config loader: rejects malformed JSON, missing fields,
// fields with wrong format. Accepts a valid config and returns the
// expected fields.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsclient-config-'));
const cfgPath = path.join(tmpDir, 'dnsclient.json');
process.env.SAFEBOX_DNSCLIENT_CONFIG = cfgPath;

// Re-require for each test since config.js doesn't cache (it re-reads file)
const config = require('../config');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

function writeConfig(obj) {
    fs.writeFileSync(cfgPath, typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function loadExpectErr(re) {
    try { config.load(); return null; }
    catch (e) { return re.test(e.message) ? null : e.message; }
}

// ── Missing file ─────────────────────────────────────────────────────────────
try { fs.unlinkSync(cfgPath); } catch {}
check('missing config file rejected',
    loadExpectErr(/not readable/) === null);

// ── Malformed JSON ───────────────────────────────────────────────────────────
writeConfig('{not json}');
check('malformed JSON rejected',
    loadExpectErr(/malformed JSON/) === null);

// ── Array instead of object ──────────────────────────────────────────────────
writeConfig([]);
check('array body rejected',
    loadExpectErr(/must be a JSON object/) === null);

// ── Missing safeboxId ────────────────────────────────────────────────────────
writeConfig({
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('missing safeboxId rejected',
    loadExpectErr(/safeboxId/) === null);

// ── Bad safeboxId format ─────────────────────────────────────────────────────
writeConfig({
    safeboxId: 'not-sbx-prefix',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('safeboxId without sbx_ prefix rejected',
    loadExpectErr(/safeboxId/) === null);

writeConfig({
    safeboxId: 'sbx_short',  // <8 chars after prefix
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('safeboxId too short rejected',
    loadExpectErr(/safeboxId/) === null);

writeConfig({
    safeboxId: 'sbx_' + 'a'.repeat(100),  // >64 chars after prefix
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('safeboxId too long rejected',
    loadExpectErr(/safeboxId/) === null);

writeConfig({
    safeboxId: 'sbx_abc.def',  // dot not allowed
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('safeboxId with disallowed char rejected',
    loadExpectErr(/safeboxId/) === null);

// ── Bad accountToken format ──────────────────────────────────────────────────
writeConfig({
    safeboxId: 'sbx_validvalue',
    accountToken: 'not-tok-prefix',
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('accountToken without tok_ prefix rejected',
    loadExpectErr(/accountToken/) === null);

writeConfig({
    safeboxId: 'sbx_validvalue',
    accountToken: 'tok_short',  // <16 chars after prefix
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
check('accountToken too short rejected',
    loadExpectErr(/accountToken/) === null);

// ── Bad dnsApiUrl ────────────────────────────────────────────────────────────
writeConfig({
    safeboxId: 'sbx_validvalue',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'http://dns-api.example.com/v1/announce',  // http not https
});
check('http (non-https) dnsApiUrl rejected',
    loadExpectErr(/dnsApiUrl/) === null);

writeConfig({
    safeboxId: 'sbx_validvalue',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'not a url',
});
check('non-URL dnsApiUrl rejected',
    loadExpectErr(/dnsApiUrl/) === null);

writeConfig({
    safeboxId: 'sbx_validvalue',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://has whitespace.com/',
});
check('dnsApiUrl with whitespace rejected',
    loadExpectErr(/dnsApiUrl/) === null);

// ── Valid config loads successfully ──────────────────────────────────────────
writeConfig({
    safeboxId: 'sbx_validvalue123',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
let cfg;
try { cfg = config.load(); }
catch (e) { cfg = null; }
check('valid config loads',
    cfg !== null &&
    cfg.safeboxId === 'sbx_validvalue123' &&
    cfg.accountToken === 'tok_' + 'a'.repeat(32) &&
    cfg.dnsApiUrl === 'https://dns-api.example.com/v1/announce' &&
    cfg.allowUnattested === false);

// ── allowUnattested explicitly true ──────────────────────────────────────────
writeConfig({
    safeboxId: 'sbx_validvalue123',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
    allowUnattested: true,
});
try { cfg = config.load(); } catch { cfg = null; }
check('allowUnattested:true is honored',
    cfg !== null && cfg.allowUnattested === true);

// ── allowUnattested with non-boolean is coerced to false ─────────────────────
writeConfig({
    safeboxId: 'sbx_validvalue123',
    accountToken: 'tok_' + 'a'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
    allowUnattested: 'yes',
});
try { cfg = config.load(); } catch { cfg = null; }
check('allowUnattested string is coerced to false',
    cfg !== null && cfg.allowUnattested === false);

// ── safeboxId with dashes and underscores accepted ───────────────────────────
writeConfig({
    safeboxId: 'sbx_abc-DEF_123',
    accountToken: 'tok_' + 'b'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com/v1/announce',
});
try { cfg = config.load(); } catch { cfg = null; }
check('safeboxId with dashes/underscores accepted',
    cfg !== null && cfg.safeboxId === 'sbx_abc-DEF_123');

// ── dnsApiUrl with port and path accepted ────────────────────────────────────
writeConfig({
    safeboxId: 'sbx_abcdef123',
    accountToken: 'tok_' + 'c'.repeat(32),
    dnsApiUrl: 'https://dns-api.example.com:8443/v1/announce',
});
try { cfg = config.load(); } catch { cfg = null; }
check('dnsApiUrl with port accepted',
    cfg !== null && cfg.dnsApiUrl === 'https://dns-api.example.com:8443/v1/announce');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
