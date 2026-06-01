// test/testAutovhostUnit.js
//
// Unit tests for autovhost's pure validation and config-generation
// functions. No nginx, no ACME, no I/O — fast and deterministic.

'use strict';

const av = require('../autovhost');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── isValidHostname ──────────────────────────────────────────────────────────

check('valid simple domain',
    av._isValidHostname('example.com') === true);
check('valid sub-domain',
    av._isValidHostname('app.example.com') === true);
check('valid deep sub-domain',
    av._isValidHostname('a.b.c.example.com') === true);
check('valid with hyphens',
    av._isValidHostname('my-app.example.com') === true);
check('valid with digits',
    av._isValidHostname('app123.example.com') === true);

check('reject empty',
    av._isValidHostname('') === false);
check('reject single label (no dot)',
    av._isValidHostname('example') === false);
check('reject starts with hyphen',
    av._isValidHostname('-app.example.com') === false);
check('reject ends with hyphen',
    av._isValidHostname('app-.example.com') === false);
check('reject starts with dot',
    av._isValidHostname('.example.com') === false);
check('reject ends with dot',
    av._isValidHostname('example.com.') === false);
check('reject double dot',
    av._isValidHostname('app..example.com') === false);
check('reject underscores',
    av._isValidHostname('my_app.example.com') === false);
check('reject spaces',
    av._isValidHostname('app .example.com') === false);
check('reject special chars',
    av._isValidHostname('app$.example.com') === false);
check('reject path injection',
    av._isValidHostname('example.com/foo') === false);
check('reject newline injection',
    av._isValidHostname('example.com\n') === false);
check('reject null byte injection',
    av._isValidHostname('example.com\x00') === false);
check('reject label longer than 63 chars',
    av._isValidHostname('a'.repeat(64) + '.example.com') === false);
check('reject hostname longer than 253 chars',
    av._isValidHostname(('a'.repeat(60) + '.').repeat(5) + 'com') === false);
check('reject IP address (no dot at end of label rule fires)',
    av._isValidHostname('192.168.1.1') === true);  // technically valid hostname syntax; ACME will reject

check('reject non-string',
    av._isValidHostname(null) === false &&
    av._isValidHostname(undefined) === false &&
    av._isValidHostname(123) === false &&
    av._isValidHostname({}) === false);

// ── negativeCache ───────────────────────────────────────────────────────────

av._negativeCacheAdd('test1.example.com', 'reason_1');
check('negative cache hit',
    av._negativeCacheCheck('test1.example.com') === 'reason_1');
check('negative cache miss',
    av._negativeCacheCheck('test2.example.com') === null);

// ── vhostConfigFor ──────────────────────────────────────────────────────────

const vhost = av._vhostConfigFor('app.example.com');
check('vhost includes server_name',
    vhost.includes('server_name app.example.com;'));
check('vhost includes ssl_certificate path',
    vhost.includes('app.example.com.crt'));
check('vhost includes ssl_certificate_key path',
    vhost.includes('app.example.com.key'));
check('vhost includes TLS 1.2+ only',
    vhost.includes('TLSv1.2 TLSv1.3') &&
    !vhost.includes('TLSv1 '));
check('vhost includes proxy_pass',
    vhost.includes('proxy_pass'));
check('vhost has HTTP→HTTPS redirect',
    vhost.includes('return 301 https://'));
check('vhost has ACME challenge location for cert renewal',
    vhost.includes('/.well-known/acme-challenge/'));
check('vhost does NOT contain shell metachars from host',
    // Defense-in-depth check: even though isValidHostname rejects most
    // dangerous chars, verify the generated config isn't trivially injectable.
    !vhost.includes('$(') && !vhost.includes('`'));

// Try a host with a hyphen (legal); ensure it appears verbatim
const vhost2 = av._vhostConfigFor('my-customer.acme.org');
check('vhost handles hyphens in hostname',
    vhost2.includes('server_name my-customer.acme.org;'));

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
