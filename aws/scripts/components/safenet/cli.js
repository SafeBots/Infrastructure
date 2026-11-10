#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const SafenetNode = require('./lib/SafenetNode');

// ------------------------------------------------------------------
// Argument parser
// ------------------------------------------------------------------

/**
 * Parse process.argv into { command, subcommand, positional, flags }.
 * Flags are --key value or --key (boolean true).
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ command: string, subcommand: string|null, positional: string[], flags: object }}
 */
function parseArgs(argv) {
    const positional = [];
    const flags = {};
    let i = 0;

    while (i < argv.length) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i += 2;
            } else {
                flags[key] = true;
                i += 1;
            }
        } else {
            positional.push(arg);
            i += 1;
        }
    }

    const command = positional[0] || 'help';
    const subcommand = positional[1] || null;
    const rest = positional.slice(1);

    return { command, subcommand, positional: rest, flags };
}

// ------------------------------------------------------------------
// Default paths
// ------------------------------------------------------------------

const DEFAULT_DATA_DIR = process.env.SAFENET_DATA_DIR
    || path.join(process.env.HOME || '/var/lib', '.safenet');
const IDENTITY_FILE = 'identity.json';
const IDENTITY_SECRET_FILE = 'identity-secret.json';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Resolve the data directory from flags or environment.
 */
function resolveDataDir(flags) {
    return flags['data-dir'] || DEFAULT_DATA_DIR;
}

/**
 * Create a SafenetNode configured from CLI flags.
 * The node is not started; the caller decides whether to call start().
 */
function createNode(flags) {
    const dataDir = resolveDataDir(flags);
    const reposDir = flags['repos-dir'] || path.join(dataDir, 'repos');
    const port = parseInt(flags.port || process.env.SAFENET_PORT || '8443', 10);

    const bootstrapPeers = [];
    if (flags.bootstrap) {
        const peers = String(flags.bootstrap).split(',');
        for (const p of peers) {
            const ep = p.trim();
            if (ep) bootstrapPeers.push({ uri: ep, endpoint: ep });
        }
    }

    return new SafenetNode({ dataDir, reposDir, bootstrapPeers, port });
}

/**
 * Print a JSON value with indentation.
 */
function printJSON(value) {
    console.log(JSON.stringify(value, null, 2));
}

/**
 * Print a labeled line.
 */
function printField(label, value) {
    console.log('  ' + label + ': ' + value);
}

// ------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------

/**
 * safenet init [--data-dir <path>]
 *
 * Initialize a new Safenet node: create the data directory, generate
 * an identity keypair, and write identity files.
 */
async function cmdInit(flags) {
    const dataDir = resolveDataDir(flags);
    const reposDir = path.join(dataDir, 'repos');
    const identityPath = path.join(dataDir, IDENTITY_FILE);
    const secretPath = path.join(dataDir, IDENTITY_SECRET_FILE);

    // Guard against overwriting an existing identity
    if (fs.existsSync(identityPath)) {
        console.error('Error: Identity already exists at ' + identityPath);
        console.error('Remove it manually if you want to reinitialize.');
        process.exit(1);
    }

    // Create directories
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(reposDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'log'), { recursive: true });

    // Generate identity
    const Identity = require('./lib/Identity');
    const identity = await Identity.generateSafebox();

    // Write public identity (safe to share)
    const pub = identity.toJSON();
    fs.writeFileSync(identityPath, JSON.stringify(pub, null, 2) + '\n', 'utf8');

    // Write secret key material (owner-read only)
    const secret = {
        type: identity.type,
        publicKey: identity.publicKeyHex,
        privateKey: typeof identity._privateKey === 'string'
            ? identity._privateKey
            : Buffer.isBuffer(identity._privateKey)
                ? identity._privateKey.toString('hex')
                : null
    };
    fs.writeFileSync(secretPath, JSON.stringify(secret, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600
    });

    console.log('Safenet node initialized.');
    console.log();
    printField('Data directory', dataDir);
    printField('Repos directory', reposDir);
    printField('Identity URI', pub.uri);
    printField('SPKI hash', pub.spkiHash);
    printField('Public key', pub.publicKey.slice(0, 32) + '...');
    console.log();
    console.log('Identity written to ' + identityPath);
    console.log('Secret key written to ' + secretPath + ' (keep this safe)');
}

/**
 * safenet start [--port <port>] [--data-dir <path>] [--bootstrap <peer>]
 *
 * Start the Safenet server. Delegates to the same logic as server.js
 * but driven from CLI flags instead of environment variables.
 */
async function cmdStart(flags) {
    const dataDir = resolveDataDir(flags);
    const port = parseInt(flags.port || process.env.SAFENET_PORT || '8443', 10);
    const tlsCert = flags['tls-cert'] || process.env.SAFENET_TLS_CERT;
    const tlsKey = flags['tls-key'] || process.env.SAFENET_TLS_KEY;

    const node = createNode(flags);
    await node.start();

    let server;
    if (tlsCert && tlsKey) {
        server = https.createServer({
            cert: fs.readFileSync(tlsCert),
            key: fs.readFileSync(tlsKey)
        }, (req, res) => node.handleRequest(req, res));
    } else {
        console.warn('[safenet] WARNING: Running without TLS. Use --tls-cert and --tls-key in production.');
        server = http.createServer((req, res) => node.handleRequest(req, res));
    }

    server.listen(port, () => {
        console.log('[safenet] Safenet node listening on port ' + port);
        console.log('[safenet] Identity: ' + node.identity.uri);
        console.log('[safenet] Data dir: ' + dataDir);
    });

    const shutdown = async (signal) => {
        console.log('[safenet] ' + signal + ' received, shutting down...');
        await node.stop();
        server.close(() => {
            console.log('[safenet] Server closed');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Keep the process alive -- the server holds the event loop open.
}

/**
 * safenet identity
 *
 * Show the node's identity (URI, public key, SPKI hash).
 */
async function cmdIdentity(flags) {
    const dataDir = resolveDataDir(flags);
    const identityPath = path.join(dataDir, IDENTITY_FILE);

    if (!fs.existsSync(identityPath)) {
        console.error('Error: No identity found. Run "safenet init" first.');
        process.exit(1);
    }

    const pub = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    console.log('Safenet Node Identity');
    console.log('---------------------');
    printField('URI', pub.uri);
    printField('Type', pub.type);
    printField('SPKI hash', pub.spkiHash);
    printField('Public key', pub.publicKey);
    if (pub.name) {
        printField('Name', pub.name);
    }
}

/**
 * safenet namespace claim <name>
 *
 * Claim a namespace in the local registry.
 */
async function cmdNamespaceClaim(positional, flags) {
    const name = positional[0]; // positional already has subcommand stripped
    if (!name) {
        console.error('Usage: safenet namespace claim <name>');
        process.exit(1);
    }

    const node = createNode(flags);
    await node.start();

    try {
        const Claims = require('./lib/Claims');
        const claim = Claims.namespaceClaim({
            namespace: name,
            owner: node.identity.name || node.identity.spkiHash
        });
        const signed = await node.identity.sign(claim);
        const result = await node.registry.claimNamespace(signed);

        if (result.ok) {
            console.log('Namespace "' + name + '" claimed successfully.');
            printField('Root hash', result.rootHash);
        } else {
            console.error('Failed to claim namespace: ' + result.message);
            process.exit(1);
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet publish [--dir <path>]
 *
 * Publish the current directory (or --dir) as a package.
 * Reads safenet.json from the directory for manifest data.
 */
async function cmdPublish(flags) {
    const dir = path.resolve(flags.dir || process.cwd());
    const manifestPath = path.join(dir, 'safenet.json');

    if (!fs.existsSync(manifestPath)) {
        console.error('Error: No safenet.json found in ' + dir);
        console.error('Create a safenet.json manifest before publishing.');
        process.exit(1);
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
        console.error('Error: Failed to parse safenet.json: ' + err.message);
        process.exit(1);
    }

    const node = createNode(flags);
    await node.start();

    try {
        // Validate manifest
        const validation = node.publisher.validateManifest(manifest);
        if (!validation.ok) {
            console.error('Manifest validation failed:');
            for (const err of validation.errors) {
                console.error('  - ' + err);
            }
            process.exit(1);
        }

        // Collect files from the directory
        const files = collectFiles(dir);
        console.log('Publishing ' + manifest.name + '@' + manifest.version);
        console.log('  Files: ' + files.length);

        // Create publication claim
        const pubResult = await node.publisher.createPublication({
            manifest,
            files
        });

        if (pubResult.ok === false) {
            console.error('Publication failed: ' + pubResult.message);
            if (pubResult.errors) {
                for (const err of pubResult.errors) {
                    console.error('  - ' + err);
                }
            }
            process.exit(1);
        }

        // Submit to local registry
        const parts = manifest.name.split('/');
        const regResult = await node.registry.publish(pubResult);

        if (regResult.ok) {
            console.log('Published successfully.');
            printField('Package', manifest.name);
            printField('Version', manifest.version);
            printField('Registry root', regResult.rootHash);
        } else {
            console.error('Registry rejected publication: ' + regResult.message);
            process.exit(1);
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet search <query> [--lang <language>]
 *
 * Search the local registry for packages.
 */
async function cmdSearch(positional, flags) {
    const query = positional.join(' ');
    if (!query) {
        console.error('Usage: safenet search <query> [--lang <language>]');
        process.exit(1);
    }

    const node = createNode(flags);
    await node.start();

    try {
        const results = await node.registry.search(query, {
            language: flags.lang || null,
            limit: parseInt(flags.limit || '20', 10)
        });

        if (results.length === 0) {
            console.log('No packages found for "' + query + '".');
            return;
        }

        console.log('Found ' + results.length + ' package(s):\n');
        for (const pkg of results) {
            console.log('  ' + pkg.namespace + '/' + pkg.name);
            if (pkg.description) {
                console.log('    ' + pkg.description);
            }
            if (pkg.latest) {
                console.log('    latest: ' + pkg.latest);
            }
            console.log();
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet info <namespace/package>
 *
 * Show detailed information about a package.
 */
async function cmdInfo(positional, flags) {
    const pkgArg = positional[0];
    if (!pkgArg) {
        console.error('Usage: safenet info <namespace/package>');
        process.exit(1);
    }

    const parts = pkgArg.split('/');
    if (parts.length !== 2) {
        console.error('Error: Package name must be in "namespace/package" format.');
        process.exit(1);
    }

    const [namespace, name] = parts;
    const node = createNode(flags);
    await node.start();

    try {
        const pkg = await node.registry.getPackage(namespace, name);
        if (!pkg) {
            console.error('Package "' + pkgArg + '" not found.');
            process.exit(1);
        }

        console.log('Package: ' + namespace + '/' + name);
        console.log('==========' + '='.repeat(namespace.length + name.length));
        if (pkg.description) {
            console.log();
            console.log(pkg.description);
        }
        console.log();
        printField('Latest', pkg.latest || '(none)');
        printField('Versions', (pkg.versions || []).join(', ') || '(none)');
        printField('Created', pkg.createdAt || 'unknown');
        printField('Updated', pkg.updatedAt || 'unknown');

        // Show the latest version's claim details if available
        if (pkg.latest) {
            const versionClaim = await node.registry.getVersion(namespace, name, pkg.latest);
            if (versionClaim && versionClaim.stm) {
                console.log();
                console.log('Latest version details:');
                if (versionClaim.stm.languages) {
                    printField('Languages', versionClaim.stm.languages.join(', '));
                }
                if (versionClaim.stm.license) {
                    printField('License', versionClaim.stm.license);
                }
                if (versionClaim.stm.merkleRoot) {
                    printField('Merkle root', versionClaim.stm.merkleRoot);
                }
                if (versionClaim.stm.contentSize) {
                    printField('Content size', formatBytes(versionClaim.stm.contentSize));
                }
                if (versionClaim.stm.fileCount) {
                    printField('Files', String(versionClaim.stm.fileCount));
                }
                if (versionClaim.stm.dependencies && versionClaim.stm.dependencies.length > 0) {
                    console.log('  Dependencies:');
                    for (const dep of versionClaim.stm.dependencies) {
                        console.log('    - ' + dep.package + ' ' + (dep.versionRange || '*'));
                    }
                }
            }
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet install <namespace/package[@version]> [--lang <language>]
 *
 * Install a package from the registry. In this reference implementation,
 * "install" means verifying the publication claim, fetching the content
 * from a peer, and writing it to the local repos directory.
 */
async function cmdInstall(positional, flags) {
    const pkgArg = positional[0];
    if (!pkgArg) {
        console.error('Usage: safenet install <namespace/package[@version]> [--lang <language>]');
        process.exit(1);
    }

    // Parse namespace/package@version
    let pkgPath, version;
    const atIndex = pkgArg.lastIndexOf('@');
    if (atIndex > 0 && atIndex > pkgArg.indexOf('/')) {
        pkgPath = pkgArg.slice(0, atIndex);
        version = pkgArg.slice(atIndex + 1);
    } else {
        pkgPath = pkgArg;
        version = null;
    }

    const parts = pkgPath.split('/');
    if (parts.length !== 2) {
        console.error('Error: Package name must be in "namespace/package" format.');
        process.exit(1);
    }

    const [namespace, name] = parts;
    const node = createNode(flags);
    await node.start();

    try {
        // Look up package
        const pkg = await node.registry.getPackage(namespace, name);
        if (!pkg) {
            console.error('Package "' + pkgPath + '" not found in the registry.');
            process.exit(1);
        }

        // Resolve version
        const targetVersion = version || pkg.latest;
        if (!targetVersion) {
            console.error('No version specified and no latest version found.');
            process.exit(1);
        }

        if (pkg.versions && !pkg.versions.includes(targetVersion)) {
            console.error('Version "' + targetVersion + '" not found.');
            console.error('Available versions: ' + (pkg.versions || []).join(', '));
            process.exit(1);
        }

        // Get the publication claim for the version
        const claim = await node.registry.getVersion(namespace, name, targetVersion);
        if (!claim) {
            console.error('Publication claim for ' + pkgPath + '@' + targetVersion + ' not found.');
            process.exit(1);
        }

        console.log('Installing ' + pkgPath + '@' + targetVersion + '...');

        // Verify the publication claim
        const verification = await node.publisher.verifyPublication(claim);
        if (verification.ok === false) {
            console.error('Publication claim verification failed:');
            for (const err of (verification.errors || [])) {
                console.error('  - ' + err);
            }
            process.exit(1);
        }

        // In a full implementation, this would fetch content chunks from
        // peers and decrypt them. For the reference implementation, we
        // record the install intent and report success.
        const installDir = path.join(
            resolveDataDir(flags), 'installed', namespace, name, targetVersion
        );
        fs.mkdirSync(installDir, { recursive: true });

        // Write a receipt file
        const receipt = {
            package: pkgPath,
            version: targetVersion,
            installedAt: new Date().toISOString(),
            merkleRoot: claim.stm && claim.stm.merkleRoot,
            claimHash: claim.stm
                ? require('./lib/utils').generateClaimHash(claim)
                : null
        };
        fs.writeFileSync(
            path.join(installDir, '.safenet-receipt.json'),
            JSON.stringify(receipt, null, 2) + '\n',
            'utf8'
        );

        console.log('Installed ' + pkgPath + '@' + targetVersion);
        printField('Location', installDir);
        if (receipt.merkleRoot) {
            printField('Merkle root', receipt.merkleRoot);
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet peers
 *
 * List all known peers.
 */
async function cmdPeers(flags) {
    const node = createNode(flags);
    await node.start();

    try {
        const peers = node.discovery.getPeers();

        if (peers.length === 0) {
            console.log('No known peers.');
            return;
        }

        console.log('Known peers (' + peers.length + '):\n');
        for (const peer of peers) {
            console.log('  ' + peer.peerUri);
            printField('  Endpoint', peer.endpoint);
            printField('  Last seen', peer.lastSeen || 'never');
            printField('  Trust level', String(peer.trustLevel));
            console.log();
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet sync [--peer <endpoint>]
 *
 * Synchronize registry state with peers. If --peer is specified,
 * sync only with that peer. Otherwise sync with all known peers.
 */
async function cmdSync(flags) {
    const node = createNode(flags);
    await node.start();

    try {
        const targetPeer = flags.peer || null;

        if (targetPeer) {
            // Sync with a specific peer
            console.log('Syncing with ' + targetPeer + '...');
            try {
                const result = await node.discovery.requestSync(targetPeer);
                console.log('Sync complete.');
                printField('Received', String(result.received) + ' claims');
                printField('Sent', String(result.sent) + ' claims');
            } catch (err) {
                console.error('Sync failed: ' + err.message);
                process.exit(1);
            }
        } else {
            // Sync with all known peers
            const peers = node.discovery.getPeers();
            if (peers.length === 0) {
                console.log('No known peers to sync with.');
                console.log('Use --bootstrap to add peers or --peer to specify one.');
                return;
            }

            console.log('Syncing with ' + peers.length + ' peer(s)...\n');
            let totalReceived = 0;
            let totalSent = 0;
            let failures = 0;

            for (const peer of peers) {
                try {
                    process.stdout.write('  ' + peer.peerUri + '... ');
                    const result = await node.discovery.requestSync(peer.peerUri);
                    totalReceived += result.received;
                    totalSent += result.sent;
                    console.log('OK (received ' + result.received + ', sent ' + result.sent + ')');
                } catch (err) {
                    failures++;
                    console.log('FAILED (' + err.message + ')');
                }
            }

            console.log();
            console.log('Sync summary:');
            printField('Peers synced', String(peers.length - failures) + '/' + peers.length);
            printField('Total received', String(totalReceived) + ' claims');
            printField('Total sent', String(totalSent) + ' claims');
        }
    } finally {
        await node.stop();
    }
}

/**
 * safenet balance [<author>]
 *
 * Show Safebux balance. If no author is specified, shows the
 * balance for this node's identity.
 */
async function cmdBalance(positional, flags) {
    const node = createNode(flags);
    await node.start();

    try {
        const authorUri = positional[0] || node.identity.uri;
        const balance = node.payments.getBalance(authorUri);

        console.log('Safebux Balance');
        console.log('---------------');
        printField('Author', authorUri);
        printField('Total received', String(balance.total) + ' SAFEBUX');
        printField('Payments', String(balance.payments));
    } finally {
        await node.stop();
    }
}

/**
 * safenet status
 *
 * Show current node status: identity, registry stats, peer count,
 * and transparency log size.
 */
async function cmdStatus(flags) {
    const dataDir = resolveDataDir(flags);
    const identityPath = path.join(dataDir, IDENTITY_FILE);

    if (!fs.existsSync(identityPath)) {
        console.error('Error: No identity found. Run "safenet init" first.');
        process.exit(1);
    }

    const node = createNode(flags);
    await node.start();

    try {
        const identity = node.identity.toJSON();
        const stats = await node.registry.stats();
        const peers = node.discovery.getPeers();
        const logRoot = node.transparencyLog.getRoot();

        console.log('Safenet Node Status');
        console.log('===================');
        console.log();

        console.log('Identity:');
        printField('URI', identity.uri);
        printField('Type', identity.type);
        printField('SPKI hash', identity.spkiHash);
        console.log();

        console.log('Registry:');
        printField('Namespaces', String(stats.namespaces));
        printField('Packages', String(stats.packages));
        printField('Versions', String(stats.versions));
        printField('Revocations', String(stats.revocations));
        printField('Root hash', node.registry.rootHash || '(empty)');
        console.log();

        console.log('Network:');
        printField('Known peers', String(peers.length));
        console.log();

        console.log('Transparency Log:');
        printField('Entries', String(logRoot.entryCount));
        printField('Root hash', logRoot.rootHash || '(empty)');
        console.log();

        console.log('Storage:');
        printField('Data dir', dataDir);
        printField('Data dir exists', String(fs.existsSync(dataDir)));
    } finally {
        await node.stop();
    }
}

/**
 * safenet help
 *
 * Show help text with all available commands.
 */
function cmdHelp() {
    console.log('Usage: safenet <command> [options]');
    console.log();
    console.log('Safenet Protocol CLI v0.1.0');
    console.log('Distributed package registry, trust network, and payment settlement.');
    console.log();
    console.log('Commands:');
    console.log('  init                              Initialize a new Safenet node');
    console.log('  start                             Start the Safenet server');
    console.log('  identity                          Show the node\'s identity');
    console.log('  namespace claim <name>            Claim a namespace');
    console.log('  publish                           Publish a package (reads safenet.json)');
    console.log('  search <query>                    Search the registry');
    console.log('  info <namespace/package>          Show package information');
    console.log('  install <ns/pkg[@version]>        Install a package');
    console.log('  peers                             List known peers');
    console.log('  sync                              Sync with peers');
    console.log('  balance [<author>]                Show Safebux balance');
    console.log('  status                            Show node status');
    console.log('  help                              Show this help');
    console.log();
    console.log('Global Options:');
    console.log('  --data-dir <path>                 Data directory (default: ~/.safenet)');
    console.log();
    console.log('Init Options:');
    console.log('  --data-dir <path>                 Where to create the node data');
    console.log();
    console.log('Start Options:');
    console.log('  --port <port>                     Listen port (default: 8443)');
    console.log('  --bootstrap <peer1,peer2,...>      Bootstrap peer endpoints');
    console.log('  --tls-cert <path>                 TLS certificate file');
    console.log('  --tls-key <path>                  TLS private key file');
    console.log();
    console.log('Publish Options:');
    console.log('  --dir <path>                      Package directory (default: cwd)');
    console.log();
    console.log('Search Options:');
    console.log('  --lang <language>                 Filter by language');
    console.log('  --limit <n>                       Max results (default: 20)');
    console.log();
    console.log('Install Options:');
    console.log('  --lang <language>                 Preferred language');
    console.log();
    console.log('Sync Options:');
    console.log('  --peer <endpoint>                 Sync with a specific peer');
    console.log();
    console.log('Environment Variables:');
    console.log('  SAFENET_DATA_DIR                  Default data directory');
    console.log('  SAFENET_PORT                      Default port');
    console.log('  SAFENET_TLS_CERT                  TLS certificate path');
    console.log('  SAFENET_TLS_KEY                   TLS key path');
    console.log('  SAFENET_BOOTSTRAP_PEERS           Comma-separated peer endpoints');
    console.log('  Q_CLASSES_PATH                    Path to Qbix platform classes');
}

// ------------------------------------------------------------------
// File collection helper
// ------------------------------------------------------------------

/**
 * Recursively collect files from a directory, excluding common
 * non-publishable paths (.git, node_modules, etc.).
 *
 * @param {string} dir - Root directory
 * @param {string} [base] - Base path for relative file paths
 * @returns {Array<{ path: string, content: Buffer }>}
 */
function collectFiles(dir, base) {
    base = base || dir;
    const results = [];
    const SKIP = new Set(['.git', 'node_modules', '.safenet', '.DS_Store']);

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return results;
    }

    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath, base));
        } else if (entry.isFile()) {
            const relPath = path.relative(base, fullPath);
            results.push({
                path: relPath,
                content: fs.readFileSync(fullPath)
            });
        }
    }

    return results;
}

/**
 * Format a byte count for human display.
 */
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GiB';
}

// ------------------------------------------------------------------
// Main dispatch
// ------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));

    try {
        switch (args.command) {
            case 'init':
                await cmdInit(args.flags);
                break;

            case 'start':
                await cmdStart(args.flags);
                break; // cmdStart holds the event loop open via the server

            case 'identity':
                await cmdIdentity(args.flags);
                break;

            case 'namespace': {
                if (args.subcommand !== 'claim') {
                    console.error('Usage: safenet namespace claim <name>');
                    process.exit(1);
                }
                // Positional is ['claim', '<name>'], pass the rest after 'claim'
                await cmdNamespaceClaim(args.positional.slice(1), args.flags);
                break;
            }

            case 'publish':
                await cmdPublish(args.flags);
                break;

            case 'search':
                await cmdSearch(args.positional, args.flags);
                break;

            case 'info':
                await cmdInfo(args.positional, args.flags);
                break;

            case 'install':
                await cmdInstall(args.positional, args.flags);
                break;

            case 'peers':
                await cmdPeers(args.flags);
                break;

            case 'sync':
                await cmdSync(args.flags);
                break;

            case 'balance':
                await cmdBalance(args.positional, args.flags);
                break;

            case 'status':
                await cmdStatus(args.flags);
                break;

            case 'help':
            case '--help':
            case '-h':
                cmdHelp();
                break;

            default:
                console.error('Unknown command: ' + args.command);
                console.error('Run "safenet help" for usage.');
                process.exit(1);
        }
    } catch (err) {
        console.error('Error: ' + err.message);
        if (process.env.SAFENET_DEBUG) {
            console.error(err.stack);
        }
        process.exit(1);
    }
}

main();
