#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path   = require('path');

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

async function asyncTest(name, fn) {
    testCount++;
    try {
        await fn();
        passed++;
        console.log(`ok ${testCount} - ${name}`);
    } catch (e) {
        failed++;
        console.log(`not ok ${testCount} - ${name}`);
        console.log(`  # ${e.message}`);
    }
}

function skip(name, reason) {
    testCount++;
    console.log(`ok ${testCount} - ${name} # SKIP ${reason}`);
    passed++;
}

// ── Load modules under test ────────────────────────────────────────────────

const libDir = path.resolve(__dirname, '..', 'lib');
const Claims = require(path.join(libDir, 'Claims'));
const ModelRegistry = require(path.join(libDir, 'ModelRegistry'));
const { nowISO, resolveQ } = require(path.join(libDir, 'utils'));

// Check whether Q modules are available (Discovery/SafenetNode need them)
let hasQ = false;
try {
    require(resolveQ('Q/Data'));
    hasQ = true;
} catch (_) {}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Claims.modelAvailable tests
// ═════════════════════════════════════════════════════════════════════════════

console.log('# Claims.modelAvailable');

const MANIFEST_HASH = 'a'.repeat(64);
const SAFEBOX_URI = 'safebox://test1234';
const ENDPOINT = 'https://peer1.example:8443';

test('modelAvailable: creates valid claim structure', () => {
    const claim = Claims.modelAvailable({
        safeboxUri: SAFEBOX_URI,
        endpoint: ENDPOINT,
        manifestHash: MANIFEST_HASH,
        modelName: 'TestModel',
        modelVersion: '1.0.0',
        modelType: 'LLM',
        capacity: 4
    });

    assert.strictEqual(claim.ocp, 1);
    assert.strictEqual(claim.iss, SAFEBOX_URI);
    assert.strictEqual(claim.sub, 'safenet:model:' + MANIFEST_HASH);
    assert.strictEqual(claim.stm.type, 'model_available');
    assert.strictEqual(claim.stm.endpoint, ENDPOINT);
    assert.strictEqual(claim.stm.manifestHash, MANIFEST_HASH);
    assert.strictEqual(claim.stm.modelName, 'TestModel');
    assert.strictEqual(claim.stm.modelVersion, '1.0.0');
    assert.strictEqual(claim.stm.modelType, 'LLM');
    assert.strictEqual(claim.stm.capacity, 4);
    assert.ok(claim.nbf);
});

test('modelAvailable: defaults capacity to 0', () => {
    const claim = Claims.modelAvailable({
        safeboxUri: SAFEBOX_URI,
        endpoint: ENDPOINT,
        manifestHash: MANIFEST_HASH
    });
    assert.strictEqual(claim.stm.capacity, 0);
});

test('modelAvailable: optional fields default to null', () => {
    const claim = Claims.modelAvailable({
        safeboxUri: SAFEBOX_URI,
        endpoint: ENDPOINT,
        manifestHash: MANIFEST_HASH
    });
    assert.strictEqual(claim.stm.modelName, null);
    assert.strictEqual(claim.stm.modelVersion, null);
    assert.strictEqual(claim.stm.modelType, null);
});

test('modelAvailable: rejects missing safeboxUri', () => {
    assert.throws(() => {
        Claims.modelAvailable({ endpoint: ENDPOINT, manifestHash: MANIFEST_HASH });
    }, /safeboxUri is required/);
});

test('modelAvailable: rejects missing endpoint', () => {
    assert.throws(() => {
        Claims.modelAvailable({ safeboxUri: SAFEBOX_URI, manifestHash: MANIFEST_HASH });
    }, /endpoint is required/);
});

test('modelAvailable: rejects invalid manifestHash (too short)', () => {
    assert.throws(() => {
        Claims.modelAvailable({ safeboxUri: SAFEBOX_URI, endpoint: ENDPOINT, manifestHash: 'abc123' });
    }, /64-char lowercase hex/);
});

test('modelAvailable: rejects invalid manifestHash (uppercase)', () => {
    assert.throws(() => {
        Claims.modelAvailable({ safeboxUri: SAFEBOX_URI, endpoint: ENDPOINT, manifestHash: 'A'.repeat(64) });
    }, /64-char lowercase hex/);
});

test('modelAvailable: rejects missing manifestHash', () => {
    assert.throws(() => {
        Claims.modelAvailable({ safeboxUri: SAFEBOX_URI, endpoint: ENDPOINT });
    }, /64-char lowercase hex/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ModelRegistry tests
// ═════════════════════════════════════════════════════════════════════════════

console.log('# ModelRegistry');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeClaim(safeboxUri, endpoint, manifestHash, modelName, modelVersion) {
    return {
        ocp: 1,
        iss: safeboxUri,
        sub: 'safenet:model:' + manifestHash,
        stm: {
            type: 'model_available',
            endpoint,
            manifestHash,
            modelName: modelName || null,
            modelVersion: modelVersion || null,
            modelType: 'LLM',
            capacity: 0
        },
        nbf: nowISO()
    };
}

test('addAnnouncement: stores and retrieves by hash', () => {
    const reg = new ModelRegistry();
    const claim = makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA');
    const result = reg.addAnnouncement(claim);
    assert.strictEqual(result.ok, true);

    const peers = reg.findByHash(HASH_A);
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].endpoint, 'https://peer1:8443');
    assert.strictEqual(peers[0].modelName, 'ModelA');
});

test('addAnnouncement: multiple peers for same model', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA'));

    const peers = reg.findByHash(HASH_A);
    assert.strictEqual(peers.length, 2);
});

test('addAnnouncement: same peer re-announces (updates entry)', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:9999', HASH_A, 'ModelA'));

    const peers = reg.findByHash(HASH_A);
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].endpoint, 'https://peer1:9999');
});

test('addAnnouncement: different models are separate', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_B, 'ModelB'));

    assert.strictEqual(reg.findByHash(HASH_A).length, 1);
    assert.strictEqual(reg.findByHash(HASH_B).length, 1);
    assert.strictEqual(reg.size, 2);
});

test('findByName: finds by model name', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA', '1.0'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA', '2.0'));
    reg.addAnnouncement(makeClaim('safebox://peer3', 'https://peer3:8443', HASH_B, 'ModelB'));

    const results = reg.findByName('ModelA');
    assert.strictEqual(results.length, 2);
});

test('findByName: filters by version', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA', '1.0'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA', '2.0'));

    const results = reg.findByName('ModelA', '1.0');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].safeboxUri, 'safebox://peer1');
});

test('findByHash: returns empty for unknown hash', () => {
    const reg = new ModelRegistry();
    assert.strictEqual(reg.findByHash('c'.repeat(64)).length, 0);
});

test('removeAnnouncement: removes specific peer+model', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA'));

    reg.removeAnnouncement(HASH_A, 'safebox://peer1');
    const peers = reg.findByHash(HASH_A);
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].safeboxUri, 'safebox://peer2');
});

test('removePeer: removes all models from a peer', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_B, 'ModelB'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA'));

    reg.removePeer('safebox://peer1');
    assert.strictEqual(reg.size, 1);
    assert.strictEqual(reg.findByHash(HASH_A).length, 1);
    assert.strictEqual(reg.findByHash(HASH_B).length, 0);
});

test('listModels: lists all known models', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_A, 'ModelA'));
    reg.addAnnouncement(makeClaim('safebox://peer3', 'https://peer3:8443', HASH_B, 'ModelB'));

    const models = reg.listModels();
    assert.strictEqual(models.length, 2);

    const modelA = models.find(m => m.manifestHash === HASH_A);
    assert.ok(modelA);
    assert.strictEqual(modelA.peerCount, 2);
    assert.strictEqual(modelA.modelName, 'ModelA');
});

test('prune: removes stale entries', () => {
    const reg = new ModelRegistry({ announceTtlMs: 1 }); // 1ms TTL
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));

    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    const pruned = reg.prune();
    assert.strictEqual(pruned, 1);
    assert.strictEqual(reg.size, 0);
});

test('findByHash: auto-prunes stale entries on read', () => {
    const reg = new ModelRegistry({ announceTtlMs: 1 });
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));

    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    const peers = reg.findByHash(HASH_A);
    assert.strictEqual(peers.length, 0);
    assert.strictEqual(reg.size, 0);
});

test('size: reports total peer-model entries', () => {
    const reg = new ModelRegistry();
    assert.strictEqual(reg.size, 0);

    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    assert.strictEqual(reg.size, 1);

    reg.addAnnouncement(makeClaim('safebox://peer2', 'https://peer2:8443', HASH_B, 'ModelB'));
    assert.strictEqual(reg.size, 2);
});

test('addAnnouncement: rejects null claim', () => {
    const reg = new ModelRegistry();
    const result = reg.addAnnouncement(null);
    assert.strictEqual(result.ok, false);
});

test('addAnnouncement: rejects claim missing manifestHash', () => {
    const reg = new ModelRegistry();
    const result = reg.addAnnouncement({
        iss: 'safebox://peer1',
        stm: { type: 'model_available', endpoint: 'https://peer1:8443' }
    });
    assert.strictEqual(result.ok, false);
});

test('addAnnouncement: rejects claim missing iss', () => {
    const reg = new ModelRegistry();
    const result = reg.addAnnouncement({
        stm: { type: 'model_available', endpoint: 'https://peer1:8443', manifestHash: HASH_A }
    });
    assert.strictEqual(result.ok, false);
});

test('addAnnouncement: rejects claim missing endpoint', () => {
    const reg = new ModelRegistry();
    const result = reg.addAnnouncement({
        iss: 'safebox://peer1',
        stm: { type: 'model_available', manifestHash: HASH_A }
    });
    assert.strictEqual(result.ok, false);
});

test('removeAnnouncement: no-op for unknown hash', () => {
    const reg = new ModelRegistry();
    reg.removeAnnouncement('c'.repeat(64), 'safebox://unknown');
    assert.strictEqual(reg.size, 0);
});

test('removePeer: no-op for unknown peer', () => {
    const reg = new ModelRegistry();
    reg.addAnnouncement(makeClaim('safebox://peer1', 'https://peer1:8443', HASH_A, 'ModelA'));
    reg.removePeer('safebox://unknown');
    assert.strictEqual(reg.size, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Discovery gossip integration test (requires Q/Data)
// ═════════════════════════════════════════════════════════════════════════════

console.log('# Discovery + ModelRegistry integration');

if (!hasQ) {
    skip('model_available claims route to ModelRegistry via Discovery', 'Q/Data not available');
    skip('Discovery gossip de-duplicates model_available claims', 'Q/Data not available');
} else {
    const Discovery = require(path.join(libDir, 'Discovery'));
    const Registry = require(path.join(libDir, 'Registry'));

    asyncTest('model_available claims route to ModelRegistry via Discovery', async () => {
        const registry = new Registry();
        const modelRegistry = new ModelRegistry();
        const discovery = new Discovery({
            identity: { stm: { peerUri: 'safebox://localnode', endpoint: 'https://localhost:8443' } },
            registry,
            modelRegistry,
            bootstrapPeers: [],
            fanout: 0,
            syncInterval: 999999
        });

        const claim = makeClaim('safebox://remote-peer', 'https://remote:8443', 'f'.repeat(64), 'TestLLM', '3.0');
        const result = await discovery.receiveGossip(claim, 'safebox://remote-peer', 1);
        assert.strictEqual(result.accepted, true);

        const peers = modelRegistry.findByHash('f'.repeat(64));
        assert.strictEqual(peers.length, 1);
        assert.strictEqual(peers[0].endpoint, 'https://remote:8443');
        assert.strictEqual(peers[0].modelName, 'TestLLM');

        discovery.stop();
    });

    asyncTest('Discovery gossip de-duplicates model_available claims', async () => {
        const registry = new Registry();
        const modelRegistry = new ModelRegistry();
        const discovery = new Discovery({
            identity: { stm: { peerUri: 'safebox://localnode', endpoint: 'https://localhost:8443' } },
            registry,
            modelRegistry,
            bootstrapPeers: [],
            fanout: 0,
            syncInterval: 999999
        });

        const claim = makeClaim('safebox://remote-peer', 'https://remote:8443', 'd'.repeat(64), 'DupModel');
        const r1 = await discovery.receiveGossip(claim, 'safebox://remote-peer', 1);
        assert.strictEqual(r1.accepted, true);

        const r2 = await discovery.receiveGossip(claim, 'safebox://remote-peer', 1);
        assert.strictEqual(r2.accepted, false);
        assert.ok(r2.reason.includes('Duplicate'));

        discovery.stop();
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. End-to-end: Claims → ModelRegistry → findByHash/findByName
// ═════════════════════════════════════════════════════════════════════════════

console.log('# End-to-end: Claims -> ModelRegistry round-trip');

test('Claims.modelAvailable -> ModelRegistry.addAnnouncement -> findByHash round-trip', () => {
    const reg = new ModelRegistry();
    const hash = 'c'.repeat(64);
    const claim = Claims.modelAvailable({
        safeboxUri: 'safebox://e2e-peer',
        endpoint: 'https://e2e:8443',
        manifestHash: hash,
        modelName: 'E2E-Model',
        modelVersion: '1.0',
        modelType: 'LLM',
        capacity: 8
    });

    const result = reg.addAnnouncement(claim);
    assert.strictEqual(result.ok, true);

    const peers = reg.findByHash(hash);
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].safeboxUri, 'safebox://e2e-peer');
    assert.strictEqual(peers[0].endpoint, 'https://e2e:8443');
    assert.strictEqual(peers[0].modelName, 'E2E-Model');
    assert.strictEqual(peers[0].modelVersion, '1.0');
    assert.strictEqual(peers[0].modelType, 'LLM');
    assert.strictEqual(peers[0].capacity, 8);
});

test('Claims.modelAvailable -> ModelRegistry.findByName round-trip', () => {
    const reg = new ModelRegistry();
    const hash = 'e'.repeat(64);
    const claim = Claims.modelAvailable({
        safeboxUri: 'safebox://name-peer',
        endpoint: 'https://name:8443',
        manifestHash: hash,
        modelName: 'NamedModel',
        modelVersion: '2.5',
        modelType: 'embedding'
    });
    reg.addAnnouncement(claim);

    const results = reg.findByName('NamedModel');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].manifestHash, hash);

    const versioned = reg.findByName('NamedModel', '2.5');
    assert.strictEqual(versioned.length, 1);

    const wrong = reg.findByName('NamedModel', '9.9');
    assert.strictEqual(wrong.length, 0);
});

test('Multiple peers announce same model, listModels shows correct count', () => {
    const reg = new ModelRegistry();
    const hash = 'f'.repeat(64);

    for (let i = 1; i <= 5; i++) {
        reg.addAnnouncement(Claims.modelAvailable({
            safeboxUri: 'safebox://peer' + i,
            endpoint: 'https://peer' + i + ':8443',
            manifestHash: hash,
            modelName: 'PopularModel'
        }));
    }

    const models = reg.listModels();
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].peerCount, 5);
    assert.strictEqual(models[0].modelName, 'PopularModel');

    const peers = reg.findByHash(hash);
    assert.strictEqual(peers.length, 5);
});

// ═════════════════════════════════════════════════════════════════════════════
// Done
// ═════════════════════════════════════════════════════════════════════════════

console.log(`\n# ${passed}/${testCount} passed`);

if (failed > 0) {
    console.log(`FAIL: ${failed} test(s) failed`);
    process.exit(1);
}
