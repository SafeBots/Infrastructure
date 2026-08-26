#!/usr/bin/env node
// test/run.js — runs every deterministic test in this directory.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;

const tests = fs.readdirSync(HERE)
    .filter(f => /^test[A-Z].*\.js$/.test(f))
    .sort();

let passedTests = 0;
let failedTests = 0;
let totalAssertions = 0;
let passedAssertions = 0;

for (const t of tests) {
    process.stdout.write(`\n── ${t} ──\n`);
    const r = spawnSync(process.execPath, [path.join(HERE, t)], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = r.stdout.toString();
    const stderr = r.stderr.toString();
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    const m = stdout.match(/(\d+)\/(\d+) passed/);
    if (m) {
        passedAssertions += parseInt(m[1], 10);
        totalAssertions   += parseInt(m[2], 10);
    }

    if (r.status === 0) passedTests++;
    else                failedTests++;
}

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Test files: ${passedTests}/${passedTests + failedTests} passed`);
console.log(`Assertions: ${passedAssertions}/${totalAssertions} passed`);
console.log('═══════════════════════════════════════════════════════════');

process.exit(failedTests === 0 ? 0 : 1);
