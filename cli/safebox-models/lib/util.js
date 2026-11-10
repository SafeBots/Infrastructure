'use strict';
//
// lib/util.js — shared utilities for the safebox-models CLI.
//
// canonicalize() and computeManifestHash() MUST match the System component's
// opsModels.js byte-for-byte. Mismatched canonicalization means the CLI's
// computed hash won't equal the System component's computed hash, and the
// install request gets MANIFEST_HASH_MISMATCH 400.
//

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Canonicalization (mirrors aws/scripts/components/system/opsModels.js) ───
// Rules:
//   - null / true / false : literal strings
//   - numbers : integers only, no floats, no non-finite. Stringified.
//   - strings : JSON.stringify (handles escaping)
//   - arrays  : [c(x), c(y), ...]
//   - objects : keys sorted lexicographically, each "k":c(v) joined by commas
//
function canonicalize(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('non-finite number in manifest');
        if (!Number.isInteger(value)) throw new Error('non-integer number in manifest: ' + value);
        return String(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalize).join(',') + ']';
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k]));
        return '{' + parts.join(',') + '}';
    }
    throw new Error(`unsupported value type: ${typeof value}`);
}

function computeManifestHash(manifest) {
    const canonical = canonicalize(manifest);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// ── HMAC signing (mirrors System component's request auth) ──────────────
//
// Header convention used elsewhere in the Safebox runners:
//   X-Safebox-Timestamp:  <unix seconds>
//   X-Safebox-Nonce:      <random>
//   X-Safebox-Signature:  hex(hmac_sha256(ts + '.' + nonce + '.' + body, key))
//
function signHmac(body, hmacKey) {
    if (!hmacKey) throw new Error('HMAC key required');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = Buffer.concat([
        Buffer.from(ts + '.' + nonce + '.', 'utf8'),
        typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
    ]);
    const sig = crypto.createHmac('sha256', hmacKey).update(payload).digest('hex');
    return {
        'X-Safebox-Timestamp': ts,
        'X-Safebox-Nonce':     nonce,
        'X-Safebox-Signature': sig,
    };
}

// ── Terminal output ──────────────────────────────────────────────────────
// Color helpers — only emit ANSI when stdout is a TTY.
const isTTY = process.stdout.isTTY;
function ansi(code, s) { return isTTY ? `\x1b[${code}m${s}\x1b[0m` : s; }
const c = {
    dim:    s => ansi('2',  s),
    bold:   s => ansi('1',  s),
    red:    s => ansi('31', s),
    green:  s => ansi('32', s),
    yellow: s => ansi('33', s),
    blue:   s => ansi('34', s),
    cyan:   s => ansi('36', s),
};

function logInfo(msg)  { process.stderr.write(c.dim('  ' + msg) + '\n'); }
function logOk(msg)    { process.stderr.write(c.green('  ✓ ') + msg + '\n'); }
function logWarn(msg)  { process.stderr.write(c.yellow('  ⚠ ') + msg + '\n'); }
function logErr(msg)   { process.stderr.write(c.red('  ✗ ') + msg + '\n'); }
function logStep(msg)  { process.stderr.write('\n' + c.bold(msg) + '\n'); }

// ── Byte formatting ──────────────────────────────────────────────────────
function fmtBytes(n) {
    if (n == null) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
}

function fmtTimestamp(s) {
    if (!s) return '';
    try {
        const d = new Date(s);
        return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    } catch { return s; }
}

// ── Confirmation prompt ─────────────────────────────────────────────────
function confirm(question) {
    return new Promise(resolve => {
        if (!process.stdin.isTTY) {
            // Non-interactive: refuse to proceed unless --yes was passed earlier
            resolve(false);
            return;
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question + ' [y/N] ', (answer) => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

// ── Read HMAC key from disk ─────────────────────────────────────────────
function readHmacKey(keyPath) {
    if (!fs.existsSync(keyPath)) return null;
    try {
        return fs.readFileSync(keyPath, 'utf8').trim();
    } catch (e) {
        throw new Error(`Failed to read HMAC key at ${keyPath}: ${e.message}`);
    }
}

// ── Recursive directory walk for SHA-256 generation ─────────────────────
async function walkAndHash(rootDir) {
    const out = [];
    async function walk(dir, rel) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                await walk(full, relPath);
            } else if (e.isFile()) {
                const stat = await fs.promises.stat(full);
                const sha = await sha256File(full);
                out.push({ path: relPath, sizeBytes: stat.size, sha256: sha });
            }
        }
    }
    await walk(rootDir, '');
    return out;
}

// Mirror of the System component's invariant: a manifest's files[] must not
// contain two entries with the same destination path. Duplicate paths let the
// second download silently overwrite the first, so the on-disk artifact set is
// smaller than the file list claims and totalSizeBytes double-counts. The
// System component rejects such manifests at install time; the CLI rejects
// them at build/verify time so the failure surfaces before signers are asked
// to approve a hash. Returns the duplicate path if found, else null.
function findDuplicatePath(files) {
    if (!Array.isArray(files)) return null;
    const seen = new Set();
    for (const f of files) {
        if (!f || typeof f.path !== 'string') continue;
        if (seen.has(f.path)) return f.path;
        seen.add(f.path);
    }
    return null;
}

module.exports = {
    canonicalize,
    computeManifestHash,
    sha256File,
    signHmac,
    readHmacKey,
    fmtBytes,
    fmtTimestamp,
    confirm,
    walkAndHash,
    findDuplicatePath,
    c,
    logInfo, logOk, logWarn, logErr, logStep,
};
