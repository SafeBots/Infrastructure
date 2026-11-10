#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const SafenetNode = require('./lib/SafenetNode');

// Configuration from environment
const PORT = parseInt(process.env.SAFENET_PORT || '8443', 10);
const DATA_DIR = process.env.SAFENET_DATA_DIR || '/var/lib/safenet';
const REPOS_DIR = process.env.SAFENET_REPOS_DIR || path.join(DATA_DIR, 'repos');
const TLS_CERT = process.env.SAFENET_TLS_CERT;
const TLS_KEY = process.env.SAFENET_TLS_KEY;
const BOOTSTRAP_PEERS = process.env.SAFENET_BOOTSTRAP_PEERS; // comma-separated endpoints
const ACCEPTABLE_IMAGES = process.env.SAFENET_ACCEPTABLE_IMAGES; // comma-separated hashes

async function main() {
    // Parse config
    const bootstrapPeers = BOOTSTRAP_PEERS
        ? BOOTSTRAP_PEERS.split(',').map(ep => ({ uri: ep.trim(), endpoint: ep.trim() }))
        : [];
    const acceptableImages = ACCEPTABLE_IMAGES
        ? new Set(ACCEPTABLE_IMAGES.split(',').map(h => h.trim()))
        : new Set();

    // Create and start node
    const node = new SafenetNode({
        dataDir: DATA_DIR,
        reposDir: REPOS_DIR,
        bootstrapPeers,
        acceptableImages,
        port: PORT
    });

    await node.start();

    // Create server
    let server;
    if (TLS_CERT && TLS_KEY) {
        server = https.createServer({
            cert: fs.readFileSync(TLS_CERT),
            key: fs.readFileSync(TLS_KEY)
        }, (req, res) => node.handleRequest(req, res));
    } else {
        console.warn('[safenet] WARNING: Running without TLS. Use SAFENET_TLS_CERT and SAFENET_TLS_KEY in production.');
        server = http.createServer((req, res) => node.handleRequest(req, res));
    }

    server.listen(PORT, () => {
        console.log(`[safenet] Safenet node listening on port ${PORT}`);
        console.log(`[safenet] Identity: ${node.identity.uri}`);
        console.log(`[safenet] Data dir: ${DATA_DIR}`);
        console.log(`[safenet] Repos dir: ${REPOS_DIR}`);
        console.log(`[safenet] Bootstrap peers: ${bootstrapPeers.length}`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`[safenet] ${signal} received, shutting down...`);
        await node.stop();
        server.close(() => {
            console.log('[safenet] Server closed');
            process.exit(0);
        });
        // Force exit after 10s
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
    console.error('[safenet] Fatal error:', err);
    process.exit(1);
});
