'use strict';

const { resolveQ, sha256hex, nowISO, validateSemver, validateNamespace, randomHex } = require('./utils');
const Data = require(resolveQ('Q/Data'));
const Crypto = require(resolveQ('Q/Crypto'));
const Claims = require('./Claims');

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string} [code] - Machine-readable error code
 * @property {string} [message] - Human-readable error message
 * @property {string[]} [errors] - Detailed error list
 */

/**
 * @typedef {Object} PaymentRecord
 * @property {Object} claim - The signed payment claim
 * @property {string} installId - Unique install/payment identifier
 * @property {string} recordedAt - ISO timestamp of when the payment was recorded
 */

/**
 * @typedef {Object} BalanceInfo
 * @property {number} total - Total Safebux received
 * @property {number} payments - Number of verified payments
 */

/** Safebux verifying contract address (canonical across chains) */
const SAFEBUX_VERIFYING_CONTRACT = '0x99999febd42cad798fe10ab0b1c563002fc99999';

/**
 * Handles Safebux payments and license grants for the Safenet Protocol.
 *
 * Maintains an in-memory ledger of payments and license grants,
 * supports verification of both, and can produce EIP-712 settlement
 * batches for on-chain settlement via the OpenClaiming Payments Extension.
 */
class Payments {
  /**
   * @param {Object} options
   * @param {Object} options.identity - Identity instance (paying Safebox or receiving author)
   */
  constructor(options) {
    if (!options || !options.identity) {
      throw new Error('Payments requires an identity');
    }
    this.identity = options.identity;

    /**
     * Ledger: authorUri -> { received: PaymentRecord[], sent: PaymentRecord[] }
     * @type {Map<string, { received: PaymentRecord[], sent: PaymentRecord[] }>}
     * @private
     */
    this._ledger = new Map();

    /**
     * License grants: "<packageName>@<safeboxUri>" -> grant claim
     * @type {Map<string, Object>}
     * @private
     */
    this._licenseGrants = new Map();
  }

  /**
   * Ensure a ledger entry exists for the given author URI.
   *
   * @param {string} authorUri
   * @returns {{ received: PaymentRecord[], sent: PaymentRecord[] }}
   * @private
   */
  _ensureLedgerEntry(authorUri) {
    if (!this._ledger.has(authorUri)) {
      this._ledger.set(authorUri, { received: [], sent: [] });
    }
    return this._ledger.get(authorUri);
  }

  /**
   * Create a signed license grant claim.
   *
   * A license grant authorizes a specific Safebox to install and run
   * a package within the specified version range, subject to install
   * limits and expiry.
   *
   * @param {Object} options
   * @param {string} options.package - Package name (namespace/packageName)
   * @param {string} options.versionRange - Semver range string (e.g. ">=1.0.0 <2.0.0")
   * @param {string} options.safeboxUri - URI of the Safebox receiving the grant
   * @param {number} options.maxInstalls - Maximum number of installations allowed
   * @param {string} options.expiry - ISO 8601 expiry timestamp
   * @returns {Promise<Object>} Signed license grant claim
   */
  async createLicenseGrant(options) {
    if (!options) {
      throw new Error('createLicenseGrant requires options');
    }
    const { versionRange, safeboxUri, maxInstalls, expiry } = options;
    const packageName = options.package;

    if (!packageName || typeof packageName !== 'string') {
      return {
        ok: false,
        code: 'MISSING_PACKAGE',
        message: 'License grant requires a package name'
      };
    }
    if (!versionRange || typeof versionRange !== 'string') {
      return {
        ok: false,
        code: 'MISSING_VERSION_RANGE',
        message: 'License grant requires a versionRange'
      };
    }
    if (!safeboxUri || typeof safeboxUri !== 'string') {
      return {
        ok: false,
        code: 'MISSING_SAFEBOX_URI',
        message: 'License grant requires a safeboxUri'
      };
    }
    if (typeof maxInstalls !== 'number' || maxInstalls < 1) {
      return {
        ok: false,
        code: 'INVALID_MAX_INSTALLS',
        message: 'maxInstalls must be a positive integer'
      };
    }
    if (!expiry || typeof expiry !== 'string') {
      return {
        ok: false,
        code: 'MISSING_EXPIRY',
        message: 'License grant requires an expiry timestamp'
      };
    }

    const claim = Claims.licenseGrant({
      package: packageName,
      versionRange,
      sub: safeboxUri,
      maxInstalls,
      expiry,
      iss: this.identity.uri,
      iat: nowISO()
    });

    const signed = await this.identity.sign(claim);
    return signed;
  }

  /**
   * Verify that a license grant claim is valid for a given Safebox,
   * package, and version.
   *
   * Checks:
   *   - Signature is valid
   *   - safeboxUri matches the claim's `sub` field
   *   - Package name matches
   *   - Version falls within the granted range
   *   - Grant has not expired
   *   - Grant has not been revoked
   *
   * @param {Object} grantClaim - The signed license grant claim
   * @param {string} safeboxUri - URI of the Safebox requesting access
   * @param {string} packageName - Package name to check
   * @param {string} version - Specific version to check
   * @returns {Promise<ValidationResult>}
   */
  async verifyLicenseGrant(grantClaim, safeboxUri, packageName, version) {
    const errors = [];

    if (!grantClaim || !grantClaim.stm) {
      return {
        ok: false,
        code: 'INVALID_CLAIM',
        message: 'Grant claim must have a stm field'
      };
    }

    // Verify signature
    try {
      const sigValid = await Crypto.verify(grantClaim);
      if (!sigValid) {
        errors.push('Grant claim signature is invalid');
      }
    } catch (err) {
      errors.push(`Signature verification failed: ${err.message}`);
    }

    // Check claim type
    if (grantClaim.stm.type !== 'licenseGrant') {
      errors.push(`Expected claim type "licenseGrant", got "${grantClaim.stm.type}"`);
    }

    // Check safeboxUri matches sub
    if (grantClaim.sub !== safeboxUri) {
      errors.push(
        `Safebox URI mismatch: grant is for "${grantClaim.sub}", ` +
        `requested by "${safeboxUri}"`
      );
    }

    // Check package name
    if (grantClaim.stm.package !== packageName) {
      errors.push(
        `Package mismatch: grant is for "${grantClaim.stm.package}", ` +
        `requested "${packageName}"`
      );
    }

    // Check version is in range
    if (grantClaim.stm.versionRange && version) {
      const inRange = _versionInRange(version, grantClaim.stm.versionRange);
      if (!inRange) {
        errors.push(
          `Version "${version}" is not in granted range "${grantClaim.stm.versionRange}"`
        );
      }
    }

    // Check expiry
    if (grantClaim.stm.expiry) {
      const expiryDate = new Date(grantClaim.stm.expiry);
      if (expiryDate <= new Date()) {
        errors.push(`License grant expired at ${grantClaim.stm.expiry}`);
      }
    }

    // Check revocation
    if (grantClaim.stm.revoked) {
      errors.push('License grant has been revoked');
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  }

  /**
   * Create a signed payment claim for a package installation.
   *
   * Generates a unique installId for deduplication and tracking.
   *
   * @param {Object} options
   * @param {string} options.package - Package name
   * @param {string} options.version - Version being paid for
   * @param {number} options.amount - Payment amount in smallest Safebux unit
   * @param {string} options.currency - Currency identifier (e.g. "SAFEBUX")
   * @returns {Promise<Object>} Signed payment claim
   */
  async createPayment(options) {
    if (!options) {
      throw new Error('createPayment requires options');
    }
    const { version, amount, currency } = options;
    const packageName = options.package;

    if (!packageName || typeof packageName !== 'string') {
      return {
        ok: false,
        code: 'MISSING_PACKAGE',
        message: 'Payment requires a package name'
      };
    }
    if (!version || typeof version !== 'string') {
      return {
        ok: false,
        code: 'MISSING_VERSION',
        message: 'Payment requires a version'
      };
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return {
        ok: false,
        code: 'INVALID_AMOUNT',
        message: 'Payment amount must be a positive number'
      };
    }
    if (!currency || typeof currency !== 'string') {
      return {
        ok: false,
        code: 'MISSING_CURRENCY',
        message: 'Payment requires a currency'
      };
    }

    const installId = randomHex(16);

    const claim = Claims.payment({
      package: packageName,
      version,
      amount,
      currency,
      installId,
      iss: this.identity.uri,
      iat: nowISO()
    });

    const signed = await this.identity.sign(claim);
    return signed;
  }

  /**
   * Record a payment in the local ledger.
   *
   * Validates the claim and deduplicates by installId. Updates the
   * sender and receiver ledger entries.
   *
   * @param {Object} paymentClaim - A signed payment claim
   * @returns {Promise<ValidationResult>}
   */
  async recordPayment(paymentClaim) {
    if (!paymentClaim || !paymentClaim.stm) {
      return {
        ok: false,
        code: 'INVALID_CLAIM',
        message: 'Payment claim must have a stm field'
      };
    }

    if (paymentClaim.stm.type !== 'payment') {
      return {
        ok: false,
        code: 'WRONG_CLAIM_TYPE',
        message: `Expected claim type "payment", got "${paymentClaim.stm.type}"`
      };
    }

    // Verify signature
    try {
      const sigValid = await Crypto.verify(paymentClaim);
      if (!sigValid) {
        return {
          ok: false,
          code: 'INVALID_SIGNATURE',
          message: 'Payment claim signature is invalid'
        };
      }
    } catch (err) {
      return {
        ok: false,
        code: 'SIGNATURE_ERROR',
        message: `Signature verification failed: ${err.message}`
      };
    }

    const installId = paymentClaim.stm.installId;
    const senderUri = paymentClaim.iss;
    const recipientUri = paymentClaim.sub || paymentClaim.stm.recipient;

    if (!installId) {
      return {
        ok: false,
        code: 'MISSING_INSTALL_ID',
        message: 'Payment claim must have an installId'
      };
    }

    // Deduplicate by installId — check all existing entries
    if (recipientUri) {
      const recipientEntry = this._ensureLedgerEntry(recipientUri);
      const duplicate = recipientEntry.received.find(
        r => r.installId === installId
      );
      if (duplicate) {
        return {
          ok: false,
          code: 'DUPLICATE_PAYMENT',
          message: `Payment with installId "${installId}" already recorded`
        };
      }
    }

    const record = {
      claim: paymentClaim,
      installId,
      recordedAt: nowISO()
    };

    // Record on the recipient side
    if (recipientUri) {
      const recipientEntry = this._ensureLedgerEntry(recipientUri);
      recipientEntry.received.push(record);
    }

    // Record on the sender side
    if (senderUri) {
      const senderEntry = this._ensureLedgerEntry(senderUri);
      senderEntry.sent.push(record);
    }

    return { ok: true };
  }

  /**
   * Get the Safebux balance for an author.
   *
   * Sums all verified payment claims where the author is the recipient
   * (their `sub` or `stm.recipient` matches).
   *
   * @param {string} authorUri - The author's identity URI
   * @returns {BalanceInfo}
   */
  getBalance(authorUri) {
    if (!authorUri || typeof authorUri !== 'string') {
      return { total: 0, payments: 0 };
    }

    const entry = this._ledger.get(authorUri);
    if (!entry) {
      return { total: 0, payments: 0 };
    }

    let total = 0;
    for (const record of entry.received) {
      const amount = record.claim.stm && record.claim.stm.amount;
      if (typeof amount === 'number') {
        total += amount;
      }
    }

    return {
      total,
      payments: entry.received.length
    };
  }

  /**
   * Get payment history, optionally filtered by author, package, or
   * time range.
   *
   * @param {Object} [options]
   * @param {string} [options.author] - Filter by author URI (recipient)
   * @param {string} [options.package] - Filter by package name
   * @param {string} [options.since] - ISO 8601 timestamp lower bound
   * @param {number} [options.limit] - Maximum number of results
   * @returns {Object[]} Array of payment claims
   */
  getPaymentHistory(options) {
    const author = options && options.author;
    const packageFilter = options && options.package;
    const since = options && options.since ? new Date(options.since) : null;
    const limit = options && options.limit;

    let records = [];

    if (author) {
      // Filter to a specific author's received payments
      const entry = this._ledger.get(author);
      if (entry) {
        records = entry.received.slice();
      }
    } else {
      // Collect all received records across the ledger
      for (const entry of this._ledger.values()) {
        records = records.concat(entry.received);
      }
    }

    // Apply package filter
    if (packageFilter) {
      records = records.filter(r =>
        r.claim.stm && r.claim.stm.package === packageFilter
      );
    }

    // Apply time filter
    if (since) {
      records = records.filter(r => new Date(r.recordedAt) >= since);
    }

    // Sort by recordedAt descending (most recent first)
    records.sort((a, b) =>
      new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
    );

    // Apply limit
    if (typeof limit === 'number' && limit > 0) {
      records = records.slice(0, limit);
    }

    return records.map(r => r.claim);
  }

  /**
   * Store a license grant locally for later lookup.
   *
   * Keyed by `<packageName>@<safeboxUri>`.
   *
   * @param {Object} grantClaim - A signed license grant claim
   */
  storeLicenseGrant(grantClaim) {
    if (!grantClaim || !grantClaim.stm) {
      throw new Error('Grant claim must have a stm field');
    }
    const packageName = grantClaim.stm.package;
    const safeboxUri = grantClaim.sub;
    if (!packageName || !safeboxUri) {
      throw new Error('Grant claim must specify package and sub');
    }
    const key = `${packageName}@${safeboxUri}`;
    this._licenseGrants.set(key, grantClaim);
  }

  /**
   * Check whether this Safebox (identity) has a valid, non-expired
   * license for a specific package and version.
   *
   * @param {string} packageName - Package name (namespace/packageName)
   * @param {string} version - Specific version to check
   * @returns {Object|null} The grant claim if valid, or null
   */
  hasLicense(packageName, version) {
    const key = `${packageName}@${this.identity.uri}`;
    const grant = this._licenseGrants.get(key);
    if (!grant) {
      return null;
    }

    // Check expiry
    if (grant.stm.expiry) {
      const expiryDate = new Date(grant.stm.expiry);
      if (expiryDate <= new Date()) {
        return null;
      }
    }

    // Check revocation
    if (grant.stm.revoked) {
      return null;
    }

    // Check version range
    if (grant.stm.versionRange && version) {
      if (!_versionInRange(version, grant.stm.versionRange)) {
        return null;
      }
    }

    return grant;
  }

  /**
   * Create an EIP-712 Payment claim for on-chain settlement.
   *
   * Aggregates all pending (unsettled) payments to a given author
   * into a single OpenClaiming Payments Extension claim, formatted
   * as EIP-712 typed data ready for signing and on-chain submission.
   *
   * @param {string} authorUri - The recipient author's identity URI
   * @param {string|number} chainId - EVM chain ID for the settlement
   * @returns {Object} EIP-712 structured claim for the OpenClaiming Payments Extension
   */
  createSettlementBatch(authorUri, chainId) {
    if (!authorUri || typeof authorUri !== 'string') {
      return {
        ok: false,
        code: 'MISSING_AUTHOR',
        message: 'Settlement batch requires an authorUri'
      };
    }
    if (!chainId) {
      return {
        ok: false,
        code: 'MISSING_CHAIN_ID',
        message: 'Settlement batch requires a chainId'
      };
    }

    const entry = this._ledger.get(authorUri);
    if (!entry || entry.received.length === 0) {
      return {
        ok: false,
        code: 'NO_PAYMENTS',
        message: `No payments found for author "${authorUri}"`
      };
    }

    // Aggregate total amount
    let totalAmount = 0;
    for (const record of entry.received) {
      const amount = record.claim.stm && record.claim.stm.amount;
      if (typeof amount === 'number') {
        totalAmount += amount;
      }
    }

    // Extract EVM addresses from URIs
    // URI format: "evm:<chainId>:address:<address>" or similar
    const payerAddress = _extractEvmAddress(this.identity.uri);
    const recipientAddress = _extractEvmAddress(authorUri);

    const chainIdStr = String(chainId);
    const payerUri = payerAddress
      ? `evm:${chainIdStr}:address:${payerAddress}`
      : this.identity.uri;
    const recipientUri = recipientAddress
      ? `evm:${chainIdStr}:address:${recipientAddress}`
      : authorUri;

    return {
      ocp: 1,
      fmt: 'EIP712',
      iss: payerUri,
      sub: recipientUri,
      stm: {
        type: 'payment',
        chainId: chainIdStr,
        verifyingContract: SAFEBUX_VERIFYING_CONTRACT,
        recipients: [recipientUri],
        max: String(totalAmount),
        line: '0'
      }
    };
  }

  /**
   * Serialize the ledger and license grants for persistence.
   *
   * @returns {Object} Serialized ledger data
   */
  exportLedger() {
    const ledger = {};
    for (const [authorUri, entry] of this._ledger.entries()) {
      ledger[authorUri] = {
        received: entry.received.slice(),
        sent: entry.sent.slice()
      };
    }

    const grants = {};
    for (const [key, grant] of this._licenseGrants.entries()) {
      grants[key] = grant;
    }

    return {
      version: 1,
      exportedAt: nowISO(),
      identityUri: this.identity.uri,
      ledger,
      licenseGrants: grants
    };
  }

  /**
   * Import a previously exported ledger, replacing current state.
   *
   * @param {Object} data - Data from exportLedger()
   */
  importLedger(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Import data must be a non-null object');
    }
    if (data.version !== 1) {
      throw new Error(`Unsupported ledger export version: ${data.version}`);
    }

    // Restore ledger
    this._ledger = new Map();
    if (data.ledger && typeof data.ledger === 'object') {
      for (const [authorUri, entry] of Object.entries(data.ledger)) {
        this._ledger.set(authorUri, {
          received: Array.isArray(entry.received) ? entry.received.slice() : [],
          sent: Array.isArray(entry.sent) ? entry.sent.slice() : []
        });
      }
    }

    // Restore license grants
    this._licenseGrants = new Map();
    if (data.licenseGrants && typeof data.licenseGrants === 'object') {
      for (const [key, grant] of Object.entries(data.licenseGrants)) {
        this._licenseGrants.set(key, grant);
      }
    }
  }
}

/**
 * Extract an EVM address from a URI of the form
 * "evm:<chainId>:address:<hexAddress>".
 *
 * @param {string} uri
 * @returns {string|null} The hex address, or null if the URI doesn't match
 * @private
 */
function _extractEvmAddress(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const match = uri.match(/^evm:\d+:address:(0x[0-9a-fA-F]{40})$/);
  return match ? match[1] : null;
}

/**
 * Basic semver range check. Supports these range formats:
 *   - Exact: "1.2.3"
 *   - Wildcard: "*"
 *   - Caret: "^1.2.3" (>=1.2.3 <2.0.0)
 *   - Tilde: "~1.2.3" (>=1.2.3 <1.3.0)
 *   - Compound: ">=1.0.0 <2.0.0"
 *
 * This is a simplified implementation suitable for the reference
 * implementation; production should use a full semver library.
 *
 * @param {string} version - Exact version to test
 * @param {string} range - Semver range string
 * @returns {boolean}
 * @private
 */
function _versionInRange(version, range) {
  if (!version || !range) return false;
  if (range === '*') return true;

  const parsed = _parseSemver(version);
  if (!parsed) return false;

  // Exact match
  if (validateSemver(range)) {
    return version === range;
  }

  // Caret range: ^major.minor.patch -> >=version <nextMajor.0.0
  if (range.startsWith('^')) {
    const base = _parseSemver(range.slice(1));
    if (!base) return false;
    if (_compareSemver(parsed, base) < 0) return false;
    return parsed.major === base.major;
  }

  // Tilde range: ~major.minor.patch -> >=version <major.nextMinor.0
  if (range.startsWith('~')) {
    const base = _parseSemver(range.slice(1));
    if (!base) return false;
    if (_compareSemver(parsed, base) < 0) return false;
    return parsed.major === base.major && parsed.minor === base.minor;
  }

  // Compound range: ">=1.0.0 <2.0.0"
  const parts = range.split(/\s+/);
  for (const part of parts) {
    let op, ver;
    if (part.startsWith('>=')) {
      op = '>=';
      ver = _parseSemver(part.slice(2));
    } else if (part.startsWith('<=')) {
      op = '<=';
      ver = _parseSemver(part.slice(2));
    } else if (part.startsWith('>')) {
      op = '>';
      ver = _parseSemver(part.slice(1));
    } else if (part.startsWith('<')) {
      op = '<';
      ver = _parseSemver(part.slice(1));
    } else {
      continue;
    }
    if (!ver) return false;
    const cmp = _compareSemver(parsed, ver);
    if (op === '>=' && cmp < 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<' && cmp >= 0) return false;
  }

  return true;
}

/**
 * Parse a semver string into { major, minor, patch }.
 *
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number }|null}
 * @private
 */
function _parseSemver(v) {
  if (!v || typeof v !== 'string') return null;
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Compare two parsed semver objects.
 *
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 * @private
 */
function _compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

module.exports = Payments;
