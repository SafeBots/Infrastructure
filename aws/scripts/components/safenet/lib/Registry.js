'use strict';

const {
  resolveQ,
  sha256hex,
  generateClaimHash,
  validateSemver,
  validateNamespace,
  nowISO
} = require('./utils');
const Data = require(resolveQ('Q/Data'));

/**
 * Key prefixes used in the Prolly tree.
 * @enum {string}
 */
const PREFIX = {
  NAMESPACE: 'namespace:',
  PACKAGE: 'package:',
  VERSION: 'version:',
  REVOCATION: 'revocation:',
  AUDIT: 'audit:',
  NAME: 'name:',
  BOX_ANNOUNCE: 'box:'
};

/**
 * Distributed package registry backed by a Q.Data.Prolly tree.
 *
 * Stores namespace claims, package metadata, and publication claims
 * in a content-addressed Prolly tree. Supports diffing and merging
 * with other registry instances for peer-to-peer sync.
 */
class Registry {
  /**
   * @param {object} [options]
   * @param {object} [options.store] - Pluggable Prolly backing store.
   *   Defaults to in-memory.
   */
  constructor(options) {
    const opts = options || {};
    this._storeOpts = opts.store ? { store: opts.store } : {};
    this._rootHash = null;
    /** @type {Map<string, object>} claimHash -> claim, for dedup */
    this._claimIndex = new Map();
  }

  /**
   * Current Prolly root hash. Null before any writes.
   * @type {string|null}
   */
  get rootHash() {
    return this._rootHash;
  }

  // ----------------------------------------------------------------
  // Namespace operations
  // ----------------------------------------------------------------

  /**
   * Process a namespace_claim. First-come-first-served: if the
   * namespace is not yet claimed, it is assigned to this claim's
   * issuer.
   *
   * Signature validation is the caller's responsibility; this method
   * checks structural validity and uniqueness only.
   *
   * @param {object} claim - An OCP claim whose stm.type is
   *   "namespace_claim" and stm.namespace holds the desired name.
   * @returns {Promise<{ok: boolean, rootHash?: string, code?: string, message?: string}>}
   */
  async claimNamespace(claim) {
    if (!claim || !claim.stm) {
      return { ok: false, code: 'INVALID_CLAIM', message: 'Claim must have a stm field' };
    }

    const name = claim.stm.namespace;

    // 1. Validate namespace format
    const v = validateNamespace(name);
    if (!v.valid) {
      return { ok: false, code: 'INVALID_NAMESPACE', message: v.reason };
    }

    // 2. Check for existing claim (first-come-first-served)
    const existing = await this._get(PREFIX.NAMESPACE + name);
    if (existing) {
      return {
        ok: false,
        code: 'NAMESPACE_TAKEN',
        message: `Namespace "${name}" is already claimed`
      };
    }

    // 3. Store
    const claimHash = generateClaimHash(claim);
    this._claimIndex.set(claimHash, claim);
    this._rootHash = await this._set(PREFIX.NAMESPACE + name, {
      claim,
      claimHash,
      claimedAt: nowISO()
    });

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Look up the claim that owns a namespace.
   *
   * @param {string} name - Namespace name
   * @returns {Promise<object|null>} The stored claim, or null
   */
  async getNamespace(name) {
    const entry = await this._get(PREFIX.NAMESPACE + name);
    return entry ? entry.claim : null;
  }

  // ----------------------------------------------------------------
  // Publication operations
  // ----------------------------------------------------------------

  /**
   * Process a publication claim. Validates ownership, semver, and
   * required manifest fields before inserting.
   *
   * Expected claim shape:
   *   claim.stm.namespace  - namespace name
   *   claim.stm.name       - package name
   *   claim.stm.version    - semver string
   *   claim.stm.issuer     - must match namespace owner
   *   claim.stm.manifest   - object with at least { description }
   *
   * @param {object} publicationClaim
   * @returns {Promise<{ok: boolean, rootHash?: string, code?: string, message?: string}>}
   */
  async publish(publicationClaim) {
    if (!publicationClaim || !publicationClaim.stm) {
      return { ok: false, code: 'INVALID_CLAIM', message: 'Claim must have a stm field' };
    }

    const stm = publicationClaim.stm;
    const ns = stm.namespace;
    const name = stm.name;
    const version = stm.version;
    const issuer = stm.issuer;
    const manifest = stm.manifest;

    // 1. Namespace must exist and be owned by issuer
    const nsEntry = await this._get(PREFIX.NAMESPACE + ns);
    if (!nsEntry) {
      return {
        ok: false,
        code: 'NAMESPACE_NOT_FOUND',
        message: `Namespace "${ns}" does not exist`
      };
    }
    if (nsEntry.claim.stm.issuer !== issuer) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: `Issuer does not own namespace "${ns}"`
      };
    }

    // 2. Validate semver
    if (!validateSemver(version)) {
      return {
        ok: false,
        code: 'INVALID_VERSION',
        message: `"${version}" is not valid semver`
      };
    }

    // 3. Validate manifest fields
    if (!manifest || typeof manifest !== 'object' || !manifest.description) {
      return {
        ok: false,
        code: 'INVALID_MANIFEST',
        message: 'Manifest must include at least a description'
      };
    }

    // 4. Check version does not already exist
    const versionKey = PREFIX.VERSION + ns + '/' + name + '@' + version;
    const existingVersion = await this._get(versionKey);
    if (existingVersion) {
      return {
        ok: false,
        code: 'VERSION_EXISTS',
        message: `Version ${version} of ${ns}/${name} already exists`
      };
    }

    // 5. Insert version record
    const claimHash = generateClaimHash(publicationClaim);
    this._claimIndex.set(claimHash, publicationClaim);

    this._rootHash = await this._set(versionKey, {
      claim: publicationClaim,
      claimHash,
      publishedAt: nowISO()
    });

    // 6. Update (or create) package metadata
    const pkgKey = PREFIX.PACKAGE + ns + '/' + name;
    const existingPkg = await this._get(pkgKey) || {
      namespace: ns,
      name: name,
      versions: [],
      createdAt: nowISO()
    };
    if (!existingPkg.versions.includes(version)) {
      existingPkg.versions.push(version);
    }
    existingPkg.latest = version;
    existingPkg.updatedAt = nowISO();
    existingPkg.description = manifest.description;

    this._rootHash = await this._set(pkgKey, existingPkg);

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Look up package metadata.
   *
   * @param {string} namespace
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async getPackage(namespace, name) {
    return this._get(PREFIX.PACKAGE + namespace + '/' + name);
  }

  /**
   * Look up the publication claim for a specific version.
   *
   * @param {string} namespace
   * @param {string} name
   * @param {string} version
   * @returns {Promise<object|null>} The publication claim, or null
   */
  async getVersion(namespace, name, version) {
    const entry = await this._get(
      PREFIX.VERSION + namespace + '/' + name + '@' + version
    );
    return entry ? entry.claim : null;
  }

  /**
   * List all published versions of a package.
   *
   * @param {string} namespace
   * @param {string} name
   * @returns {Promise<string[]>} Version strings, or empty array
   */
  async listVersions(namespace, name) {
    const pkg = await this.getPackage(namespace, name);
    return pkg ? (pkg.versions || []) : [];
  }

  // ----------------------------------------------------------------
  // Audit attestation operations
  // ----------------------------------------------------------------

  /**
   * Process an audit attestation claim. Stores the attestation keyed
   * by topic, auditor, namespace, and package for efficient lookup
   * during mutual attestation.
   *
   * Expected claim shape:
   *   claim.stm.type         = "audit_attestation"
   *   claim.stm.topic        - Topic path (e.g. "safenet.audit.ml-inference")
   *   claim.stm.namespace    - Package namespace
   *   claim.stm.package      - Package name
   *   claim.stm.versionRange - Semver range the attestation covers
   *   claim.stm.assessment   - "approved" or "rejected"
   *   claim.stm.auditor      - Auditor public key or URI
   *
   * @param {object} claim - Signed OCP claim
   * @returns {Promise<{ok: boolean, rootHash?: string, code?: string, message?: string}>}
   */
  async processAuditAttestation(claim) {
    if (!claim || !claim.stm) {
      return { ok: false, code: 'INVALID_CLAIM', message: 'Claim must have a stm field' };
    }

    const stm = claim.stm;
    if (!stm.topic || !stm.auditor || !stm.namespace || !stm.package) {
      return {
        ok: false,
        code: 'INVALID_AUDIT',
        message: 'Audit attestation requires topic, auditor, namespace, and package'
      };
    }

    if (stm.assessment !== 'approved' && stm.assessment !== 'rejected') {
      return {
        ok: false,
        code: 'INVALID_ASSESSMENT',
        message: 'assessment must be "approved" or "rejected"'
      };
    }

    // Key format: audit:<topic>:<auditor>:<namespace>/<package>
    const auditKey = PREFIX.AUDIT + stm.topic + ':' + stm.auditor
      + ':' + stm.namespace + '/' + stm.package;

    const claimHash = generateClaimHash(claim);
    this._claimIndex.set(claimHash, claim);

    this._rootHash = await this._set(auditKey, {
      claim,
      claimHash,
      attestedAt: nowISO()
    });

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Retrieve all audit attestations for a specific topic and package.
   *
   * @param {string} topic     - Topic path (e.g. "safenet.audit.ml-inference")
   * @param {string} namespace - Package namespace
   * @param {string} name      - Package name
   * @returns {Promise<object[]>} Array of audit attestation claims
   */
  async getAuditAttestations(topic, namespace, name) {
    const prefix = PREFIX.AUDIT + topic + ':';
    const suffix = ':' + namespace + '/' + name;
    const all = await this._allEntries();
    const results = [];

    for (const { key, value } of all) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        if (value && value.claim) {
          results.push(value.claim);
        }
      }
    }

    return results;
  }

  /**
   * Query all audit attestations for a given topic, regardless of package.
   *
   * @param {string} topic - Topic path
   * @param {object} [options]
   * @param {number} [options.limit] - Max results (default 100)
   * @returns {Promise<object[]>} Array of audit attestation claims
   */
  async queryAuditsByTopic(topic, options) {
    const opts = options || {};
    const limit = opts.limit || 100;
    const prefix = PREFIX.AUDIT + topic + ':';
    const all = await this._allEntries();
    const results = [];

    for (const { key, value } of all) {
      if (key.startsWith(prefix) && value && value.claim) {
        results.push(value.claim);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  // ----------------------------------------------------------------
  // Name claim operations (DNS)
  // ----------------------------------------------------------------

  /**
   * Process a name_claim. Maps a domain name to a safebox ID.
   * Last-writer-wins: a new claim for the same name from the same
   * issuer replaces the old one. Different issuers are rejected
   * (the name is taken).
   *
   * @param {object} claim - OCP claim with stm.type = "name_claim"
   * @returns {Promise<{ok: boolean, rootHash?: string, code?: string, message?: string}>}
   */
  async processNameClaim(claim) {
    if (!claim || !claim.stm) {
      return { ok: false, code: 'INVALID_CLAIM', message: 'Claim must have a stm field' };
    }

    const stm = claim.stm;
    if (stm.type !== 'name_claim') {
      return { ok: false, code: 'INVALID_TYPE', message: 'stm.type must be name_claim' };
    }
    if (!stm.name || typeof stm.name !== 'string') {
      return { ok: false, code: 'INVALID_NAME', message: 'stm.name is required' };
    }
    if (!stm.safeboxId || typeof stm.safeboxId !== 'string') {
      return { ok: false, code: 'INVALID_SAFEBOX', message: 'stm.safeboxId is required' };
    }

    const nameKey = PREFIX.NAME + stm.name;
    const existing = await this._get(nameKey);

    // If already claimed by a different issuer, reject
    if (existing && existing.claim && existing.claim.iss !== claim.iss) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: `Name "${stm.name}" is already claimed by a different issuer`
      };
    }

    const claimHash = generateClaimHash(claim);
    this._claimIndex.set(claimHash, claim);

    this._rootHash = await this._set(nameKey, {
      claim,
      claimHash,
      name: stm.name,
      safeboxId: stm.safeboxId,
      failoverSafeboxId: stm.failoverSafeboxId || null,
      updatedAt: nowISO()
    });

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Look up the name_claim for a domain name.
   *
   * @param {string} name - Domain name
   * @returns {Promise<object|null>}
   */
  async getNameClaim(name) {
    const entry = await this._get(PREFIX.NAME + name);
    return entry || null;
  }

  /**
   * Get all name_claims. Used by the zone compiler.
   *
   * @returns {Promise<object[]>} Array of { name, safeboxId, failoverSafeboxId, claim }
   */
  async getAllNameClaims() {
    const all = await this._allEntries();
    return all
      .filter(({ key }) => key.startsWith(PREFIX.NAME))
      .map(({ value }) => value);
  }

  // ----------------------------------------------------------------
  // Box announce operations (DNS zone source)
  // ----------------------------------------------------------------

  /**
   * Process a safebox_announce. Stores the latest announce for a
   * safebox ID so the zone compiler can look up IP addresses.
   * Last-announce-wins per safebox ID.
   *
   * @param {object} announce - The announce record { safeboxId, publicIp, ... }
   * @returns {Promise<{ok: boolean, rootHash?: string}>}
   */
  async processBoxAnnounce(announce) {
    if (!announce || !announce.safeboxId || !announce.publicIp) {
      return { ok: false, code: 'INVALID_ANNOUNCE', message: 'announce must have safeboxId and publicIp' };
    }

    const key = PREFIX.BOX_ANNOUNCE + announce.safeboxId;
    this._rootHash = await this._set(key, {
      safeboxId: announce.safeboxId,
      publicIp: announce.publicIp,
      cloud: announce.cloud || null,
      attestedAt: announce.issuedAt || nowISO(),
      updatedAt: nowISO()
    });

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Get the latest announce for a safebox ID.
   *
   * @param {string} safeboxId
   * @returns {Promise<object|null>}
   */
  async getBoxAnnounce(safeboxId) {
    return this._get(PREFIX.BOX_ANNOUNCE + safeboxId);
  }

  /**
   * Get all box announces. Used by the zone compiler.
   *
   * @returns {Promise<Map<string, object>>} Map of safeboxId -> announce
   */
  async getAllBoxAnnounces() {
    const all = await this._allEntries();
    const map = new Map();
    for (const { key, value } of all) {
      if (key.startsWith(PREFIX.BOX_ANNOUNCE)) {
        map.set(value.safeboxId, value);
      }
    }
    return map;
  }

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------

  /**
   * Simple text search across package names and descriptions.
   *
   * This is a brute-force scan of all package:* entries. A production
   * implementation would maintain a search index.
   *
   * @param {string} query - Search string (case-insensitive substring match)
   * @param {object} [options]
   * @param {string} [options.language] - Reserved for future i18n filtering
   * @param {number} [options.limit] - Max results (default 50)
   * @returns {Promise<object[]>} Array of matching package metadata objects
   */
  async search(query, options) {
    const opts = options || {};
    const limit = opts.limit || 50;
    const q = (query || '').toLowerCase();

    if (!q) return [];

    const all = await this._allEntries();
    const results = [];

    for (const { key, value } of all) {
      if (!key.startsWith(PREFIX.PACKAGE)) continue;

      const nameMatch = (value.name || '').toLowerCase().includes(q);
      const descMatch = (value.description || '').toLowerCase().includes(q);
      const nsMatch = (value.namespace || '').toLowerCase().includes(q);

      if (nameMatch || descMatch || nsMatch) {
        results.push(value);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  // ----------------------------------------------------------------
  // Revocation
  // ----------------------------------------------------------------

  /**
   * Process a revocation claim. Marks the target claim hash as
   * revoked. Does not remove the original entry from the tree.
   *
   * @param {object} revocationClaim - Claim whose stm.targetHash
   *   identifies what is being revoked.
   * @returns {Promise<{ok: boolean, rootHash?: string, code?: string, message?: string}>}
   */
  async processRevocation(revocationClaim) {
    if (!revocationClaim || !revocationClaim.stm) {
      return { ok: false, code: 'INVALID_CLAIM', message: 'Claim must have a stm field' };
    }

    const targetHash = revocationClaim.stm.targetHash;
    if (!targetHash) {
      return {
        ok: false,
        code: 'MISSING_TARGET',
        message: 'Revocation claim must specify stm.targetHash'
      };
    }

    const claimHash = generateClaimHash(revocationClaim);
    this._claimIndex.set(claimHash, revocationClaim);

    this._rootHash = await this._set(PREFIX.REVOCATION + targetHash, {
      claim: revocationClaim,
      claimHash,
      revokedAt: nowISO()
    });

    return { ok: true, rootHash: this._rootHash };
  }

  /**
   * Check whether a claim hash has been revoked.
   *
   * @param {string} claimHash
   * @returns {Promise<boolean>}
   */
  async isRevoked(claimHash) {
    const entry = await this._get(PREFIX.REVOCATION + claimHash);
    return entry !== null;
  }

  // ----------------------------------------------------------------
  // Sync / merge
  // ----------------------------------------------------------------

  /**
   * Diff this registry's Prolly tree against another root hash.
   *
   * @param {string} otherRootHash
   * @returns {Promise<{added: Array, removed: Array, changed: Array}>}
   */
  async diff(otherRootHash) {
    if (!this._rootHash || !otherRootHash) {
      return { added: [], removed: [], changed: [] };
    }
    return Data.Prolly.diff(this._rootHash, otherRootHash, this._storeOpts);
  }

  /**
   * Merge an array of claims received from a peer. Each claim is
   * validated and applied in order. Duplicates (by claim hash) are
   * silently skipped.
   *
   * @param {object[]} claims
   * @returns {Promise<{accepted: number, skipped: number, errors: Array<{claimHash: string, message: string}>}>}
   */
  async merge(claims) {
    let accepted = 0;
    let skipped = 0;
    const errors = [];

    for (const claim of claims) {
      if (!claim || !claim.stm) {
        errors.push({ claimHash: null, message: 'Invalid claim structure' });
        continue;
      }

      const claimHash = generateClaimHash(claim);

      // Skip duplicates
      if (this._claimIndex.has(claimHash)) {
        skipped++;
        continue;
      }

      let result;
      const type = claim.stm.type;

      try {
        if (type === 'namespace_claim') {
          result = await this.claimNamespace(claim);
        } else if (type === 'publication') {
          result = await this.publish(claim);
        } else if (type === 'revocation') {
          result = await this.processRevocation(claim);
        } else if (type === 'audit_attestation') {
          result = await this.processAuditAttestation(claim);
        } else if (type === 'name_claim') {
          result = await this.processNameClaim(claim);
        } else if (type === 'safebox_announce') {
          // Box announces come from Infrastructure (Ed25519-signed).
          // Extract the fields the zone compiler needs.
          result = await this.processBoxAnnounce(claim.stm || claim);
        } else {
          // Unknown claim type: store in the index but don't
          // insert into the tree
          this._claimIndex.set(claimHash, claim);
          skipped++;
          continue;
        }
      } catch (err) {
        errors.push({ claimHash, message: err.message });
        continue;
      }

      if (result.ok) {
        accepted++;
      } else {
        // Namespace-taken or version-exists during merge is
        // expected (first-come-first-served). Count as skipped.
        skipped++;
      }
    }

    return { accepted, skipped, errors };
  }

  // ----------------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------------

  /**
   * Export all entries for serialization or transfer.
   *
   * @returns {Promise<Array<{key: string, value: *}>>} Sorted by key
   */
  async exportState() {
    return this._allEntries();
  }

  /**
   * Rebuild the registry from previously exported state.
   * Overwrites the current tree entirely.
   *
   * @param {Array<{key: string, value: *}>} entries - Sorted by key
   * @returns {Promise<void>}
   */
  async importState(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      this._rootHash = null;
      this._claimIndex.clear();
      return;
    }

    // Rebuild the Prolly tree from the sorted entries
    this._rootHash = await Data.Prolly.build(entries, this._storeOpts);

    // Rebuild the claim index
    this._claimIndex.clear();
    for (const { value } of entries) {
      if (value && value.claim && value.claimHash) {
        this._claimIndex.set(value.claimHash, value.claim);
      }
    }
  }

  // ----------------------------------------------------------------
  // Stats
  // ----------------------------------------------------------------

  /**
   * Return aggregate counts of entries in the registry.
   *
   * @returns {Promise<{namespaces: number, packages: number, versions: number, revocations: number}>}
   */
  async stats() {
    const all = await this._allEntries();
    let namespaces = 0;
    let packages = 0;
    let versions = 0;
    let revocations = 0;
    let audits = 0;
    let names = 0;
    let boxes = 0;

    for (const { key } of all) {
      if (key.startsWith(PREFIX.NAMESPACE)) namespaces++;
      else if (key.startsWith(PREFIX.PACKAGE)) packages++;
      else if (key.startsWith(PREFIX.VERSION)) versions++;
      else if (key.startsWith(PREFIX.REVOCATION)) revocations++;
      else if (key.startsWith(PREFIX.AUDIT)) audits++;
      else if (key.startsWith(PREFIX.NAME)) names++;
      else if (key.startsWith(PREFIX.BOX_ANNOUNCE)) boxes++;
    }

    return { namespaces, packages, versions, revocations, audits, names, boxes };
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  /**
   * Get a value from the Prolly tree.
   * @private
   * @param {string} key
   * @returns {Promise<*|null>}
   */
  async _get(key) {
    if (!this._rootHash) return null;
    const raw = await Data.Prolly.get(this._rootHash, key, this._storeOpts);
    if (raw === null || raw === undefined) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  /**
   * Set a value in the Prolly tree, updating the root hash.
   * @private
   * @param {string} key
   * @param {*} value
   * @returns {Promise<string>} New root hash
   */
  async _set(key, value) {
    const serialized = JSON.stringify(value);
    if (this._rootHash) {
      return Data.Prolly.set(this._rootHash, key, serialized, this._storeOpts);
    }
    // First insert: build a tree with one entry
    return Data.Prolly.build([{ key, value: serialized }], this._storeOpts);
  }

  /**
   * Retrieve all entries from the tree by exporting and rebuilding.
   * Uses Prolly.diff against a null/empty tree to enumerate everything.
   *
   * @private
   * @returns {Promise<Array<{key: string, value: *}>>}
   */
  async _allEntries() {
    if (!this._rootHash) return [];

    // Diff against an empty tree gives us all entries as "added"
    const emptyRoot = await Data.Prolly.build([], this._storeOpts);
    const result = await Data.Prolly.diff(emptyRoot, this._rootHash, this._storeOpts);

    return (result.added || []).map(entry => ({
      key: entry.key,
      value: typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value
    })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
}

module.exports = Registry;
