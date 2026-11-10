'use strict';
//
// lib/catalog.js — scan the Infrastructure repo for runner manifests.
//
// A "runner manifest" is a JSON file at:
//   <infra-dir>/model-runners/<runner>/manifests/<name>.json
//
// These are RUNNER-CONFIG manifests (what each model-runner consumes to know
// how to launch the model — vLLM args, ComfyUI workflow family, etc.).
//
// They are NOT the same shape as the INSTALL manifests the System component
// requires (which list files + SHA-256 + sources). The CLI knows how to bridge
// the two: for production installs it expects a sibling `<name>.install.json`
// with the file list. For local-mode installs it just stages the runner
// manifest into /etc/safebox/runners/<runner>/manifests/.
//

const fs = require('fs');
const path = require('path');

function defaultInfraDir() {
    return process.env.SAFEBOX_INFRA
        || (fs.existsSync('/opt/safebox-infrastructure')
              ? '/opt/safebox-infrastructure'
              : process.cwd());
}

function scanCatalog(infraDir) {
    infraDir = infraDir || defaultInfraDir();
    const runnersDir = path.join(infraDir, 'model-runners');
    if (!fs.existsSync(runnersDir)) {
        throw new Error(`model-runners/ not found at ${runnersDir}. `
                      + `Set --infrastructure-dir or SAFEBOX_INFRA.`);
    }
    const out = [];
    for (const runner of fs.readdirSync(runnersDir)) {
        const manifestsDir = path.join(runnersDir, runner, 'manifests');
        if (!fs.existsSync(manifestsDir)) continue;
        for (const f of fs.readdirSync(manifestsDir)) {
            if (!f.endsWith('.json')) continue;
            if (f === 'README.json') continue;
            const filePath = path.join(manifestsDir, f);
            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                // Skip corrupt manifests; surface in `doctor` instead.
                continue;
            }
            // Look for sibling install manifest
            const installFile = filePath.replace(/\.json$/, '.install.json');
            const hasInstallManifest = fs.existsSync(installFile);
            out.push({
                name:        manifest.name || f.replace(/\.json$/, ''),
                runner,
                runnerManifestPath:  filePath,
                installManifestPath: hasInstallManifest ? installFile : null,
                manifest,
            });
        }
    }
    // Sort by runner then name for stable output
    out.sort((a, b) => a.runner.localeCompare(b.runner) || a.name.localeCompare(b.name));
    return out;
}

function findByName(infraDir, name) {
    const catalog = scanCatalog(infraDir);
    const e = catalog.find(x => x.name === name);
    if (!e) {
        const available = catalog.map(x => x.name).join(', ');
        throw new Error(`Model '${name}' not in catalog. Available: ${available}`);
    }
    return e;
}

// Read the install manifest (the one the System component validates and signs).
// Throws if absent — the operator either needs to provide one with --install-manifest
// or use --local mode.
function readInstallManifest(entry, overridePath) {
    const installPath = overridePath || entry.installManifestPath;
    if (!installPath) {
        throw new Error(
            `No install manifest for '${entry.name}'. `
          + `Provide one with --install-manifest <path>, or use --local to skip the `
          + `System component install (you'll need to pre-stage weights yourself).`);
    }
    const text = fs.readFileSync(installPath, 'utf8');
    return JSON.parse(text);
}

module.exports = {
    defaultInfraDir,
    scanCatalog,
    findByName,
    readInstallManifest,
};
