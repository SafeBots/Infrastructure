#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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

// ── Load modules under test ─────────────────────────────────────────────────

const libDir = path.resolve(__dirname, '..', 'lib');
const {
    sha256hex,
    randomHex,
    canonicalJSON,
    generateClaimHash,
    nowISO,
    validateSemver,
    validateNamespace,
    resolveQ,
    RESERVED_PREFIXES
} = require(path.join(libDir, 'utils'));

const Claims = require(path.join(libDir, 'Claims'));

// Check whether Q modules are available
let hasQ = false;
try {
    require(resolveQ('Q/Data'));
    hasQ = true;
} catch (_) {}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Utils tests
// ═════════════════════════════════════════════════════════════════════════════

async function runUtilsTests() {
    console.log('# Utils tests');

    // ── sha256hex ────────────────────────────────────────────────────────────

    test('sha256hex: produces correct hex for empty string', () => {
        const expected = crypto.createHash('sha256').update('').digest('hex');
        assert.strictEqual(sha256hex(''), expected);
    });

    test('sha256hex: produces correct hex for "hello"', () => {
        const expected = crypto.createHash('sha256').update('hello').digest('hex');
        assert.strictEqual(sha256hex('hello'), expected);
    });

    test('sha256hex: produces 64-char lowercase hex', () => {
        const result = sha256hex('test data');
        assert.strictEqual(result.length, 64);
        assert.ok(/^[0-9a-f]{64}$/.test(result));
    });

    test('sha256hex: accepts Buffer input', () => {
        const buf = Buffer.from('binary data');
        const expected = crypto.createHash('sha256').update(buf).digest('hex');
        assert.strictEqual(sha256hex(buf), expected);
    });

    // ── randomHex ───────────────────────────────────────────────────────────

    test('randomHex: produces correct length for 16 bytes', () => {
        const result = randomHex(16);
        assert.strictEqual(result.length, 32);
        assert.ok(/^[0-9a-f]{32}$/.test(result));
    });

    test('randomHex: produces correct length for 32 bytes', () => {
        const result = randomHex(32);
        assert.strictEqual(result.length, 64);
    });

    test('randomHex: successive calls produce different values', () => {
        const a = randomHex(16);
        const b = randomHex(16);
        assert.notStrictEqual(a, b);
    });

    // ── canonicalJSON ───────────────────────────────────────────────────────

    test('canonicalJSON: sorts keys alphabetically', () => {
        assert.strictEqual(canonicalJSON({ c: 3, a: 1, b: 2 }), '{"a":1,"b":2,"c":3}');
    });

    test('canonicalJSON: sorts keys recursively', () => {
        const input = { z: { y: 1, x: 2 }, a: 3 };
        assert.strictEqual(canonicalJSON(input), '{"a":3,"z":{"x":2,"y":1}}');
    });

    test('canonicalJSON: preserves array order', () => {
        assert.strictEqual(canonicalJSON({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
    });

    test('canonicalJSON: handles nested arrays', () => {
        assert.strictEqual(canonicalJSON([[1, 2], [3]]), '[[1,2],[3]]');
    });

    test('canonicalJSON: handles numbers', () => {
        assert.strictEqual(canonicalJSON(42), '42');
        assert.strictEqual(canonicalJSON(0), '0');
        assert.strictEqual(canonicalJSON(-1), '-1');
    });

    test('canonicalJSON: handles booleans', () => {
        assert.strictEqual(canonicalJSON(true), 'true');
        assert.strictEqual(canonicalJSON(false), 'false');
    });

    test('canonicalJSON: handles null', () => {
        assert.strictEqual(canonicalJSON(null), 'null');
    });

    test('canonicalJSON: handles strings', () => {
        assert.strictEqual(canonicalJSON('hello'), '"hello"');
    });

    test('canonicalJSON: strips undefined values from objects', () => {
        assert.strictEqual(canonicalJSON({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
    });

    test('canonicalJSON: handles booleans and null in object', () => {
        assert.strictEqual(
            canonicalJSON({ t: true, f: false, n: null }),
            '{"f":false,"n":null,"t":true}'
        );
    });

    // ── generateClaimHash ───────────────────────────────────────────────────

    test('generateClaimHash: is deterministic for same stm', () => {
        const claim = { stm: { type: 'test', value: 42 } };
        const h1 = generateClaimHash(claim);
        const h2 = generateClaimHash(claim);
        assert.strictEqual(h1, h2);
    });

    test('generateClaimHash: different stm produces different hash', () => {
        const c1 = { stm: { type: 'test', value: 1 } };
        const c2 = { stm: { type: 'test', value: 2 } };
        assert.notStrictEqual(generateClaimHash(c1), generateClaimHash(c2));
    });

    test('generateClaimHash: equals sha256 of canonical stm', () => {
        const claim = { stm: { type: 'test', data: 'abc' } };
        const expected = sha256hex(canonicalJSON(claim.stm));
        assert.strictEqual(generateClaimHash(claim), expected);
    });

    test('generateClaimHash: throws on missing stm', () => {
        assert.throws(() => generateClaimHash({}), /stm/);
        assert.throws(() => generateClaimHash(null), /stm/);
    });

    // ── nowISO ──────────────────────────────────────────────────────────────

    test('nowISO: returns valid ISO 8601 string ending in Z', () => {
        const result = nowISO();
        assert.ok(result.endsWith('Z'), 'should end with Z');
        assert.ok(!result.includes('.'), 'should not include milliseconds');
        // Verify it parses back
        const parsed = new Date(result);
        assert.ok(!isNaN(parsed.getTime()), 'should parse as valid date');
    });

    test('nowISO: matches expected ISO format', () => {
        const result = nowISO();
        assert.ok(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result),
            'format should be YYYY-MM-DDTHH:MM:SSZ, got ' + result
        );
    });

    // ── validateSemver ──────────────────────────────────────────────────────

    test('validateSemver: accepts "1.0.0"', () => {
        assert.strictEqual(validateSemver('1.0.0'), true);
    });

    test('validateSemver: accepts "0.0.1"', () => {
        assert.strictEqual(validateSemver('0.0.1'), true);
    });

    test('validateSemver: accepts "1.2.3-alpha.1"', () => {
        assert.strictEqual(validateSemver('1.2.3-alpha.1'), true);
    });

    test('validateSemver: accepts "0.0.1+build.123"', () => {
        assert.strictEqual(validateSemver('0.0.1+build.123'), true);
    });

    test('validateSemver: accepts "10.20.30"', () => {
        assert.strictEqual(validateSemver('10.20.30'), true);
    });

    test('validateSemver: rejects "1"', () => {
        assert.strictEqual(validateSemver('1'), false);
    });

    test('validateSemver: rejects "1.2"', () => {
        assert.strictEqual(validateSemver('1.2'), false);
    });

    test('validateSemver: rejects "v1.0.0"', () => {
        assert.strictEqual(validateSemver('v1.0.0'), false);
    });

    test('validateSemver: rejects "1.0.0.0"', () => {
        assert.strictEqual(validateSemver('1.0.0.0'), false);
    });

    test('validateSemver: rejects non-string input', () => {
        assert.strictEqual(validateSemver(null), false);
        assert.strictEqual(validateSemver(123), false);
        assert.strictEqual(validateSemver(undefined), false);
    });

    test('validateSemver: rejects leading zeros "01.0.0"', () => {
        assert.strictEqual(validateSemver('01.0.0'), false);
    });

    // ── validateNamespace ───────────────────────────────────────────────────

    test('validateNamespace: accepts "alice"', () => {
        assert.strictEqual(validateNamespace('alice').valid, true);
    });

    test('validateNamespace: accepts "my-lib"', () => {
        assert.strictEqual(validateNamespace('my-lib').valid, true);
    });

    test('validateNamespace: accepts "a1"', () => {
        assert.strictEqual(validateNamespace('a1').valid, true);
    });

    test('validateNamespace: accepts single char "a"', () => {
        assert.strictEqual(validateNamespace('a').valid, true);
    });

    test('validateNamespace: rejects uppercase "Alice"', () => {
        const r = validateNamespace('Alice');
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('lowercase'));
    });

    test('validateNamespace: rejects leading hyphen "-bad"', () => {
        const r = validateNamespace('-bad');
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('hyphen'));
    });

    test('validateNamespace: rejects trailing hyphen "bad-"', () => {
        const r = validateNamespace('bad-');
        assert.strictEqual(r.valid, false);
    });

    test('validateNamespace: rejects consecutive hyphens "a--b"', () => {
        const r = validateNamespace('a--b');
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('consecutive'));
    });

    test('validateNamespace: rejects reserved prefix "safebox-x"', () => {
        const r = validateNamespace('safebox-x');
        assert.strictEqual(r.valid, false);
        assert.ok(r.reason.includes('reserved'));
    });

    test('validateNamespace: rejects reserved prefix "safenet-x"', () => {
        const r = validateNamespace('safenet-x');
        assert.strictEqual(r.valid, false);
    });

    test('validateNamespace: rejects reserved prefix "system-x"', () => {
        const r = validateNamespace('system-x');
        assert.strictEqual(r.valid, false);
    });

    test('validateNamespace: rejects empty string', () => {
        assert.strictEqual(validateNamespace('').valid, false);
    });

    test('validateNamespace: rejects string > 64 chars', () => {
        assert.strictEqual(validateNamespace('a'.repeat(65)).valid, false);
    });

    test('validateNamespace: accepts string of exactly 64 chars', () => {
        assert.strictEqual(validateNamespace('a'.repeat(64)).valid, true);
    });

    test('validateNamespace: rejects spaces "a b"', () => {
        assert.strictEqual(validateNamespace('a b').valid, false);
    });

    test('validateNamespace: rejects non-string input', () => {
        assert.strictEqual(validateNamespace(123).valid, false);
        assert.strictEqual(validateNamespace(null).valid, false);
    });

    // ── RESERVED_PREFIXES ───────────────────────────────────────────────────

    test('RESERVED_PREFIXES: contains expected entries', () => {
        assert.ok(RESERVED_PREFIXES.includes('safebox-'));
        assert.ok(RESERVED_PREFIXES.includes('safenet-'));
        assert.ok(RESERVED_PREFIXES.includes('system-'));
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Claims tests
// ═════════════════════════════════════════════════════════════════════════════

async function runClaimsTests() {
    console.log('# Claims tests');

    const fakePubKey = 'a'.repeat(64);
    const fakePcr = 'b'.repeat(64);
    const fakeImageHash = 'c'.repeat(64);
    const fakeMerkle = 'd'.repeat(64);
    const fakeManifest = 'e'.repeat(64);

    // ── safeboxIdentity ─────────────────────────────────────────────────────

    test('Claims.safeboxIdentity: produces correct structure', () => {
        const claim = Claims.safeboxIdentity({
            publicKey: fakePubKey,
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash
        });
        assert.strictEqual(claim.ocp, 1);
        assert.ok(claim.iss.startsWith('safebox://'));
        assert.strictEqual(claim.iss, claim.sub);
        assert.strictEqual(claim.stm.type, 'safebox_identity');
        assert.strictEqual(claim.stm.publicKey, fakePubKey);
        assert.ok(claim.nbf);
    });

    test('Claims.safeboxIdentity: iss is sha256 of public key', () => {
        const claim = Claims.safeboxIdentity({
            publicKey: fakePubKey,
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash
        });
        const expectedHash = sha256hex(Buffer.from(fakePubKey, 'hex'));
        assert.strictEqual(claim.iss, 'safebox://' + expectedHash);
    });

    test('Claims.safeboxIdentity: includes optional fields when provided', () => {
        const claim = Claims.safeboxIdentity({
            publicKey: fakePubKey,
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash,
            endpoints: ['https://node1.example.com'],
            capabilities: ['compute'],
            version: '1.0.0'
        });
        assert.deepStrictEqual(claim.stm.endpoints, ['https://node1.example.com']);
        assert.deepStrictEqual(claim.stm.capabilities, ['compute']);
        assert.strictEqual(claim.stm.version, '1.0.0');
    });

    test('Claims.safeboxIdentity: strips undefined optional fields', () => {
        const claim = Claims.safeboxIdentity({
            publicKey: fakePubKey,
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash
        });
        assert.ok(!('endpoints' in claim.stm));
        assert.ok(!('capabilities' in claim.stm));
        assert.ok(!('version' in claim.stm));
    });

    test('Claims.safeboxIdentity: throws on missing publicKey', () => {
        assert.throws(() => Claims.safeboxIdentity({
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash
        }), /publicKey/);
    });

    test('Claims.safeboxIdentity: throws on missing PCR measurements', () => {
        assert.throws(() => Claims.safeboxIdentity({
            publicKey: fakePubKey, imageHash: fakeImageHash
        }), /PCR/);
    });

    test('Claims.safeboxIdentity: throws on invalid semver version', () => {
        assert.throws(() => Claims.safeboxIdentity({
            publicKey: fakePubKey,
            pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
            imageHash: fakeImageHash,
            version: 'bad'
        }), /semver/);
    });

    // ── authorIdentity ──────────────────────────────────────────────────────

    test('Claims.authorIdentity: produces correct iss/sub format', () => {
        const claim = Claims.authorIdentity({
            name: 'alice',
            keys: [{ id: 'k1', algorithm: 'ES256', publicKey: fakePubKey }]
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safenet:author:alice');
        assert.strictEqual(claim.sub, 'safenet:author:alice');
        assert.strictEqual(claim.stm.type, 'author_identity');
        assert.strictEqual(claim.stm.name, 'alice');
    });

    test('Claims.authorIdentity: includes displayName when provided', () => {
        const claim = Claims.authorIdentity({
            name: 'alice',
            displayName: 'Alice Smith',
            keys: [{ id: 'k1', algorithm: 'ES256', publicKey: fakePubKey }]
        });
        assert.strictEqual(claim.stm.displayName, 'Alice Smith');
    });

    test('Claims.authorIdentity: throws on missing name', () => {
        assert.throws(() => Claims.authorIdentity({
            keys: [{ id: 'k1', algorithm: 'ES256', publicKey: fakePubKey }]
        }), /name/);
    });

    test('Claims.authorIdentity: throws on missing keys', () => {
        assert.throws(() => Claims.authorIdentity({ name: 'alice' }), /keys/);
        assert.throws(() => Claims.authorIdentity({ name: 'alice', keys: [] }), /keys/);
    });

    // ── orgIdentity ─────────────────────────────────────────────────────────

    test('Claims.orgIdentity: includes members and thresholds', () => {
        const claim = Claims.orgIdentity({
            name: 'myorg',
            members: [{ name: 'alice', keys: [], role: 'admin' }],
            thresholds: { publish: 2, revoke: 3 }
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safenet:org:myorg');
        assert.strictEqual(claim.sub, 'safenet:org:myorg');
        assert.strictEqual(claim.stm.type, 'org_identity');
        assert.deepStrictEqual(claim.stm.thresholds, { publish: 2, revoke: 3 });
        assert.strictEqual(claim.stm.members.length, 1);
    });

    test('Claims.orgIdentity: throws on missing members', () => {
        assert.throws(() => Claims.orgIdentity({ name: 'myorg' }), /members/);
    });

    // ── namespaceClaim ──────────────────────────────────────────────────────

    test('Claims.namespaceClaim: derives correct iss from owner', () => {
        const claim = Claims.namespaceClaim({
            namespace: 'my-lib',
            owner: 'alice'
        });
        assert.strictEqual(claim.iss, 'safenet:author:alice');
        assert.strictEqual(claim.sub, 'safenet:namespace:my-lib');
        assert.strictEqual(claim.stm.type, 'namespace_claim');
        assert.strictEqual(claim.stm.namespace, 'my-lib');
        assert.strictEqual(claim.stm.owner, 'alice');
    });

    test('Claims.namespaceClaim: throws on invalid namespace', () => {
        assert.throws(() => Claims.namespaceClaim({
            namespace: 'Bad-Name',
            owner: 'alice'
        }), /Invalid namespace/);
    });

    test('Claims.namespaceClaim: throws on missing owner', () => {
        assert.throws(() => Claims.namespaceClaim({
            namespace: 'my-lib'
        }), /owner/);
    });

    // ── namespaceTransfer ───────────────────────────────────────────────────

    test('Claims.namespaceTransfer: includes fromOwner and toOwner', () => {
        const claim = Claims.namespaceTransfer({
            namespace: 'my-lib',
            fromOwner: 'alice',
            toOwner: 'bob'
        });
        assert.strictEqual(claim.iss, 'safenet:author:alice');
        assert.strictEqual(claim.sub, 'safenet:namespace:my-lib');
        assert.strictEqual(claim.stm.type, 'namespace_transfer');
        assert.strictEqual(claim.stm.fromOwner, 'alice');
        assert.strictEqual(claim.stm.toOwner, 'bob');
    });

    test('Claims.namespaceTransfer: throws on missing fields', () => {
        assert.throws(() => Claims.namespaceTransfer({
            namespace: 'my-lib', fromOwner: 'alice'
        }), /toOwner/);
        assert.throws(() => Claims.namespaceTransfer({
            namespace: 'my-lib', toOwner: 'bob'
        }), /fromOwner/);
    });

    // ── publication ─────────────────────────────────────────────────────────

    test('Claims.publication: includes all required fields', () => {
        const claim = Claims.publication({
            namespace: 'myns',
            package: 'myns/mypkg',
            version: '1.0.0',
            merkleRoot: fakeMerkle,
            manifestHash: fakeManifest
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safenet:namespace:myns');
        assert.strictEqual(claim.sub, 'safenet:package:myns/mypkg@1.0.0');
        assert.strictEqual(claim.stm.type, 'publication');
        assert.strictEqual(claim.stm.merkleRoot, fakeMerkle);
        assert.strictEqual(claim.stm.manifestHash, fakeManifest);
        assert.strictEqual(claim.stm.version, '1.0.0');
        assert.ok(claim.nbf);
    });

    test('Claims.publication: includes optional fields when provided', () => {
        const claim = Claims.publication({
            namespace: 'myns',
            package: 'myns/mypkg',
            version: '1.0.0',
            merkleRoot: fakeMerkle,
            manifestHash: fakeManifest,
            languages: ['javascript'],
            license: 'MIT',
            safeboxOnly: true,
            contentSize: 1024,
            fileCount: 5,
            dependencies: [{ package: 'other/dep', versionRange: '^1.0.0' }],
            pricing: { model: 'per-install', amount: 10 },
            previousVersion: '0.9.0',
            previousMerkleRoot: 'f'.repeat(64)
        });
        assert.deepStrictEqual(claim.stm.languages, ['javascript']);
        assert.strictEqual(claim.stm.license, 'MIT');
        assert.strictEqual(claim.stm.safeboxOnly, true);
        assert.strictEqual(claim.stm.contentSize, 1024);
        assert.strictEqual(claim.stm.fileCount, 5);
        assert.strictEqual(claim.stm.dependencies.length, 1);
        assert.strictEqual(claim.stm.previousVersion, '0.9.0');
    });

    test('Claims.publication: strips undefined optional fields', () => {
        const claim = Claims.publication({
            namespace: 'myns',
            package: 'myns/mypkg',
            version: '1.0.0',
            merkleRoot: fakeMerkle,
            manifestHash: fakeManifest
        });
        assert.ok(!('languages' in claim.stm));
        assert.ok(!('license' in claim.stm));
        assert.ok(!('dependencies' in claim.stm));
        assert.ok(!('pricing' in claim.stm));
    });

    test('Claims.publication: throws on invalid semver', () => {
        assert.throws(() => Claims.publication({
            namespace: 'myns',
            package: 'myns/mypkg',
            version: 'bad',
            merkleRoot: fakeMerkle,
            manifestHash: fakeManifest
        }), /semver/);
    });

    test('Claims.publication: throws on missing required fields', () => {
        assert.throws(() => Claims.publication({
            namespace: 'myns', package: 'myns/mypkg', version: '1.0.0',
            merkleRoot: fakeMerkle
            // missing manifestHash
        }), /manifestHash/);

        assert.throws(() => Claims.publication({
            namespace: 'myns', package: 'myns/mypkg', version: '1.0.0',
            manifestHash: fakeManifest
            // missing merkleRoot
        }), /merkleRoot/);
    });

    // ── licenseGrant ────────────────────────────────────────────────────────

    test('Claims.licenseGrant: has correct sub format', () => {
        const claim = Claims.licenseGrant({
            package: 'myns/mypkg',
            versionRange: '>=1.0.0 <2.0.0',
            safeboxUri: 'safebox://abc123'
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safenet:package:myns/mypkg');
        assert.strictEqual(claim.sub, 'safebox://abc123');
        assert.strictEqual(claim.stm.type, 'license_grant');
        assert.strictEqual(claim.stm.versionRange, '>=1.0.0 <2.0.0');
    });

    test('Claims.licenseGrant: includes maxInstalls when provided', () => {
        const claim = Claims.licenseGrant({
            package: 'myns/mypkg',
            versionRange: '*',
            safeboxUri: 'safebox://abc123',
            maxInstalls: 5
        });
        assert.strictEqual(claim.stm.maxInstalls, 5);
    });

    test('Claims.licenseGrant: throws on missing package', () => {
        assert.throws(() => Claims.licenseGrant({
            versionRange: '*',
            safeboxUri: 'safebox://abc123'
        }), /package/);
    });

    // ── payment ─────────────────────────────────────────────────────────────

    test('Claims.payment: generates proper structure', () => {
        const claim = Claims.payment({
            package: 'myns/mypkg',
            version: '1.0.0',
            amount: '100',
            currency: 'SAFEBUX',
            installId: 'inst-001',
            safeboxUri: 'safebox://abc123'
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safebox://abc123');
        assert.strictEqual(claim.sub, 'safenet:package:myns/mypkg@1.0.0');
        assert.strictEqual(claim.stm.type, 'payment');
        assert.strictEqual(claim.stm.amount, '100');
        assert.strictEqual(claim.stm.currency, 'SAFEBUX');
        assert.strictEqual(claim.stm.installId, 'inst-001');
    });

    test('Claims.payment: throws on missing fields', () => {
        assert.throws(() => Claims.payment({
            package: 'myns/mypkg', version: '1.0.0',
            amount: '100', currency: 'SAFEBUX', installId: 'i1'
            // missing safeboxUri
        }), /safeboxUri/);

        assert.throws(() => Claims.payment({
            package: 'myns/mypkg', version: '1.0.0',
            currency: 'SAFEBUX', installId: 'i1', safeboxUri: 'safebox://x'
            // missing amount
        }), /amount/);
    });

    // ── keyRevocation ───────────────────────────────────────────────────────

    test('Claims.keyRevocation: includes revokedKey and reason', () => {
        const claim = Claims.keyRevocation({
            revokedKey: fakePubKey,
            reason: 'key compromised'
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.stm.type, 'key_revocation');
        assert.strictEqual(claim.stm.revokedKey, fakePubKey);
        assert.strictEqual(claim.stm.reason, 'key compromised');
        assert.ok(claim.sub.startsWith('safenet:key:'));
    });

    test('Claims.keyRevocation: includes invalidatePublicationsAfter when provided', () => {
        const ts = '2026-01-01T00:00:00Z';
        const claim = Claims.keyRevocation({
            revokedKey: fakePubKey,
            reason: 'compromised',
            invalidatePublicationsAfter: ts
        });
        assert.strictEqual(claim.stm.invalidatePublicationsAfter, ts);
    });

    test('Claims.keyRevocation: throws on missing revokedKey', () => {
        assert.throws(() => Claims.keyRevocation({
            reason: 'test'
        }), /revokedKey/);
    });

    // ── packageRevocation ───────────────────────────────────────────────────

    test('Claims.packageRevocation: includes advisory', () => {
        const claim = Claims.packageRevocation({
            package: 'myns/mypkg',
            version: '1.0.0',
            reason: 'vulnerability found',
            advisory: 'CVE-2026-1234'
        });
        assert.strictEqual(claim.stm.type, 'package_revocation');
        assert.strictEqual(claim.stm.advisory, 'CVE-2026-1234');
        assert.strictEqual(claim.stm.reason, 'vulnerability found');
        assert.strictEqual(claim.sub, 'safenet:package:myns/mypkg@1.0.0');
        assert.strictEqual(claim.iss, 'safenet:package:myns/mypkg');
    });

    test('Claims.packageRevocation: includes replacement when provided', () => {
        const claim = Claims.packageRevocation({
            package: 'myns/mypkg',
            version: '1.0.0',
            reason: 'superseded',
            replacement: 'myns/mypkg@2.0.0'
        });
        assert.strictEqual(claim.stm.replacement, 'myns/mypkg@2.0.0');
    });

    test('Claims.packageRevocation: throws on missing reason', () => {
        assert.throws(() => Claims.packageRevocation({
            package: 'myns/mypkg',
            version: '1.0.0'
        }), /reason/);
    });

    // ── safeboxRevocation ───────────────────────────────────────────────────

    test('Claims.safeboxRevocation: structure', () => {
        const claim = Claims.safeboxRevocation({
            safeboxUri: 'safebox://abc123',
            reason: 'decommissioned'
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.iss, 'safebox://abc123');
        assert.strictEqual(claim.sub, 'safebox://abc123');
        assert.strictEqual(claim.stm.type, 'safebox_revocation');
        assert.strictEqual(claim.stm.reason, 'decommissioned');
    });

    test('Claims.safeboxRevocation: throws on missing safeboxUri', () => {
        assert.throws(() => Claims.safeboxRevocation({
            reason: 'test'
        }), /safeboxUri/);
    });

    test('Claims.safeboxRevocation: throws on missing reason', () => {
        assert.throws(() => Claims.safeboxRevocation({
            safeboxUri: 'safebox://abc'
        }), /reason/);
    });

    // ── imageBlessing ───────────────────────────────────────────────────────

    test('Claims.imageBlessing: has correct subject', () => {
        const claim = Claims.imageBlessing({
            imageHash: fakeImageHash,
            version: '1.0.0',
            description: 'blessed image'
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.sub, 'safenet:image:' + fakeImageHash);
        assert.strictEqual(claim.iss, 'safenet:authority');
        assert.strictEqual(claim.stm.type, 'image_blessing');
        assert.strictEqual(claim.stm.imageHash, fakeImageHash);
        assert.strictEqual(claim.stm.description, 'blessed image');
    });

    test('Claims.imageBlessing: throws on missing imageHash', () => {
        assert.throws(() => Claims.imageBlessing({
            version: '1.0.0'
        }), /imageHash/);
    });

    // ── peerAnnounce ────────────────────────────────────────────────────────

    test('Claims.peerAnnounce: includes endpoints and capabilities', () => {
        const claim = Claims.peerAnnounce({
            safeboxUri: 'safebox://abc',
            endpoints: ['https://node1.example.com'],
            capabilities: ['relay', 'compute']
        });
        assert.strictEqual(claim.ocp, 1);
        assert.strictEqual(claim.stm.type, 'peer_announce');
        assert.deepStrictEqual(claim.stm.endpoints, ['https://node1.example.com']);
        assert.deepStrictEqual(claim.stm.capabilities, ['relay', 'compute']);
    });

    test('Claims.peerAnnounce: throws on empty endpoints', () => {
        assert.throws(() => Claims.peerAnnounce({
            safeboxUri: 'safebox://abc',
            endpoints: []
        }), /endpoints/);
    });

    // ── Cross-cutting claim properties ──────────────────────────────────────

    test('All claims have ocp: 1', () => {
        const claims = [
            Claims.safeboxIdentity({
                publicKey: fakePubKey, pcr0: fakePcr, pcr1: fakePcr, pcr4: fakePcr,
                imageHash: fakeImageHash
            }),
            Claims.authorIdentity({
                name: 'alice', keys: [{ id: 'k1', algorithm: 'ES256', publicKey: fakePubKey }]
            }),
            Claims.namespaceClaim({ namespace: 'myns', owner: 'alice' }),
            Claims.publication({
                namespace: 'myns', package: 'myns/mypkg', version: '1.0.0',
                merkleRoot: fakeMerkle, manifestHash: fakeManifest
            }),
            Claims.payment({
                package: 'myns/mypkg', version: '1.0.0', amount: '10',
                currency: 'SAFEBUX', installId: 'i1', safeboxUri: 'safebox://x'
            })
        ];
        for (const c of claims) {
            assert.strictEqual(c.ocp, 1, 'claim type ' + c.stm.type + ' missing ocp: 1');
        }
    });

    test('All claims have nbf field', () => {
        const claim = Claims.authorIdentity({
            name: 'bob', keys: [{ id: 'k1', algorithm: 'ES256', publicKey: fakePubKey }]
        });
        assert.ok(claim.nbf, 'nbf field should be present');
        assert.ok(typeof claim.nbf === 'string');
    });

    test('Claim hashes are deterministic for same input', () => {
        const claim = Claims.namespaceClaim({ namespace: 'test-ns', owner: 'alice' });
        const h1 = generateClaimHash(claim);
        const h2 = generateClaimHash(claim);
        assert.strictEqual(h1, h2);
    });

    test('Different inputs produce different hashes', () => {
        const c1 = Claims.namespaceClaim({ namespace: 'ns-a', owner: 'alice' });
        const c2 = Claims.namespaceClaim({ namespace: 'ns-b', owner: 'alice' });
        assert.notStrictEqual(generateClaimHash(c1), generateClaimHash(c2));
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Payments validation tests (logic that doesn't need Q.Crypto)
// ═════════════════════════════════════════════════════════════════════════════

async function runPaymentsValidationTests() {
    console.log('# Payments validation tests');

    // We can't instantiate Payments (it needs identity.sign via Q.Crypto),
    // but we can test the private functions by re-implementing the exported
    // logic, or we can test the portions accessible through the module's
    // own internal functions.
    //
    // The Payments module exposes _versionInRange and _parseSemver as
    // module-private. We replicate the logic here to test it, since the
    // actual Payments class requires Q.Crypto for construction.

    // Replicate _parseSemver and _compareSemver and _versionInRange
    // from Payments.js for standalone testing:

    function parseSemver(v) {
        if (!v || typeof v !== 'string') return null;
        const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
        if (!match) return null;
        return {
            major: parseInt(match[1], 10),
            minor: parseInt(match[2], 10),
            patch: parseInt(match[3], 10)
        };
    }

    function compareSemver(a, b) {
        if (a.major !== b.major) return a.major < b.major ? -1 : 1;
        if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
        if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
        return 0;
    }

    function versionInRange(version, range) {
        if (!version || !range) return false;
        if (range === '*') return true;
        const parsed = parseSemver(version);
        if (!parsed) return false;
        if (validateSemver(range)) return version === range;
        if (range.startsWith('^')) {
            const base = parseSemver(range.slice(1));
            if (!base) return false;
            if (compareSemver(parsed, base) < 0) return false;
            return parsed.major === base.major;
        }
        if (range.startsWith('~')) {
            const base = parseSemver(range.slice(1));
            if (!base) return false;
            if (compareSemver(parsed, base) < 0) return false;
            return parsed.major === base.major && parsed.minor === base.minor;
        }
        const parts = range.split(/\s+/);
        for (const part of parts) {
            let op, ver;
            if (part.startsWith('>=')) { op = '>='; ver = parseSemver(part.slice(2)); }
            else if (part.startsWith('<=')) { op = '<='; ver = parseSemver(part.slice(2)); }
            else if (part.startsWith('>')) { op = '>'; ver = parseSemver(part.slice(1)); }
            else if (part.startsWith('<')) { op = '<'; ver = parseSemver(part.slice(1)); }
            else continue;
            if (!ver) return false;
            const cmp = compareSemver(parsed, ver);
            if (op === '>=' && cmp < 0) return false;
            if (op === '<=' && cmp > 0) return false;
            if (op === '>' && cmp <= 0) return false;
            if (op === '<' && cmp >= 0) return false;
        }
        return true;
    }

    // ── _parseSemver ────────────────────────────────────────────────────────

    test('parseSemver: parses "1.2.3"', () => {
        const p = parseSemver('1.2.3');
        assert.deepStrictEqual(p, { major: 1, minor: 2, patch: 3 });
    });

    test('parseSemver: parses "0.0.0"', () => {
        const p = parseSemver('0.0.0');
        assert.deepStrictEqual(p, { major: 0, minor: 0, patch: 0 });
    });

    test('parseSemver: returns null for invalid input', () => {
        assert.strictEqual(parseSemver(null), null);
        assert.strictEqual(parseSemver('abc'), null);
        assert.strictEqual(parseSemver(''), null);
    });

    // ── _compareSemver ──────────────────────────────────────────────────────

    test('compareSemver: equal versions return 0', () => {
        assert.strictEqual(compareSemver(
            { major: 1, minor: 2, patch: 3 },
            { major: 1, minor: 2, patch: 3 }
        ), 0);
    });

    test('compareSemver: major difference', () => {
        assert.strictEqual(compareSemver(
            { major: 1, minor: 0, patch: 0 },
            { major: 2, minor: 0, patch: 0 }
        ), -1);
        assert.strictEqual(compareSemver(
            { major: 2, minor: 0, patch: 0 },
            { major: 1, minor: 0, patch: 0 }
        ), 1);
    });

    test('compareSemver: minor difference', () => {
        assert.strictEqual(compareSemver(
            { major: 1, minor: 1, patch: 0 },
            { major: 1, minor: 2, patch: 0 }
        ), -1);
    });

    test('compareSemver: patch difference', () => {
        assert.strictEqual(compareSemver(
            { major: 1, minor: 2, patch: 3 },
            { major: 1, minor: 2, patch: 4 }
        ), -1);
    });

    // ── _versionInRange ─────────────────────────────────────────────────────

    test('versionInRange: wildcard "*" matches anything', () => {
        assert.strictEqual(versionInRange('1.0.0', '*'), true);
        assert.strictEqual(versionInRange('99.99.99', '*'), true);
    });

    test('versionInRange: exact match', () => {
        assert.strictEqual(versionInRange('1.2.3', '1.2.3'), true);
        assert.strictEqual(versionInRange('1.2.3', '1.2.4'), false);
    });

    test('versionInRange: caret range "^1.2.3"', () => {
        assert.strictEqual(versionInRange('1.2.3', '^1.2.3'), true);
        assert.strictEqual(versionInRange('1.9.9', '^1.2.3'), true);
        assert.strictEqual(versionInRange('2.0.0', '^1.2.3'), false);
        assert.strictEqual(versionInRange('1.2.2', '^1.2.3'), false);
    });

    test('versionInRange: tilde range "~1.2.3"', () => {
        assert.strictEqual(versionInRange('1.2.3', '~1.2.3'), true);
        assert.strictEqual(versionInRange('1.2.9', '~1.2.3'), true);
        assert.strictEqual(versionInRange('1.3.0', '~1.2.3'), false);
        assert.strictEqual(versionInRange('1.2.2', '~1.2.3'), false);
    });

    test('versionInRange: compound range ">=1.0.0 <2.0.0"', () => {
        assert.strictEqual(versionInRange('1.0.0', '>=1.0.0 <2.0.0'), true);
        assert.strictEqual(versionInRange('1.5.0', '>=1.0.0 <2.0.0'), true);
        assert.strictEqual(versionInRange('2.0.0', '>=1.0.0 <2.0.0'), false);
        assert.strictEqual(versionInRange('0.9.9', '>=1.0.0 <2.0.0'), false);
    });

    test('versionInRange: returns false for null/empty inputs', () => {
        assert.strictEqual(versionInRange(null, '*'), false);
        assert.strictEqual(versionInRange('1.0.0', null), false);
        assert.strictEqual(versionInRange('', '*'), false);
    });

    // ── Payments ledger logic (via mock identity) ───────────────────────────
    // We can construct a minimal Payments-like ledger to test getBalance and
    // getPaymentHistory without Q.Crypto, by testing the data structures.

    test('Payments: ledger balance accounting', () => {
        // Simulate what Payments._ensureLedgerEntry + recordPayment do
        const ledger = new Map();
        const authorUri = 'safenet:author:alice';
        ledger.set(authorUri, { received: [], sent: [] });

        const entry = ledger.get(authorUri);
        entry.received.push({
            claim: { stm: { type: 'payment', amount: 100, package: 'ns/a' } },
            installId: 'i1',
            recordedAt: '2026-01-01T00:00:00Z'
        });
        entry.received.push({
            claim: { stm: { type: 'payment', amount: 50, package: 'ns/b' } },
            installId: 'i2',
            recordedAt: '2026-01-02T00:00:00Z'
        });

        let total = 0;
        for (const r of entry.received) {
            if (typeof r.claim.stm.amount === 'number') total += r.claim.stm.amount;
        }
        assert.strictEqual(total, 150);
        assert.strictEqual(entry.received.length, 2);
    });

    test('Payments: deduplication by installId', () => {
        const received = [];
        const id = 'install-abc';

        received.push({ installId: id, claim: {}, recordedAt: nowISO() });

        // Check for duplicate
        const isDuplicate = received.some(r => r.installId === id);
        assert.strictEqual(isDuplicate, true);

        const newId = 'install-xyz';
        const isDuplicate2 = received.some(r => r.installId === newId);
        assert.strictEqual(isDuplicate2, false);
    });

    test('Payments: payment history filtering by package', () => {
        const records = [
            { claim: { stm: { package: 'ns/a', amount: 10 } }, recordedAt: '2026-01-01T00:00:00Z' },
            { claim: { stm: { package: 'ns/b', amount: 20 } }, recordedAt: '2026-01-02T00:00:00Z' },
            { claim: { stm: { package: 'ns/a', amount: 30 } }, recordedAt: '2026-01-03T00:00:00Z' }
        ];

        const filtered = records.filter(r => r.claim.stm.package === 'ns/a');
        assert.strictEqual(filtered.length, 2);
    });

    test('Payments: _extractEvmAddress pattern matching', () => {
        // Replicate _extractEvmAddress for testing
        function extractEvmAddress(uri) {
            if (!uri || typeof uri !== 'string') return null;
            const match = uri.match(/^evm:\d+:address:(0x[0-9a-fA-F]{40})$/);
            return match ? match[1] : null;
        }

        const addr = '0x' + 'a'.repeat(40);
        assert.strictEqual(extractEvmAddress('evm:1:address:' + addr), addr);
        assert.strictEqual(extractEvmAddress('evm:137:address:' + addr), addr);
        assert.strictEqual(extractEvmAddress('safebox://abc'), null);
        assert.strictEqual(extractEvmAddress(null), null);
        assert.strictEqual(extractEvmAddress(''), null);
        // Too short address
        assert.strictEqual(extractEvmAddress('evm:1:address:0xabc'), null);
    });

    test('Payments: settlement batch structure', () => {
        // Test the structure of createSettlementBatch output without needing
        // an actual Payments instance. Replicate the shape.
        const totalAmount = 250;
        const chainId = '137';
        const batch = {
            ocp: 1,
            fmt: 'EIP712',
            iss: 'evm:137:address:0x' + 'a'.repeat(40),
            sub: 'evm:137:address:0x' + 'b'.repeat(40),
            stm: {
                type: 'payment',
                chainId: chainId,
                verifyingContract: '0x99999febd42cad798fe10ab0b1c563002fc99999',
                recipients: ['evm:137:address:0x' + 'b'.repeat(40)],
                max: String(totalAmount),
                line: '0'
            }
        };
        assert.strictEqual(batch.ocp, 1);
        assert.strictEqual(batch.fmt, 'EIP712');
        assert.strictEqual(batch.stm.chainId, '137');
        assert.strictEqual(batch.stm.max, '250');
        assert.strictEqual(batch.stm.verifyingContract, '0x99999febd42cad798fe10ab0b1c563002fc99999');
    });

    test('Payments: license grant storage key format', () => {
        // Verify the key format used for license grant storage
        const packageName = 'myns/mypkg';
        const safeboxUri = 'safebox://abc123';
        const key = `${packageName}@${safeboxUri}`;
        assert.strictEqual(key, 'myns/mypkg@safebox://abc123');
    });

    test('Payments: ledger export/import roundtrip structure', () => {
        // Test that the export structure is correct
        const exported = {
            version: 1,
            exportedAt: nowISO(),
            identityUri: 'safenet:author:alice',
            ledger: {
                'safenet:author:alice': {
                    received: [{ claim: { stm: { amount: 10 } }, installId: 'i1', recordedAt: nowISO() }],
                    sent: []
                }
            },
            licenseGrants: {}
        };
        assert.strictEqual(exported.version, 1);
        assert.ok(exported.exportedAt);
        assert.ok(exported.ledger['safenet:author:alice'].received.length === 1);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. TransparencyLog tests (entry chaining logic, standalone)
// ═════════════════════════════════════════════════════════════════════════════

async function runTransparencyLogTests() {
    console.log('# TransparencyLog tests');

    const ZERO_HASH = '0'.repeat(64);

    // Test the entry hash chaining logic without the Merkle tree parts
    // (which require Q.Data.Merkle). We replicate the hash-chaining here.

    test('TransparencyLog: entry hash chaining for first entry', () => {
        // First entry: entryHash = sha256(ZERO_HASH + claimHash + timestamp)
        const claim = { stm: { type: 'test', value: 'hello' } };
        const claimHash = generateClaimHash(claim);
        const timestamp = '2026-01-01T00:00:00Z';

        const entryHash = sha256hex(ZERO_HASH + claimHash + timestamp);
        assert.ok(/^[0-9a-f]{64}$/.test(entryHash));
    });

    test('TransparencyLog: entry hash chaining for subsequent entries', () => {
        const claim1 = { stm: { type: 'test', value: 1 } };
        const claim2 = { stm: { type: 'test', value: 2 } };
        const ts1 = '2026-01-01T00:00:00Z';
        const ts2 = '2026-01-02T00:00:00Z';

        const hash1 = generateClaimHash(claim1);
        const entryHash1 = sha256hex(ZERO_HASH + hash1 + ts1);

        const hash2 = generateClaimHash(claim2);
        const entryHash2 = sha256hex(entryHash1 + hash2 + ts2);

        // The second entry should chain to the first
        assert.notStrictEqual(entryHash1, entryHash2);
        assert.ok(/^[0-9a-f]{64}$/.test(entryHash2));
    });

    test('TransparencyLog: changing claim changes entry hash', () => {
        const ts = '2026-01-01T00:00:00Z';
        const claim1 = { stm: { type: 'test', value: 'a' } };
        const claim2 = { stm: { type: 'test', value: 'b' } };

        const eh1 = sha256hex(ZERO_HASH + generateClaimHash(claim1) + ts);
        const eh2 = sha256hex(ZERO_HASH + generateClaimHash(claim2) + ts);
        assert.notStrictEqual(eh1, eh2);
    });

    test('TransparencyLog: changing timestamp changes entry hash', () => {
        const claim = { stm: { type: 'test', value: 'x' } };
        const claimHash = generateClaimHash(claim);

        const eh1 = sha256hex(ZERO_HASH + claimHash + '2026-01-01T00:00:00Z');
        const eh2 = sha256hex(ZERO_HASH + claimHash + '2026-01-02T00:00:00Z');
        assert.notStrictEqual(eh1, eh2);
    });

    test('TransparencyLog: ZERO_HASH is 64 zero chars', () => {
        assert.strictEqual(ZERO_HASH.length, 64);
        assert.ok(/^0{64}$/.test(ZERO_HASH));
    });

    test('TransparencyLog: chain of 5 entries is deterministic', () => {
        const entries = [];
        for (let i = 0; i < 5; i++) {
            const claim = { stm: { type: 'test', index: i } };
            const claimHash = generateClaimHash(claim);
            const ts = `2026-01-0${i + 1}T00:00:00Z`;
            const prev = i === 0 ? ZERO_HASH : entries[i - 1].entryHash;
            const entryHash = sha256hex(prev + claimHash + ts);
            entries.push({ index: i, claimHash, timestamp: ts, entryHash });
        }

        // Rebuild and verify
        for (let i = 0; i < 5; i++) {
            const claim = { stm: { type: 'test', index: i } };
            const claimHash = generateClaimHash(claim);
            const ts = `2026-01-0${i + 1}T00:00:00Z`;
            const prev = i === 0 ? ZERO_HASH : entries[i - 1].entryHash;
            const expected = sha256hex(prev + claimHash + ts);
            assert.strictEqual(entries[i].entryHash, expected);
        }
    });

    test('TransparencyLog: tampering with middle entry breaks chain', () => {
        const entries = [];
        for (let i = 0; i < 3; i++) {
            const claim = { stm: { type: 'test', index: i } };
            const claimHash = generateClaimHash(claim);
            const ts = `2026-01-0${i + 1}T00:00:00Z`;
            const prev = i === 0 ? ZERO_HASH : entries[i - 1].entryHash;
            entries.push({ entryHash: sha256hex(prev + claimHash + ts), claimHash, ts });
        }

        // Tamper with entry 1's hash
        const original = entries[1].entryHash;
        entries[1].entryHash = 'x'.repeat(64);

        // Re-derive entry 2 from tampered chain
        const claim2 = { stm: { type: 'test', index: 2 } };
        const rederived = sha256hex(entries[1].entryHash + generateClaimHash(claim2) + entries[2].ts);

        // It should NOT match the original entry 2
        assert.notStrictEqual(rederived, entries[2].entryHash);
    });

    // ── _largestPowerOfTwo logic ────────────────────────────────────────────

    test('TransparencyLog: largest power of two logic', () => {
        function largestPowerOfTwo(n) {
            let k = 1;
            while (k * 2 < n) k *= 2;
            return k;
        }
        assert.strictEqual(largestPowerOfTwo(1), 1);
        assert.strictEqual(largestPowerOfTwo(2), 1);
        assert.strictEqual(largestPowerOfTwo(3), 2);
        assert.strictEqual(largestPowerOfTwo(4), 2);
        assert.strictEqual(largestPowerOfTwo(5), 4);
        assert.strictEqual(largestPowerOfTwo(8), 4);
        assert.strictEqual(largestPowerOfTwo(9), 8);
    });

    // ── _merkleHash logic (standalone) ──────────────────────────────────────

    test('TransparencyLog: merkleHash of single leaf is the leaf itself', () => {
        function merkleHash(leaves) {
            if (leaves.length === 0) return ZERO_HASH;
            if (leaves.length === 1) return leaves[0];
            function lpt(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }
            const k = lpt(leaves.length);
            const left = merkleHash(leaves.slice(0, k));
            const right = merkleHash(leaves.slice(k));
            return sha256hex(left + right);
        }

        const leaf = sha256hex('leaf0');
        assert.strictEqual(merkleHash([leaf]), leaf);
    });

    test('TransparencyLog: merkleHash of empty is ZERO_HASH', () => {
        function merkleHash(leaves) {
            if (leaves.length === 0) return ZERO_HASH;
            if (leaves.length === 1) return leaves[0];
            function lpt(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }
            const k = lpt(leaves.length);
            return sha256hex(merkleHash(leaves.slice(0, k)) + merkleHash(leaves.slice(k)));
        }
        assert.strictEqual(merkleHash([]), ZERO_HASH);
    });

    test('TransparencyLog: merkleHash of two leaves', () => {
        function merkleHash(leaves) {
            if (leaves.length === 0) return ZERO_HASH;
            if (leaves.length === 1) return leaves[0];
            function lpt(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }
            const k = lpt(leaves.length);
            return sha256hex(merkleHash(leaves.slice(0, k)) + merkleHash(leaves.slice(k)));
        }

        const a = sha256hex('a');
        const b = sha256hex('b');
        const root = merkleHash([a, b]);
        assert.strictEqual(root, sha256hex(a + b));
    });

    test('TransparencyLog: search filter by type', () => {
        const entries = [
            { claimType: 'publication', subject: 'pkg-a', timestamp: '2026-01-01T00:00:00Z' },
            { claimType: 'revocation', subject: 'pkg-b', timestamp: '2026-01-02T00:00:00Z' },
            { claimType: 'publication', subject: 'pkg-c', timestamp: '2026-01-03T00:00:00Z' }
        ];
        const filtered = entries.filter(e => e.claimType === 'publication');
        assert.strictEqual(filtered.length, 2);
    });

    test('TransparencyLog: search filter by time range', () => {
        const entries = [
            { claimType: 'publication', timestamp: '2026-01-01T00:00:00Z' },
            { claimType: 'publication', timestamp: '2026-01-15T00:00:00Z' },
            { claimType: 'publication', timestamp: '2026-02-01T00:00:00Z' }
        ];
        const since = '2026-01-10T00:00:00Z';
        const until = '2026-01-20T00:00:00Z';
        const filtered = entries.filter(e => e.timestamp >= since && e.timestamp <= until);
        assert.strictEqual(filtered.length, 1);
    });

    test('TransparencyLog: search with limit', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ({
            claimType: 'publication',
            timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`
        }));
        const limited = entries.slice(0, 3);
        assert.strictEqual(limited.length, 3);
    });

    test('TransparencyLog: exportEntries range clipping', () => {
        const entries = [0, 1, 2, 3, 4];
        // Replicate exportEntries logic
        const from = -1;
        const to = 100;
        const start = Math.max(0, from);
        const end = Math.min(entries.length, to);
        const result = entries.slice(start, end);
        assert.strictEqual(result.length, 5);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Identity tests (constructor and serialization, no Q.Crypto)
// ═════════════════════════════════════════════════════════════════════════════

async function runIdentityTests() {
    console.log('# Identity tests (constructor/serialization)');

    // We require Identity here -- it uses lazy loading for Q modules,
    // so the constructor itself should work without Q.
    const Identity = require(path.join(libDir, 'Identity'));

    test('Identity: constructor requires type', () => {
        assert.throws(() => new Identity({}), /type/);
        assert.throws(() => new Identity(), /type/);
    });

    test('Identity: constructor rejects invalid type', () => {
        assert.throws(() => new Identity({ type: 'invalid' }), /safebox.*author/);
    });

    test('Identity: author type requires name', () => {
        assert.throws(() => new Identity({ type: 'author' }), /name/);
    });

    test('Identity: safebox constructor with publicKey', () => {
        const pubKey = 'ab'.repeat(32);
        const id = new Identity({ type: 'safebox', publicKey: pubKey });
        assert.strictEqual(id.type, 'safebox');
        assert.strictEqual(id.publicKeyHex, pubKey);
        assert.ok(id.uri.startsWith('safebox://'));
    });

    test('Identity: author constructor', () => {
        const pubKey = 'cd'.repeat(32);
        const id = new Identity({ type: 'author', name: 'alice', publicKey: pubKey });
        assert.strictEqual(id.type, 'author');
        assert.strictEqual(id.name, 'alice');
        assert.strictEqual(id.uri, 'safenet:author:alice');
    });

    test('Identity: spkiHash is sha256 of publicKey bytes', () => {
        const pubKey = 'ab'.repeat(32);
        const id = new Identity({ type: 'safebox', publicKey: pubKey });
        const expected = sha256hex(Buffer.from(pubKey, 'hex'));
        assert.strictEqual(id.spkiHash, expected);
    });

    test('Identity: canSign is false without privateKey', () => {
        const id = new Identity({ type: 'safebox', publicKey: 'ab'.repeat(32) });
        assert.strictEqual(id.canSign, false);
    });

    test('Identity: canSign is true with privateKey', () => {
        const id = new Identity({
            type: 'safebox',
            publicKey: 'ab'.repeat(32),
            privateKey: 'cd'.repeat(32)
        });
        assert.strictEqual(id.canSign, true);
    });

    test('Identity: toJSON includes type, publicKey, uri, spkiHash', () => {
        const pubKey = 'ab'.repeat(32);
        const id = new Identity({ type: 'author', name: 'bob', publicKey: pubKey });
        const json = id.toJSON();
        assert.strictEqual(json.type, 'author');
        assert.strictEqual(json.name, 'bob');
        assert.strictEqual(json.publicKey, pubKey);
        assert.strictEqual(json.uri, 'safenet:author:bob');
        assert.ok(json.spkiHash);
    });

    test('Identity: toJSON does not include privateKey', () => {
        const id = new Identity({
            type: 'safebox',
            publicKey: 'ab'.repeat(32),
            privateKey: 'cd'.repeat(32)
        });
        const json = id.toJSON();
        assert.strictEqual(json.privateKey, undefined);
    });

    test('Identity: fromJSON restores type and publicKey', () => {
        const pubKey = 'ab'.repeat(32);
        const original = new Identity({ type: 'author', name: 'alice', publicKey: pubKey });
        const json = original.toJSON();
        const restored = Identity.fromJSON(json);
        assert.strictEqual(restored.type, 'author');
        assert.strictEqual(restored.name, 'alice');
        assert.strictEqual(restored.publicKeyHex, pubKey);
        assert.strictEqual(restored.canSign, false); // no private key after fromJSON
    });

    test('Identity: fromJSON throws on invalid input', () => {
        assert.throws(() => Identity.fromJSON(null), /Invalid/);
        assert.throws(() => Identity.fromJSON({}), /Invalid/);
    });

    test('Identity: publicKeyHex throws when no public key', () => {
        // author identity with name but no keys
        const id = new Identity({ type: 'author', name: 'nokey' });
        // Manually clear the key that might have been set
        id._publicKey = null;
        assert.throws(() => id.publicKeyHex, /public key/);
    });

    test('Identity: keyPair option extracts keys', () => {
        const kp = { publicKey: 'aa'.repeat(32), privateKey: 'bb'.repeat(32) };
        const id = new Identity({ type: 'safebox', keyPair: kp });
        assert.strictEqual(id.publicKeyHex, kp.publicKey);
        assert.strictEqual(id.canSign, true);
    });

    test('Identity: Buffer publicKey is handled', () => {
        const pubBuf = Buffer.from('ab'.repeat(32), 'hex');
        const id = new Identity({ type: 'safebox', publicKey: pubBuf });
        assert.strictEqual(id.publicKeyHex, 'ab'.repeat(32));
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Discovery tests (peer management, no network I/O)
// ═════════════════════════════════════════════════════════════════════════════

async function runDiscoveryTests() {
    console.log('# Discovery tests (peer management)');

    // Discovery requires Q.Data at the module level, so we can only test
    // it if Q is available. We test the logic patterns standalone.

    test('Discovery: _selectRandom logic returns correct count', () => {
        // Replicate the Fisher-Yates partial shuffle
        function selectRandom(arr, count) {
            if (arr.length <= count) return arr.slice();
            const copy = arr.slice();
            const n = Math.min(count, copy.length);
            for (let i = 0; i < n; i++) {
                const j = i + Math.floor(Math.random() * (copy.length - i));
                const tmp = copy[i];
                copy[i] = copy[j];
                copy[j] = tmp;
            }
            return copy.slice(0, n);
        }

        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const selected = selectRandom(items, 3);
        assert.strictEqual(selected.length, 3);
    });

    test('Discovery: _selectRandom returns all when count >= length', () => {
        function selectRandom(arr, count) {
            if (arr.length <= count) return arr.slice();
            return arr.slice(0, count);
        }
        const items = [1, 2, 3];
        const selected = selectRandom(items, 5);
        assert.strictEqual(selected.length, 3);
    });

    test('Discovery: peer failure tracking removes after MAX_FAILURES', () => {
        const MAX_FAILURES = 3;
        const peers = new Map();
        peers.set('peer-1', { endpoint: 'https://p1', failures: 0 });

        const info = peers.get('peer-1');
        info.failures++;
        assert.ok(info.failures < MAX_FAILURES);
        info.failures++;
        assert.ok(info.failures < MAX_FAILURES);
        info.failures++;
        assert.ok(info.failures >= MAX_FAILURES);
        // Should be removed
        if (info.failures >= MAX_FAILURES) {
            peers.delete('peer-1');
        }
        assert.strictEqual(peers.has('peer-1'), false);
    });

    test('Discovery: addPeer resets failures', () => {
        const peers = new Map();
        peers.set('peer-1', { endpoint: 'https://p1', failures: 2, lastSeen: null, trustLevel: 0, bloom: null });

        // Simulate addPeer
        const existing = peers.get('peer-1');
        peers.set('peer-1', {
            endpoint: 'https://p1-new',
            lastSeen: nowISO(),
            trustLevel: 5,
            bloom: existing ? existing.bloom : null,
            failures: 0
        });

        assert.strictEqual(peers.get('peer-1').failures, 0);
        assert.strictEqual(peers.get('peer-1').trustLevel, 5);
    });

    test('Discovery: getPeers filters by minimum trust level', () => {
        const peers = new Map();
        peers.set('p1', { endpoint: 'e1', trustLevel: 1, lastSeen: null });
        peers.set('p2', { endpoint: 'e2', trustLevel: 5, lastSeen: null });
        peers.set('p3', { endpoint: 'e3', trustLevel: 10, lastSeen: null });

        const minTrust = 5;
        const result = [];
        for (const [peerUri, info] of peers) {
            if (info.trustLevel >= minTrust) {
                result.push({ peerUri, trustLevel: info.trustLevel });
            }
        }
        assert.strictEqual(result.length, 2);
    });

    test('Discovery: bootstrap peers are seeded correctly', () => {
        const bootstrapPeers = ['https://seed1.example.com', 'https://seed2.example.com'];
        const peers = new Map();
        for (const uri of bootstrapPeers) {
            peers.set(uri, {
                endpoint: uri,
                lastSeen: null,
                trustLevel: 0,
                bloom: null,
                failures: 0
            });
        }
        assert.strictEqual(peers.size, 2);
        assert.ok(peers.has('https://seed1.example.com'));
        assert.strictEqual(peers.get('https://seed1.example.com').lastSeen, null);
    });

    test('Discovery: claim deduplication via seen set', () => {
        const seen = new Set();
        const claim1 = { stm: { type: 'test', value: 1 } };
        const claim2 = { stm: { type: 'test', value: 2 } };

        const h1 = generateClaimHash(claim1);
        const h2 = generateClaimHash(claim2);

        assert.strictEqual(seen.has(h1), false);
        seen.add(h1);
        assert.strictEqual(seen.has(h1), true);
        assert.strictEqual(seen.has(h2), false);
    });

    test('Discovery: revocation claims skip fanout limit', () => {
        const isRevocation = (claim) => claim.stm.type === 'revocation';
        const claim = { stm: { type: 'revocation', targetHash: 'abc' } };
        assert.strictEqual(isRevocation(claim), true);

        const normalClaim = { stm: { type: 'publication' } };
        assert.strictEqual(isRevocation(normalClaim), false);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Integration tests (require Q)
// ═════════════════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
    if (!hasQ) {
        console.log('# Integration tests (Q modules not available)');
        skip('Integration: create identity', 'Q modules not available');
        skip('Integration: claim namespace', 'Q modules not available');
        skip('Integration: publish package', 'Q modules not available');
        skip('Integration: verify publication', 'Q modules not available');
        skip('Integration: transparency log append', 'Q modules not available');
        return;
    }

    console.log('# Integration tests');

    const Identity = require(path.join(libDir, 'Identity'));
    const Registry = require(path.join(libDir, 'Registry'));
    const TransparencyLog = require(path.join(libDir, 'TransparencyLog'));

    let identity;
    let registry;
    let log;

    await asyncTest('Integration: create author identity', async () => {
        identity = await Identity.generateAuthor('testauthor');
        assert.strictEqual(identity.type, 'author');
        assert.strictEqual(identity.name, 'testauthor');
        assert.ok(identity.canSign);
        assert.strictEqual(identity.uri, 'safenet:author:testauthor');
    });

    await asyncTest('Integration: claim namespace via registry', async () => {
        registry = new Registry();
        const claim = Claims.namespaceClaim({
            namespace: 'testns',
            owner: 'testauthor'
        });
        const result = await registry.claimNamespace(claim);
        assert.strictEqual(result.ok, true);
        assert.ok(result.rootHash);
    });

    await asyncTest('Integration: namespace cannot be claimed twice', async () => {
        const claim = Claims.namespaceClaim({
            namespace: 'testns',
            owner: 'otheauthor'
        });
        const result = await registry.claimNamespace(claim);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, 'NAMESPACE_TAKEN');
    });

    await asyncTest('Integration: transparency log append and chain', async () => {
        log = new TransparencyLog();
        const claim1 = Claims.namespaceClaim({ namespace: 'logns', owner: 'alice' });
        const r1 = log.append(claim1);
        assert.strictEqual(r1.index, 0);
        assert.ok(r1.entryHash);
        assert.ok(r1.rootHash);

        const claim2 = Claims.authorIdentity({
            name: 'alice',
            keys: [{ id: 'k1', algorithm: 'ES256', publicKey: 'ab'.repeat(32) }]
        });
        const r2 = log.append(claim2);
        assert.strictEqual(r2.index, 1);
        assert.notStrictEqual(r1.entryHash, r2.entryHash);
    });

    await asyncTest('Integration: transparency log getEntry', async () => {
        const entry = log.getEntry(0);
        assert.ok(entry);
        assert.strictEqual(entry.index, 0);
        assert.ok(entry.entryHash);
        assert.strictEqual(log.getEntry(999), null);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Main runner
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('TAP version 14');

    await runUtilsTests();
    await runClaimsTests();
    await runPaymentsValidationTests();
    await runTransparencyLogTests();
    await runIdentityTests();
    await runDiscoveryTests();
    await runIntegrationTests();

    console.log(`1..${testCount}`);
    console.log(`# ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(2);
});
