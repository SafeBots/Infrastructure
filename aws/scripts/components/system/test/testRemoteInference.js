#!/usr/bin/env node
// test/testRemoteInference.js
//
// Tests the remote inference wiring in opsEmbed.js:
//   - setSafenetNode / _getSafenetNode round-trip
//   - config.disableRemoteInference defaults to false
//   - safenetNode is null by default (no remote routing)

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── TAP harness ─────────────────────────────────────────────────────────────

let testCount = 0;
let passed = 0;
let failed = 0;

function test(name, fn) {
    testCount++;
    try {
        fn();
        passed++;
        console.log(`ok ${testCount} - ${name}`);
    } catch (e) {
        failed++;
        console.log(`not ok ${testCount} - ${name}`);
        console.log(`  # ${e.message}`);
    }
}

// ── Set up temp config ──────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebox-remote-inf-test-'));
const cfgPath = path.join(tmpDir, 'managed-containers.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    'safebox-app-test': {
        imagePattern: '^test/.*$',
        execContext: 'container',
        allowedActions: ['embed'],
        keyEpoch: 'a'.repeat(32),
    },
}));
process.env.SAFEBOX_SYSTEM_CONFIG = cfgPath;
delete process.env.SAFEBOX_DISABLE_REMOTE_INFERENCE;

// ── Load modules ────────────────────────────────────────────────────────────

const config = require(path.join(__dirname, '..', 'config'));
config.reload();

const opsEmbed = require(path.join(__dirname, '..', 'opsEmbed'));

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

console.log('# opsEmbed remote inference wiring');

test('config.disableRemoteInference: defaults to false', () => {
    assert.strictEqual(config.disableRemoteInference, false);
});

test('_getSafenetNode: null by default', () => {
    // Fresh module load — safenetNode starts as null
    assert.strictEqual(opsEmbed._getSafenetNode(), null);
});

test('setSafenetNode: stores and retrieves reference', () => {
    const mockNode = {
        findModelPeers: function() { return []; },
        findModelPeersByName: function() { return []; }
    };
    opsEmbed.setSafenetNode(mockNode);
    assert.strictEqual(opsEmbed._getSafenetNode(), mockNode);
});

test('setSafenetNode: can be reset to null', () => {
    opsEmbed.setSafenetNode(null);
    assert.strictEqual(opsEmbed._getSafenetNode(), null);
});

test('setSafenetNode: accepts node with findModelPeers returning peers', () => {
    const peers = [
        { safeboxUri: 'safebox://peer1', endpoint: 'https://peer1:8443', modelName: 'TestModel' },
        { safeboxUri: 'safebox://peer2', endpoint: 'https://peer2:8443', modelName: 'TestModel' }
    ];
    const mockNode = {
        findModelPeers: function(hash) {
            if (hash === 'a'.repeat(64)) return peers;
            return [];
        },
        findModelPeersByName: function(name) {
            if (name === 'TestModel') return peers;
            return [];
        }
    };
    opsEmbed.setSafenetNode(mockNode);

    const node = opsEmbed._getSafenetNode();
    const found = node.findModelPeers('a'.repeat(64));
    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].endpoint, 'https://peer1:8443');

    const byName = node.findModelPeersByName('TestModel');
    assert.strictEqual(byName.length, 2);

    const empty = node.findModelPeers('b'.repeat(64));
    assert.strictEqual(empty.length, 0);

    opsEmbed.setSafenetNode(null);
});

test('opsEmbed exports handle, startWorker, shutdownWorker, setSafenetNode', () => {
    assert.strictEqual(typeof opsEmbed.handle, 'function');
    assert.strictEqual(typeof opsEmbed.startWorker, 'function');
    assert.strictEqual(typeof opsEmbed.shutdownWorker, 'function');
    assert.strictEqual(typeof opsEmbed.setSafenetNode, 'function');
    assert.strictEqual(typeof opsEmbed._getSafenetNode, 'function');
});

// Clean up
try {
    fs.unlinkSync(cfgPath);
    fs.rmdirSync(tmpDir);
} catch (_) {}

// ═════════════════════════════════════════════════════════════════════════════
// Done
// ═════════════════════════════════════════════════════════════════════════════

console.log(`\n# ${passed}/${testCount} passed`);

if (failed > 0) {
    console.log(`FAIL: ${failed} test(s) failed`);
    process.exit(1);
}
