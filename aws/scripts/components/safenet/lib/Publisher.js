'use strict';

const { resolveQ, sha256hex, canonicalJSON, nowISO, validateSemver, validateNamespace } = require('./utils');
const Data = require(resolveQ('Q/Data'));
const Crypto = require(resolveQ('Q/Crypto'));
const Claims = require('./Claims');

/**
 * @typedef {Object} ManifestValidation
 * @property {boolean} ok - Whether the manifest is valid
 * @property {string[]} [errors] - Validation error messages
 */

/**
 * @typedef {Object} FileEntry
 * @property {string} path - File path relative to the package root
 * @property {Buffer|string} content - File content
 */

/**
 * @typedef {Object} EncryptedChunk
 * @property {number} index - Zero-based chunk index
 * @property {{ iv: string, ciphertext: string, tag: string }} encrypted - AES-256-GCM output
 * @property {string} hash - SHA-256 hex of the plaintext chunk
 */

/**
 * @typedef {Object} EncryptionResult
 * @property {string} [packageKey] - Hex-encoded package key (only present when safeboxOnly=true)
 * @property {EncryptedChunk[]} chunks - Encrypted chunk array
 */

const CHUNK_SIZE = 256 * 1024; // 256 KiB

/**
 * Handles the package publication workflow for the Safenet Protocol.
 *
 * Responsible for validating manifests, computing content Merkle roots,
 * creating and verifying signed publication claims, and encrypting
 * package content into chunks for Safecloud storage.
 */
class Publisher {
  /**
   * @param {Object} options
   * @param {Object} options.identity - Identity instance (Safebox or author) used for signing
   * @param {Object} options.registry - Registry instance for package lookups
   */
  constructor(options) {
    if (!options || !options.identity) {
      throw new Error('Publisher requires an identity');
    }
    if (!options || !options.registry) {
      throw new Error('Publisher requires a registry');
    }
    this.identity = options.identity;
    this.registry = options.registry;
  }

  /**
   * Validate a safenet.json manifest object.
   *
   * Checks required fields (name, version, languages), validates the
   * version as semver, and validates the namespace extracted from the
   * package name (expected format: `namespace/packageName`).
   *
   * @param {Object} manifest - The safenet.json manifest to validate
   * @returns {ManifestValidation}
   */
  validateManifest(manifest) {
    const errors = [];

    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, errors: ['Manifest must be a non-null object'] };
    }

    // Required fields
    if (!manifest.name || typeof manifest.name !== 'string') {
      errors.push('Manifest must have a string "name" field');
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push('Manifest must have a string "version" field');
    }
    if (!manifest.languages || !Array.isArray(manifest.languages) || manifest.languages.length === 0) {
      errors.push('Manifest must have a non-empty "languages" array');
    }

    // Stop early if required fields are missing entirely
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Validate semver
    if (!validateSemver(manifest.version)) {
      errors.push(`Invalid semver version: "${manifest.version}"`);
    }

    // Validate namespace/packageName format
    const parts = manifest.name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      errors.push(`Package name must be in "namespace/packageName" format, got: "${manifest.name}"`);
    } else {
      const nsResult = validateNamespace(parts[0]);
      if (!nsResult.valid) {
        errors.push(`Invalid namespace "${parts[0]}": ${nsResult.reason}`);
      }
      // Validate package name portion (same rules as namespace)
      const pkgResult = validateNamespace(parts[1]);
      if (!pkgResult.valid) {
        errors.push(`Invalid package name "${parts[1]}": ${pkgResult.reason}`);
      }
    }

    // Validate languages entries are strings
    if (manifest.languages) {
      for (let i = 0; i < manifest.languages.length; i++) {
        if (typeof manifest.languages[i] !== 'string') {
          errors.push(`languages[${i}] must be a string`);
        }
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  }

  /**
   * Compute the content Merkle root from an array of file entries.
   *
   * Files are sorted by path to ensure deterministic ordering, then
   * their contents are used as leaves in a Merkle tree built via
   * Q.Data.Merkle.build.
   *
   * @param {FileEntry[]} files - Array of { path, content } objects
   * @returns {Promise<string>} Hex-encoded Merkle root hash
   */
  async computeMerkleRoot(files) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('Files array must be non-empty');
    }

    // Sort deterministically by path
    const sorted = files.slice().sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });

    // Build leaves from file contents
    const leaves = sorted.map(f => {
      const content = typeof f.content === 'string'
        ? Buffer.from(f.content, 'utf8')
        : f.content;
      return content;
    });

    const tree = await Data.Merkle.build(leaves);
    return tree.root;
  }

  /**
   * Create a signed publication claim for a package version.
   *
   * Steps:
   *   1. Validate the manifest
   *   2. Compute the Merkle root from the provided files
   *   3. Compute the manifest hash (SHA-256 of canonical JSON)
   *   4. Build the publication claim via Claims.publication()
   *   5. Sign the claim with this.identity
   *
   * @param {Object} options
   * @param {Object} options.manifest - The safenet.json manifest
   * @param {FileEntry[]} options.files - Package file entries
   * @param {string} [options.previousVersion] - Previous version string (for upgrade chains)
   * @param {string} [options.previousMerkleRoot] - Previous version's Merkle root hex
   * @returns {Promise<Object>} Signed publication claim
   */
  async createPublication(options) {
    if (!options || !options.manifest || !options.files) {
      throw new Error('createPublication requires manifest and files');
    }

    const { manifest, files, previousVersion, previousMerkleRoot } = options;

    // 1. Validate manifest
    const validation = this.validateManifest(manifest);
    if (!validation.ok) {
      return {
        ok: false,
        code: 'INVALID_MANIFEST',
        message: 'Manifest validation failed',
        errors: validation.errors
      };
    }

    // 2. Compute Merkle root
    const merkleRoot = await this.computeMerkleRoot(files);

    // 3. Compute manifest hash
    const manifestHash = sha256hex(canonicalJSON(manifest));

    // 4. Build publication claim
    const claim = Claims.publication({
      name: manifest.name,
      version: manifest.version,
      merkleRoot,
      manifestHash,
      languages: manifest.languages,
      previousVersion: previousVersion || null,
      previousMerkleRoot: previousMerkleRoot || null,
      iss: this.identity.uri,
      iat: nowISO()
    });

    // 5. Sign claim
    const signed = await this.identity.sign(claim);
    return signed;
  }

  /**
   * Verify a publication claim's signature and, optionally, its Merkle
   * root against a set of provided files.
   *
   * @param {Object} claim - The signed publication claim to verify
   * @param {FileEntry[]} [files] - If provided, also verify the Merkle root
   * @returns {Promise<ManifestValidation>}
   */
  async verifyPublication(claim, files) {
    const errors = [];

    if (!claim || !claim.stm) {
      return {
        ok: false,
        code: 'INVALID_CLAIM',
        message: 'Claim must have a stm field'
      };
    }

    // Verify signature
    try {
      const sigValid = await Crypto.verify(claim);
      if (!sigValid) {
        errors.push('Claim signature is invalid');
      }
    } catch (err) {
      errors.push(`Signature verification failed: ${err.message}`);
    }

    // Verify claim type
    if (claim.stm.type !== 'publication') {
      errors.push(`Expected claim type "publication", got "${claim.stm.type}"`);
    }

    // Optionally verify Merkle root against files
    if (files && files.length > 0) {
      try {
        const computedRoot = await this.computeMerkleRoot(files);
        if (computedRoot !== claim.stm.merkleRoot) {
          errors.push(
            `Merkle root mismatch: claim has "${claim.stm.merkleRoot}", ` +
            `computed "${computedRoot}"`
          );
        }
      } catch (err) {
        errors.push(`Merkle root computation failed: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  }

  /**
   * Encrypt package content into chunks for Safecloud storage.
   *
   * Two modes:
   *   - safeboxOnly=false (default): the package key is derived from the
   *     Merkle root via HKDF, so anyone who knows the Merkle root can
   *     derive it and decrypt the package.
   *   - safeboxOnly=true: a random package key is generated and must be
   *     distributed separately via license grants.
   *
   * Content is concatenated, split into 256 KiB chunks, and each chunk
   * is encrypted with AES-256-GCM using a per-chunk key derived from
   * the package key via HKDF.
   *
   * @param {FileEntry[]} files - Package file entries
   * @param {string} merkleRoot - Hex-encoded Merkle root of the content
   * @param {boolean} [safeboxOnly=false] - Whether to use a random key
   * @returns {Promise<EncryptionResult>}
   */
  async encryptChunks(files, merkleRoot, safeboxOnly) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('Files array must be non-empty');
    }
    if (!merkleRoot || typeof merkleRoot !== 'string') {
      throw new Error('merkleRoot must be a non-empty hex string');
    }

    // Derive or generate the package key
    let packageKey;
    if (safeboxOnly) {
      // Random key — distributed via license grants
      packageKey = Crypto.randomBytes(32);
    } else {
      // Deterministic key — anyone with the Merkle root can derive it
      packageKey = await Crypto.hkdf(
        Buffer.from(merkleRoot, 'hex'),
        Buffer.from('safenet', 'utf8'),           // salt
        Buffer.from('safenet-package-key-v1', 'utf8'), // info
        32
      );
    }

    // Concatenate all file contents
    const sorted = files.slice().sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });
    const buffers = sorted.map(f =>
      typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content
    );
    const concatenated = Buffer.concat(buffers);

    // Split into chunks
    const chunks = [];
    for (let offset = 0; offset < concatenated.length; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, concatenated.length);
      const chunk = concatenated.slice(offset, end);
      const index = chunks.length;

      // Derive per-chunk key via HKDF
      const chunkKey = await Crypto.hkdf(
        packageKey,
        Buffer.from(String(index), 'utf8'),           // salt = chunk index
        Buffer.from('safenet-chunk-v1', 'utf8'),       // info
        32
      );

      // Encrypt with AES-256-GCM
      const encrypted = await Data.encrypt(chunk, chunkKey);

      chunks.push({
        index,
        encrypted: {
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          tag: encrypted.tag
        },
        hash: sha256hex(chunk)
      });
    }

    const result = { chunks };
    if (safeboxOnly) {
      result.packageKey = packageKey.toString('hex');
    }
    return result;
  }

  /**
   * Decrypt a single encrypted chunk.
   *
   * Derives the per-chunk key from the package key and chunk index,
   * then decrypts via Q.Data.decrypt.
   *
   * @param {EncryptedChunk} encryptedChunk - The chunk to decrypt
   * @param {Buffer|string} packageKey - 32-byte package key (Buffer or hex string)
   * @param {number} chunkIndex - Zero-based index of the chunk
   * @returns {Promise<Buffer>} Decrypted plaintext
   */
  async decryptChunk(encryptedChunk, packageKey, chunkIndex) {
    if (!encryptedChunk || !encryptedChunk.encrypted) {
      throw new Error('encryptedChunk must have an encrypted field');
    }

    const keyBuf = typeof packageKey === 'string'
      ? Buffer.from(packageKey, 'hex')
      : packageKey;

    if (keyBuf.length !== 32) {
      throw new Error('Package key must be exactly 32 bytes');
    }

    // Derive per-chunk key (same derivation as encrypt)
    const chunkKey = await Crypto.hkdf(
      keyBuf,
      Buffer.from(String(chunkIndex), 'utf8'),
      Buffer.from('safenet-chunk-v1', 'utf8'),
      32
    );

    const plaintext = await Data.decrypt(encryptedChunk.encrypted, chunkKey);
    return plaintext;
  }
}

module.exports = Publisher;
