'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./Identity');
const Registry = require('./Registry');
const Publisher = require('./Publisher');
const Discovery = require('./Discovery');
const Payments = require('./Payments');
const TransparencyLog = require('./TransparencyLog');
const GitReceiver = require('./GitReceiver');
const ModelRegistry = require('./ModelRegistry');
const Claims = require('./Claims');
const Verify = require('./Verify');
const { sha256hex, nowISO } = require('./utils');

/**
 * Default data directory for persistent state.
 * @const {string}
 */
const DEFAULT_DATA_DIR = '/var/lib/safenet';

/**
 * Trust level assigned to peers that pass mutual attestation.
 * @const {number}
 */
const TRUST_ENDORSED = 2;

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------

/**
 * Read the full request body as a Buffer.
 *
 * @param {object} req - Node.js IncomingMessage
 * @returns {Promise<Buffer>}
 */
function _readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse the request body as JSON. Returns null on failure.
 *
 * @param {object} req - Node.js IncomingMessage
 * @returns {Promise<object|null>}
 */
async function _parseJSON(req) {
  try {
    const buf = await _readBody(req);
    if (buf.length === 0) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Write a JSON response with the given status code.
 *
 * @param {object} res - Node.js ServerResponse
 * @param {number} status - HTTP status code
 * @param {object} body - Response body (serialised as JSON)
 */
function _json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Extract a URL path segment after a prefix.
 *
 * @param {string} pathname - Full URL pathname
 * @param {string} prefix - Prefix to strip (must include trailing slash)
 * @returns {string} Everything after the prefix, or empty string
 */
function _after(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return '';
  return pathname.slice(prefix.length);
}

// ------------------------------------------------------------------
// SafenetNode
// ------------------------------------------------------------------

/**
 * Top-level orchestrator for a Safenet Protocol node.
 *
 * Ties together Identity, Registry, Publisher, Discovery, Payments,
 * TransparencyLog, and GitReceiver into a single operational unit.
 * Provides high-level workflows for attestation, publishing,
 * installation, and namespace management, plus an HTTP request
 * handler for the Safenet REST API.
 */
class SafenetNode {
  /**
   * Create a new SafenetNode.
   *
   * @param {object} [options]
   * @param {Identity}  [options.identity]        - Pre-built Identity (safebox type).
   *   Null or omitted to auto-generate on start().
   * @param {string}    [options.dataDir]          - Persistent data directory
   *   (default: /var/lib/safenet)
   * @param {string}    [options.reposDir]         - Git bare-repo directory
   *   (default: <dataDir>/repos)
   * @param {Array<{uri: string, endpoint: string}>} [options.bootstrapPeers]
   *   Seed peers for discovery (default: [])
   * @param {number}    [options.fanout]           - Gossip fanout (default: 6)
   * @param {number}    [options.syncInterval]     - Bloom-sync interval in ms
   *   (default: 60000)
   * @param {number}    [options.port]             - HTTP listen port (default: 8443)
   * @param {Set<string>} [options.acceptableImages] - Enclave image hashes
   *   accepted during attestation (default: empty Set)
   * @param {object}      [options.topicTrustPolicies] - Per-topic auditor trust
   *   policies. Keys are topic paths (e.g. "safenet.audit.ml-inference") or
   *   "*" for a default policy. Each value is:
   *     { required: <number>, trusted_auditors: [<key>, ...], on_missing: "warn"|"block" }
   *   When on_missing is absent/null, defaults to "warn" (non-blocking).
   */
  constructor(options) {
    const opts = options || {};

    /** @private */
    this._dataDir = opts.dataDir || DEFAULT_DATA_DIR;

    /** @private */
    this._reposDir = opts.reposDir || path.join(this._dataDir, 'repos');

    /** @private */
    this._bootstrapPeers = opts.bootstrapPeers || [];

    /** @private */
    this._fanout = opts.fanout || 6;

    /** @private */
    this._syncInterval = opts.syncInterval || 60000;

    /** @private */
    this._port = opts.port || 8443;

    /** @private */
    this._acceptableImages = opts.acceptableImages || new Set();

    /** @private @type {object|null} */
    this._topicTrustPolicies = opts.topicTrustPolicies || null;

    /** @private @type {Identity|null} */
    this._identity = opts.identity || null;

    /** @private @type {Registry|null} */
    this._registry = null;

    /** @private @type {Publisher|null} */
    this._publisher = null;

    /** @private @type {Discovery|null} */
    this._discovery = null;

    /** @private @type {Payments|null} */
    this._payments = null;

    /** @private @type {TransparencyLog|null} */
    this._transparencyLog = null;

    /** @private @type {GitReceiver|null} */
    this._gitReceiver = null;

    /** @private @type {ModelRegistry|null} */
    this._modelRegistry = null;

    /** @private @type {object|null} */
    this._httpServer = null;

    /** @private */
    this._started = false;
  }

  // ------------------------------------------------------------------
  // Getters
  // ------------------------------------------------------------------

  /**
   * The node's Identity instance.
   * @type {Identity}
   */
  get identity() {
    return this._identity;
  }

  /**
   * The Registry instance.
   * @type {Registry}
   */
  get registry() {
    return this._registry;
  }

  /**
   * The Publisher instance.
   * @type {Publisher}
   */
  get publisher() {
    return this._publisher;
  }

  /**
   * The Discovery instance.
   * @type {Discovery}
   */
  get discovery() {
    return this._discovery;
  }

  /**
   * The Payments instance.
   * @type {Payments}
   */
  get payments() {
    return this._payments;
  }

  /**
   * The TransparencyLog instance.
   * @type {TransparencyLog}
   */
  get transparencyLog() {
    return this._transparencyLog;
  }

  /**
   * The GitReceiver instance.
   * @type {GitReceiver}
   */
  get gitReceiver() {
    return this._gitReceiver;
  }

  /**
   * The ModelRegistry instance (tracks which peers serve which models).
   * @type {ModelRegistry}
   */
  get modelRegistry() {
    return this._modelRegistry;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Initialize all subsystems and start the node.
   *
   * 1. Create data directories if needed.
   * 2. Load or generate the node identity.
   * 3. Initialize every subsystem (Registry, Publisher, Discovery,
   *    Payments, TransparencyLog, GitReceiver).
   * 4. Wire the onPublish callback so new publications are gossiped
   *    and appended to the transparency log.
   * 5. Start discovery periodic sync.
   *
   * @returns {Promise<SafenetNode>} This instance, for chaining.
   */
  async start() {
    // 1. Ensure data directories exist
    _mkdirp(this._dataDir);
    _mkdirp(this._reposDir);

    // 2. Identity: load from disk or generate fresh
    if (!this._identity) {
      this._identity = await this._loadOrGenerateIdentity();
    }

    // 3. Subsystem initialisation

    // Registry (Prolly-backed, in-memory store for the reference impl)
    this._registry = new Registry();

    // Publisher
    this._publisher = new Publisher({
      identity: this._identity,
      registry: this._registry
    });

    // ModelRegistry: tracks which attested peers have which models
    this._modelRegistry = new ModelRegistry();

    // Discovery: needs an identity claim structure for peer announce
    const identityClaim = {
      stm: {
        peerUri: this._identity.uri,
        endpoint: 'https://localhost:' + this._port
      }
    };
    const bootstrapUris = this._bootstrapPeers.map((p) => {
      return typeof p === 'string' ? p : (p.uri || p.endpoint);
    });
    this._discovery = new Discovery({
      identity: identityClaim,
      registry: this._registry,
      bootstrapPeers: bootstrapUris,
      fanout: this._fanout,
      syncInterval: this._syncInterval,
      modelRegistry: this._modelRegistry
    });

    // Register bootstrap peers with their endpoints
    for (const peer of this._bootstrapPeers) {
      if (peer && typeof peer === 'object' && peer.uri && peer.endpoint) {
        this._discovery.addPeer(peer.uri, peer.endpoint, 0);
      }
    }

    // Payments
    this._payments = new Payments({
      identity: this._identity
    });

    // Transparency log
    this._transparencyLog = new TransparencyLog({
      storagePath: path.join(this._dataDir, 'transparency.json')
    });

    // Git receiver — wire the onPublish callback below
    this._gitReceiver = new GitReceiver({
      reposDir: this._reposDir,
      identity: this._identity,
      registry: this._registry,
      publisher: this._publisher,
      onPublish: (claim) => this._onPublish(claim)
    });

    // 4. Start discovery periodic sync
    this._discovery.startPeriodicSync();

    this._started = true;

    // eslint-disable-next-line no-console
    console.log(
      '[SafenetNode] started  uri=%s  dataDir=%s  peers=%d',
      this._identity.uri,
      this._dataDir,
      this._bootstrapPeers.length
    );

    return this;
  }

  /**
   * Gracefully shut down the node.
   *
   * Stops the discovery sync timer and closes the HTTP server if one
   * is running.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._discovery) {
      this._discovery.stop();
    }

    if (this._httpServer) {
      await new Promise((resolve) => {
        this._httpServer.close(() => resolve());
      });
      this._httpServer = null;
    }

    this._started = false;

    // eslint-disable-next-line no-console
    console.log('[SafenetNode] stopped  uri=%s', this._identity ? this._identity.uri : '(none)');
  }

  // ------------------------------------------------------------------
  // Attestation
  // ------------------------------------------------------------------

  /**
   * Perform mutual attestation with a remote peer.
   *
   * Protocol:
   *   1. POST our identity claim to the peer's /safenet/v1/attest endpoint.
   *   2. Receive and verify the peer's identity claim (signature + PCR values).
   *   3. Send a challenge nonce; verify the peer's signed response.
   *   4. On success add the peer with the "endorsed" trust level.
   *
   * @param {string} peerEndpoint - Base URL of the peer (e.g. https://peer.example:8443)
   * @returns {Promise<{ok: boolean, peerUri?: string, trustLevel?: number, errors?: string[]}>}
   */
  async attest(peerEndpoint) {
    const errors = [];

    try {
      // 1. POST our identity claim
      const ourClaim = await this._identity.createIdentityClaim({
        pcr0: '0'.repeat(64),
        pcr1: '0'.repeat(64),
        pcr4: '0'.repeat(64),
        imageHash: '0'.repeat(64),
        endpoints: ['https://localhost:' + this._port]
      });

      const attestResponse = await this._postJSON(
        peerEndpoint + '/safenet/v1/attest',
        { claim: ourClaim }
      );

      if (!attestResponse || !attestResponse.claim) {
        return { ok: false, errors: ['Peer did not return an identity claim'] };
      }

      const peerClaim = attestResponse.claim;

      // 2. Verify the peer's identity claim signature
      const sigResult = await Identity.verify(peerClaim);
      if (!sigResult.valid) {
        errors.push('Peer claim signature invalid: ' + (sigResult.reason || 'unknown'));
      }

      // 3. Verify PCR values against acceptable images
      const peerImageHash = peerClaim.stm && peerClaim.stm.imageHash;
      if (this._acceptableImages.size > 0 && peerImageHash) {
        if (!this._acceptableImages.has(peerImageHash)) {
          errors.push('Peer image hash not in acceptable set: ' + peerImageHash);
        }
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      // 3.5. Per-topic audit attestation check
      const topicWarnings = [];
      if (this._topicTrustPolicies && this._registry) {
        const peerPackages = _extractTopicsFromClaim(peerClaim);
        for (const { topic, namespace: ns, package: pkg, version } of peerPackages) {
          const policy = this._topicTrustPolicies[topic]
            || this._topicTrustPolicies['*'];
          if (!policy) continue;

          const attestations = await this._registry.getAuditAttestations(topic, ns, pkg);
          const now = new Date().toISOString();

          const matching = attestations.filter(function (a) {
            if (!a || !a.stm) return false;
            if (a.stm.assessment !== 'approved') return false;
            if (a.stm.expiry && a.stm.expiry < now) return false;
            if (!policy.trusted_auditors.includes(a.stm.auditor)) return false;
            return true;
          });

          if (matching.length < policy.required) {
            const msg = 'Topic "' + topic + '" requires ' + policy.required
              + ' auditor attestation(s) for ' + ns + '/' + pkg
              + ', found ' + matching.length;
            if (policy.on_missing === 'block') {
              errors.push(msg);
            } else {
              topicWarnings.push(msg);
              // eslint-disable-next-line no-console
              console.warn('[SafenetNode] audit warning: ' + msg);
            }
          }
        }
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      // 4. Challenge-response
      const nonce = sha256hex(Buffer.from(Date.now().toString() + Math.random().toString()));
      const challengeResponse = await this._postJSON(
        peerEndpoint + '/safenet/v1/challenge',
        { nonce, from: this._identity.uri }
      );

      if (!challengeResponse || !challengeResponse.signedNonce) {
        return { ok: false, errors: ['Peer did not respond to challenge'] };
      }

      // Verify the signed nonce
      const nonceVerify = await Identity.verify(challengeResponse.signedNonce);
      if (!nonceVerify.valid) {
        return { ok: false, errors: ['Peer challenge response signature invalid'] };
      }

      // 5. Success: add peer with endorsed trust
      const peerUri = peerClaim.iss || (peerClaim.stm && peerClaim.stm.peerUri);
      if (peerUri && this._discovery) {
        this._discovery.addPeer(peerUri, peerEndpoint, TRUST_ENDORSED);
      }

      return {
        ok: true,
        peerUri: peerUri || null,
        trustLevel: TRUST_ENDORSED,
        topicWarnings: topicWarnings.length > 0 ? topicWarnings : undefined
      };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  // ------------------------------------------------------------------
  // Publishing
  // ------------------------------------------------------------------

  /**
   * High-level package publication workflow.
   *
   * 1. Validate the manifest.
   * 2. Check (or claim) namespace ownership.
   * 3. Create a signed publication claim via the Publisher.
   * 4. Register the publication in the Registry.
   * 5. Encrypt chunks if needed (for Safecloud storage).
   * 6. Append to the transparency log.
   * 7. Gossip the publication claim.
   *
   * @param {object} options
   * @param {object}      options.manifest       - safenet.json manifest
   * @param {Array<{path: string, content: Buffer|string}>} options.files
   *   Package file entries
   * @param {Identity}   [options.authorIdentity] - Author identity for signing.
   *   Falls back to the node's own identity.
   * @returns {Promise<{ok: boolean, claim?: object, merkleRoot?: string, errors?: string[]}>}
   */
  async publishPackage(options) {
    if (!options || !options.manifest || !options.files) {
      return { ok: false, errors: ['manifest and files are required'] };
    }

    const { manifest, files } = options;
    const authorIdentity = options.authorIdentity || this._identity;
    const errors = [];

    try {
      // 1. Validate manifest
      const validation = this._publisher.validateManifest(manifest);
      if (!validation.ok) {
        return { ok: false, errors: validation.errors };
      }

      // 2. Namespace: parse from manifest name
      const parts = manifest.name.split('/');
      const ns = parts[0];
      const pkgName = parts[1];

      // Check ownership; claim if first time
      const existingNs = await this._registry.getNamespace(ns);
      if (!existingNs) {
        const claimResult = await this.claimNamespace(ns, authorIdentity);
        if (!claimResult.ok) {
          return { ok: false, errors: claimResult.errors || ['Failed to claim namespace'] };
        }
      }

      // 3. Create publication claim
      const authorPublisher = new Publisher({
        identity: authorIdentity,
        registry: this._registry
      });
      const claim = await authorPublisher.createPublication({
        manifest,
        files
      });

      // Handle Publisher returning an error structure
      if (claim && claim.ok === false) {
        return { ok: false, errors: claim.errors || [claim.message] };
      }

      // 4. Register the publication
      const regResult = await this._registry.publish(claim);
      if (!regResult.ok) {
        return { ok: false, errors: [regResult.message || regResult.code] };
      }

      // 5. Compute Merkle root for the result
      const merkleRoot = claim.stm ? claim.stm.merkleRoot : null;

      // 6. Encrypt chunks if the manifest requests it
      let chunks = null;
      if (manifest.encryption) {
        try {
          chunks = await authorPublisher.encryptContent(files);
        } catch (encErr) {
          errors.push('Chunk encryption failed: ' + encErr.message);
        }
      }

      // 7. Transparency log + gossip (via the shared callback)
      this._onPublish(claim);

      return {
        ok: true,
        claim,
        merkleRoot,
        chunks: chunks || undefined,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  // ------------------------------------------------------------------
  // Installation
  // ------------------------------------------------------------------

  /**
   * Install a package from the Safenet registry.
   *
   * 1. Query the registry for a version matching the requested range.
   * 2. Verify the publication claim.
   * 3. Check whether payment is required and process it.
   * 4. Download the content (from peers or Safecloud).
   * 5. Verify the Merkle root of the downloaded files.
   *
   * @param {string} namespace    - Package namespace
   * @param {string} name         - Package name
   * @param {string} versionRange - Semver range (e.g. "^1.0.0") or exact version
   * @param {object} [options]
   * @param {string} [options.language] - Language filter
   * @returns {Promise<{ok: boolean, version?: string, files?: object[], errors?: string[]}>}
   */
  async installPackage(namespace, name, versionRange, options) {
    const opts = options || {};

    try {
      // 1. Find a matching version
      const versions = await this._registry.listVersions(namespace, name);
      if (!versions || versions.length === 0) {
        return { ok: false, errors: ['Package ' + namespace + '/' + name + ' not found'] };
      }

      const resolvedVersion = _resolveVersion(versions, versionRange);
      if (!resolvedVersion) {
        return {
          ok: false,
          errors: ['No version of ' + namespace + '/' + name + ' matches "' + versionRange + '"']
        };
      }

      // 2. Retrieve and verify the publication claim
      const pubClaim = await this._registry.getVersion(namespace, name, resolvedVersion);
      if (!pubClaim) {
        return { ok: false, errors: ['Publication claim not found for ' + resolvedVersion] };
      }

      const verifyResult = await this._publisher.verifyPublication(pubClaim);
      if (!verifyResult.ok) {
        return {
          ok: false,
          errors: verifyResult.errors || ['Publication claim verification failed']
        };
      }

      // 3. Check payment requirement
      const pricing = pubClaim.stm && pubClaim.stm.manifest && pubClaim.stm.manifest.pricing;
      if (pricing && pricing.amount > 0) {
        const payResult = await this._payments.createPayment({
          package: namespace + '/' + name,
          version: resolvedVersion,
          amount: pricing.amount,
          currency: pricing.currency || 'SAFEBUX'
        });

        if (payResult && payResult.ok === false) {
          return { ok: false, errors: [payResult.message || 'Payment creation failed'] };
        }

        // Record the payment locally
        await this._payments.recordPayment(payResult);
      }

      // 4. Download content (placeholder — real implementation fetches from Safecloud / peers)
      const files = await this._fetchContent(namespace, name, resolvedVersion, pubClaim);

      // 5. Verify Merkle root
      if (files && files.length > 0 && pubClaim.stm && pubClaim.stm.merkleRoot) {
        const computedRoot = await this._publisher.computeMerkleRoot(files);
        if (computedRoot !== pubClaim.stm.merkleRoot) {
          return {
            ok: false,
            errors: [
              'Merkle root mismatch: expected ' + pubClaim.stm.merkleRoot +
              ', computed ' + computedRoot
            ]
          };
        }
      }

      return {
        ok: true,
        version: resolvedVersion,
        files
      };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  // ------------------------------------------------------------------
  // Namespace management
  // ------------------------------------------------------------------

  /**
   * Claim a namespace for an author.
   *
   * 1. Validate the namespace name.
   * 2. Create a namespace claim.
   * 3. Sign it with the author identity.
   * 4. Submit to the registry.
   * 5. Gossip the claim.
   *
   * @param {string}   name            - Namespace to claim
   * @param {Identity} authorIdentity  - Author identity that will own the namespace
   * @returns {Promise<{ok: boolean, claim?: object, errors?: string[]}>}
   */
  async claimNamespace(name, authorIdentity) {
    const identity = authorIdentity || this._identity;

    try {
      // 1. Build the namespace claim
      const ownerName = identity.name || identity.uri;
      const claim = Claims.namespaceClaim({
        namespace: name,
        owner: ownerName
      });

      // 2. Sign
      const signed = await identity.sign(claim);

      // 3. Submit to registry
      const result = await this._registry.claimNamespace(signed);
      if (!result.ok) {
        return { ok: false, errors: [result.message || result.code] };
      }

      // 4. Gossip
      if (this._discovery) {
        this._discovery.gossip(signed).catch(() => {});
      }

      return { ok: true, claim: signed };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  // ------------------------------------------------------------------
  // Registry queries
  // ------------------------------------------------------------------

  /**
   * Search the registry for packages matching a query.
   *
   * @param {string} query   - Search string
   * @param {object} [options]
   * @param {string} [options.language] - Language filter
   * @param {number} [options.limit]    - Max results
   * @returns {Promise<object[]>} Matching package metadata
   */
  async searchPackages(query, options) {
    if (!this._registry) return [];
    return this._registry.search(query, options);
  }

  /**
   * Retrieve full metadata for a package, including all versions.
   *
   * @param {string} namespace - Package namespace
   * @param {string} name      - Package name
   * @returns {Promise<object|null>} Package metadata or null
   */
  async getPackageInfo(namespace, name) {
    if (!this._registry) return null;
    return this._registry.getPackage(namespace, name);
  }

  // ------------------------------------------------------------------
  // Model discovery & remote inference
  // ------------------------------------------------------------------

  /**
   * Find attested peers that have a model loaded, by manifest hash.
   *
   * @param {string} manifestHash - 64-char hex SHA-256 of the canonical manifest
   * @returns {Array<{safeboxUri: string, endpoint: string, modelName: string|null, capacity: number, claim: object}>}
   */
  findModelPeers(manifestHash) {
    if (!this._modelRegistry) return [];
    return this._modelRegistry.findByHash(manifestHash);
  }

  /**
   * Find attested peers that have a model loaded, by name/version.
   *
   * @param {string} modelName
   * @param {string} [modelVersion]
   * @returns {Array<{safeboxUri: string, endpoint: string, manifestHash: string, capacity: number, claim: object}>}
   */
  findModelPeersByName(modelName, modelVersion) {
    if (!this._modelRegistry) return [];
    return this._modelRegistry.findByName(modelName, modelVersion);
  }

  /**
   * Announce that this Safebox has a model loaded and ready for inference.
   * Creates a signed model_available claim and gossips it.
   *
   * @param {object} modelEntry - Model metadata from SystemComponent._models
   * @param {string} modelEntry.manifestHash - 64-char hex
   * @param {string} [modelEntry.name]       - Human-readable model name
   * @param {string} [modelEntry.version]    - Model version
   * @param {string} [modelEntry.type]       - Model type (e.g. "LLM")
   * @returns {Promise<{ok: boolean, claim?: object, errors?: string[]}>}
   */
  async announceModel(modelEntry) {
    if (!this._identity || !this._discovery) {
      return { ok: false, errors: ['Node not started'] };
    }
    if (!modelEntry || !modelEntry.manifestHash) {
      return { ok: false, errors: ['manifestHash is required'] };
    }

    try {
      const claim = Claims.modelAvailable({
        safeboxUri: this._identity.uri,
        endpoint: 'https://localhost:' + this._port,
        manifestHash: modelEntry.manifestHash,
        modelName: modelEntry.name || null,
        modelVersion: modelEntry.version || null,
        modelType: modelEntry.type || null,
        capacity: 0
      });

      const signed = await this._identity.sign(claim);

      // Record locally too
      if (this._modelRegistry) {
        this._modelRegistry.addAnnouncement(signed);
      }

      // Gossip to peers
      await this._discovery.gossip(signed);

      return { ok: true, claim: signed };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  }

  /**
   * Proxy an inference request to a remote attested peer.
   *
   * @param {string} endpoint - Peer's HTTPS endpoint
   * @param {object} body     - The inference request body
   * @returns {Promise<object>} The peer's response
   */
  async proxyInference(endpoint, body) {
    return this._postJSON(endpoint + '/embed', body);
  }

  // ------------------------------------------------------------------
  // HTTP request handler
  // ------------------------------------------------------------------

  /**
   * Route an incoming HTTP request to the appropriate subsystem handler.
   *
   * Supported routes:
   *
   *   POST   /safenet/v1/attest             - Attestation
   *   POST   /safenet/v1/challenge           - Challenge-response
   *   POST   /safenet/v1/verify              - Claim verification
   *   POST   /safenet/v1/gossip              - Receive gossip
   *   POST   /safenet/v1/sync/bloom          - Bloom filter sync
   *   GET    /safenet/v1/registry/*          - Registry queries
   *   POST   /safenet/v1/publish             - Publish a package
   *   GET    /safenet/v1/namespace/*         - Namespace queries
   *   POST   /safenet/v1/namespace/*         - Namespace claim
   *   GET    /safenet/v1/git/*               - Git info/refs
   *   POST   /safenet/v1/git/*               - Git receive-pack / upload-pack
   *   POST   /safenet/v1/pay                 - Payment
   *   GET    /safenet/v1/balance/*           - Balance queries
   *   GET    /safenet/v1/transparency/*      - Transparency log queries
   *   GET    /safenet/v1/peers               - Peer list
   *   GET    /safenet/v1/content/*           - Content chunk retrieval
   *   POST   /safenet/v1/audit              - Submit audit attestation
   *   GET    /safenet/v1/audit/*            - Query audit attestations
   *   POST   /safenet/v1/attestation/verify - Full attestation verification (Safenet layer)
   *   GET    /safenet/v1/attestation/history/* - Attestation history from transparency log
   *   GET    /safenet/v1/attestation/provenance/* - Deployment provenance chain
   *   GET    /healthz                        - Health check
   *
   * @param {object} req - Node.js IncomingMessage
   * @param {object} res - Node.js ServerResponse
   */
  async handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      // ---- Health check ----
      if (pathname === '/healthz') {
        return _json(res, 200, {
          ok: true,
          uri: this._identity ? this._identity.uri : null,
          started: this._started,
          timestamp: nowISO()
        });
      }

      // ---- Attestation ----
      if (pathname === '/safenet/v1/attest' && method === 'POST') {
        return await this._handleAttest(req, res);
      }

      // ---- Challenge ----
      if (pathname === '/safenet/v1/challenge' && method === 'POST') {
        return await this._handleChallenge(req, res);
      }

      // ---- Verify ----
      if (pathname === '/safenet/v1/verify' && method === 'POST') {
        return await this._handleVerify(req, res);
      }

      // ---- Gossip ----
      if (pathname === '/safenet/v1/gossip' && method === 'POST') {
        return await this._handleGossip(req, res);
      }

      // ---- Bloom sync ----
      if (pathname === '/safenet/v1/sync/bloom' && method === 'POST') {
        return await this._handleBloomSync(req, res);
      }

      // ---- Publish ----
      if (pathname === '/safenet/v1/publish' && method === 'POST') {
        return await this._handlePublish(req, res);
      }

      // ---- Payments ----
      if (pathname === '/safenet/v1/pay' && method === 'POST') {
        return await this._handlePay(req, res);
      }

      // ---- Peers ----
      if (pathname === '/safenet/v1/peers' && method === 'GET') {
        return this._handlePeers(req, res);
      }

      // ---- Model discovery ----
      if (pathname === '/safenet/v1/models' && method === 'GET') {
        const models = this._modelRegistry ? this._modelRegistry.listModels() : [];
        return _json(res, 200, { ok: true, models });
      }
      if (pathname === '/safenet/v1/models/find' && method === 'POST') {
        const body = await _parseJSON(req);
        if (!body) return _json(res, 400, { ok: false, message: 'Body required' });
        let peers;
        if (body.manifestHash) {
          peers = this.findModelPeers(body.manifestHash);
        } else if (body.modelName) {
          peers = this.findModelPeersByName(body.modelName, body.modelVersion);
        } else {
          return _json(res, 400, { ok: false, message: 'manifestHash or modelName required' });
        }
        return _json(res, 200, { ok: true, peers: peers.map(function(p) {
          return { safeboxUri: p.safeboxUri, endpoint: p.endpoint,
                   modelName: p.modelName, capacity: p.capacity };
        })});
      }

      // ---- Balance ----
      if (pathname.startsWith('/safenet/v1/balance/') && method === 'GET') {
        return this._handleBalance(req, res, pathname);
      }

      // ---- Transparency log ----
      if (pathname.startsWith('/safenet/v1/transparency') && method === 'GET') {
        return this._handleTransparency(req, res, pathname, url);
      }

      // ---- Registry queries ----
      if (pathname.startsWith('/safenet/v1/registry/') && method === 'GET') {
        return await this._handleRegistryQuery(req, res, pathname, url);
      }

      // ---- Namespace ----
      if (pathname.startsWith('/safenet/v1/namespace/')) {
        if (method === 'GET') {
          return await this._handleNamespaceQuery(req, res, pathname);
        }
        if (method === 'POST') {
          return await this._handleNamespaceClaim(req, res, pathname);
        }
      }

      // ---- Git Smart HTTP ----
      if (pathname.startsWith('/safenet/v1/git/')) {
        return await this._handleGit(req, res, pathname, method, url);
      }

      // ---- Content chunks ----
      if (pathname.startsWith('/safenet/v1/content/') && method === 'GET') {
        return this._handleContent(req, res, pathname);
      }

      // ---- Audit attestation ----
      if (pathname === '/safenet/v1/audit' && method === 'POST') {
        return await this._handleAuditSubmit(req, res);
      }
      if (pathname.startsWith('/safenet/v1/audit/') && method === 'GET') {
        return await this._handleAuditQuery(req, res, pathname);
      }

      // ---- Attestation verification (Safenet verification layer) ----
      if (pathname === '/safenet/v1/attestation/verify' && method === 'POST') {
        return await this._handleAttestationVerify(req, res);
      }
      if (pathname.startsWith('/safenet/v1/attestation/history/') && method === 'GET') {
        return this._handleAttestationHistory(req, res, pathname);
      }
      if (pathname.startsWith('/safenet/v1/attestation/provenance/') && method === 'GET') {
        return await this._handleAttestationProvenance(req, res, pathname);
      }

      // ---- Not found ----
      _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown route: ' + pathname });
    } catch (err) {
      _json(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: err.message });
    }
  }

  // ------------------------------------------------------------------
  // HTTP route handlers (private)
  // ------------------------------------------------------------------

  /**
   * Handle POST /safenet/v1/attest
   * @private
   */
  async _handleAttest(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a claim' });
    }

    // Verify the incoming claim
    const sigResult = await Identity.verify(body.claim);
    if (!sigResult.valid) {
      return _json(res, 401, { ok: false, code: 'INVALID_SIGNATURE', message: sigResult.reason });
    }

    // Return our own identity claim
    const ourClaim = await this._identity.createIdentityClaim({
      pcr0: '0'.repeat(64),
      pcr1: '0'.repeat(64),
      pcr4: '0'.repeat(64),
      imageHash: '0'.repeat(64),
      endpoints: ['https://localhost:' + this._port]
    });

    _json(res, 200, { ok: true, claim: ourClaim });
  }

  /**
   * Handle POST /safenet/v1/challenge
   * @private
   */
  async _handleChallenge(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.nonce) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a nonce' });
    }

    // Sign the nonce as proof of private key ownership
    const signedNonce = await this._identity.sign({
      ocp: 1,
      iss: this._identity.uri,
      sub: this._identity.uri,
      stm: {
        type: 'challenge_response',
        nonce: body.nonce,
        timestamp: nowISO()
      },
      nbf: nowISO()
    });

    _json(res, 200, { ok: true, signedNonce });
  }

  /**
   * Handle POST /safenet/v1/verify
   * @private
   */
  async _handleVerify(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a claim' });
    }

    const result = await Identity.verify(body.claim);
    _json(res, 200, { ok: result.valid, reason: result.reason || undefined });
  }

  /**
   * Handle POST /safenet/v1/gossip
   * @private
   */
  async _handleGossip(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a claim' });
    }

    const result = await this._discovery.receiveGossip(
      body.claim,
      body.from || 'unknown',
      typeof body.ttl === 'number' ? body.ttl : 0
    );

    _json(res, 200, result);
  }

  /**
   * Handle POST /safenet/v1/sync/bloom
   * @private
   */
  async _handleBloomSync(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.bloom) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a bloom filter' });
    }

    // Build our Bloom filter to send back
    const ourBloom = await this._discovery.buildBloomFilter();

    // Determine which claims the peer is missing based on their Bloom
    const entries = await this._registry.exportState();
    const missingClaims = [];
    // We cannot test their Bloom without Data.Bloom — collect all for now
    for (const { value } of entries) {
      if (value && value.claim) {
        missingClaims.push(value.claim);
      }
    }

    _json(res, 200, {
      ok: true,
      claims: missingClaims,
      peerBloom: ourBloom
    });
  }

  /**
   * Handle POST /safenet/v1/publish
   * @private
   */
  async _handlePublish(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.manifest || !body.files) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include manifest and files'
      });
    }

    const result = await this.publishPackage({
      manifest: body.manifest,
      files: body.files,
      authorIdentity: body.authorClaim ? Identity.fromJSON(body.authorClaim) : undefined
    });

    const status = result.ok ? 200 : 400;
    _json(res, status, result);
  }

  /**
   * Handle POST /safenet/v1/pay
   * @private
   */
  async _handlePay(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Body must include a payment claim' });
    }

    const result = await this._payments.recordPayment(body.claim);
    const status = result.ok ? 200 : 400;
    _json(res, status, result);
  }

  /**
   * Handle GET /safenet/v1/peers
   * @private
   */
  _handlePeers(req, res) {
    const peers = this._discovery ? this._discovery.getPeers() : [];
    _json(res, 200, { ok: true, peers });
  }

  /**
   * Handle GET /safenet/v1/balance/<authorUri>
   * @private
   */
  _handleBalance(req, res, pathname) {
    const authorUri = decodeURIComponent(_after(pathname, '/safenet/v1/balance/'));
    if (!authorUri) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Author URI required' });
    }

    const balance = this._payments.getBalance(authorUri);
    _json(res, 200, { ok: true, authorUri, balance });
  }

  /**
   * Handle GET /safenet/v1/transparency/*
   *
   * Sub-routes:
   *   /safenet/v1/transparency/root           - Current Merkle root
   *   /safenet/v1/transparency/entry/<index>   - Single entry
   *   /safenet/v1/transparency/proof/<index>   - Inclusion proof
   *
   * @private
   */
  _handleTransparency(req, res, pathname, url) {
    const sub = _after(pathname, '/safenet/v1/transparency/');

    if (sub === 'root' || sub === '') {
      const root = this._transparencyLog.getRoot();
      return _json(res, 200, { ok: true, root });
    }

    if (sub.startsWith('entry/')) {
      const idx = parseInt(sub.slice('entry/'.length), 10);
      if (isNaN(idx)) {
        return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Invalid index' });
      }
      const entry = this._transparencyLog.getEntry(idx);
      if (!entry) {
        return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Entry not found' });
      }
      return _json(res, 200, { ok: true, entry });
    }

    if (sub.startsWith('proof/')) {
      const idx = parseInt(sub.slice('proof/'.length), 10);
      if (isNaN(idx)) {
        return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Invalid index' });
      }
      try {
        const proof = this._transparencyLog.getInclusionProof(idx);
        return _json(res, 200, { ok: true, proof });
      } catch (err) {
        return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: err.message });
      }
    }

    _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown transparency sub-route' });
  }

  /**
   * Handle GET /safenet/v1/registry/*
   *
   * Sub-routes:
   *   /safenet/v1/registry/search?q=<query>&limit=<n>
   *   /safenet/v1/registry/<ns>/<pkg>
   *   /safenet/v1/registry/<ns>/<pkg>/versions
   *   /safenet/v1/registry/<ns>/<pkg>/<version>
   *
   * @private
   */
  async _handleRegistryQuery(req, res, pathname, url) {
    const sub = _after(pathname, '/safenet/v1/registry/');

    // Search
    if (sub === 'search') {
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
      const results = await this._registry.search(q, { limit });
      return _json(res, 200, { ok: true, results });
    }

    // Parse <ns>/<pkg>[/<version-or-subcommand>]
    const segments = sub.split('/');
    if (segments.length < 2) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Registry route requires namespace/package'
      });
    }

    const ns = segments[0];
    const pkg = segments[1];

    // /versions
    if (segments.length === 3 && segments[2] === 'versions') {
      const versions = await this._registry.listVersions(ns, pkg);
      return _json(res, 200, { ok: true, namespace: ns, package: pkg, versions });
    }

    // /<version>
    if (segments.length === 3) {
      const version = segments[2];
      const claim = await this._registry.getVersion(ns, pkg, version);
      if (!claim) {
        return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Version not found' });
      }
      return _json(res, 200, { ok: true, claim });
    }

    // Package info
    const info = await this._registry.getPackage(ns, pkg);
    if (!info) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Package not found' });
    }
    _json(res, 200, { ok: true, package: info });
  }

  /**
   * Handle GET /safenet/v1/namespace/<name>
   * @private
   */
  async _handleNamespaceQuery(req, res, pathname) {
    const name = _after(pathname, '/safenet/v1/namespace/');
    if (!name) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Namespace name required' });
    }

    const claim = await this._registry.getNamespace(name);
    if (!claim) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Namespace not claimed' });
    }
    _json(res, 200, { ok: true, namespace: name, claim });
  }

  /**
   * Handle POST /safenet/v1/namespace/<name>
   * @private
   */
  async _handleNamespaceClaim(req, res, pathname) {
    const name = _after(pathname, '/safenet/v1/namespace/');
    if (!name) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Namespace name required' });
    }

    const body = await _parseJSON(req);
    const authorIdentity = (body && body.authorClaim)
      ? Identity.fromJSON(body.authorClaim)
      : this._identity;

    const result = await this.claimNamespace(name, authorIdentity);
    const status = result.ok ? 200 : 400;
    _json(res, status, result);
  }

  /**
   * Handle /safenet/v1/git/* routes.
   *
   * Maps URL segments to GitReceiver methods:
   *   GET  /safenet/v1/git/<ns>/<pkg>/info/refs?service=...
   *   POST /safenet/v1/git/<ns>/<pkg>/git-receive-pack
   *   POST /safenet/v1/git/<ns>/<pkg>/git-upload-pack
   *
   * @private
   */
  async _handleGit(req, res, pathname, method, url) {
    const sub = _after(pathname, '/safenet/v1/git/');
    const segments = sub.split('/');

    if (segments.length < 3) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Git route requires namespace/package/action'
      });
    }

    const ns = segments[0];
    const pkg = segments[1];
    const action = segments.slice(2).join('/');

    // GET info/refs
    if (method === 'GET' && action === 'info/refs') {
      const service = url.searchParams.get('service');
      return this._gitReceiver.handleInfoRefs(req, res, ns, pkg, service);
    }

    // POST git-receive-pack
    if (method === 'POST' && action === 'git-receive-pack') {
      return this._gitReceiver.handleReceivePack(req, res, ns, pkg);
    }

    // POST git-upload-pack
    if (method === 'POST' && action === 'git-upload-pack') {
      return this._gitReceiver.handleUploadPack(req, res, ns, pkg);
    }

    _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown git action: ' + action });
  }

  /**
   * Handle POST /safenet/v1/audit
   *
   * Submit a signed audit attestation claim to the registry.
   *
   * @private
   */
  async _handleAuditSubmit(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include a signed audit attestation claim'
      });
    }

    const result = await this._registry.processAuditAttestation(body.claim);
    if (result.ok && this._discovery) {
      this._discovery.gossip(body.claim).catch(() => {});
    }
    const status = result.ok ? 200 : 400;
    _json(res, status, result);
  }

  /**
   * Handle GET /safenet/v1/audit/<topic>/<ns>/<pkg>
   *
   * Query audit attestations for a given topic and package.
   * If only topic is provided, returns all attestations for that topic.
   *
   * @private
   */
  async _handleAuditQuery(req, res, pathname) {
    const sub = _after(pathname, '/safenet/v1/audit/');
    const segments = sub.split('/');

    if (segments.length >= 3) {
      // /audit/<topic>/<ns>/<pkg>
      const topic = segments[0];
      const ns = segments[1];
      const pkg = segments[2];
      const attestations = await this._registry.getAuditAttestations(topic, ns, pkg);
      return _json(res, 200, { ok: true, attestations });
    }

    if (segments.length === 1 && segments[0]) {
      // /audit/<topic> — all attestations for a topic
      const topic = segments[0];
      const attestations = await this._registry.queryAuditsByTopic(topic);
      return _json(res, 200, { ok: true, attestations });
    }

    _json(res, 400, {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'Audit route requires at least a topic: /audit/<topic>[/<ns>/<pkg>]'
    });
  }

  // ------------------------------------------------------------------
  // Attestation verification handlers (Safenet verification layer)
  //
  // These are the external-facing endpoints for relying parties making
  // OCP grant decisions. They wrap Infrastructure's raw attestation
  // evidence with transparency log history, deployment provenance,
  // and fleet context.
  // ------------------------------------------------------------------

  /**
   * Handle POST /safenet/v1/attestation/verify
   *
   * Full attestation verification with enrichment. This is the primary
   * endpoint for OCP grant holders deciding whether to release key
   * fragments to a Safebox.
   *
   * Body:
   *   {
   *     claim: <signed safebox_announce or safebox_identity claim>,
   *     trustedImages: [<hash>, ...],          // required: blessed image set
   *     maxAgeSec: 600,                        // optional (default 600)
   *     requireConfidential: false,            // optional
   *     grantPolicy: { ... }                   // optional: OCP grant policy
   *   }
   *
   * Response:
   *   {
   *     ok: true|false,
   *     errors: [...],
   *     safeboxId, boxPubkey, imageHash,
   *     attestationAge,
   *     transparencyEntry: { index, entryHash, inclusionProof },
   *     attestationHistory: [ ... ],
   *     provenance: { imageHash, found, ... },
   *     fleetContext: { endorsedPeers, peers: [...] },
   *     grantDecision: { release: true|false, reasons: [...] }
   *   }
   *
   * @private
   */
  async _handleAttestationVerify(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.claim) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include a claim'
      });
    }

    const trustedImages = body.trustedImages
      ? new Set(body.trustedImages)
      : this._acceptableImages;

    if (!trustedImages || trustedImages.size === 0) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'trustedImages required (array of blessed image hashes)'
      });
    }

    const result = await Verify.boxAttestation(body.claim, {
      trustedImages: trustedImages,
      maxAgeSec: body.maxAgeSec,
      requireConfidential: body.requireConfidential || false,
      transparencyLog: this._transparencyLog,
      discovery: this._discovery,
      gitReceiver: this._gitReceiver,
      grantPolicy: body.grantPolicy || null
    });

    _json(res, 200, result);
  }

  /**
   * Handle GET /safenet/v1/attestation/history/<safeboxId>
   *
   * Returns the attestation history for a Safebox from the transparency
   * log. Allows relying parties to verify chain continuity, detect
   * reboots, and see how long a box has been attesting.
   *
   * Query params:
   *   since - ISO timestamp lower bound
   *   until - ISO timestamp upper bound
   *   limit - max entries (default 50)
   *
   * @private
   */
  _handleAttestationHistory(req, res, pathname) {
    const safeboxId = _after(pathname, '/safenet/v1/attestation/history/');
    if (!safeboxId) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Safebox ID required: /attestation/history/<safeboxId>'
      });
    }

    const url = new URL(req.url, 'https://localhost');
    const result = Verify.attestationHistory(safeboxId, this._transparencyLog, {
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      limit: url.searchParams.has('limit')
        ? parseInt(url.searchParams.get('limit'), 10)
        : undefined
    });

    _json(res, 200, { ok: true, safeboxId: safeboxId, ...result });
  }

  /**
   * Handle GET /safenet/v1/attestation/provenance/<imageHash>
   *
   * Traces an image hash back to its publication claim in the
   * transparency log, bridging "this box runs image X" to
   * "image X was built from git commit Y".
   *
   * @private
   */
  async _handleAttestationProvenance(req, res, pathname) {
    const imageHash = _after(pathname, '/safenet/v1/attestation/provenance/');
    if (!imageHash) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Image hash required: /attestation/provenance/<imageHash>'
      });
    }

    const result = await Verify.deploymentProvenance(
      imageHash,
      this._transparencyLog,
      this._registry
    );

    _json(res, 200, { ok: true, imageHash: imageHash, ...result });
  }

  /**
   * Handle GET /safenet/v1/content/<hash>
   *
   * Returns the raw content chunk identified by its SHA-256 hash.
   * Placeholder: a production implementation would look up the chunk
   * in a content-addressed store.
   *
   * @private
   */
  _handleContent(req, res, pathname) {
    const hash = _after(pathname, '/safenet/v1/content/');
    if (!hash) {
      return _json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Content hash required' });
    }

    // Reference implementation: content is not stored locally by default.
    // A production node would check its chunk store here.
    _json(res, 404, {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Content chunk not available on this node'
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Load identity from disk or generate a new one.
   *
   * Looks for <dataDir>/identity.json. If it exists, reconstructs
   * the Identity from the stored public key. Otherwise generates
   * a fresh Safebox identity and persists it.
   *
   * @private
   * @returns {Promise<Identity>}
   */
  async _loadOrGenerateIdentity() {
    const idPath = path.join(this._dataDir, 'identity.json');

    if (fs.existsSync(idPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(idPath, 'utf8'));
        return Identity.fromJSON(raw);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[SafenetNode] failed to load identity, generating new:', err.message);
      }
    }

    const identity = await Identity.generateSafebox();

    // Persist (public key only — private key stays in memory / TEE)
    const json = identity.toJSON ? identity.toJSON() : {
      type: identity.type,
      publicKey: identity.publicKeyHex,
      uri: identity.uri
    };
    fs.writeFileSync(idPath, JSON.stringify(json, null, 2), 'utf8');

    return identity;
  }

  /**
   * Shared callback invoked after any successful publication.
   * Appends to the transparency log and gossips the claim.
   *
   * @private
   * @param {object} claim - Signed publication claim
   */
  _onPublish(claim) {
    if (!claim) return;

    // Append to transparency log
    if (this._transparencyLog) {
      try {
        this._transparencyLog.append(claim);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[SafenetNode] transparency log append failed:', err.message);
      }
    }

    // Gossip to peers
    if (this._discovery) {
      this._discovery.gossip(claim).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[SafenetNode] gossip failed:', err.message);
      });
    }
  }

  /**
   * POST JSON to a remote endpoint. Returns the parsed response body.
   *
   * Uses the built-in https module for zero external dependencies.
   *
   * @private
   * @param {string} urlStr - Full HTTPS URL
   * @param {object} body   - Request body (serialised as JSON)
   * @returns {Promise<object>}
   */
  _postJSON(urlStr, body) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const parsed = new URL(urlStr);
      const payload = JSON.stringify(body);

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        rejectUnauthorized: false // TEE-to-TEE: attestation replaces TLS PKI
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (_) {
            reject(new Error('Invalid JSON from peer'));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Fetch package content from peers or Safecloud.
   *
   * Placeholder: the reference implementation returns an empty array.
   * A production implementation would query peers via discovery and
   * fall back to Safecloud CDN.
   *
   * @private
   * @param {string} namespace
   * @param {string} name
   * @param {string} version
   * @param {object} pubClaim - Publication claim (contains merkleRoot, etc.)
   * @returns {Promise<Array<{path: string, content: Buffer}>>}
   */
  async _fetchContent(namespace, name, version, pubClaim) {
    // In the reference implementation, content is stored alongside the
    // git repo. Try to read from the repos directory.
    const repoDir = path.join(this._reposDir, namespace, name + '.git');
    if (!fs.existsSync(repoDir)) {
      return [];
    }

    // Placeholder: real implementation would check out the tagged version
    // and return file entries. For now return empty.
    return [];
  }
}

// ------------------------------------------------------------------
// Module-level helpers
// ------------------------------------------------------------------

/**
 * Extract topic/package pairs from a peer's identity claim.
 *
 * The peer's claim may include a `capabilities` or `topics` array in
 * its stm field, each entry having { topic, namespace, package, version }.
 * If no explicit topics are declared, returns an empty array (no
 * topic attestation is checked).
 *
 * @param {object} claim - Peer's identity claim
 * @returns {Array<{topic: string, namespace: string, package: string, version: string}>}
 */
function _extractTopicsFromClaim(claim) {
  if (!claim || !claim.stm) return [];
  const stm = claim.stm;

  // Peer may advertise its topics/capabilities explicitly
  if (Array.isArray(stm.topics)) {
    return stm.topics.filter(function (t) {
      return t && t.topic && t.namespace && t.package;
    });
  }

  if (Array.isArray(stm.capabilities)) {
    return stm.capabilities
      .filter(function (c) { return c && c.topic && c.namespace && c.package; })
      .map(function (c) {
        return {
          topic: c.topic,
          namespace: c.namespace,
          package: c.package,
          version: c.version || '*'
        };
      });
  }

  return [];
}

/**
 * Recursively create a directory if it does not exist.
 *
 * @param {string} dir - Directory path
 */
function _mkdirp(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve a version string or range against a list of available versions.
 *
 * Supports exact match and simple prefix matching (^major, ~major.minor).
 * A full semver range resolver would use a library; this is a reference
 * approximation.
 *
 * @param {string[]} versions - Available version strings
 * @param {string}   range    - Requested range or exact version
 * @returns {string|null} Best matching version, or null
 */
function _resolveVersion(versions, range) {
  if (!versions || versions.length === 0) return null;
  if (!range) return versions[versions.length - 1]; // latest

  // Exact match
  if (versions.includes(range)) return range;

  // Caret range: ^1.2.3 matches >=1.2.3 <2.0.0
  if (range.startsWith('^')) {
    const base = range.slice(1);
    const parts = base.split('.');
    const major = parseInt(parts[0], 10);

    const candidates = versions.filter((v) => {
      const vp = v.split('.');
      const vMajor = parseInt(vp[0], 10);
      return vMajor === major && v >= base;
    });

    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  // Tilde range: ~1.2.3 matches >=1.2.3 <1.3.0
  if (range.startsWith('~')) {
    const base = range.slice(1);
    const parts = base.split('.');
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1] || '0', 10);

    const candidates = versions.filter((v) => {
      const vp = v.split('.');
      const vMajor = parseInt(vp[0], 10);
      const vMinor = parseInt(vp[1] || '0', 10);
      return vMajor === major && vMinor === minor && v >= base;
    });

    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  // Wildcard: just return latest
  if (range === '*' || range === 'latest') {
    return versions[versions.length - 1];
  }

  return null;
}

module.exports = SafenetNode;
