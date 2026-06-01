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
check('undefined → /app',    sanitize(undefined) === '/app');
check('null → /app',         sanitize(null) === '/app');
check('empty string → /app', sanitize('') === '/app');

// ── Happy path ───────────────────────────────────────────────────────────────
check('plain /app',           sanitize('/app') === '/app');
check('nested /app/src',      sanitize('/app/src') === '/app/src');
check('with dots /app/v1.0',  sanitize('/app/v1.0') === '/app/v1.0');
check('with hyphens',         sanitize('/srv/foo-app/data') === '/srv/foo-app/data');
check('with underscore',      sanitize('/srv/foo_bar') === '/srv/foo_bar');

// ── Rejections ──────────────────────────────────────────────────────────────
function rejected(input, label) {
    let threw = false, msg = '';
    try { sanitize(input); }
    catch (e) { threw = true; msg = e.message; }
    check(label, threw, 'should have thrown for: ' + JSON.stringify(input));
}

rejected('app',              'reject: not absolute');
rejected('/app/../etc',      'reject: contains ..');
rejected('/app;rm -rf /',    'reject: semicolon');
rejected('/app && evil',     'reject: ampersand');
rejected('/app | tee',       'reject: pipe');
rejected('/app$(whoami)',    'reject: command substitution');
rejected('/app`whoami`',     'reject: backtick');
rejected('/app\nrm',         'reject: newline');
rejected('/app\tx',          'reject: tab');
rejected('/app x',           'reject: space');
rejected('/app#comment',     'reject: hash');
rejected('/app\\x',          'reject: backslash');
rejected('/app/* ',          'reject: glob');
rejected('/app"x',           'reject: quote');
rejected("/app'x",           'reject: single quote');
rejected('/app>out',         'reject: redirection');

// Type/length
rejected(123,                'reject: not a string');
rejected({},                 'reject: object');
rejected([],                 'reject: array');
rejected('/' + 'a'.repeat(256), 'reject: too long');

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
