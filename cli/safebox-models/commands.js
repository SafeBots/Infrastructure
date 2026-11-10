'use strict';
//
// commands.js — implementations of every safebox-models subcommand.
//
// Each command takes (args, opts) where args is the positional argv after
// the subcommand and opts is the parsed flag dict.
//

const fs   = require('fs');
const path = require('path');
const {
    canonicalize, computeManifestHash, sha256File, walkAndHash, findDuplicatePath,
    fmtBytes, fmtTimestamp, confirm,
    c, logInfo, logOk, logWarn, logErr, logStep,
} = require('./lib/util');
const cat = require('./lib/catalog');
const { ApiClient } = require('./lib/api');

const MODELS_DIR = process.env.SAFEBOX_MODELS_DIR || '/srv/safebox/models';

// ── Helper: build api client from opts ──────────────────────────────────
function newApi(opts) {
    return new ApiClient({
        systemUrl:   opts.systemUrl,
        hmacKeyPath: opts.hmacKeyPath,
    });
}

// ── catalog ─────────────────────────────────────────────────────────────
async function cmdCatalog(args, opts) {
    const items = cat.scanCatalog(opts.infrastructureDir);
    if (opts.json) {
        process.stdout.write(JSON.stringify(items.map(e => ({
            name: e.name, runner: e.runner,
            version: e.manifest.version, vendor: e.manifest.vendor,
            license: e.manifest.license,
            hasInstallManifest: !!e.installManifestPath,
        })), null, 2) + '\n');
        return;
    }
    if (items.length === 0) {
        process.stdout.write('No manifests found.\n');
        return;
    }
    // Group by runner
    const byRunner = {};
    for (const it of items) {
        (byRunner[it.runner] = byRunner[it.runner] || []).push(it);
    }
    process.stdout.write(c.bold('Catalog ') + c.dim('(in ' + (opts.infrastructureDir || cat.defaultInfraDir()) + ')') + '\n');
    for (const r of Object.keys(byRunner).sort()) {
        process.stdout.write('\n  ' + c.cyan(r) + ':\n');
        for (const it of byRunner[r]) {
            const m = it.manifest;
            const lic = m.license || '(unknown license)';
            const flag = it.installManifestPath ? c.green('●') : c.dim('○');
            process.stdout.write(`    ${flag} ${c.bold(it.name.padEnd(28))} ${(m.vendor || '').padEnd(16)} ${c.dim(lic)}\n`);
        }
    }
    process.stdout.write('\n' + c.dim('  ● install manifest present     ○ runner manifest only') + '\n');
}

// ── show ─────────────────────────────────────────────────────────────────
async function cmdShow(args, opts) {
    if (args.length === 0) throw new Error('Usage: safebox-models show <name>');
    const e = cat.findByName(opts.infrastructureDir, args[0]);
    if (opts.json) {
        process.stdout.write(JSON.stringify(e, null, 2) + '\n');
        return;
    }
    const m = e.manifest;
    process.stdout.write('\n' + c.bold(e.name) + '\n');
    process.stdout.write(c.dim('  Runner:      ') + e.runner + '\n');
    process.stdout.write(c.dim('  Vendor:      ') + (m.vendor || '?') + '\n');
    process.stdout.write(c.dim('  Version:     ') + (m.version || '?') + '\n');
    process.stdout.write(c.dim('  License:     ') + (m.license || '?') + '\n');
    process.stdout.write(c.dim('  Homepage:    ') + (m.homepage || '?') + '\n');
    process.stdout.write(c.dim('  Manifest:    ') + e.runnerManifestPath + '\n');
    if (e.installManifestPath) {
        process.stdout.write(c.dim('  Install:     ') + e.installManifestPath + '\n');
    } else {
        process.stdout.write(c.dim('  Install:     ') + c.yellow('not yet provided') + '\n');
    }
    if (m.resources) {
        const r = m.resources;
        process.stdout.write(c.dim('  GPU:         ') + (r.recommendedGpu || '?') + '\n');
        process.stdout.write(c.dim('  Min VRAM:    ') + (r.minGpuMemoryGb != null ? r.minGpuMemoryGb + ' GB' : '?') + '\n');
        if (r.diskSizeGb) {
            process.stdout.write(c.dim('  Disk:        ') + r.diskSizeGb + ' GB\n');
        }
    }
    if (m.notes) {
        process.stdout.write('\n' + c.dim('  Notes:') + '\n');
        for (const line of String(m.notes).split('\n')) {
            process.stdout.write(c.dim('    ' + line) + '\n');
        }
    }
}

// ── list ─────────────────────────────────────────────────────────────────
async function cmdList(args, opts) {
    if (opts.local) {
        // Read from /srv/safebox/models/ directly
        if (!fs.existsSync(MODELS_DIR)) {
            process.stdout.write('No models installed.\n');
            return;
        }
        const out = [];
        for (const entry of fs.readdirSync(MODELS_DIR)) {
            if (!/^[0-9a-f]{64}$/.test(entry)) continue;
            const mpath = path.join(MODELS_DIR, entry, 'manifest.json');
            if (!fs.existsSync(mpath)) continue;
            try {
                const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
                out.push({ manifestHash: entry, ...m });
            } catch { /* skip corrupt */ }
        }
        if (opts.json) {
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
            return;
        }
        renderInstalled(out);
        return;
    }
    // Talk to the system component
    const api = newApi(opts);
    const r = await api.list();
    if (r.status !== 200) {
        throw new Error(`/models/list failed: ${r.status} ${JSON.stringify(r.data)}`);
    }
    const models = (r.data && r.data.data && r.data.data.models) || [];
    if (opts.json) {
        process.stdout.write(JSON.stringify(models, null, 2) + '\n');
        return;
    }
    renderInstalled(models);
}

function renderInstalled(models) {
    if (models.length === 0) {
        process.stdout.write('No models installed.\n');
        return;
    }
    process.stdout.write(c.bold('Installed models') + '\n\n');
    for (const m of models) {
        const size = m.totalSizeBytes ? fmtBytes(m.totalSizeBytes) : '?';
        process.stdout.write(
            `  ${c.bold((m.name || '?').padEnd(32))} `
          + `${c.dim(m.runnerType || '?')} `
          + `${size.padStart(10)} `
          + `${c.dim(m.license || '')} `
          + `${c.dim(m.manifestHash ? m.manifestHash.slice(0,12) + '…' : '')}\n`);
    }
}

// ── install ──────────────────────────────────────────────────────────────
async function cmdInstall(args, opts) {
    if (args.length === 0) throw new Error('Usage: safebox-models install <name> [--local|--install-manifest <path>]');
    const name = args[0];
    const entry = cat.findByName(opts.infrastructureDir, name);

    logStep(`Install: ${entry.name}`);
    logInfo(`Runner manifest: ${entry.runnerManifestPath}`);

    if (opts.local) {
        return cmdInstallLocal(entry, opts);
    }

    // Production path: read install manifest, validate, sign, POST to System
    let installManifest;
    try {
        installManifest = cat.readInstallManifest(entry, opts.installManifest);
    } catch (e) {
        logErr(e.message);
        process.exit(2);
    }

    // Compute the manifest hash. This MUST match what the System component computes.
    const manifestHash = computeManifestHash(installManifest);
    logInfo(`Manifest hash: ${manifestHash}`);

    // Summarize what's about to happen
    const totalSize = installManifest.totalSizeBytes;
    const fileCount = installManifest.files && installManifest.files.length;
    process.stderr.write('\n');
    process.stderr.write('  Files:       ' + (fileCount != null ? fileCount : '?') + '\n');
    process.stderr.write('  Total size:  ' + (totalSize != null ? fmtBytes(totalSize) : '?') + '\n');
    process.stderr.write('  License:     ' + (installManifest.license || '?') + '\n');
    process.stderr.write('  Will be installed to: ' + path.join(MODELS_DIR, manifestHash) + '\n');
    process.stderr.write('\n');

    if (!opts.yes) {
        const ok = await confirm('Proceed with install?');
        if (!ok) {
            logWarn('Aborted by user.');
            process.exit(1);
        }
    }

    const api = newApi(opts);
    logInfo('Sending signed install request to System component...');
    const r = await api.install(installManifest, manifestHash);

    if (r.status === 200 && r.data && r.data.status === 'ok') {
        const d = r.data.data || {};
        if (d.alreadyInstalled) {
            logOk(`Already installed (idempotent): ${manifestHash}`);
        } else {
            logOk(`Installed: ${manifestHash}`);
            logInfo('Installed at: ' + path.join(MODELS_DIR, manifestHash));
            logInfo('Files verified: ' + ((d.files && d.files.length) || '?'));
        }
        // Stage the runner manifest into /etc/safebox/runners/<runner>/manifests/
        stageRunnerManifest(entry, opts);
        return;
    }

    logErr(`Install failed: ${r.status} ${JSON.stringify(r.data)}`);
    process.exit(1);
}

async function cmdInstallLocal(entry, opts) {
    logWarn('Local mode: System component will NOT be contacted.');
    logInfo('Weights are expected to be pre-staged. See README for instructions.');
    logInfo('Only the runner manifest will be staged.');
    if (!opts.yes) {
        const ok = await confirm('Proceed?');
        if (!ok) {
            logWarn('Aborted.');
            process.exit(1);
        }
    }
    stageRunnerManifest(entry, opts);
}

function stageRunnerManifest(entry, opts) {
    const runnerCfgDir = process.env.SAFEBOX_RUNNER_CONFIG_DIR
        || path.join('/etc/safebox/runners', entry.runner, 'manifests');
    try {
        fs.mkdirSync(runnerCfgDir, { recursive: true });
        const dest = path.join(runnerCfgDir, entry.name + '.json');
        fs.copyFileSync(entry.runnerManifestPath, dest);
        logOk(`Staged runner manifest at ${dest}`);
        logInfo('Start the runner with MODEL_NAME=' + entry.name);
    } catch (e) {
        logWarn(`Could not stage runner manifest at ${runnerCfgDir}: ${e.message}`);
        logInfo('(This is expected when running without root. The system component would handle this in production.)');
    }
}

// ── verify ───────────────────────────────────────────────────────────────
async function cmdVerify(args, opts) {
    if (args.length === 0) throw new Error('Usage: safebox-models verify <name|manifestHash>');
    const arg = args[0];

    if (opts.local) {
        // Local verify — read manifest from disk and re-hash every file
        return cmdVerifyLocal(arg, opts);
    }

    // Resolve name to hash via catalog if it's not already a hash
    let hash;
    if (/^[0-9a-f]{64}$/.test(arg)) {
        hash = arg;
    } else {
        const entry = cat.findByName(opts.infrastructureDir, arg);
        const installManifest = cat.readInstallManifest(entry, opts.installManifest);
        hash = computeManifestHash(installManifest);
    }
    logInfo(`Verifying ${hash}`);
    const api = newApi(opts);
    const r = await api.verify(hash);
    if (r.status === 200 && r.data && r.data.status === 'ok') {
        const d = r.data.data || {};
        logOk(`Verified: ${hash}`);
        if (d.files) {
            logInfo(`${d.files.length} files OK`);
        }
        return;
    }
    logErr(`Verify failed: ${r.status} ${JSON.stringify(r.data)}`);
    process.exit(1);
}

async function cmdVerifyLocal(arg, opts) {
    // Find the hash dir locally
    if (!fs.existsSync(MODELS_DIR)) {
        logErr(`Models directory not found: ${MODELS_DIR}`);
        process.exit(2);
    }
    const candidates = /^[0-9a-f]{64}$/.test(arg)
        ? [arg]
        : fs.readdirSync(MODELS_DIR).filter(d => {
            const mpath = path.join(MODELS_DIR, d, 'manifest.json');
            if (!fs.existsSync(mpath)) return false;
            try { return JSON.parse(fs.readFileSync(mpath)).name === arg; } catch { return false; }
        });
    if (candidates.length === 0) {
        logErr(`No installed model matches '${arg}'`);
        process.exit(2);
    }
    for (const hash of candidates) {
        const dir = path.join(MODELS_DIR, hash);
        const mpath = path.join(dir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
        logStep(`Verifying ${manifest.name} (${hash.slice(0, 12)}…)`);
        // Re-hash and compare to manifest
        const computed = computeManifestHash(manifest);
        if (computed !== hash) {
            logErr('Directory name does not match canonical manifest hash');
            process.exit(1);
        }
        logOk('Manifest hash matches directory name');
        // A duplicate path means the file list attests to more distinct files
        // than exist on disk. The System component now rejects such manifests
        // at install; a model installed before that fix could still be on disk,
        // so we check here too and fail the verify.
        const dupPath = findDuplicatePath(manifest.files);
        if (dupPath) {
            logErr(`Manifest contains duplicate path '${dupPath}' — file list does not correspond to distinct on-disk files`);
            process.exit(1);
        }
        let allOk = true;
        for (const f of manifest.files || []) {
            const fp = path.join(dir, f.path);
            if (!fs.existsSync(fp)) { logErr(`Missing: ${f.path}`); allOk = false; continue; }
            const actual = await sha256File(fp);
            if (actual !== f.sha256) {
                logErr(`SHA-256 mismatch: ${f.path}\n      expected ${f.sha256}\n      got      ${actual}`);
                allOk = false;
            } else {
                logOk(f.path);
            }
        }
        if (!allOk) process.exit(1);
        logOk(`${manifest.name} verified.`);
    }
}

// ── remove ──────────────────────────────────────────────────────────────
async function cmdRemove(args, opts) {
    if (args.length === 0) throw new Error('Usage: safebox-models remove <name|manifestHash>');
    const arg = args[0];

    let hash;
    if (/^[0-9a-f]{64}$/.test(arg)) {
        hash = arg;
    } else {
        // Look up hash from catalog
        const entry = cat.findByName(opts.infrastructureDir, arg);
        const installManifest = cat.readInstallManifest(entry, opts.installManifest);
        hash = computeManifestHash(installManifest);
    }

    if (!opts.yes) {
        const ok = await confirm(`Remove model ${arg} (${hash.slice(0, 12)}…)?`);
        if (!ok) { logWarn('Aborted.'); process.exit(1); }
    }

    if (opts.local) {
        const dir = path.join(MODELS_DIR, hash);
        if (!fs.existsSync(dir)) { logErr(`Not installed: ${hash}`); process.exit(2); }
        fs.rmSync(dir, { recursive: true, force: true });
        logOk(`Removed ${hash}`);
        return;
    }

    const api = newApi(opts);
    const r = await api.remove(hash);
    if (r.status === 200 && r.data && r.data.status === 'ok') {
        logOk(`Removed ${hash}`);
        return;
    }
    logErr(`Remove failed: ${r.status} ${JSON.stringify(r.data)}`);
    process.exit(1);
}

// ── doctor ──────────────────────────────────────────────────────────────
// Diagnose common setup issues — useful first-thing-to-run for new operators.
async function cmdDoctor(args, opts) {
    logStep('safebox-models doctor');

    // 1. Can we find the Infrastructure repo?
    const infraDir = opts.infrastructureDir || cat.defaultInfraDir();
    if (!fs.existsSync(path.join(infraDir, 'model-runners'))) {
        logErr(`Infrastructure repo not found at ${infraDir} (no model-runners/)`);
    } else {
        logOk(`Infrastructure repo: ${infraDir}`);
    }

    // 2. Can we scan the catalog?
    let catalog = [];
    try {
        catalog = cat.scanCatalog(infraDir);
        logOk(`Catalog scan: ${catalog.length} manifests found`);
    } catch (e) {
        logErr(`Catalog scan failed: ${e.message}`);
    }

    // 3. Which manifests have install manifests?
    const withInstall = catalog.filter(e => e.installManifestPath).length;
    if (withInstall === catalog.length) {
        logOk(`All ${catalog.length} catalog entries have install manifests`);
    } else {
        logWarn(`${catalog.length - withInstall} catalog entries lack install manifests`);
        logInfo('Production install requires these. Local install (--local) does not.');
    }

    // 4. Models dir exists and is writable (for local mode)?
    if (fs.existsSync(MODELS_DIR)) {
        logOk(`Models directory exists: ${MODELS_DIR}`);
        try {
            fs.accessSync(MODELS_DIR, fs.constants.R_OK);
            logOk(`Models directory is readable`);
        } catch {
            logWarn(`Models directory exists but is not readable to the current user`);
        }
    } else {
        logWarn(`Models directory does not exist: ${MODELS_DIR}`);
        logInfo('Will be created on first --local install.');
    }

    // 5. HMAC key?
    const keyPath = opts.hmacKeyPath || process.env.SAFEBOX_HMAC_KEY || '/etc/safebox/system.hmac';
    if (fs.existsSync(keyPath)) {
        logOk(`HMAC key present at ${keyPath}`);
    } else {
        logWarn(`HMAC key not found at ${keyPath}`);
        logInfo('Local mode (--local) does not require it. Production install does.');
    }

    // 6. System component reachable?
    const api = newApi(opts);
    logInfo('Probing System component at ' + api.baseUrl + ' ...');
    const ping = await api.ping();
    if (ping.ok) {
        logOk('System component reachable');
    } else {
        logWarn(`System component not reachable: ${ping.error || ping.status}`);
        logInfo('Local mode (--local) works without it.');
    }

    process.stderr.write('\n');
    if (catalog.length > 0) {
        logInfo('Ready. Try: safebox-models catalog');
    }
}

// ── make-install-manifest helper ──────────────────────────────────────────
// Walks a directory of weight files, computes SHA-256, emits a skeleton
// install manifest the operator can edit (adding sources URLs) and commit
// next to the runner manifest.
async function cmdMakeInstallManifest(args, opts) {
    if (args.length < 2) {
        throw new Error('Usage: safebox-models make-install-manifest <name> <weights-directory>');
    }
    const name = args[0];
    const weightsDir = path.resolve(args[1]);
    if (!fs.existsSync(weightsDir) || !fs.statSync(weightsDir).isDirectory()) {
        throw new Error(`Not a directory: ${weightsDir}`);
    }
    const entry = cat.findByName(opts.infrastructureDir, name);
    logStep(`Building install manifest for ${name}`);
    logInfo(`Hashing files in ${weightsDir}...`);
    const files = await walkAndHash(weightsDir);
    const totalSize = files.reduce((a, f) => a + f.sizeBytes, 0);
    logOk(`Hashed ${files.length} files, total ${fmtBytes(totalSize)}`);

    const m = entry.manifest;
    const installManifest = {
        name:           name,
        version:        m.version    || '1.0',
        license:        m.license    || 'unspecified',
        runnerType:     entry.runner,
        totalSizeBytes: totalSize,
        files: files.map(f => ({
            path:      f.path,
            sizeBytes: f.sizeBytes,
            sha256:    f.sha256,
            sources:   ['https://CHANGE-ME.example.com/' + f.path],
        })),
    };
    const outPath = entry.runnerManifestPath.replace(/\.json$/, '.install.json');
    fs.writeFileSync(outPath, JSON.stringify(installManifest, null, 2) + '\n');
    logOk(`Wrote ${outPath}`);
    logInfo('Edit the `sources` arrays before checking in or signing.');
    logInfo('The Safebox M-of-N signers approve the manifest as a whole; ');
    logInfo('the hash is computed by canonicalizing this exact JSON.');
    const hash = computeManifestHash(installManifest);
    logInfo(`Computed manifest hash: ${hash}`);
}

// ── fetch-install-manifest ─────────────────────────────────────────────
// Fetches the file list + LFS SHA-256s from HuggingFace's API for the
// runner manifest's huggingfaceModel id (looked up from the runner manifest
// or passed via --huggingface). Writes a real install manifest to disk that
// the operator can review, commit, and have the M-of-N signers approve.
//
// This is the right architecture for install manifests: they DON'T live
// statically in the repo (where they'd go stale within months as upstream
// repos add/remove files), they get materialized from the upstream source
// of truth on demand.
//
// HF API shape (with ?expand=true):
//   GET https://huggingface.co/api/models/<repo>/tree/main?expand=true
//   Returns: [
//     { path: 'config.json', size: 1234, type: 'file',
//       lfs: null  (regular git file)  },
//     { path: 'model.safetensors', size: 1638400000, type: 'file',
//       lfs: { oid: '...', size: ..., pointerSize: ... }  },
//     ...
//   ]
// For LFS files, lfs.oid is the SHA-256 of the actual file content.
// For non-LFS files, we'd need to download and hash separately — they're
// usually small text files (configs, tokenizer JSON, READMEs).
//
async function cmdFetchInstallManifest(args, opts) {
    if (args.length === 0) {
        throw new Error('Usage: safebox-models fetch-install-manifest <name> [--huggingface <repo>] [--revision <branch-or-commit>]');
    }
    const name = args[0];
    const entry = cat.findByName(opts.infrastructureDir, name);
    const m = entry.manifest;

    // Resolve the HF repo. Check (in order):
    //   1. --huggingface CLI flag (already in opts as opts.huggingface? we add below)
    //   2. The runner manifest's huggingfaceRepo field (the standard place)
    //   3. The first looking-like-an-HF-id field across known runner-specific blocks
    let hfRepo = opts.huggingface
              || m.huggingfaceRepo
              || (m.kokoro && m.kokoro.huggingfaceRepo)
              || (m.stableAudio && m.stableAudio.huggingfaceModel)
              || (m.ltxVideo && m.ltxVideo.huggingfaceModel)
              || (m.wanVideo && m.wanVideo.huggingfaceModel)
              || (m.triposr && m.triposr.huggingfaceModel)
              || (m.vllm && m.vllm.huggingfaceModel)
              || (m.whisper && m.whisper.huggingfaceModel)
              || (m.comfyui && m.comfyui.huggingfaceModel);

    if (!hfRepo) {
        // Best-effort guess from the homepage URL
        if (m.homepage && /huggingface\.co\/([^/]+\/[^/?#]+)/.test(m.homepage)) {
            hfRepo = m.homepage.match(/huggingface\.co\/([^/]+\/[^/?#]+)/)[1];
            logInfo(`Guessed HF repo from homepage: ${hfRepo}`);
        } else {
            throw new Error(
                `No HuggingFace repo known for '${name}'. `
              + `Add it to the runner manifest as huggingfaceRepo, `
              + `or pass --huggingface <user/repo>.`);
        }
    }

    const revision = opts.revision || 'main';
    logStep(`Fetching file metadata for ${hfRepo}@${revision}`);
    logInfo(`API: https://huggingface.co/api/models/${hfRepo}/tree/${revision}?expand=true`);

    const tree = await fetchHfTree(hfRepo, revision);

    // Convert HF tree response to Safebox install-manifest files[]
    const files = [];
    let smallFileMissing = 0;
    for (const entry of tree) {
        if (entry.type !== 'file') continue;  // skip directories
        const sha = entry.lfs && entry.lfs.oid
                  ? entry.lfs.oid
                  : null;
        if (!sha) smallFileMissing++;
        files.push({
            path:      entry.path,
            sizeBytes: entry.size || 0,
            sha256:    sha || '__NEEDS_DOWNLOAD_AND_HASH__',
            sources:   [`https://huggingface.co/${hfRepo}/resolve/${revision}/${entry.path}`],
        });
    }

    if (files.length === 0) {
        throw new Error(`HF API returned no files for ${hfRepo}@${revision}`);
    }
    const dupPath = findDuplicatePath(files);
    if (dupPath) {
        // The HF tree API should never return two entries with the same path,
        // but a compromised or buggy mirror could. Refuse to write a manifest
        // the System component would reject at install time.
        throw new Error(
            `HF tree for ${hfRepo}@${revision} contains a duplicate path '${dupPath}'. `
          + `Refusing to build a manifest — duplicate paths break hash attestation.`);
    }
    const totalSize = files.reduce((a, f) => a + f.sizeBytes, 0);
    const lfsCount = files.filter(f => f.sha256 !== '__NEEDS_DOWNLOAD_AND_HASH__').length;
    logOk(`${files.length} files, ${fmtBytes(totalSize)}`);
    logOk(`${lfsCount} LFS files have SHA-256 from HF API`);
    if (smallFileMissing > 0) {
        logWarn(`${smallFileMissing} non-LFS files need SHA-256 computed locally`);
        logInfo(`After fetch, run: safebox-models make-install-manifest ${name} <dir-with-downloaded-files>`);
        logInfo('to populate the remaining hashes from staged weights.');
    }

    const installManifest = {
        name:           name,
        version:        m.version    || '1.0',
        license:        m.license    || 'unspecified',
        runnerType:     entry.runner,
        totalSizeBytes: totalSize,
        huggingfaceRepo: hfRepo,
        revision:       revision,
        files:          files,
    };

    const outPath = entry.runnerManifestPath.replace(/\.json$/, '.install.json');
    fs.writeFileSync(outPath, JSON.stringify(installManifest, null, 2) + '\n');
    logOk(`Wrote ${outPath}`);

    const hash = computeManifestHash(installManifest);
    logInfo(`Computed manifest hash: ${hash}`);
    logInfo('Have your M-of-N signers approve this hash before production install.');
    if (smallFileMissing > 0) {
        logWarn('NOTE: This manifest is NOT yet installable. '
              + `${smallFileMissing} files have __NEEDS_DOWNLOAD_AND_HASH__ placeholder.`);
    }
}

// HF API helper — fetches /api/models/<repo>/tree/<rev>?expand=true
// Uses Node's built-in https module to keep zero npm deps.
async function fetchHfTree(hfRepo, revision) {
    const https = require('https');
    const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MiB — HF tree JSON is large for big repos but bounded
    const REQUEST_TIMEOUT_MS = 30 * 1000;
    const MAX_REDIRECTS = 5;

    function getOnce(url, redirectsLeft) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: { 'User-Agent': 'safebox-models/1.0', 'Accept': 'application/json' },
                timeout: REQUEST_TIMEOUT_MS,
            }, (res) => {
                // Follow redirects (up to MAX_REDIRECTS) with a proper status check
                // at every hop. The previous version followed exactly one redirect
                // and never checked the post-redirect status, so a 404 error page
                // after a redirect would be JSON.parse'd as if it were the tree.
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // drain
                    if (redirectsLeft <= 0) return reject(new Error('too many redirects from HF'));
                    let next;
                    try { next = new URL(res.headers.location, url).toString(); }
                    catch { return reject(new Error('HF redirect with unparseable location')); }
                    if (new URL(next).protocol !== 'https:') return reject(new Error('HF redirect to non-https'));
                    resolve(getOnce(next, redirectsLeft - 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HF API returned ${res.statusCode} for ${hfRepo}@${revision}`));
                }
                let body = '';
                let bytes = 0;
                let aborted = false;
                res.on('data', c => {
                    if (aborted) return;
                    bytes += c.length;
                    if (bytes > MAX_RESPONSE_BYTES) {
                        aborted = true;
                        req.destroy();
                        reject(new Error(`HF API response exceeded ${MAX_RESPONSE_BYTES} bytes`));
                        return;
                    }
                    body += c;
                });
                res.on('end', () => {
                    if (aborted) return;
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error(`HF API parse error: ${e.message}`)); }
                });
            });
            req.on('timeout', () => { req.destroy(new Error(`HF API request timed out after ${REQUEST_TIMEOUT_MS}ms`)); });
            req.on('error', reject);
        });
    }

    const url = `https://huggingface.co/api/models/${hfRepo}/tree/${revision}?expand=true`;
    return getOnce(url, MAX_REDIRECTS);
}


module.exports = {
    cmdCatalog,
    cmdShow,
    cmdList,
    cmdInstall,
    cmdVerify,
    cmdRemove,
    cmdDoctor,
    cmdMakeInstallManifest,
    cmdFetchInstallManifest,
};
