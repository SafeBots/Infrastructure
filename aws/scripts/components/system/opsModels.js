// /opt/safebox/system/opsModels.js
//
// Model supply chain. Handles install / list / verify / remove of AI model
// weights for use by the model-runner containers.
//
// Trust model:
//
//   - Every model is identified by the SHA-256 of its canonical manifest JSON.
//     That hash is what Safebox M-of-N actually signs. The manifest itself
//     declares: download sources, per-file SHA-256s, total size, license,
//     and which runner type consumes it.
//   - The system never trusts a download. After fetching each file, it
//     verifies the SHA-256 against the manifest BEFORE moving the file
//     into the active model directory. A mismatch aborts the install
//     loudly — the partial download is deleted.
//   - All /models endpoints are restricted to managedContainer='_host',
//     same as dnf. Model pulls affect every tenant; they need the same
//     governance gate as a system-wide package update.
//   - Once installed, weights live at /srv/safebox/models/<manifestHash>/.
//     The directory name IS the manifest hash, so an auditor can verify
//     a given install matches a known-good manifest by hashing the
//     directory name's manifest file.
//
// Manifest schema:
//
//   {
//     "name":           "stable-audio-3-small",
//     "version":        "1.0.0",
//     "license":        "Stability-Community-License",
//     "runnerType":     "stable-audio-3",
//     "totalSizeBytes": 1837465600,
//     "files": [
//       {
//         "path":       "model.safetensors",
//         "sizeBytes":  1837465600,
//         "sha256":     "abc123...",
//         "sources":    [
//           "https://huggingface.co/stabilityai/stable-audio-3-small/resolve/main/model.safetensors",
//           "https://safebots-models.s3.amazonaws.com/stable-audio-3-small/model.safetensors"
//         ]
//       },
//       ...
//     ],
//     "metadata": { ... any additional runner-specific info ... }
//   }
//
// The manifest hash is sha256(JSON.stringify(manifest)) with the JSON
// canonicalized per RFC 8785 (sorted keys, no whitespace). Both Safebox
// and the system must produce the same hash for the same manifest.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const MODELS_DIR = process.env.SAFEBOX_SYSTEM_MODELS_DIR || '/srv/safebox/models';
const STAGING_DIR = process.env.SAFEBOX_SYSTEM_MODELS_STAGING || '/srv/safebox/models/.staging';
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour per file
const MAX_FILES_PER_MANIFEST = 256;
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024 * 1024; // 200 GB (XL model weights)
const SHA256_HEX = /^[0-9a-f]{64}$/;

class ModelError extends Error {
    constructor(msg, code, httpStatus) {
        super(msg);
        this.code = code || 'MODEL_OP_FAILED';
        this._http = httpStatus || 500;
    }
}

// ── RFC 8785 canonicalization ────────────────────────────────────────────────
// Same algorithm Safebox uses for OpenClaim canonical JSON.
//
// Rules: object keys sorted ascending by code unit; no whitespace; strings
// in JSON-string form; numbers in shortest IEEE-754 round-trippable form.
// Arrays preserve order. We restrict to the subset that appears in our
// manifests: strings, numbers (integers, since sizes are ints), arrays,
// objects, true/false/null. No floats. The JSON.stringify defaults give
// us shortest-form integers; we handle key sorting ourselves.

function canonicalize(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new ModelError('non-finite number in manifest', 'BAD_REQUEST', 400);
        if (!Number.isInteger(value)) throw new ModelError('non-integer number in manifest', 'BAD_REQUEST', 400);
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
    throw new ModelError(`unsupported value type in manifest: ${typeof value}`, 'BAD_REQUEST', 400);
}

function computeManifestHash(manifest) {
    const canonical = canonicalize(manifest);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Manifest validation ──────────────────────────────────────────────────────

function validateManifest(m) {
    if (!m || typeof m !== 'object') throw new ModelError('manifest must be an object', 'BAD_REQUEST', 400);
    if (typeof m.name !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(m.name)) {
        throw new ModelError('manifest.name must be a short identifier', 'BAD_REQUEST', 400);
    }
    if (typeof m.version !== 'string' || m.version.length > 64) {
        throw new ModelError('manifest.version is required', 'BAD_REQUEST', 400);
    }
    if (typeof m.license !== 'string' || m.license.length > 256) {
        throw new ModelError('manifest.license is required', 'BAD_REQUEST', 400);
    }
    if (typeof m.runnerType !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.runnerType)) {
        throw new ModelError('manifest.runnerType must be a short identifier', 'BAD_REQUEST', 400);
    }
    if (!Number.isInteger(m.totalSizeBytes) || m.totalSizeBytes < 1) {
        throw new ModelError('manifest.totalSizeBytes must be a positive integer', 'BAD_REQUEST', 400);
    }
    if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES_PER_MANIFEST) {
        throw new ModelError(`manifest.files must be a non-empty array of <= ${MAX_FILES_PER_MANIFEST} entries`, 'BAD_REQUEST', 400);
    }
    let sumBytes = 0;
    // Track paths we've already seen. Two entries that resolve to the same
    // destination path are a supply-chain hazard: on install the second
    // download overwrites the first, so the on-disk artifact set is SMALLER
    // than the manifest's file list claims. The manifest hash then attests to
    // "N distinct files" when fewer than N exist — an auditor reading the
    // manifest is misled, and totalSizeBytes double-counts the shared path.
    // This is the same class of bug as counting one signature N times toward
    // an M-of-N threshold. Reject duplicates outright.
    //
    // Paths are compared after NFC normalization and case-folding is NOT
    // applied (the filesystem is case-sensitive on Linux), but we do reject
    // exact byte-duplicate paths. The regex below already constrains segments
    // to [A-Za-z0-9._-], so there is no Unicode-normalization ambiguity to
    // worry about — two paths are equal iff they are byte-identical.
    const seenPaths = new Set();
    for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        if (!f || typeof f !== 'object') throw new ModelError(`files[${i}] must be an object`, 'BAD_REQUEST', 400);
        if (typeof f.path !== 'string' || f.path.length === 0 || f.path.length > 256) {
            throw new ModelError(`files[${i}].path is required (1-256 chars)`, 'BAD_REQUEST', 400);
        }
        // Allowlist: relative POSIX-style path of non-empty segments separated
        // by single slashes. Segments contain only [A-Za-z0-9._-]. Reject:
        //   - leading slash / absolute paths
        //   - backslashes (Windows-style)
        //   - null bytes (Node will reject downstream but we should fail fast)
        //   - any segment equal to '.' or '..' (traversal / no-op)
        //   - empty segments (would mean // somewhere)
        //   - any other character outside the allowlist (control chars, spaces,
        //     shell metachars — all of which could surprise an auditor)
        if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(f.path)) {
            throw new ModelError(
                `files[${i}].path '${f.path}' must be a relative POSIX path of [A-Za-z0-9._-] segments`,
                'BAD_REQUEST', 400);
        }
        // Even with the regex, '.' and '..' segments would slip through (they
        // match [A-Za-z0-9._-]+). Reject them explicitly. Single '.' alone
        // is also caught.
        for (const seg of f.path.split('/')) {
            if (seg === '.' || seg === '..') {
                throw new ModelError(
                    `files[${i}].path '${f.path}' contains '${seg}' segment`,
                    'BAD_REQUEST', 400);
            }
        }
        // Duplicate destination path — see the seenPaths comment above.
        if (seenPaths.has(f.path)) {
            throw new ModelError(
                `files[${i}].path '${f.path}' is a duplicate; every file entry must have a distinct path`,
                'BAD_REQUEST', 400);
        }
        seenPaths.add(f.path);
        if (!Number.isInteger(f.sizeBytes) || f.sizeBytes < 1 || f.sizeBytes > MAX_FILE_SIZE_BYTES) {
            throw new ModelError(`files[${i}].sizeBytes out of range`, 'BAD_REQUEST', 400);
        }
        if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) {
            throw new ModelError(`files[${i}].sha256 must be 64 lowercase hex chars`, 'BAD_REQUEST', 400);
        }
        if (!Array.isArray(f.sources) || f.sources.length < 1 || f.sources.length > 16) {
            throw new ModelError(`files[${i}].sources must be 1-16 URLs`, 'BAD_REQUEST', 400);
        }
        for (let j = 0; j < f.sources.length; j++) {
            if (typeof f.sources[j] !== 'string') throw new ModelError(`files[${i}].sources[${j}] not a string`, 'BAD_REQUEST', 400);
            let u;
            try { u = new URL(f.sources[j]); } catch { throw new ModelError(`files[${i}].sources[${j}] not a URL`, 'BAD_REQUEST', 400); }
            if (u.protocol !== 'https:') throw new ModelError(`files[${i}].sources[${j}] must be https`, 'BAD_REQUEST', 400);
        }
        sumBytes += f.sizeBytes;
    }
    if (sumBytes !== m.totalSizeBytes) {
        throw new ModelError(`sum of files[].sizeBytes (${sumBytes}) != totalSizeBytes (${m.totalSizeBytes})`, 'BAD_REQUEST', 400);
    }
}

// ── HTTPS download with size cap and per-source fallback ─────────────────────

function downloadWithFallback(sources, destPath, expectedSize, expectedSha256) {
    const MAX_REDIRECTS_PER_SOURCE = 5;
    return new Promise((resolve, reject) => {
        let attemptIdx = 0;
        let redirectsForThisSource = 0;
        let done = false;
        let wallClockTimer = null;
        const finish = (fn) => {
            if (done) return;
            done = true;
            if (wallClockTimer) { clearTimeout(wallClockTimer); wallClockTimer = null; }
            fn();
        };

        function tryNext() {
            if (done) return;
            // Cancel any pending wall-clock timer from a previous attempt so
            // its setImmediate(tryNext) doesn't fire later and double-trigger
            // the next attempt while we're already processing one.
            if (wallClockTimer) { clearTimeout(wallClockTimer); wallClockTimer = null; }
            if (attemptIdx >= sources.length) {
                finish(() => reject(new ModelError(`all ${sources.length} sources exhausted`, 'DOWNLOAD_FAILED', 502)));
                return;
            }
            const url = sources[attemptIdx++];
            const tmpPath = destPath + '.partial';
            try { fs.unlinkSync(tmpPath); } catch {}
            const out = fs.createWriteStream(tmpPath, { flags: 'w' });
            const hash = crypto.createHash('sha256');
            let bytesReceived = 0;
            let timedOut = false;
            // Guard: exactly one terminal transition per attempt. Node can emit
            // several 'data' events (and then 'error' from req.destroy(), and
            // 'close') after we've decided to abandon this source. Without this
            // flag each of those would setImmediate(tryNext), running multiple
            // concurrent attempts — skipping sources and racing to write the same
            // tmpPath. advance() de-dups: the first caller schedules tryNext, the
            // rest are no-ops.
            let attemptSettled = false;
            const advance = () => {
                if (attemptSettled) return;
                attemptSettled = true;
                setImmediate(tryNext);
            };

            const req = https.get(url, { timeout: 30 * 1000 }, (res) => {
                // Follow up to MAX_REDIRECTS_PER_SOURCE redirects (HF + S3
                // commonly redirect). After the cap, give up and try the
                // next source. Without the cap, a redirect loop would hang
                // this Promise forever.
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    out.destroy();
                    try { fs.unlinkSync(tmpPath); } catch {}
                    redirectsForThisSource++;
                    if (redirectsForThisSource > MAX_REDIRECTS_PER_SOURCE) {
                        // Too many redirects from this source; skip to next.
                        redirectsForThisSource = 0;
                        res.resume();
                        advance();
                        return;
                    }
                    // Resolve the redirect target against the current URL so a
                    // relative Location header (RFC 7231 allows them) works, and
                    // RE-VALIDATE that it is still https. The manifest validator
                    // enforces https on the declared sources; a redirect must not
                    // be a hole in that invariant — a compromised mirror could
                    // otherwise bounce us to http:// (downgrade) or another scheme.
                    // Content is still hash-checked at finish, but we refuse the
                    // downgrade outright rather than depending solely on that.
                    let redirectUrl;
                    try {
                        redirectUrl = new URL(res.headers.location, url).toString();
                    } catch {
                        // Unparseable Location — abandon this source.
                        redirectsForThisSource = 0;
                        res.resume();
                        advance();
                        return;
                    }
                    if (new URL(redirectUrl).protocol !== 'https:') {
                        // Non-https redirect target — skip this source entirely.
                        redirectsForThisSource = 0;
                        res.resume();
                        advance();
                        return;
                    }
                    // Replace source with redirect target and re-attempt the same slot
                    sources[attemptIdx - 1] = redirectUrl;
                    attemptIdx--;
                    res.resume();
                    advance();
                    return;
                }
                // Non-redirect response: reset the per-source redirect counter
                // before attempting the next source (or proceeding with this one).
                redirectsForThisSource = 0;
                if (res.statusCode !== 200) {
                    out.destroy();
                    try { fs.unlinkSync(tmpPath); } catch {}
                    res.resume();
                    advance();
                    return;
                }
                res.on('data', chunk => {
                    if (attemptSettled) return;
                    bytesReceived += chunk.length;
                    if (bytesReceived > expectedSize) {
                        timedOut = true;
                        req.destroy();
                        out.destroy();
                        try { fs.unlinkSync(tmpPath); } catch {}
                        advance();
                        return;
                    }
                    hash.update(chunk);
                });
                res.pipe(out);
                out.on('finish', () => {
                    if (timedOut || attemptSettled) return;
                    if (bytesReceived !== expectedSize) {
                        try { fs.unlinkSync(tmpPath); } catch {}
                        advance();
                        return;
                    }
                    const actualSha = hash.digest('hex');
                    if (actualSha !== expectedSha256) {
                        try { fs.unlinkSync(tmpPath); } catch {}
                        advance();
                        return;
                    }
                    // Verified; move to final. Mark settled so a late error/close
                    // event can't also advance after we've already resolved.
                    attemptSettled = true;
                    fs.renameSync(tmpPath, destPath);
                    finish(() => resolve({ url, bytesReceived, sha256: actualSha }));
                });
                out.on('error', () => {
                    try { fs.unlinkSync(tmpPath); } catch {}
                    advance();
                });
            });

            req.on('timeout', () => {
                req.destroy();
                out.destroy();
                try { fs.unlinkSync(tmpPath); } catch {}
                advance();
            });
            req.on('error', () => {
                out.destroy();
                try { fs.unlinkSync(tmpPath); } catch {}
                advance();
            });

            // Hard wall-clock cap. The timer is stored on the closure so
            // success / failure paths can cancel it via finish().
            wallClockTimer = setTimeout(() => {
                if (!done && !timedOut) {
                    timedOut = true;
                    req.destroy();
                    out.destroy();
                    try { fs.unlinkSync(tmpPath); } catch {}
                    advance();
                }
            }, DOWNLOAD_TIMEOUT_MS);
        }

        tryNext();
    });
}

// ── Path safety ──────────────────────────────────────────────────────────────

function modelDirFor(manifestHash) {
    if (!SHA256_HEX.test(manifestHash)) {
        throw new ModelError('manifest hash must be 64 lowercase hex chars', 'BAD_REQUEST', 400);
    }
    return path.join(MODELS_DIR, manifestHash);
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

// ── Public handlers ──────────────────────────────────────────────────────────

// Model operations are host-wide — they affect every tenant on the box.
// Same scope discipline as dnf: only the _host channel may invoke them.
// Safebox's M-of-N gate runs before the call.
function requireHostScope(req, opName) {
    if (!req || typeof req !== 'object' || req.managedContainer !== '_host') {
        throw new ModelError(
            `${opName} is host-wide and may only be invoked by managedContainer '_host'`,
            'FORBIDDEN_ACTION', 403);
    }
}

// POST /models — install (download + verify + materialize) a model from a manifest
//   request body: { managedContainer: '_host', manifestHash, manifest }
//   - managedContainer MUST be '_host' (enforced at the wire)
//   - manifestHash MUST equal sha256(canonicalize(manifest))
//   - All files in manifest are downloaded, sha-verified, then atomically
//     moved into /srv/safebox/models/<manifestHash>/
//   - If any file fails to verify or download, the entire install rolls
//     back and nothing is left in the active models directory.
//   - Idempotent: if a model with the same manifestHash is already installed
//     and passes verification, returns ALREADY_INSTALLED without re-downloading.
async function handleInstall(req) {
    requireHostScope(req, 'POST /models');
    if (typeof req.manifestHash !== 'string' || !SHA256_HEX.test(req.manifestHash)) {
        throw new ModelError('manifestHash must be 64 lowercase hex chars', 'BAD_REQUEST', 400);
    }
    if (!req.manifest || typeof req.manifest !== 'object') {
        throw new ModelError('manifest must be an object', 'BAD_REQUEST', 400);
    }
    validateManifest(req.manifest);

    // Pin: the hash MUST be computable from the manifest. This is what makes
    // the manifest itself the unit of governance — a different hash means a
    // different manifest means a different Safebox signature.
    const computedHash = computeManifestHash(req.manifest);
    if (computedHash !== req.manifestHash) {
        throw new ModelError(
            `manifestHash does not match canonical hash of manifest (expected ${computedHash}, got ${req.manifestHash})`,
            'MANIFEST_HASH_MISMATCH', 400);
    }

    const targetDir = modelDirFor(req.manifestHash);
    if (fs.existsSync(targetDir)) {
        // Already installed; verify before claiming idempotent success
        const verifyResult = verifyInstalledModel(req.manifestHash, req.manifest);
        if (verifyResult.ok) {
            return { status: 'ok', data: { manifestHash: req.manifestHash, alreadyInstalled: true } };
        }
        // Otherwise the on-disk install is corrupt; remove and reinstall
        fs.rmSync(targetDir, { recursive: true, force: true });
    }

    ensureDir(STAGING_DIR);
    // Use a fresh random suffix (not just pid) so two concurrent /models/install
    // requests for the SAME manifestHash don't trample each other's staging dirs.
    // The two installs both proceed to completion; whichever calls renameSync
    // first wins, the other's rename throws EEXIST and gets cleaned up below.
    const stagingDir = path.join(STAGING_DIR,
        req.manifestHash + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex'));
    // No need for rmSync — fresh random suffix means stagingDir cannot exist
    ensureDir(stagingDir);

    const downloaded = [];
    try {
        // Write the manifest itself into the staging dir, hashed by its own hash
        fs.writeFileSync(path.join(stagingDir, 'manifest.json'),
            canonicalize(req.manifest), { mode: 0o644 });

        // Download each file
        for (const f of req.manifest.files) {
            const destPath = path.join(stagingDir, f.path);
            const subdir = path.dirname(destPath);
            if (subdir !== stagingDir) ensureDir(subdir);
            const result = await downloadWithFallback([...f.sources], destPath, f.sizeBytes, f.sha256);
            downloaded.push({ path: f.path, sha256: result.sha256, sourceUsed: result.url });
        }

        // Atomic move: staging -> final. If targetDir was created by a racing
        // installer in the meantime, rename fails — and because both installs
        // are for the SAME manifestHash, the racer's directory is by definition
        // the model we were about to produce. Treat that as success.
        ensureDir(MODELS_DIR);
        try {
            fs.renameSync(stagingDir, targetDir);
        } catch (e) {
            // ENOTEMPTY / EEXIST: another installer for the same hash won the race.
            // On Linux renaming a dir onto a non-empty dir yields ENOTEMPTY; onto
            // an empty dir it may yield EEXIST. Either way the winner's install is
            // already at targetDir. Clean up our staging and report idempotent success.
            if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'EPERM') {
                fs.rmSync(stagingDir, { recursive: true, force: true });
                return { status: 'ok', data: { manifestHash: req.manifestHash, alreadyInstalled: true } };
            }
            throw e;
        }
    } catch (e) {
        // Clean up partial staging on any failure
        fs.rmSync(stagingDir, { recursive: true, force: true });
        if (e instanceof ModelError) throw e;
        throw new ModelError(`install failed: ${e.message}`, 'INSTALL_FAILED', 500);
    }

    return {
        status: 'ok',
        data: {
            manifestHash: req.manifestHash,
            name: req.manifest.name,
            version: req.manifest.version,
            license: req.manifest.license,
            runnerType: req.manifest.runnerType,
            installedAt: new Date().toISOString(),
            files: downloaded,
        },
    };
}

// GET /models — list installed models
// Restricted to _host; tenants don't enumerate the model directory.
// The runner processes that consume models read /srv/safebox/models/
// directly from disk; the system endpoint is for Safebox's audit/sync logic.
function handleList(req) {
    requireHostScope(req, 'GET /models');
    if (!fs.existsSync(MODELS_DIR)) return { status: 'ok', data: { models: [] } };
    const entries = fs.readdirSync(MODELS_DIR);
    const out = [];
    for (const e of entries) {
        if (!SHA256_HEX.test(e)) continue;
        const manifestPath = path.join(MODELS_DIR, e, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            out.push({
                manifestHash: e,
                name: m.name,
                version: m.version,
                license: m.license,
                runnerType: m.runnerType,
                totalSizeBytes: m.totalSizeBytes,
            });
        } catch {
            // Skip corrupt manifest entries; report only well-formed ones
        }
    }
    return { status: 'ok', data: { models: out } };
}

// POST /models/<hash>/verify — re-verify SHA-256 of every file on disk
function handleVerify(req, manifestHash) {
    requireHostScope(req, 'POST /models/<hash>/verify');
    if (!SHA256_HEX.test(manifestHash)) {
        throw new ModelError('manifest hash must be 64 lowercase hex chars', 'BAD_REQUEST', 400);
    }
    const dir = modelDirFor(manifestHash);
    if (!fs.existsSync(dir)) {
        throw new ModelError(`model ${manifestHash} not installed`, 'NOT_FOUND', 404);
    }
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new ModelError('installed model is missing its manifest.json', 'CORRUPT_INSTALL', 500);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = verifyInstalledModel(manifestHash, manifest);
    if (!result.ok) {
        return { status: 'error', code: 'VERIFICATION_FAILED', data: result, _http: 409 };
    }
    return { status: 'ok', data: { manifestHash, verifiedAt: new Date().toISOString(), files: result.files } };
}

// POST /models/<hash>/remove — atomically delete an installed model
function handleRemove(req, manifestHash) {
    requireHostScope(req, 'POST /models/<hash>/remove');
    if (!SHA256_HEX.test(manifestHash)) {
        throw new ModelError('manifest hash must be 64 lowercase hex chars', 'BAD_REQUEST', 400);
    }
    const dir = modelDirFor(manifestHash);
    if (!fs.existsSync(dir)) {
        throw new ModelError(`model ${manifestHash} not installed`, 'NOT_FOUND', 404);
    }
    // Move to a temp dir first, then rm. Atomic from the caller's view.
    const trash = path.join(STAGING_DIR, '.trash.' + manifestHash + '.' + Date.now());
    ensureDir(STAGING_DIR);
    fs.renameSync(dir, trash);
    fs.rmSync(trash, { recursive: true, force: true });
    return { status: 'ok', data: { manifestHash, removed: true } };
}

function sha256File(filePath) {
    // Stream the file through the hash in 1 MiB chunks. readFileSync would pull
    // an entire multi-gigabyte weight file into memory at once — a 30-55 GB
    // safetensors shard would OOM the System process. fs.statSync + a read loop
    // keeps memory flat regardless of file size.
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const CHUNK = 1024 * 1024;
        const buf = Buffer.allocUnsafe(CHUNK);
        let bytesRead;
        // eslint-disable-next-line no-cond-assign
        while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
            hash.update(bytesRead === CHUNK ? buf : buf.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function verifyInstalledModel(manifestHash, manifest) {
    const dir = modelDirFor(manifestHash);
    const computedHash = computeManifestHash(manifest);
    if (computedHash !== manifestHash) {
        return { ok: false, reason: 'manifest on disk does not hash to the directory name' };
    }
    const fileResults = [];
    for (const f of manifest.files) {
        const p = path.join(dir, f.path);
        let st;
        try {
            st = fs.statSync(p);
        } catch {
            return { ok: false, reason: `file missing: ${f.path}` };
        }
        if (st.size !== f.sizeBytes) {
            return { ok: false, reason: `${f.path} size mismatch: expected ${f.sizeBytes}, got ${st.size}` };
        }
        const actual = sha256File(p);
        if (actual !== f.sha256) {
            return { ok: false, reason: `${f.path} SHA-256 mismatch: expected ${f.sha256}, got ${actual}` };
        }
        fileResults.push({ path: f.path, sha256: actual });
    }
    return { ok: true, files: fileResults };
}

// Top-level dispatch. All endpoints are POST so that the body carries the
// managedContainer=_host scope assertion uniformly. Listing is a POST too;
// the body is just `{managedContainer: '_host'}`.
async function handle(method, pathname, body) {
    if (method === 'POST' && pathname === '/models/install') {
        return await handleInstall(body);
    }
    if (method === 'POST' && pathname === '/models/list') {
        return handleList(body);
    }
    const verifyMatch = pathname.match(/^\/models\/([0-9a-f]{64})\/verify$/);
    if (method === 'POST' && verifyMatch) {
        return handleVerify(body, verifyMatch[1]);
    }
    const removeMatch = pathname.match(/^\/models\/([0-9a-f]{64})\/remove$/);
    if (method === 'POST' && removeMatch) {
        return handleRemove(body, removeMatch[1]);
    }
    return null; // not a /models route; server.js falls through
}

module.exports = {
    handle,
    // exposed for tests
    _canonicalize: canonicalize,
    _computeManifestHash: computeManifestHash,
    _validateManifest: validateManifest,
};
