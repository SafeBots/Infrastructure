'use strict';

const fs = require('fs');
const path = require('path');
const { resolveQ, sha256hex, nowISO, generateClaimHash } = require('./utils');
const Data = require(resolveQ('Q/Data'));

/**
 * @module TransparencyLog
 *
 * Append-only Merkle-based transparency log for Safenet publications.
 *
 * Each entry is hash-chained to its predecessor and the full set of
 * entry hashes forms a Merkle tree, enabling compact inclusion and
 * consistency proofs. Optionally persists to a JSON file on disk
 * with atomic writes (write-to-temp + rename).
 *
 * Entry structure:
 *   { index, claimHash, claimType, subject, timestamp, entryHash }
 *
 * entryHash = SHA-256(previousEntryHash || claimHash || timestamp)
 * For index 0 the previousEntryHash is 32 zero-bytes (hex: 64 '0' chars).
 */

/** @type {string} 64-char hex string representing 32 zero bytes */
const ZERO_HASH = '0'.repeat(64);

class TransparencyLog {
  /**
   * Create a new TransparencyLog.
   *
   * @param {object} [options]
   * @param {string} [options.storagePath] - Path to a JSON file for
   *   persistence. When provided the log loads existing entries on
   *   construction and writes back after every append. When omitted
   *   the log is purely in-memory.
   */
  constructor(options) {
    const opts = options || {};

    /** @private */
    this._storagePath = opts.storagePath || null;

    /** @private @type {Array<object>} */
    this._entries = [];

    /** @private @type {string|null} */
    this._rootHash = null;

    if (this._storagePath) {
      this._load();
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Number of entries in the log.
   * @type {number}
   */
  get size() {
    return this._entries.length;
  }

  /**
   * Append a claim to the transparency log.
   *
   * Computes the entry hash by chaining the previous entry hash with the
   * claim hash and timestamp, pushes the entry, recomputes the Merkle
   * root, and persists if a storage path is configured.
   *
   * @param {object} claim - An OCP claim object with at least a `stm`
   *   field containing `type` and `sub` (or a top-level `sub`).
   * @returns {{ index: number, entryHash: string, rootHash: string }}
   */
  append(claim) {
    if (!claim || !claim.stm) {
      throw new Error('claim must have a stm field');
    }

    const index = this._entries.length;
    const claimHash = generateClaimHash(claim);
    const claimType = claim.stm.type || 'unknown';
    const subject = claim.sub || claim.stm.sub || '';
    const timestamp = nowISO();

    const previousEntryHash = index === 0
      ? ZERO_HASH
      : this._entries[index - 1].entryHash;

    const entryHash = sha256hex(previousEntryHash + claimHash + timestamp);

    const entry = {
      index,
      claimHash,
      claimType,
      subject,
      timestamp,
      entryHash
    };

    this._entries.push(entry);
    this._rootHash = this._computeRootHash();

    if (this._storagePath) {
      this._persist();
    }

    return { index, entryHash, rootHash: this._rootHash };
  }

  /**
   * Get the current Merkle root and entry count.
   *
   * @returns {{ rootHash: string|null, entryCount: number }}
   */
  getRoot() {
    return {
      rootHash: this._rootHash,
      entryCount: this._entries.length
    };
  }

  /**
   * Get a single entry by its index.
   *
   * @param {number} index
   * @returns {object|null} The entry, or null if out of range.
   */
  getEntry(index) {
    if (index < 0 || index >= this._entries.length) {
      return null;
    }
    return Object.assign({}, this._entries[index]);
  }

  /**
   * Build a Merkle inclusion proof showing that the entry at `index`
   * is part of the current tree.
   *
   * Uses Q.Data.Merkle on the array of entry hashes.
   *
   * @param {number} index
   * @returns {{ proof: string[], rootHash: string }}
   * @throws {RangeError} If index is out of range.
   */
  getInclusionProof(index) {
    if (index < 0 || index >= this._entries.length) {
      throw new RangeError(
        'Index ' + index + ' out of range [0, ' + this._entries.length + ')'
      );
    }

    const hashes = this._entries.map(e => e.entryHash);
    const tree = Data.Merkle.build(hashes);
    const proof = Data.Merkle.proof(tree, index);

    return { proof, rootHash: this._rootHash };
  }

  /**
   * Verify a Merkle inclusion proof for a given entry hash.
   *
   * @param {string} entryHash  - The entry hash to verify
   * @param {string[]} proof    - Sibling hashes from getInclusionProof
   * @param {string} rootHash   - Expected Merkle root
   * @returns {Promise<boolean>} True if the proof is valid.
   */
  async verifyInclusionProof(entryHash, proof, rootHash) {
    try {
      return Data.Merkle.verify(entryHash, proof, rootHash);
    } catch (_) {
      return false;
    }
  }

  /**
   * Build a consistency proof showing that the log at `fromSize` is a
   * prefix of the log at `toSize`.
   *
   * The proof is an array of intermediate Merkle root hashes that
   * let a verifier reconstruct both the old root (over `fromSize`
   * leaves) and the new root (over `toSize` leaves) without needing
   * the full set of entries.
   *
   * @param {number} fromSize - Earlier log size (> 0)
   * @param {number} toSize   - Later log size (<= current size)
   * @returns {string[]} Array of intermediate hashes.
   * @throws {RangeError} If sizes are invalid.
   */
  getConsistencyProof(fromSize, toSize) {
    if (fromSize < 1) {
      throw new RangeError('fromSize must be >= 1');
    }
    if (toSize > this._entries.length) {
      throw new RangeError(
        'toSize ' + toSize + ' exceeds log size ' + this._entries.length
      );
    }
    if (fromSize > toSize) {
      throw new RangeError('fromSize must be <= toSize');
    }
    if (fromSize === toSize) {
      return [];
    }

    const hashes = this._entries.slice(0, toSize).map(e => e.entryHash);
    return _subproof(hashes, fromSize, toSize, true);
  }

  /**
   * Verify a consistency proof.
   *
   * Recomputes both the old root (from `fromSize`) and the new root
   * (from `toSize`) using the proof hashes, then checks they match
   * the supplied values.
   *
   * @param {string} fromRoot  - Expected Merkle root at fromSize
   * @param {string} toRoot    - Expected Merkle root at toSize
   * @param {number} fromSize  - Earlier log size
   * @param {number} toSize    - Later log size
   * @param {string[]} proof   - Array of intermediate hashes
   * @returns {boolean}
   */
  verifyConsistencyProof(fromRoot, toRoot, fromSize, toSize, proof) {
    if (fromSize < 1 || fromSize > toSize) {
      return false;
    }
    if (fromSize === toSize) {
      return proof.length === 0 && fromRoot === toRoot;
    }

    try {
      // Walk the proof to reconstruct both roots.
      let oldHash = proof.length > 0 ? proof[0] : fromRoot;
      let newHash = proof.length > 0 ? proof[0] : fromRoot;
      let idx = 1;
      let fn = fromSize - 1;
      let sn = toSize - 1;

      while (fn > 0) {
        if (fn & 1) {
          // fn is odd -- proof node is a left sibling
          if (idx >= proof.length) return false;
          oldHash = sha256hex(proof[idx] + oldHash);
          newHash = sha256hex(proof[idx] + newHash);
          idx++;
        }
        fn >>= 1;
        sn >>= 1;
      }

      while (sn > 0) {
        if (idx >= proof.length) return false;
        newHash = sha256hex(newHash + proof[idx]);
        idx++;
        sn >>= 1;
      }

      return oldHash === fromRoot && newHash === toRoot;
    } catch (_) {
      return false;
    }
  }

  /**
   * Search log entries by filter criteria.
   *
   * @param {object} [options]
   * @param {string} [options.package] - Filter by subject containing this package name
   * @param {string} [options.author]  - Filter by subject containing this author name
   * @param {string} [options.type]    - Filter by claimType
   * @param {string} [options.since]   - ISO timestamp lower bound (inclusive)
   * @param {string} [options.until]   - ISO timestamp upper bound (inclusive)
   * @param {number} [options.limit]   - Maximum number of results
   * @returns {object[]} Array of matching entries.
   */
  search(options) {
    const opts = options || {};
    let results = this._entries;

    if (opts.type) {
      results = results.filter(e => e.claimType === opts.type);
    }
    if (opts.package) {
      const pkg = opts.package;
      results = results.filter(e => e.subject.indexOf(pkg) !== -1);
    }
    if (opts.author) {
      const author = opts.author;
      results = results.filter(e => e.subject.indexOf(author) !== -1);
    }
    if (opts.since) {
      const since = opts.since;
      results = results.filter(e => e.timestamp >= since);
    }
    if (opts.until) {
      const until = opts.until;
      results = results.filter(e => e.timestamp <= until);
    }
    if (opts.limit && opts.limit > 0) {
      results = results.slice(0, opts.limit);
    }

    // Return copies to prevent external mutation
    return results.map(e => Object.assign({}, e));
  }

  /**
   * Export entries in a half-open index range [from, to).
   *
   * @param {number} from - Start index (inclusive)
   * @param {number} to   - End index (exclusive)
   * @returns {object[]} Array of entry copies.
   */
  exportEntries(from, to) {
    const start = Math.max(0, from || 0);
    const end = Math.min(this._entries.length, to || this._entries.length);
    return this._entries.slice(start, end).map(e => Object.assign({}, e));
  }

  // ------------------------------------------------------------------
  // Internal methods
  // ------------------------------------------------------------------

  /**
   * Recompute the Merkle root hash from all entry hashes.
   *
   * @private
   * @returns {string|null} Root hash, or null if the log is empty.
   */
  _computeRootHash() {
    if (this._entries.length === 0) {
      return null;
    }
    const hashes = this._entries.map(e => e.entryHash);
    const tree = Data.Merkle.build(hashes);
    return tree.root;
  }

  /**
   * Persist the log state to disk atomically.
   * Writes to a temporary file then renames to avoid partial writes.
   *
   * @private
   */
  _persist() {
    if (!this._storagePath) return;

    const data = JSON.stringify({
      rootHash: this._rootHash,
      entries: this._entries
    }, null, 2);

    const dir = path.dirname(this._storagePath);
    const tmpPath = path.join(
      dir,
      '.transparency-log-' + process.pid + '-' + Date.now() + '.tmp'
    );

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, data, 'utf8');
      fs.renameSync(tmpPath, this._storagePath);
    } catch (err) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      throw new Error('Failed to persist transparency log: ' + err.message);
    }
  }

  /**
   * Load log state from disk. If the file does not exist the log
   * starts empty. If the file is corrupt an error is thrown.
   *
   * @private
   */
  _load() {
    if (!this._storagePath) return;

    let raw;
    try {
      raw = fs.readFileSync(this._storagePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File does not exist yet -- start fresh
        return;
      }
      throw new Error('Failed to read transparency log: ' + err.message);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error('Corrupt transparency log file: ' + err.message);
    }

    if (!Array.isArray(parsed.entries)) {
      throw new Error('Corrupt transparency log: entries is not an array');
    }

    this._entries = parsed.entries;
    this._rootHash = this._computeRootHash();

    // Verify stored root matches recomputed root
    if (parsed.rootHash && parsed.rootHash !== this._rootHash) {
      throw new Error(
        'Transparency log root hash mismatch: stored ' +
        parsed.rootHash + ' vs computed ' + this._rootHash
      );
    }
  }
}

// --------------------------------------------------------------------
// Module-level helpers for consistency proofs
// --------------------------------------------------------------------

/**
 * Compute sub-proof hashes for a consistency proof.
 *
 * Follows the algorithm from RFC 6962 section 2.1.2 adapted for
 * a binary Merkle tree over an array of leaf hashes.
 *
 * @private
 * @param {string[]} hashes  - Full array of leaf hashes (length = toSize)
 * @param {number} fromSize  - Earlier tree size
 * @param {number} toSize    - Later tree size
 * @param {boolean} startFromOld - True on the initial call
 * @returns {string[]}
 */
function _subproof(hashes, fromSize, toSize, startFromOld) {
  if (fromSize === toSize) {
    if (startFromOld) {
      return [];
    }
    return [_merkleHash(hashes.slice(0, toSize))];
  }

  const k = _largestPowerOfTwo(toSize);

  if (fromSize <= k) {
    const subProof = _subproof(hashes, fromSize, k, startFromOld);
    subProof.push(_merkleHash(hashes.slice(k, toSize)));
    return subProof;
  }

  const subProof = _subproof(hashes.slice(k), fromSize - k, toSize - k, false);
  subProof.push(_merkleHash(hashes.slice(0, k)));
  return subProof;
}

/**
 * Compute the Merkle root of a slice of leaf hashes.
 *
 * @private
 * @param {string[]} leaves
 * @returns {string}
 */
function _merkleHash(leaves) {
  if (leaves.length === 0) {
    return ZERO_HASH;
  }
  if (leaves.length === 1) {
    return leaves[0];
  }
  const k = _largestPowerOfTwo(leaves.length);
  const left = _merkleHash(leaves.slice(0, k));
  const right = _merkleHash(leaves.slice(k));
  return sha256hex(left + right);
}

/**
 * Largest power of two strictly less than n.
 *
 * @private
 * @param {number} n
 * @returns {number}
 */
function _largestPowerOfTwo(n) {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

module.exports = TransparencyLog;
