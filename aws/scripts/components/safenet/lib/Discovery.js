'use strict';

const https = require('https');
const { resolveQ, generateClaimHash, nowISO } = require('./utils');
const Data = require(resolveQ('Q/Data'));

/**
 * Maximum consecutive send failures before a peer is marked
 * unreachable and removed from the active set.
 * @const {number}
 */
const MAX_FAILURES = 3;

/**
 * Peer discovery and gossip protocol for the Safenet network.
 *
 * Peers exchange claims via a push-based gossip protocol with
 * configurable fanout and TTL. Bloom-filter-based sync allows
 * efficient catch-up after partitions.
 */
class Discovery {
  /**
   * @param {object} options
   * @param {object} options.identity  - This node's identity claim
   *   (must have stm.peerUri and stm.endpoint)
   * @param {import('./Registry')} options.registry - Registry instance
   *   to insert accepted claims into
   * @param {string[]} [options.bootstrapPeers] - URIs of seed peers
   * @param {number}   [options.fanout]       - Gossip fanout (default 6)
   * @param {number}   [options.maxTTL]       - Max hops (default 8)
   * @param {number}   [options.syncInterval] - Periodic sync ms (default 60000)
   */
  constructor(options) {
    if (!options || !options.identity || !options.registry) {
      throw new Error('Discovery requires identity and registry options');
    }

    this._identity = options.identity;
    this._registry = options.registry;
    this._fanout = options.fanout || 6;
    this._maxTTL = options.maxTTL || 8;
    this._syncInterval = options.syncInterval || 60000;

    /** @type {Map<string, {endpoint: string, lastSeen: string, trustLevel: number, bloom: string|null, failures: number}>} */
    this._peers = new Map();

    /** @type {Set<string>} claim hashes already seen */
    this._seenClaims = new Set();

    /** @type {object[]} claims queued for forwarding */
    this._gossipQueue = [];

    /** @type {NodeJS.Timeout|null} */
    this._syncTimer = null;

    /** @type {import('./ModelRegistry')|null} */
    this._modelRegistry = options.modelRegistry || null;

    // Seed bootstrap peers
    if (Array.isArray(options.bootstrapPeers)) {
      for (const uri of options.bootstrapPeers) {
        this._peers.set(uri, {
          endpoint: uri,
          lastSeen: null,
          trustLevel: 0,
          bloom: null,
          failures: 0
        });
      }
    }
  }

  // ----------------------------------------------------------------
  // Peer management
  // ----------------------------------------------------------------

  /**
   * Add or update a known peer.
   *
   * @param {string} peerUri   - Unique peer identifier
   * @param {string} endpoint  - HTTPS base URL for the peer
   * @param {number} trustLevel - Numeric trust level (higher = more trusted)
   */
  addPeer(peerUri, endpoint, trustLevel) {
    const existing = this._peers.get(peerUri);
    this._peers.set(peerUri, {
      endpoint: endpoint,
      lastSeen: nowISO(),
      trustLevel: typeof trustLevel === 'number' ? trustLevel : 0,
      bloom: existing ? existing.bloom : null,
      failures: 0
    });
  }

  /**
   * Remove a peer from the known set.
   *
   * @param {string} peerUri
   * @returns {boolean} True if the peer existed and was removed
   */
  removePeer(peerUri) {
    return this._peers.delete(peerUri);
  }

  /**
   * List known peers, optionally filtered by minimum trust level.
   *
   * @param {object} [options]
   * @param {number} [options.trustLevel] - Minimum trust level to include
   * @returns {Array<{peerUri: string, endpoint: string, lastSeen: string|null, trustLevel: number}>}
   */
  getPeers(options) {
    const opts = options || {};
    const minTrust = opts.trustLevel;
    const result = [];

    for (const [peerUri, info] of this._peers) {
      if (typeof minTrust === 'number' && info.trustLevel < minTrust) {
        continue;
      }
      result.push({
        peerUri,
        endpoint: info.endpoint,
        lastSeen: info.lastSeen,
        trustLevel: info.trustLevel
      });
    }

    return result;
  }

  // ----------------------------------------------------------------
  // Gossip: outbound
  // ----------------------------------------------------------------

  /**
   * Gossip a claim to a random subset of peers.
   *
   * Revocation claims bypass the fanout limit and are sent to ALL
   * peers to ensure rapid propagation.
   *
   * @param {object} claim - The claim to gossip
   * @param {number} [ttl] - Time-to-live (hops remaining). Defaults
   *   to maxTTL.
   * @returns {Promise<Array<{peerUri: string, ok: boolean, error?: string}>>}
   */
  async gossip(claim, ttl) {
    if (!claim || !claim.stm) {
      return [];
    }

    const effectiveTTL = typeof ttl === 'number' ? ttl : this._maxTTL;
    if (effectiveTTL <= 0) return [];

    const claimHash = generateClaimHash(claim);
    this._seenClaims.add(claimHash);

    const isRevocation = claim.stm.type === 'revocation';
    const sourcePeer = claim.stm.sourcePeer || null;

    // Collect eligible peers (exclude the source)
    const eligible = [];
    for (const [peerUri, info] of this._peers) {
      if (peerUri === sourcePeer) continue;
      eligible.push({ peerUri, info });
    }

    // Select targets: all peers for revocations, random subset otherwise
    let targets;
    if (isRevocation) {
      targets = eligible;
    } else {
      targets = this._selectRandom(eligible, this._fanout);
    }

    // Send in parallel
    const results = await Promise.all(
      targets.map(async ({ peerUri, info }) => {
        try {
          await this._sendToPeer(info.endpoint, {
            type: 'gossip',
            claim,
            ttl: effectiveTTL - 1,
            from: this._identity.stm.peerUri
          });
          info.lastSeen = nowISO();
          info.failures = 0;
          return { peerUri, ok: true };
        } catch (err) {
          info.failures = (info.failures || 0) + 1;
          if (info.failures >= MAX_FAILURES) {
            this._peers.delete(peerUri);
          }
          return { peerUri, ok: false, error: err.message };
        }
      })
    );

    return results;
  }

  // ----------------------------------------------------------------
  // Gossip: inbound
  // ----------------------------------------------------------------

  /**
   * Process an incoming gossiped claim from a peer.
   *
   * Deduplicates by claim hash. If the claim is new and the TTL
   * allows further propagation, it is re-gossiped with TTL - 1.
   *
   * @param {object} claim    - The received claim
   * @param {string} fromPeer - URI of the sending peer
   * @param {number} ttl      - Remaining TTL
   * @returns {Promise<{accepted: boolean, reason?: string}>}
   */
  async receiveGossip(claim, fromPeer, ttl) {
    if (!claim || !claim.stm) {
      return { accepted: false, reason: 'Invalid claim structure' };
    }

    const claimHash = generateClaimHash(claim);

    // Dedup: already seen this claim
    if (this._seenClaims.has(claimHash)) {
      return { accepted: false, reason: 'Duplicate claim' };
    }

    this._seenClaims.add(claimHash);

    // Update the sending peer's lastSeen
    const peerInfo = this._peers.get(fromPeer);
    if (peerInfo) {
      peerInfo.lastSeen = nowISO();
      peerInfo.failures = 0;
    }

    // Insert into the registry
    const type = claim.stm.type;
    let result;
    try {
      if (type === 'namespace_claim') {
        result = await this._registry.claimNamespace(claim);
      } else if (type === 'publication') {
        result = await this._registry.publish(claim);
      } else if (type === 'revocation') {
        result = await this._registry.processRevocation(claim);
      } else if (type === 'peer_announce') {
        // Peer announcements update the peer list
        this._handlePeerAnnounce(claim);
        result = { ok: true };
      } else if (type === 'model_available') {
        // Model availability announcements go to the ModelRegistry
        if (this._modelRegistry) {
          result = this._modelRegistry.addAnnouncement(claim);
        } else {
          result = { ok: true }; // accept but nowhere to store
        }
      } else {
        return { accepted: false, reason: 'Unknown claim type: ' + type };
      }
    } catch (err) {
      return { accepted: false, reason: 'Registry error: ' + err.message };
    }

    if (!result.ok) {
      // Registry rejected it (namespace taken, version exists, etc.)
      // Still mark as seen so we don't retry.
      return { accepted: false, reason: result.message || result.code };
    }

    // Re-gossip if TTL allows
    if (ttl > 1) {
      // Tag the source so we don't send it back
      const taggedClaim = Object.assign({}, claim);
      if (!taggedClaim.stm.sourcePeer) {
        taggedClaim.stm = Object.assign({}, taggedClaim.stm, {
          sourcePeer: fromPeer
        });
      }
      // Fire-and-forget re-gossip
      this.gossip(taggedClaim, ttl - 1).catch(() => {});
    }

    return { accepted: true };
  }

  // ----------------------------------------------------------------
  // Bloom filter sync
  // ----------------------------------------------------------------

  /**
   * Build a Bloom filter containing all publication claim hashes
   * currently in the registry.
   *
   * Uses a false-positive rate of 0.001.
   *
   * @returns {Promise<string>} Base64-encoded Bloom filter
   */
  async buildBloomFilter() {
    const entries = await this._registry.exportState();

    // Count publication entries for Bloom sizing
    const pubHashes = [];
    for (const { value } of entries) {
      if (value && value.claimHash) {
        pubHashes.push(value.claimHash);
      }
    }

    // Minimum size of 64 to avoid degenerate filters
    const n = Math.max(pubHashes.length, 64);
    const bloom = Data.Bloom.create(n, 0.001);

    for (const hash of pubHashes) {
      bloom.add(hash);
    }

    return bloom.toBase64();
  }

  /**
   * Initiate a sync with a peer using Bloom filter reconciliation.
   *
   * 1. Build our Bloom filter and send it to the peer.
   * 2. The peer responds with claims we are missing.
   * 3. We reciprocate by sending claims the peer is missing
   *    (determined by the peer's Bloom filter in the response).
   *
   * @param {string} peerUri
   * @returns {Promise<{received: number, sent: number}>}
   */
  async requestSync(peerUri) {
    const peerInfo = this._peers.get(peerUri);
    if (!peerInfo) {
      throw new Error('Unknown peer: ' + peerUri);
    }

    // 1. Build and send our Bloom filter
    const ourBloom = await this.buildBloomFilter();

    let response;
    try {
      response = await this._syncWithPeer(peerInfo.endpoint, {
        bloom: ourBloom,
        from: this._identity.stm.peerUri
      });
    } catch (err) {
      peerInfo.failures = (peerInfo.failures || 0) + 1;
      if (peerInfo.failures >= MAX_FAILURES) {
        this._peers.delete(peerUri);
      }
      throw err;
    }

    peerInfo.lastSeen = nowISO();
    peerInfo.failures = 0;

    // 2. Process claims the peer sent us
    let received = 0;
    if (response.claims && Array.isArray(response.claims)) {
      const mergeResult = await this._registry.merge(response.claims);
      received = mergeResult.accepted;
    }

    // 3. Store the peer's Bloom so we know their state
    if (response.peerBloom) {
      peerInfo.bloom = response.peerBloom;
    }

    // 4. Determine what the peer is missing using their Bloom
    let sent = 0;
    if (response.peerBloom) {
      const peerBloom = Data.Bloom.fromBase64(response.peerBloom);
      const entries = await this._registry.exportState();
      const missing = [];

      for (const { value } of entries) {
        if (value && value.claimHash && value.claim) {
          if (!peerBloom.has(value.claimHash)) {
            missing.push(value.claim);
          }
        }
      }

      if (missing.length > 0) {
        try {
          await this._sendToPeer(peerInfo.endpoint, {
            type: 'sync_push',
            claims: missing,
            from: this._identity.stm.peerUri
          });
          sent = missing.length;
        } catch (_) {
          // Non-fatal: we got our claims, reciprocation failed
        }
      }
    }

    return { received, sent };
  }

  // ----------------------------------------------------------------
  // Self-announcement
  // ----------------------------------------------------------------

  /**
   * Create and gossip a peer_announce claim advertising this node's
   * presence on the network.
   *
   * @returns {Promise<Array<{peerUri: string, ok: boolean, error?: string}>>}
   */
  async announceSelf() {
    const claim = {
      stm: {
        type: 'peer_announce',
        peerUri: this._identity.stm.peerUri,
        endpoint: this._identity.stm.endpoint,
        timestamp: nowISO()
      }
    };

    return this.gossip(claim);
  }

  // ----------------------------------------------------------------
  // Periodic sync
  // ----------------------------------------------------------------

  /**
   * Start a timer that periodically syncs with a random peer.
   * Only one timer runs at a time; calling this again is a no-op
   * unless stop() was called first.
   */
  startPeriodicSync() {
    if (this._syncTimer) return;

    this._syncTimer = setInterval(async () => {
      const eligible = [];
      for (const [peerUri] of this._peers) {
        eligible.push(peerUri);
      }
      if (eligible.length === 0) return;

      const target = eligible[Math.floor(Math.random() * eligible.length)];
      try {
        await this.requestSync(target);
      } catch (_) {
        // Logged elsewhere via failure tracking
      }
    }, this._syncInterval);

    // Allow the process to exit even if the timer is running
    if (this._syncTimer.unref) {
      this._syncTimer.unref();
    }
  }

  /**
   * Stop all timers. Safe to call multiple times.
   */
  stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  // ----------------------------------------------------------------
  // Internal: peer announcement handling
  // ----------------------------------------------------------------

  /**
   * Handle an incoming peer_announce claim by updating the peer list.
   * @private
   * @param {object} claim
   */
  _handlePeerAnnounce(claim) {
    const stm = claim.stm;
    if (!stm.peerUri || !stm.endpoint) return;

    // Don't add ourselves
    if (stm.peerUri === this._identity.stm.peerUri) return;

    this.addPeer(stm.peerUri, stm.endpoint, 0);
  }

  // ----------------------------------------------------------------
  // Internal: random selection
  // ----------------------------------------------------------------

  /**
   * Select up to `count` random items from an array using
   * Fisher-Yates partial shuffle.
   *
   * @private
   * @param {Array} arr
   * @param {number} count
   * @returns {Array}
   */
  _selectRandom(arr, count) {
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

  // ----------------------------------------------------------------
  // Internal: network I/O
  // ----------------------------------------------------------------

  /**
   * POST a JSON payload to a peer's gossip endpoint.
   *
   * @private
   * @param {string} endpoint - Peer base URL (https://host:port)
   * @param {object} payload  - JSON-serializable body
   * @returns {Promise<object>} Parsed JSON response
   */
  _sendToPeer(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const url = new URL(endpoint + '/safenet/v1/gossip');

      const reqOpts = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      };

      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(
              'Peer returned HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)
            ));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            resolve({});
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request to peer timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * POST a Bloom filter to a peer's sync endpoint and return the
   * peer's response (missing claims + their own Bloom filter).
   *
   * @private
   * @param {string} endpoint - Peer base URL
   * @param {object} payload  - { bloom: string, from: string }
   * @returns {Promise<{claims?: object[], peerBloom?: string}>}
   */
  _syncWithPeer(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const url = new URL(endpoint + '/safenet/v1/sync/bloom');

      const reqOpts = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 30000
      };

      const req = https.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(
              'Sync peer returned HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)
            ));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            resolve({});
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Sync request to peer timed out'));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = Discovery;
