'use strict';

const { nowISO } = require('./utils');

/**
 * @module ModelRegistry
 *
 * In-memory registry tracking which attested Safenet peers have which
 * models loaded and available for remote inference.
 *
 * Keyed by manifestHash (64-char hex).  Each entry holds a Map of
 * peer endpoints that announced availability for that model.
 *
 * Entries are ephemeral — they come from gossip and are pruned when a
 * peer goes stale (no re-announcement within the TTL window).
 */

/**
 * Default TTL for model announcements in milliseconds (10 minutes).
 * A peer must re-announce within this window or be pruned.
 * @const {number}
 */
const DEFAULT_ANNOUNCE_TTL_MS = 10 * 60 * 1000;

class ModelRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.announceTtlMs] - How long an announcement
   *   stays valid without a refresh (default: 10 minutes)
   */
  constructor(options) {
    const opts = options || {};

    /** @private */
    this._ttlMs = opts.announceTtlMs || DEFAULT_ANNOUNCE_TTL_MS;

    /**
     * manifestHash -> Map<safeboxUri, PeerModelEntry>
     *
     * PeerModelEntry: {
     *   safeboxUri: string,
     *   endpoint:   string,
     *   modelName:  string|null,
     *   modelVersion: string|null,
     *   modelType:  string|null,
     *   capacity:   number,
     *   announcedAt: string (ISO),
     *   claim:      object (the original signed claim)
     * }
     *
     * @private
     * @type {Map<string, Map<string, object>>}
     */
    this._models = new Map();
  }

  // ----------------------------------------------------------------
  // Write path (called from Discovery gossip handler)
  // ----------------------------------------------------------------

  /**
   * Record a model_available announcement from a peer.
   *
   * @param {object} claim - The signed model_available OCP claim
   * @returns {{ ok: boolean, message?: string }}
   */
  addAnnouncement(claim) {
    if (!claim || !claim.stm) {
      return { ok: false, message: 'Invalid claim' };
    }

    const stm = claim.stm;
    const manifestHash = stm.manifestHash;
    const safeboxUri = claim.iss;
    const endpoint = stm.endpoint;

    if (!manifestHash || !safeboxUri || !endpoint) {
      return { ok: false, message: 'Missing manifestHash, iss, or endpoint' };
    }

    if (!this._models.has(manifestHash)) {
      this._models.set(manifestHash, new Map());
    }

    const peers = this._models.get(manifestHash);
    peers.set(safeboxUri, {
      safeboxUri,
      endpoint,
      modelName: stm.modelName || null,
      modelVersion: stm.modelVersion || null,
      modelType: stm.modelType || null,
      capacity: typeof stm.capacity === 'number' ? stm.capacity : 0,
      announcedAt: nowISO(),
      claim
    });

    return { ok: true };
  }

  /**
   * Remove a peer's announcement for a specific model.
   *
   * @param {string} manifestHash
   * @param {string} safeboxUri
   */
  removeAnnouncement(manifestHash, safeboxUri) {
    const peers = this._models.get(manifestHash);
    if (peers) {
      peers.delete(safeboxUri);
      if (peers.size === 0) this._models.delete(manifestHash);
    }
  }

  /**
   * Remove ALL announcements from a specific peer (e.g. on disconnect).
   *
   * @param {string} safeboxUri
   */
  removePeer(safeboxUri) {
    for (const [hash, peers] of this._models) {
      peers.delete(safeboxUri);
      if (peers.size === 0) this._models.delete(hash);
    }
  }

  // ----------------------------------------------------------------
  // Read path (called when routing inference)
  // ----------------------------------------------------------------

  /**
   * Find peers that have a model available, by manifest hash.
   *
   * Prunes stale entries automatically.
   *
   * @param {string} manifestHash - 64-char hex
   * @returns {Array<{safeboxUri: string, endpoint: string, modelName: string|null, capacity: number, claim: object}>}
   */
  findByHash(manifestHash) {
    const peers = this._models.get(manifestHash);
    if (!peers) return [];

    const now = Date.now();
    const results = [];

    for (const [uri, entry] of peers) {
      const age = now - new Date(entry.announcedAt).getTime();
      if (age > this._ttlMs) {
        peers.delete(uri);
        continue;
      }
      results.push(entry);
    }

    if (peers.size === 0) this._models.delete(manifestHash);

    return results;
  }

  /**
   * Find peers that have a model available, by name (and optionally version).
   *
   * Searches all announcements for a matching modelName.
   *
   * @param {string} modelName
   * @param {string} [modelVersion]
   * @returns {Array<{safeboxUri: string, endpoint: string, manifestHash: string, capacity: number, claim: object}>}
   */
  findByName(modelName, modelVersion) {
    const now = Date.now();
    const results = [];

    for (const [hash, peers] of this._models) {
      for (const [uri, entry] of peers) {
        const age = now - new Date(entry.announcedAt).getTime();
        if (age > this._ttlMs) {
          peers.delete(uri);
          continue;
        }
        if (entry.modelName === modelName) {
          if (modelVersion && entry.modelVersion !== modelVersion) continue;
          results.push(Object.assign({}, entry, { manifestHash: hash }));
        }
      }
      if (peers.size === 0) this._models.delete(hash);
    }

    return results;
  }

  /**
   * List all known models and how many peers serve each.
   *
   * @returns {Array<{manifestHash: string, modelName: string|null, peerCount: number}>}
   */
  listModels() {
    const result = [];
    for (const [hash, peers] of this._models) {
      // Pick the name from the first entry
      const first = peers.values().next().value;
      result.push({
        manifestHash: hash,
        modelName: first ? first.modelName : null,
        peerCount: peers.size
      });
    }
    return result;
  }

  /**
   * Prune all stale announcements.
   *
   * @returns {number} Number of entries pruned
   */
  prune() {
    const now = Date.now();
    let pruned = 0;

    for (const [hash, peers] of this._models) {
      for (const [uri, entry] of peers) {
        const age = now - new Date(entry.announcedAt).getTime();
        if (age > this._ttlMs) {
          peers.delete(uri);
          pruned++;
        }
      }
      if (peers.size === 0) this._models.delete(hash);
    }

    return pruned;
  }

  /**
   * Total number of peer-model entries (for metrics / tests).
   * @returns {number}
   */
  get size() {
    let count = 0;
    for (const peers of this._models.values()) {
      count += peers.size;
    }
    return count;
  }
}

module.exports = ModelRegistry;
