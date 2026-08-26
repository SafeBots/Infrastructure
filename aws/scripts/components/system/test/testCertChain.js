// test/testCertChain.js
//
// Tests _verifyCertChain in isolation. We can't test it through nsmClient's
// public API because the pinned fingerprint check would reject our fake root.
// So we patch the rootCertCached internal directly.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const cbor = require('../cborDecode');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// Build the same fake chain
function genP384Key() {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
}
function makeCert(subject, issuer, subjectKey, issuerKey, isCA, validDays, validFrom) {
    const tmp = fs.mkdtempSync('/tmp/safebox-attest-test-');
    const subjectKeyPath = path.join(tmp, 'subject.pem');
    const issuerKeyPath = path.join(tmp, 'issuer.pem');
    fs.writeFileSync(subjectKeyPath, subjectKey.privateKey.export({ type: 'sec1', format: 'pem' }));
    fs.writeFileSync(issuerKeyPath, issuerKey.privateKey.export({ type: 'sec1', format: 'pem' }));
    const csrPath = path.join(tmp, 'csr.pem');
    const certPath = path.join(tmp, 'cert.pem');
    const extPath = path.join(tmp, 'ext.cnf');
    const extConf = isCA
        ? 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n'
        : 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n';
    fs.writeFileSync(extPath, extConf);
    execFileSync('openssl', ['req', '-new', '-key', subjectKeyPath, '-out', csrPath,
        '-subj', `/CN=${subject}/O=Test/C=US`, '-sha384'], { stdio: 'pipe' });
    if (subject === issuer) {
        execFileSync('openssl', ['x509', '-req', '-in', csrPath, '-out', certPath,
            '-signkey', issuerKeyPath, '-sha384', '-days', String(validDays),
            '-extfile', extPath], { stdio: 'pipe' });
    } else {
        const issuerCertPath = path.join(tmp, 'issuer-cert.pem');
        fs.writeFileSync(issuerCertPath, issuerKey._certPem);
        execFileSync('openssl', ['x509', '-req', '-in', csrPath, '-out', certPath,
            '-CA', issuerCertPath, '-CAkey', issuerKeyPath, '-CAcreateserial',
            '-sha384', '-days', String(validDays), '-extfile', extPath], { stdio: 'pipe' });
    }
    const pem = fs.readFileSync(certPath, 'utf8');
    subjectKey._certPem = pem;
    fs.rmSync(tmp, { recursive: true, force: true });
    return pem;
}

console.log('Building fake P-384 chain...');
const rootKey = genP384Key();
const intKey = genP384Key();
const leafKey = genP384Key();
const rootPem = makeCert('FakeAwsRoot', 'FakeAwsRoot', rootKey, rootKey, true, 365);
rootKey._certPem = rootPem;
const intPem = makeCert('FakeIntermediate', 'FakeAwsRoot', intKey, rootKey, true, 365);
intKey._certPem = intPem;
const leafPem = makeCert('FakeNsmLeaf', 'FakeIntermediate', leafKey, intKey, false, 30);
leafKey._certPem = leafPem;

const rootDer = new crypto.X509Certificate(rootPem).raw;
const intDer = new crypto.X509Certificate(intPem).raw;
const leafDer = new crypto.X509Certificate(leafPem).raw;
const rootSha = crypto.createHash('sha256').update(rootPem).digest('hex');

// Point nsmClient at the fake root, and override its expected fingerprint
// by patching the module before first require
const fakeRootPath = '/tmp/fake-aws-root-chain.pem';
fs.writeFileSync(fakeRootPath, rootPem);
process.env.SAFEBOX_SYSTEM_AWS_ROOT_PEM = fakeRootPath;

// We need to override AWS_ROOT_FINGERPRINT_HEX. The cleanest way is to read
// nsmClient.js source, replace the constant, eval into a new module.
const Module = require('module');
const nsmSrc = fs.readFileSync(require.resolve('../nsmClient'), 'utf8');
const patchedSrc = nsmSrc.replace(
    /const AWS_ROOT_FINGERPRINT_HEX = '[0-9a-f]+';/,
    `const AWS_ROOT_FINGERPRINT_HEX = '${rootSha}';`
);
const m = new Module(require.resolve('../nsmClient'));
m.filename = require.resolve('../nsmClient');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(patchedSrc, m.filename);
const nsm = m.exports;

// Build a payload with the leaf cert + cabundle (intermediate + root)
const payload = new Map();
payload.set('certificate', leafDer);
payload.set('cabundle', [intDer, rootDer]);

// Happy path
let chainOk = false, leafReturned = null;
try {
    leafReturned = nsm._verifyCertChain(payload);
    chainOk = leafReturned instanceof crypto.X509Certificate;
} catch (e) {
    console.error('  chain verify error:', e.message);
}
check('verifyCertChain happy path returns leaf', chainOk);
check('returned leaf has expected subject', leafReturned && leafReturned.subject.includes('FakeNsmLeaf'));

// Wrong root (one we haven't pinned)
const otherRootKey = genP384Key();
const otherRootPem = makeCert('OtherRoot', 'OtherRoot', otherRootKey, otherRootKey, true, 365);
otherRootKey._certPem = otherRootPem;
const otherLeafKey = genP384Key();
const otherLeafPem = makeCert('OtherLeaf', 'OtherRoot', otherLeafKey, otherRootKey, false, 30);
otherLeafKey._certPem = otherLeafPem;
const otherLeafDer = new crypto.X509Certificate(otherLeafPem).raw;
const otherRootDer = new crypto.X509Certificate(otherRootPem).raw;

const badPayload = new Map();
badPayload.set('certificate', otherLeafDer);
badPayload.set('cabundle', [otherRootDer]);
let badChainRejected = false;
try {
    nsm._verifyCertChain(badPayload);
} catch (e) {
    badChainRejected = e.code === 'CHAIN_BROKEN' || e.code === 'CHAIN_TOO_LONG';
}
check('non-pinned root is rejected', badChainRejected);

// Forged leaf: claim to be issued by FakeIntermediate but signed by a different key
const forgerKey = genP384Key();
const forgedLeafPem = makeCert('FakeIntermediate', 'FakeIntermediate', forgerKey, forgerKey, false, 30);
// This leaf claims subject=FakeIntermediate (issuer = self). We try to insert it
// into the chain — it won't have the right issuer for our leaf, but let's see
// what happens if we craft a payload where the leaf's issuer doesn't match a
// real intermediate.
const orphanLeafKey = genP384Key();
const orphanLeafPem = makeCert('Orphan', 'NoSuchIssuer', orphanLeafKey, forgerKey, false, 30);
const orphanLeafDer = new crypto.X509Certificate(orphanLeafPem).raw;
const orphanPayload = new Map();
orphanPayload.set('certificate', orphanLeafDer);
orphanPayload.set('cabundle', [intDer, rootDer]);
let orphanRejected = false;
try {
    nsm._verifyCertChain(orphanPayload);
} catch (e) {
    orphanRejected = e.code === 'CHAIN_BROKEN' || e.code === 'CHAIN_BAD_SIGNATURE';
}
check('orphan leaf (issuer not in chain) is rejected', orphanRejected);

// Missing certificate field
let missingCertRejected = false;
try {
    nsm._verifyCertChain(new Map([['cabundle', [intDer, rootDer]]]));
} catch (e) {
    missingCertRejected = e.code === 'CHAIN_BAD_LEAF';
}
check('missing certificate field rejected', missingCertRejected);

// Missing cabundle field
let missingBundleRejected = false;
try {
    nsm._verifyCertChain(new Map([['certificate', leafDer]]));
} catch (e) {
    missingBundleRejected = e.code === 'CHAIN_BAD_BUNDLE';
}
check('missing cabundle field rejected', missingBundleRejected);

// Cabundle as bytes (not array)
let badBundleRejected = false;
try {
    nsm._verifyCertChain(new Map([['certificate', leafDer], ['cabundle', leafDer]]));
} catch (e) {
    badBundleRejected = e.code === 'CHAIN_BAD_BUNDLE';
}
check('non-array cabundle rejected', badBundleRejected);

// Test the raw-to-DER converter on known input
const fakeRaw = Buffer.alloc(96);
fakeRaw.fill(0x42, 0, 48);
fakeRaw.fill(0x99, 48, 96);
const derConverted = nsm._rawSignatureToDer(fakeRaw);
check('rawSignatureToDer produces valid DER SEQUENCE start',
    derConverted[0] === 0x30,
    'first byte=' + derConverted[0].toString(16));

// Test that empty/0-byte signature is rejected
let zeroSigRejected = false;
try {
    nsm._rawSignatureToDer(Buffer.alloc(0));
} catch (e) {
    zeroSigRejected = true;
}
check('zero-length signature rejected by rawSignatureToDer', zeroSigRejected);

fs.unlinkSync(fakeRootPath);

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
