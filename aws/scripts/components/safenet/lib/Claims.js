'use strict';

const { sha256hex, nowISO, validateSemver, validateNamespace } = require('./utils');

/**
 * @module Claims
 *
 * Factory for Safenet OCP (Open Claiming Protocol) claim objects.
 * Each static method returns a plain unsigned claim object.
 * The caller signs it via Q.Crypto.OpenClaim or Identity.sign().
 *
 * Claim structure follows OCP v1:
 *   { ocp: 1, iss, sub, stm, nbf }
 *
 * The `stm` (statement) field carries the type-specific payload.
 * After signing, the caller adds `sig` and `keys` fields.
 */
const Claims = {};

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

/**
 * Build the base claim envelope.
 *
 * @param {string} iss - Issuer URI
 * @param {string} sub - Subject URI
 * @param {string} type - Statement type
 * @param {object} fields - Additional stm fields
 * @returns {object} Unsigned OCP claim
 */
function _buildClaim(iss, sub, type, fields) {
  const stm = Object.assign({ type }, fields);
  // Remove undefined values so canonical JSON stays clean
  for (const k of Object.keys(stm)) {
    if (stm[k] === undefined) delete stm[k];
  }
  return {
    ocp: 1,
    iss,
    sub,
    stm,
    nbf: nowISO()
  };
}

/**
 * Derive a safebox URI from a public key (or its hex hash).
 *
 * @param {string|Buffer} publicKey - Raw public key bytes or hex string
 * @returns {string} safebox://<sha256hex>
 */
function _safeboxUri(publicKey) {
  const input = Buffer.isBuffer(publicKey)
    ? publicKey
    : Buffer.from(publicKey, 'hex');
  return 'safebox://' + sha256hex(input);
}

/**
 * Build an author URI from an author name.
 *
 * @param {string} name
 * @returns {string} safenet:author:<name>
 */
function _authorUri(name) {
  return 'safenet:author:' + name;
}

// ----------------------------------------------------------------
// Safebox claims
// ----------------------------------------------------------------

/**
 * Create a safebox identity claim.
 * Issued by the safebox about itself; attests to its attestation
 * measurements and reachable endpoints.
 *
 * @param {object} opts
 * @param {string|Buffer} opts.publicKey    - Safebox public key (SPKI or raw)
 * @param {string}        opts.pcr0         - PCR0 measurement hex
 * @param {string}        opts.pcr1         - PCR1 measurement hex
 * @param {string}        opts.pcr4         - PCR4 measurement hex
 * @param {string}        opts.imageHash    - Enclave image SHA-256 hex
 * @param {string[]}     [opts.endpoints]   - Reachable URIs
 * @param {string[]}     [opts.capabilities]- Declared capabilities
 * @param {string}       [opts.version]     - Safebox software version (semver)
 * @returns {object} Unsigned OCP claim
 */
Claims.safeboxIdentity = function safeboxIdentity(opts) {
  const { publicKey, pcr0, pcr1, pcr4, imageHash,
    endpoints, capabilities, version } = opts;

  if (!publicKey) throw new Error('publicKey is required');
  if (!pcr0 || !pcr1 || !pcr4) throw new Error('PCR measurements (pcr0, pcr1, pcr4) are required');
  if (!imageHash) throw new Error('imageHash is required');
  if (version && !validateSemver(version)) {
    throw new Error('version must be valid semver: ' + version);
  }

  const uri = _safeboxUri(publicKey);
  return _buildClaim(uri, uri, 'safebox_identity', {
    publicKey: Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : publicKey,
    pcr0,
    pcr1,
    pcr4,
    imageHash,
    endpoints,
    capabilities,
    version
  });
};

/**
 * Create a safebox revocation claim.
 * Issued by a safebox (or operator) to revoke a safebox URI.
 *
 * @param {object} opts
 * @param {string} opts.safeboxUri - URI of the safebox being revoked
 * @param {string} opts.reason     - Human-readable revocation reason
 * @returns {object} Unsigned OCP claim
 */
Claims.safeboxRevocation = function safeboxRevocation(opts) {
  const { safeboxUri, reason } = opts;
  if (!safeboxUri) throw new Error('safeboxUri is required');
  if (!reason) throw new Error('reason is required');

  return _buildClaim(safeboxUri, safeboxUri, 'safebox_revocation', {
    reason
  });
};

/**
 * Create an image blessing claim.
 * Issued by a trusted authority to approve an enclave image hash.
 *
 * @param {object} opts
 * @param {string} opts.imageHash   - SHA-256 hex of the blessed image
 * @param {string} opts.version     - Version label for the blessed image
 * @param {string} [opts.description] - Human-readable description
 * @returns {object} Unsigned OCP claim
 */
Claims.imageBlessing = function imageBlessing(opts) {
  const { imageHash, version, description } = opts;
  if (!imageHash) throw new Error('imageHash is required');
  if (!version) throw new Error('version is required');

  const sub = 'safenet:image:' + imageHash;
  // iss is set to a placeholder; caller replaces with their own identity
  return _buildClaim('safenet:authority', sub, 'image_blessing', {
    imageHash,
    version,
    description
  });
};

/**
 * Create a peer announce claim.
 * A safebox advertises itself to the peer network.
 *
 * @param {object} opts
 * @param {string}   opts.safeboxUri    - Announcing safebox URI
 * @param {string[]} opts.endpoints     - Network endpoints
 * @param {string[]} [opts.capabilities] - Advertised capabilities
 * @returns {object} Unsigned OCP claim
 */
Claims.peerAnnounce = function peerAnnounce(opts) {
  const { safeboxUri, endpoints, capabilities } = opts;
  if (!safeboxUri) throw new Error('safeboxUri is required');
  if (!endpoints || !endpoints.length) throw new Error('endpoints are required');

  return _buildClaim(safeboxUri, safeboxUri, 'peer_announce', {
    endpoints,
    capabilities
  });
};

// ----------------------------------------------------------------
// Author / Org claims
// ----------------------------------------------------------------

/**
 * Create an author identity claim.
 * Establishes a named author with one or more signing keys.
 *
 * @param {object} opts
 * @param {string}   opts.name         - Author name (namespace-safe)
 * @param {string}  [opts.displayName] - Human-readable display name
 * @param {object[]} opts.keys         - Array of { id, algorithm, publicKey }
 * @param {object}  [opts.recovery]    - Recovery key specification
 * @param {object}  [opts.secondFactor]- Second-factor auth specification
 * @returns {object} Unsigned OCP claim
 */
Claims.authorIdentity = function authorIdentity(opts) {
  const { name, displayName, keys, recovery, secondFactor } = opts;
  if (!name) throw new Error('name is required');
  if (!keys || !keys.length) throw new Error('keys are required');

  const uri = _authorUri(name);
  return _buildClaim(uri, uri, 'author_identity', {
    name,
    displayName,
    keys,
    recovery,
    secondFactor
  });
};

/**
 * Create an organization identity claim.
 * Establishes a multi-member org with threshold signing.
 *
 * @param {object} opts
 * @param {string}   opts.name        - Org name
 * @param {string}  [opts.displayName]- Human-readable name
 * @param {object[]} opts.members     - Array of { name, keys, role }
 * @param {object}  [opts.thresholds] - Signing thresholds, e.g. { publish: 2, revoke: 3 }
 * @returns {object} Unsigned OCP claim
 */
Claims.orgIdentity = function orgIdentity(opts) {
  const { name, displayName, members, thresholds } = opts;
  if (!name) throw new Error('name is required');
  if (!members || !members.length) throw new Error('members are required');

  const uri = 'safenet:org:' + name;
  return _buildClaim(uri, uri, 'org_identity', {
    name,
    displayName,
    members,
    thresholds
  });
};

// ----------------------------------------------------------------
// Namespace claims
// ----------------------------------------------------------------

/**
 * Create a namespace claim.
 * An author claims ownership of a package namespace.
 *
 * @param {object} opts
 * @param {string} opts.namespace - Namespace name to claim
 * @param {string} opts.owner     - Author name that owns the namespace
 * @returns {object} Unsigned OCP claim
 */
Claims.namespaceClaim = function namespaceClaim(opts) {
  const { namespace, owner } = opts;
  if (!namespace) throw new Error('namespace is required');
  if (!owner) throw new Error('owner is required');

  const v = validateNamespace(namespace);
  if (!v.valid) throw new Error('Invalid namespace: ' + v.reason);

  const iss = _authorUri(owner);
  const sub = 'safenet:namespace:' + namespace;
  return _buildClaim(iss, sub, 'namespace_claim', {
    namespace,
    owner
  });
};

/**
 * Create a namespace transfer claim.
 * Transfers ownership of a namespace from one author to another.
 *
 * @param {object} opts
 * @param {string} opts.namespace - Namespace being transferred
 * @param {string} opts.fromOwner - Current owner author name
 * @param {string} opts.toOwner   - New owner author name
 * @returns {object} Unsigned OCP claim
 */
Claims.namespaceTransfer = function namespaceTransfer(opts) {
  const { namespace, fromOwner, toOwner } = opts;
  if (!namespace) throw new Error('namespace is required');
  if (!fromOwner) throw new Error('fromOwner is required');
  if (!toOwner) throw new Error('toOwner is required');

  const iss = _authorUri(fromOwner);
  const sub = 'safenet:namespace:' + namespace;
  return _buildClaim(iss, sub, 'namespace_transfer', {
    namespace,
    fromOwner,
    toOwner
  });
};

// ----------------------------------------------------------------
// Publication claims
// ----------------------------------------------------------------

/**
 * Create a publication claim.
 * An author publishes a versioned package into a namespace.
 *
 * @param {object} opts
 * @param {string}   opts.namespace       - Namespace the package belongs to
 * @param {string}   opts.package         - Package name (namespace/package)
 * @param {string}   opts.version         - Semver version string
 * @param {string}   opts.merkleRoot      - Merkle root hex of package content
 * @param {string}   opts.manifestHash    - SHA-256 hex of the manifest file
 * @param {string[]} [opts.languages]     - Supported languages / runtimes
 * @param {string}   [opts.license]       - SPDX license identifier
 * @param {boolean}  [opts.safeboxOnly]   - If true, runs only inside safeboxes
 * @param {number}   [opts.contentSize]   - Total content size in bytes
 * @param {number}   [opts.fileCount]     - Number of files in the package
 * @param {object[]} [opts.dependencies]  - Array of { package, versionRange }
 * @param {object}   [opts.pricing]       - Pricing specification
 * @param {string}   [opts.previousVersion]    - Previous version for chaining
 * @param {string}   [opts.previousMerkleRoot] - Previous Merkle root for chaining
 * @returns {object} Unsigned OCP claim
 */
Claims.publication = function publication(opts) {
  const { namespace, version, merkleRoot, manifestHash,
    languages, license, safeboxOnly, contentSize, fileCount,
    dependencies, pricing, previousVersion, previousMerkleRoot } = opts;
  const pkg = opts.package;

  if (!namespace) throw new Error('namespace is required');
  if (!pkg) throw new Error('package is required');
  if (!version) throw new Error('version is required');
  if (!validateSemver(version)) throw new Error('version must be valid semver: ' + version);
  if (!merkleRoot) throw new Error('merkleRoot is required');
  if (!manifestHash) throw new Error('manifestHash is required');

  const iss = 'safenet:namespace:' + namespace;
  const sub = 'safenet:package:' + pkg + '@' + version;
  return _buildClaim(iss, sub, 'publication', {
    namespace,
    package: pkg,
    version,
    merkleRoot,
    manifestHash,
    languages,
    license,
    safeboxOnly,
    contentSize,
    fileCount,
    dependencies,
    pricing,
    previousVersion,
    previousMerkleRoot
  });
};

// ----------------------------------------------------------------
// License & payment claims
// ----------------------------------------------------------------

/**
 * Create a license grant claim.
 * An author grants a specific safebox permission to install a package.
 *
 * @param {object} opts
 * @param {string} opts.package      - Package name
 * @param {string} opts.versionRange - Semver range, e.g. ">=1.0.0 <2.0.0"
 * @param {string} opts.safeboxUri   - Safebox URI receiving the license
 * @param {number} [opts.maxInstalls]- Maximum concurrent installations
 * @returns {object} Unsigned OCP claim
 */
Claims.licenseGrant = function licenseGrant(opts) {
  const { versionRange, safeboxUri, maxInstalls } = opts;
  const pkg = opts.package;
  if (!pkg) throw new Error('package is required');
  if (!versionRange) throw new Error('versionRange is required');
  if (!safeboxUri) throw new Error('safeboxUri is required');

  const iss = 'safenet:package:' + pkg;
  return _buildClaim(iss, safeboxUri, 'license_grant', {
    package: pkg,
    versionRange,
    safeboxUri,
    maxInstalls
  });
};

/**
 * Create a payment claim.
 * Records a payment for a package version by a safebox.
 *
 * @param {object} opts
 * @param {string} opts.package    - Package name
 * @param {string} opts.version    - Package version
 * @param {string} opts.amount     - Payment amount as string (decimal-safe)
 * @param {string} opts.currency   - Currency code (e.g. "USD", "ETH")
 * @param {string} opts.installId  - Unique installation identifier
 * @param {string} opts.safeboxUri - Paying safebox URI
 * @returns {object} Unsigned OCP claim
 */
Claims.payment = function payment(opts) {
  const { version, amount, currency, installId, safeboxUri } = opts;
  const pkg = opts.package;
  if (!pkg) throw new Error('package is required');
  if (!version) throw new Error('version is required');
  if (!amount) throw new Error('amount is required');
  if (!currency) throw new Error('currency is required');
  if (!installId) throw new Error('installId is required');
  if (!safeboxUri) throw new Error('safeboxUri is required');

  const sub = 'safenet:package:' + pkg + '@' + version;
  return _buildClaim(safeboxUri, sub, 'payment', {
    package: pkg,
    version,
    amount,
    currency,
    installId,
    safeboxUri
  });
};

// ----------------------------------------------------------------
// Audit attestation claims
// ----------------------------------------------------------------

/**
 * Create an audit attestation claim.
 * An auditor attests that a specific package (or version range) meets
 * the requirements for a given topic (e.g., ml-inference, crypto).
 *
 * The auditor's key is derived via HKDF delegation from an auditor
 * root secret, chained through the topic path:
 *   auditorRoot → delegate("safenet.audit") → delegate("safenet.audit.<topic>")
 *
 * @param {object} opts
 * @param {string}   opts.topic          - Topic path (e.g. "safenet.audit.ml-inference")
 * @param {string}   opts.namespace      - Package namespace
 * @param {string}   opts.package        - Package name
 * @param {string}   opts.versionRange   - Semver range the attestation covers
 * @param {string}   opts.assessment     - Assessment result ("approved" or "rejected")
 * @param {string}   opts.auditor        - Auditor public key (hex) or identity URI
 * @param {string}  [opts.expiry]        - ISO timestamp when this attestation expires
 * @param {object}  [opts.delegationProof] - OCP delegation chain proving auditor authority
 * @param {string}  [opts.summary]       - Human-readable summary of the audit findings
 * @returns {object} Unsigned OCP claim
 */
Claims.auditAttestation = function auditAttestation(opts) {
  const { topic, namespace, versionRange, assessment,
    auditor, expiry, delegationProof, summary } = opts;
  const pkg = opts.package;

  if (!topic) throw new Error('topic is required');
  if (!namespace) throw new Error('namespace is required');
  if (!pkg) throw new Error('package is required');
  if (!versionRange) throw new Error('versionRange is required');
  if (!assessment) throw new Error('assessment is required');
  if (assessment !== 'approved' && assessment !== 'rejected') {
    throw new Error('assessment must be "approved" or "rejected"');
  }
  if (!auditor) throw new Error('auditor is required');

  const iss = 'safenet:auditor:' + auditor;
  const sub = 'safenet:package:' + pkg;
  return _buildClaim(iss, sub, 'audit_attestation', {
    topic,
    namespace,
    package: pkg,
    versionRange,
    assessment,
    auditor,
    expiry,
    delegationProof,
    summary
  });
};

// ----------------------------------------------------------------
// Revocation claims
// ----------------------------------------------------------------

/**
 * Create a key revocation claim.
 * Revokes a specific signing key, optionally invalidating
 * publications signed after a given timestamp.
 *
 * @param {object} opts
 * @param {string} opts.revokedKey                 - Hex or JWK of the revoked key
 * @param {string} opts.reason                     - Revocation reason
 * @param {string} [opts.invalidatePublicationsAfter] - ISO timestamp; publications
 *   signed after this time with the revoked key are considered invalid
 * @returns {object} Unsigned OCP claim
 */
Claims.keyRevocation = function keyRevocation(opts) {
  const { revokedKey, reason, invalidatePublicationsAfter } = opts;
  if (!revokedKey) throw new Error('revokedKey is required');
  if (!reason) throw new Error('reason is required');

  const sub = 'safenet:key:' + (typeof revokedKey === 'string'
    ? revokedKey
    : sha256hex(JSON.stringify(revokedKey)));
  // iss will be set by the signer (the key owner)
  return _buildClaim('safenet:authority', sub, 'key_revocation', {
    revokedKey,
    reason,
    invalidatePublicationsAfter
  });
};

/**
 * Create a package revocation claim.
 * Revokes a specific package version, with optional advisory and replacement.
 *
 * @param {object} opts
 * @param {string}  opts.package     - Package name
 * @param {string}  opts.version     - Version being revoked
 * @param {string}  opts.reason      - Revocation reason
 * @param {string} [opts.advisory]   - Security advisory identifier
 * @param {string} [opts.replacement]- Replacement package@version
 * @returns {object} Unsigned OCP claim
 */
Claims.packageRevocation = function packageRevocation(opts) {
  const { version, reason, advisory, replacement } = opts;
  const pkg = opts.package;
  if (!pkg) throw new Error('package is required');
  if (!version) throw new Error('version is required');
  if (!reason) throw new Error('reason is required');

  const sub = 'safenet:package:' + pkg + '@' + version;
  return _buildClaim('safenet:package:' + pkg, sub, 'package_revocation', {
    package: pkg,
    version,
    reason,
    advisory,
    replacement
  });
};

// ----------------------------------------------------------------
// DNS name claims
// ----------------------------------------------------------------

/**
 * Create a name claim.
 * Maps a human-readable domain name to a safebox, with optional failover.
 * Signed by the hub owner or governance key. The zone compiler reads
 * accepted name_claims from the registry to produce DNS A records.
 *
 * @param {object} opts
 * @param {string} opts.name              - Domain name (e.g. "myapp.safenet.org")
 * @param {string} opts.safeboxId         - Primary safebox ID
 * @param {string} opts.owner             - Owner/issuer name or public key
 * @param {string} [opts.failoverSafeboxId] - Failover safebox ID
 * @param {string} [opts.governancePolicy]  - Governance policy (null initially)
 * @returns {object} Unsigned OCP claim
 */
/**
 * Create a model_available claim — announces that this Safebox has a
 * specific model loaded and ready for inference.
 *
 * Gossiped through the Safenet so peers can discover who can serve
 * inference for a given model.
 *
 * @param {object} opts
 * @param {string} opts.safeboxUri    - URI of the announcing Safebox
 * @param {string} opts.endpoint      - HTTPS endpoint to reach this Safebox
 * @param {string} opts.manifestHash  - 64-char hex SHA-256 of the canonical model manifest
 * @param {string} [opts.modelName]   - Human-readable model name (e.g. "Kimi-K3.1-Pro")
 * @param {string} [opts.modelVersion] - Model version string
 * @param {string} [opts.modelType]   - Model type (e.g. "LLM", "embedding")
 * @param {number} [opts.capacity]    - Max concurrent inference requests (0 = unlimited)
 * @returns {object} Unsigned OCP claim
 */
Claims.modelAvailable = function modelAvailable(opts) {
  const { safeboxUri, endpoint, manifestHash, modelName, modelVersion, modelType, capacity } = opts;
  if (!safeboxUri) throw new Error('safeboxUri is required');
  if (!endpoint) throw new Error('endpoint is required');
  if (!manifestHash || !/^[0-9a-f]{64}$/.test(manifestHash)) {
    throw new Error('manifestHash must be a 64-char lowercase hex string');
  }

  return _buildClaim(safeboxUri, 'safenet:model:' + manifestHash, 'model_available', {
    endpoint,
    manifestHash,
    modelName: modelName || null,
    modelVersion: modelVersion || null,
    modelType: modelType || null,
    capacity: typeof capacity === 'number' ? capacity : 0
  });
};

Claims.nameClaim = function nameClaim(opts) {
  const { name, safeboxId, owner, failoverSafeboxId, governancePolicy } = opts;
  if (!name) throw new Error('name is required');
  if (!safeboxId) throw new Error('safeboxId is required');
  if (!owner) throw new Error('owner is required');

  // Basic domain validation
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(name)) {
    throw new Error('name must be a valid lowercase domain (e.g. "myapp.safenet.org")');
  }

  const iss = owner.includes(':') ? owner : _authorUri(owner);
  const sub = 'safenet:name:' + name;
  return _buildClaim(iss, sub, 'name_claim', {
    name,
    safeboxId,
    failoverSafeboxId: failoverSafeboxId || null,
    governancePolicy: governancePolicy || null
  });
};

module.exports = Claims;
