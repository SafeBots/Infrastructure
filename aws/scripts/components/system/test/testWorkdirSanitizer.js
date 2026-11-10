// test/testWorkdirSanitizer.js
//
// Tests sanitizeWorkdir() in isolation. The function gates what we pass
// to `docker exec --workdir`; if it ever lets a shell metacharacter through,
// an attacker who controls req.containerWorkdir could potentially break out
// of the docker exec argv shape (though Node's execFile uses array argv, so
// shell injection isn't possible — this is defense in depth).

'use strict';

const ops = require('../opsSystem');
const sanitize = ops._sanitizeWorkdir;

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── Defaults ─────────────────────────────────────────────────────────────────
check('undefined → /workspace', sanitize(undefined) === '/workspace');
check('null → /workspace',      sanitize(null) === '/workspace');
check('empty string → /workspace', sanitize('') === '/workspace');

// ── Happy path ───────────────────────────────────────────────────────────────
check('plain /workspace',     sanitize('/workspace') === '/workspace');
check('trailing slash',       sanitize('/workspace/') === '/workspace');
rejected('/workspace/src',  'reject: subdirectory not supported by the wrapper (fixed --workdir /workspace)');
rejected('/app',                  'reject: outside /workspace');

// ── Rejections ──────────────────────────────────────────────────────────────
function rejected(input, label) {
    let threw = false, msg = '';
    try { sanitize(input); }
    catch (e) { threw = true; msg = e.message; }
    check(label, threw, 'should have thrown for: ' + JSON.stringify(input));
}

rejected('app',              'reject: not absolute');
rejected('/workspace/../etc',      'reject: contains ..');
rejected('/workspace;rm -rf /',    'reject: semicolon');
rejected('/workspace && evil',     'reject: ampersand');
rejected('/workspace | tee',       'reject: pipe');
rejected('/workspace$(whoami)',    'reject: command substitution');
rejected('/workspace`whoami`',     'reject: backtick');
rejected('/workspace\nrm',         'reject: newline');
rejected('/workspace\tx',          'reject: tab');
rejected('/workspace x',           'reject: space');
rejected('/workspace#comment',     'reject: hash');
rejected('/workspace\\x',          'reject: backslash');
rejected('/workspace/* ',          'reject: glob');
rejected('/workspace"x',           'reject: quote');
rejected("/workspace'x",           'reject: single quote');
rejected('/workspace>out',         'reject: redirection');

// Type/length
rejected(123,                'reject: not a string');
rejected({},                 'reject: object');
rejected([],                 'reject: array');
rejected('/' + 'a'.repeat(256), 'reject: too long');

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
