'use strict';

const { resolveQ, sha256hex } = require('./utils');
const Claims = require('./Claims');

// Lazy-loaded Q modules. Resolved on first use so the module can
// be required even when Q is not yet on the path (e.g. during tests
// that mock these).
let _Crypto = null;
let _Data = null;

/**
 * @returns {object} Q.Crypto module
 */
function getCrypto() {
  if (!_Crypto) _Crypto = require(resolveQ('Q/Crypto'));
  return _Crypto;
}

/**
 * @returns {object} Q.Data module
 */
function getData() {
  if (!_Data) _Data = require(resolveQ('Q/Data'));
  return _Data;
}

/**
 * Represents a Safebox or Author identity in the Safenet protocol.
 *
 * Wraps a keypair and provides methods for creating identity claims,
 * signing arbitrary OCP claims, and verifying signed claims.
 *
 * @class
 */
class Identity {
  /**
   * @param {object} options
   * @param {'safebox'|'author'} options.type       - Identity type
   * @param {string}            [options.name]      - Author name (required for author type)
   * @param {string|Buffer}     [options.publicKey]  - Public key (hex string or Buffer)
   * @param {string|Buffer}     [options.privateKey] - Private key (hex string or Buffer)
   * @param {object}            [options.keyPair]    - Full keypair object from Q.Data / Q.Crypto
   * @param {string}            [options.secret]     - Secret to derive keypair from
   */
  constructor(options) {
    if (!options || !options.type) {
      throw new Error('options.type is required ("safebox" or "author")');
    }
    if (options.type !== 'safebox' && options.type !== 'author') {
      throw new Error('type must be "safebox" or "author"');
    }
    if (options.type === 'author' && !options.name) {
      throw new Error('name is required for author identities');
    }

    /** @type {'safebox'|'author'} */
    this.type = options.type;

    /** @type {string|undefined} */
    this.name = options.name;

    /** @type {string|Buffer|null} */
    this._publicKey = options.publicKey || null;

    /** @type {string|Buffer|null} */
    this._privateKey = options.privateKey || null;

    /** @type {object|null} */
    this._keyPair = options.keyPair || null;

    // If we got a keyPair object, extract the keys from it
    if (this._keyPair) {
      if (!this._publicKey && this._keyPair.publicKey) {
        this._publicKey = this._keyPair.publicKey;
      }
      if (!this._privateKey && this._keyPair.privateKey) {
        this._privateKey = this._keyPair.privateKey;
      }
    }
  }

  // ------------------------------------------------------------------
  // Static factories
  // ------------------------------------------------------------------

  /**
   * Generate a new Safebox identity with a fresh P-256 keypair.
   *
   * @returns {Promise<Identity>}
   */
  static async generateSafebox() {
    const Data = getData();
    const keyPair = await Data.generateKey('P-256');
    return new Identity({
      type: 'safebox',
      keyPair,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey
    });
  }

  /**
   * Generate a new Author identity with a fresh P-256 keypair.
   *
   * @param {string} name - Author name (must be namespace-safe)
   * @returns {Promise<Identity>}
   */
  static async generateAuthor(name) {
    if (!name) throw new Error('Author name is required');
    const Data = getData();
    const keyPair = await Data.generateKey('P-256');
    return new Identity({
      type: 'author',
      name,
      keyPair,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey
    });
  }

  /**
   * Derive an identity's keypair deterministically from a secret.
   *
   * @param {string} secret - Secret seed value
   * @param {'safebox'|'author'} type - Identity type
   * @param {string} [name] - Author name (required if type is 'author')
   * @returns {Promise<Identity>}
   */
  static async fromSecret(secret, type, name) {
    if (!secret) throw new Error('secret is required');
    if (type === 'author' && !name) {
      throw new Error('name is required for author identities');
    }
    const Crypto = getCrypto();
    const keyPair = await Crypto.internalKeypair({
      secret,
      type: 'ES256'
    });
    return new Identity({
      type,
      name,
      keyPair,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey
    });
  }

  /**
   * Reconstruct an Identity from its JSON representation.
   * Only restores the public key; the private key is never serialised.
   *
   * @param {object} json - Output of identity.toJSON()
   * @returns {Identity}
   */
  static fromJSON(json) {
    if (!json || !json.type) {
      throw new Error('Invalid identity JSON');
    }
    return new Identity({
      type: json.type,
      name: json.name,
      publicKey: json.publicKey
    });
  }

  // ------------------------------------------------------------------
  // Getters
  // ------------------------------------------------------------------

  /**
   * The public key as a hex string.
   * @type {string}
   */
  get publicKeyHex() {
    if (!this._publicKey) {
      throw new Error('No public key available');
    }
    return Buffer.isBuffer(this._publicKey)
      ? this._publicKey.toString('hex')
      : this._publicKey;
  }

  /**
   * SHA-256 hex digest of the public key (SPKI hash).
   * Used as the stable identifier for safebox URIs.
   * @type {string}
   */
  get spkiHash() {
    return sha256hex(
      Buffer.isBuffer(this._publicKey)
        ? this._publicKey
        : Buffer.from(this._publicKey, 'hex')
    );
  }

  /**
   * The identity's URI.
   *   - safebox: safebox://<spkiHash>
   *   - author:  safenet:author:<name>
   * @type {string}
   */
  get uri() {
    if (this.type === 'safebox') {
      return 'safebox://' + this.spkiHash;
    }
    return 'safenet:author:' + this.name;
  }

  /**
   * Whether this identity has a private key and can sign.
   * @type {boolean}
   */
  get canSign() {
    return this._privateKey != null;
  }

  // ------------------------------------------------------------------
  // Claim creation
  // ------------------------------------------------------------------

  /**
   * Create and sign an identity claim for this identity.
   *
   * For safebox identities, delegates to Claims.safeboxIdentity.
   * For author identities, delegates to Claims.authorIdentity.
   *
   * @param {object} options - Claim-type-specific options.
   *   Safebox: { pcr0, pcr1, pcr4, imageHash, endpoints, capabilities, version }
   *   Author:  { displayName, recovery, secondFactor }
   * @returns {Promise<object>} Signed OCP claim
   */
  async createIdentityClaim(options) {
    if (!this.canSign) {
      throw new Error('Cannot create identity claim without a private key');
    }

    let claim;
    if (this.type === 'safebox') {
      claim = Claims.safeboxIdentity(Object.assign({
        publicKey: this.publicKeyHex
      }, options));
    } else {
      claim = Claims.authorIdentity(Object.assign({
        name: this.name,
        keys: [{
          id: 'primary',
          algorithm: 'ES256',
          publicKey: this.publicKeyHex
        }]
      }, options));
    }

    return this.sign(claim);
  }

  // ------------------------------------------------------------------
  // Sign / verify
  // ------------------------------------------------------------------

  /**
   * Sign an OCP claim with this identity's private key.
   *
   * Uses Q.Crypto.OpenClaim to produce the signed claim structure
   * with `sig` and `keys` fields added.
   *
   * @param {object} claim - Unsigned OCP claim object
   * @returns {Promise<object>} Signed OCP claim
   */
  async sign(claim) {
    if (!this.canSign) {
      throw new Error('Cannot sign without a private key');
    }
    const Crypto = getCrypto();

    // If Q.Crypto.OpenClaim.sign is available, use it directly
    if (Crypto.OpenClaim && typeof Crypto.OpenClaim.sign === 'function') {
      return Crypto.OpenClaim.sign(claim, {
        privateKey: this._privateKey,
        publicKey: this._publicKey,
        algorithm: 'ES256'
      });
    }

    // Fallback: manual signing via Crypto.sign
    const { canonicalJSON } = require('./utils');
    const payload = canonicalJSON(claim.stm);
    const signature = await Crypto.sign(payload, {
      privateKey: this._privateKey,
      algorithm: 'ES256'
    });

    return Object.assign({}, claim, {
      sig: {
        algorithm: 'ES256',
        value: signature
      },
      keys: [{
        id: 'primary',
        algorithm: 'ES256',
        publicKey: this.publicKeyHex
      }]
    });
  }

  /**
   * Verify a signed OCP claim.
   *
   * Delegates to Q.Crypto.OpenClaim.verify if available, otherwise
   * performs a manual signature check.
   *
   * @param {object} claim - Signed OCP claim with sig and keys fields
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async verify(claim) {
    if (!claim || !claim.sig || !claim.stm) {
      return { valid: false, reason: 'Claim is missing sig or stm fields' };
    }
    const Crypto = getCrypto();

    // Prefer Q.Crypto.OpenClaim.verify
    if (Crypto.OpenClaim && typeof Crypto.OpenClaim.verify === 'function') {
      try {
        const result = await Crypto.OpenClaim.verify(claim);
        return typeof result === 'boolean'
          ? { valid: result }
          : result;
      } catch (err) {
        return { valid: false, reason: err.message };
      }
    }

    // Fallback: manual verification
    try {
      const { canonicalJSON } = require('./utils');
      const payload = canonicalJSON(claim.stm);
      const sigKey = (claim.keys && claim.keys[0] && claim.keys[0].publicKey)
        || this.publicKeyHex;
      const valid = await Crypto.verify(payload, claim.sig.value, {
        publicKey: sigKey,
        algorithm: claim.sig.algorithm || 'ES256'
      });
      return { valid };
    } catch (err) {
      return { valid: false, reason: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Serialization
  // ------------------------------------------------------------------

  /**
   * Serialise this identity to a plain object.
   * The private key is intentionally excluded.
   *
   * @returns {object}
   */
  toJSON() {
    const json = {
      type: this.type,
      publicKey: this.publicKeyHex,
      uri: this.uri,
      spkiHash: this.spkiHash
    };
    if (this.name) {
      json.name = this.name;
    }
    return json;
  }
}

module.exports = Identity;
