// opsArtifacts.js
//
// Unified dispatcher for hash-allowlisted artifact installs across all kinds:
// models, RPMs, npm packages, pip packages, HuggingFace files, custom binaries.
//
// This file is the entry point for every install action received from the
// Safebox plugin. It performs the shared work (manifest validation, hash
// verification, atomic install) and dispatches to a kind-specific install
// step for the bytes-to-disk part.
//
// The shared work lives in opsModels.js (canonical JSON, manifest hash,
// per-file download with sha256 verification). We re-export those primitives
// and call them from each kind handler. This preserves the existing
// model-install path bit-for-bit while extending the trust property to all
// other artifact kinds.
//
// See docs/INDUCTIVE-TRUST.md for the auditor-facing statement of the
// trust property this module maintains, and docs/ARTIFACT-UPDATES.md for
// the operational workflow this module supports.
//
// ARCHITECTURE
// ────────────
// 1. Safebox sends POST /artifacts/install with the signed manifest and
//    the verifiedOpToken. The manifest's `kind` field tells the dispatcher
//    which install path to take.
// 2. validateManifest() runs (from opsModels) — schema check, hash format,
//    size sums, sources are HTTPS, etc. Same validator for every kind.
// 3. computeManifestHash() produces the canonical RFC 8785 hash. This is
//    what the M-of-N signatures attest to. The dispatcher will refuse to
//    proceed if this hash doesn't match the action's Safebox/sha256.
// 4. downloadWithFallback() pulls each file from sources[] in order,
//    verifies sha256 (and optional npm-native integrity), and stages
//    the file. Same downloader for every kind.
// 5. Kind-specific install step takes the verified staged files and
//    deposits them in the right place:
//       model    → mv to /srv/safebox/models/<hash>/
//       rpm      → dnf localinstall (sudoers-gated)
//       npm      → tar -xf into /var/lib/safebox/node-runtime/<consumer>/
//       pip      → pip install --require-hashes into venv
//       hf-file  → mv to /srv/safebox/hf-cache/<hash>/
//       binary   → mv to /srv/safebox/binaries/<hash>/ + chmod
//
// All five kinds share steps 1–4. Only step 5 differs.

'use strict';

const opsModels = require('./opsModels');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Re-export shared primitives so callers that import opsArtifacts get
// everything they need without reaching into opsModels.
exports._canonicalize = opsModels._canonicalize;
exports._computeManifestHash = opsModels._computeManifestHash;
exports._validateManifest = opsModels._validateManifest;
exports._downloadWithFallback = opsModels._downloadWithFallback;

// ── handleInstall ────────────────────────────────────────────────────────
// Dispatcher. The Safebox plugin sends this for every artifact kind; the
// `kind` field on the manifest selects the install path.

exports.handleInstall = async function (manifest, verifiedOpToken) {
    // 1. Shared validation. Schema, hashes, sums, sources.
    opsModels._validateManifest(manifest);

    // 2. Verify the manifest hash matches what was signed.
    //    (verifiedOpToken's payload carries the Safebox/sha256.)
    const computed = opsModels._computeManifestHash(manifest);
    if (computed !== verifiedOpToken.manifestHash) {
        throw new opsModels.ModelError(
            'manifest hash mismatch: signed=' + verifiedOpToken.manifestHash +
            ' computed=' + computed,
            'MANIFEST_HASH_MISMATCH',
            400
        );
    }

    // 3. Download and verify every file. Shared downloader; same sha256
    //    check for every kind. npm artifacts additionally have an
    //    integrity field that gets verified by the npm-specific installer
    //    in step 5.
    const stagingDir = await opsModels._stageDownloads(manifest);

    // 4. Dispatch to the kind-specific installer.
    let result;
    try {
        switch (manifest.kind) {
            case 'model':
                result = await opsModels._installModel(manifest, stagingDir);
                break;
            case 'rpm':
                result = await _installRpm(manifest, stagingDir);
                break;
            case 'npm':
                result = await _installNpm(manifest, stagingDir);
                break;
            case 'pip':
                result = await _installPip(manifest, stagingDir);
                break;
            case 'hf-file':
                result = await _installHfFile(manifest, stagingDir);
                break;
            case 'binary':
                result = await _installBinary(manifest, stagingDir);
                break;
            default:
                // Manifests without `kind` are legacy model installs.
                // Treat as model for backwards compat. New manifests
                // must declare kind explicitly.
                result = await opsModels._installModel(manifest, stagingDir);
        }
    } catch (err) {
        // Any failure in the install step removes the staged files so we
        // never leave partial state on disk. The system's running state
        // is unchanged.
        await _cleanupStaging(stagingDir);
        throw err;
    }

    return {
        ok: true,
        kind: manifest.kind || 'model',
        manifestHash: computed,
        installedAt: result.installedAt,
        consumer: manifest.consumer || null,
    };
};

// ── _installRpm ──────────────────────────────────────────────────────────
// dnf localinstall of every verified RPM file. The sudoers entry
// `safebox-system` allows this command; the GPG signature on each RPM
// is also verified by dnf as a second check beyond our sha256.

async function _installRpm(manifest, stagingDir) {
    const rpmFiles = manifest.files.map(f => path.join(stagingDir, f.path));

    // dnf localinstall verifies GPG signatures by default (gpgcheck=1
    // on Amazon Linux 2023). We pass --assumeyes since the M-of-N
    // approval is the consent gate, not an interactive prompt.
    await _execFile('sudo', [
        '/usr/bin/dnf',
        'localinstall',
        '--assumeyes',
        '--quiet',
        ...rpmFiles,
    ], { timeout: 5 * 60 * 1000 });

    return { installedAt: '/var/lib/rpm', method: 'dnf-localinstall' };
}

// ── _installNpm ──────────────────────────────────────────────────────────
// Extract verified .tgz tarballs into a per-consumer node_modules
// directory. We don't shell out to `npm install` because that would
// trigger npm's own resolution (and possibly its own downloads); we
// already verified the bytes and just need them on disk.

async function _installNpm(manifest, stagingDir) {
    const consumer = manifest.consumer || 'default';
    const consumerDir = `/var/lib/safebox/node-runtime/${_sanitize(consumer)}/node_modules`;
    await fs.promises.mkdir(consumerDir, { recursive: true });

    for (const file of manifest.files) {
        const tarball = path.join(stagingDir, file.path);

        // Optional: verify npm-native integrity (sha512 base64) in
        // addition to the sha256 we already checked. Both must match.
        if (file.integrity) {
            await _verifyNpmIntegrity(tarball, file.integrity);
        }

        // npm tarballs unpack to a `package/` directory; rename to
        // the package's name as it would appear in node_modules.
        const targetDir = path.join(consumerDir, manifest.name);
        await _extractTarball(tarball, targetDir);
    }

    return { installedAt: consumerDir, method: 'tarball-extract' };
}

// ── _installPip ──────────────────────────────────────────────────────────
// pip install --require-hashes into a per-consumer venv. We generate a
// minimal requirements.txt from the manifest and run pip against it.

async function _installPip(manifest, stagingDir) {
    const consumer = manifest.consumer || 'default';
    const venvDir = `/var/lib/safebox/python-runtime/${_sanitize(consumer)}/venv`;

    // Ensure the venv exists.
    if (!fs.existsSync(venvDir)) {
        await _execFile('/usr/bin/python3', ['-m', 'venv', venvDir]);
    }

    // Write a requirements.txt that references the local wheels by
    // path and pins their hashes. pip --require-hashes verifies on
    // install, giving a second hash check after our sha256.
    const reqLines = manifest.files.map(f =>
        `${path.join(stagingDir, f.path)} \\\n  --hash=sha256:${f.sha256}`
    );
    const reqPath = path.join(stagingDir, 'requirements.txt');
    await fs.promises.writeFile(reqPath, reqLines.join('\n') + '\n');

    await _execFile(`${venvDir}/bin/pip`, [
        'install',
        '--require-hashes',
        '--no-deps',
        '--quiet',
        '-r', reqPath,
    ], { timeout: 10 * 60 * 1000 });

    return { installedAt: venvDir, method: 'pip-require-hashes' };
}

// ── _installHfFile ───────────────────────────────────────────────────────
// HuggingFace file that isn't part of a model bundle — e.g., a dataset
// shard, a tokenizer, a reference audio file. Same pattern as model
// install (atomic mv to hash-named directory), different consumer.

async function _installHfFile(manifest, stagingDir) {
    const targetDir = `/srv/safebox/hf-cache/${_computeManifestHash(manifest)}`;
    await _execFile('mv', [stagingDir, targetDir]);
    return { installedAt: targetDir, method: 'hf-cache-atomic' };
}

// ── _installBinary ──────────────────────────────────────────────────────
// Custom binary (a daemon, a CLI tool). Same pattern, chmod +x at end.

async function _installBinary(manifest, stagingDir) {
    const hash = _computeManifestHash(manifest);
    const targetDir = `/srv/safebox/binaries/${hash}`;
    await _execFile('mv', [stagingDir, targetDir]);
    for (const file of manifest.files) {
        await fs.promises.chmod(path.join(targetDir, file.path), 0o755);
    }
    return { installedAt: targetDir, method: 'binary-atomic' };
}

// ── helpers ──────────────────────────────────────────────────────────────

function _execFile(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                err.stdout = stdout;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function _sanitize(s) {
    return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

async function _verifyNpmIntegrity(tarballPath, integrity) {
    // integrity is "sha512-<base64>". Compute the same and compare.
    const crypto = require('crypto');
    const [algo, expected] = integrity.split('-', 2);
    if (algo !== 'sha512') {
        throw new opsModels.ModelError(
            'unsupported npm integrity algo: ' + algo,
            'BAD_INTEGRITY',
            400
        );
    }
    const buf = await fs.promises.readFile(tarballPath);
    const computed = crypto.createHash('sha512').update(buf).digest('base64');
    if (computed !== expected) {
        throw new opsModels.ModelError(
            'npm integrity mismatch on ' + tarballPath,
            'INTEGRITY_MISMATCH',
            400
        );
    }
}

async function _extractTarball(tarballPath, targetDir) {
    await fs.promises.mkdir(targetDir, { recursive: true });
    await _execFile('tar', [
        '-xzf', tarballPath,
        '-C', targetDir,
        '--strip-components=1',
    ]);
}

async function _cleanupStaging(stagingDir) {
    try {
        await _execFile('rm', ['-rf', stagingDir]);
    } catch (err) {
        // Cleanup failure is logged but doesn't fail the request — the
        // staging dir will be cleaned by the next install cycle.
        console.error('[opsArtifacts] cleanup failure:', err);
    }
}

function _computeManifestHash(m) {
    return opsModels._computeManifestHash(m);
}
