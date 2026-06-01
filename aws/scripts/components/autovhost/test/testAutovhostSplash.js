// test/testAutovhostSplash.js
//
// Validates the two Safebox splash HTML files:
//   safebox-autovhost-splash.html       — HTTP-first design surface
//   safebox-autovhost-splash-https.html — minimal HTTPS-fallback
// Both must be self-contained (no external scripts/styles/images) so they
// load cleanly without any cert chain the browser trusts.

'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── splash.html (HTTP-first design surface) ─────────────────────────────────
const splashPath = path.resolve(__dirname, '..', 'nginx-templates',
    'safebox-autovhost-splash.html');
const html = fs.readFileSync(splashPath, 'utf8');

check('HTTP splash exists and is substantial', html.length > 1500);
check('HTTP splash has doctype', html.toLowerCase().startsWith('<!doctype html>'));
check('HTTP splash is Safebox-branded', html.includes('Safebox'));
check('HTTP splash has provisioning message',
    /provisioning|setting up|issuing/i.test(html));
check('HTTP splash has refresh meta', html.includes('http-equiv="refresh"'));
check('HTTP splash has noindex robots', html.includes('noindex'));
check('HTTP splash includes DNS troubleshooting hint', /\bDNS\b/.test(html));
check('HTTP splash references safebox-autovhost unit',
    html.includes('safebox-autovhost'));

// Self-containment
check('HTTP splash has no external <script src=>',
    !/<script[^>]+src=/i.test(html));
check('HTTP splash has no external <link rel="stylesheet" href=>',
    !/<link[^>]+stylesheet[^>]+href=["']http/i.test(html));
check('HTTP splash has no <img src="http">',
    !/<img[^>]+src=["']http/i.test(html));

// ── splash-https.html (minimal HTTPS-fallback) ──────────────────────────────
const httpsSplashPath = path.resolve(__dirname, '..', 'nginx-templates',
    'safebox-autovhost-splash-https.html');
const httpsHtml = fs.readFileSync(httpsSplashPath, 'utf8');

check('HTTPS-fallback splash exists', httpsHtml.length > 200);
check('HTTPS-fallback splash has doctype', httpsHtml.toLowerCase().startsWith('<!doctype html>'));
check('HTTPS-fallback splash explains certificate situation',
    /HTTPS|certificate|warning/i.test(httpsHtml));
check('HTTPS-fallback splash points user to HTTP',
    /HTTP|plain HTTP|http:\/\//i.test(httpsHtml));
check('HTTPS-fallback splash has no external scripts',
    !/<script[^>]+src=/i.test(httpsHtml));
check('HTTPS-fallback splash has no external stylesheets',
    !/<link[^>]+stylesheet[^>]+href=["']http/i.test(httpsHtml));

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
