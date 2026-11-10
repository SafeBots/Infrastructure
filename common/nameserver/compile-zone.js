#!/usr/bin/env node
// common/nameserver/compile-zone.js
//
// Standalone zone compiler for the safebox-zone-compiler.service. Reads
// registry state from the local registry replica and outputs a standard
// DNS zone file that Knot DNS serves.
//
// This script is the integration point between the Safenet registry
// (name_claims + box_announces) and Knot DNS. It:
//
//   1. Connects to the local registry replica (via Unix socket or file)
//   2. Reads all name_claims and box_announces
//   3. Compiles a zone file using ZoneCompiler
//   4. Writes the zone file atomically to /var/lib/safebox/knot/zones/
//   5. Signals Knot DNS to reload via knotc
//
// See docs/DNS-ARCHITECTURE.md for the full design.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const ZONE_DIR = process.env.SAFEBOX_ZONE_DIR || '/var/lib/safebox/knot/zones';
const ZONE_FILE = path.join(ZONE_DIR, 'safenet.org.zone');
const ZONE_TMP = ZONE_FILE + '.tmp';
const REGISTRY_SOCKET = process.env.SAFEBOX_REGISTRY_SOCKET || '/run/safebox/registry.sock';
const CONFIG_FILE = process.env.SAFEBOX_NAMESERVER_CONFIG || '/etc/safebox/nameserver.json';

// Default zone configuration
const DEFAULT_CONFIG = {
    origin: 'safenet.org.',
    nameservers: ['ns1.safenet.org.', 'ns2.safenet.org.'],
    ttl: 300,
    soaContact: 'hostmaster.safenet.org.',
    attestationMaxAge: 600,
    caaIssuers: ['letsencrypt.org'],
    staticRecords: [],
};

async function main() {
    // Load config overlay if it exists
    let config = { ...DEFAULT_CONFIG };
    try {
        const overlay = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        config = { ...config, ...overlay };
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error('compile-zone: warning: could not read config:', e.message);
        }
    }

    // Connect to registry and get state.
    // The registry interface is provided by the safebox runtime.
    // For now we read from a JSON snapshot that the registry sync
    // service writes after each peer sync cycle.
    const REGISTRY_SNAPSHOT = process.env.SAFEBOX_REGISTRY_SNAPSHOT
        || '/var/lib/safebox/registry/snapshot.json';

    let nameClaims = [];
    let boxAnnounces = new Map();
    let rootHash = null;

    try {
        const snapshot = JSON.parse(fs.readFileSync(REGISTRY_SNAPSHOT, 'utf8'));
        nameClaims = snapshot.nameClaims || [];
        rootHash = snapshot.rootHash || null;

        // Box announces: snapshot stores them as {safeboxId -> announceData}
        if (snapshot.boxAnnounces) {
            for (const [id, data] of Object.entries(snapshot.boxAnnounces)) {
                boxAnnounces.set(id, data);
            }
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.error('compile-zone: no registry snapshot yet; writing empty zone');
        } else {
            console.error('compile-zone: error reading registry snapshot:', e.message);
            process.exit(1);
        }
    }

    // Build a minimal registry-compatible object for ZoneCompiler
    const registryView = {
        rootHash,
        getAllNameClaims: async () => nameClaims,
        getAllBoxAnnounces: async () => boxAnnounces,
    };

    // Import ZoneCompiler from the Safenet lib. In the installed image,
    // this lives at /opt/safebox/lib/ZoneCompiler.js; during development,
    // look for it relative to this script.
    let ZoneCompiler;
    const candidates = [
        '/opt/safebox/lib/ZoneCompiler.js',
        path.resolve(__dirname, '../../safenet/lib/ZoneCompiler.js'),
        path.resolve(__dirname, '../../../safenet-extract/lib/ZoneCompiler.js'),
    ];
    for (const p of candidates) {
        try {
            ZoneCompiler = require(p);
            break;
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
    }
    if (!ZoneCompiler) {
        console.error('compile-zone: cannot find ZoneCompiler.js');
        process.exit(1);
    }

    // Compile the zone
    const result = await ZoneCompiler.compile(registryView, config);

    // Atomic write: write to .tmp then rename
    fs.mkdirSync(ZONE_DIR, { recursive: true });
    fs.writeFileSync(ZONE_TMP, result.zone, 'utf8');
    fs.renameSync(ZONE_TMP, ZONE_FILE);

    console.log(`compile-zone: wrote ${ZONE_FILE}`);
    console.log(`  serial=${result.serial} records=${result.recordCount} names=${result.nameCount}`);

    // Signal Knot to reload the zone (if running)
    try {
        execSync('knotc zone-reload safenet.org 2>/dev/null', { stdio: 'pipe' });
        console.log('compile-zone: signalled knot to reload');
    } catch (e) {
        // Knot may not be running yet (first boot, or non-nameserver box)
        console.log('compile-zone: knot not running or reload skipped');
    }
}

main().catch(e => {
    console.error('compile-zone: fatal:', e);
    process.exit(1);
});
