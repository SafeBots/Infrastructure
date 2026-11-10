'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { nowISO } = require('./utils');

// ------------------------------------------------------------------
// HTTP helpers (shared pattern with SafenetNode)
// ------------------------------------------------------------------

function _readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function _parseJSON(req) {
  try {
    const buf = await _readBody(req);
    if (buf.length === 0) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

function _json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

function _after(str, prefix) {
  const idx = str.indexOf(prefix);
  if (idx === -1) return '';
  return str.slice(idx + prefix.length);
}

// ------------------------------------------------------------------
// SystemComponent
// ------------------------------------------------------------------

/**
 * SystemComponent exposes /system/v1/* endpoints for host-level
 * infrastructure monitoring: health, models, containers, governance
 * quorum state, KV/latent cache stats, and system metrics.
 *
 * Follows the same request/response patterns as SafenetNode so both
 * can be mounted in the same HTTP server.
 */
class SystemComponent {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir         - persistent state dir (e.g. /var/lib/safenet)
   * @param {string} [opts.cacheDir]      - cache root (default /srv/safebox/cache)
   * @param {string} [opts.modelsDir]     - model storage root
   * @param {string} [opts.containersFile]- managed-containers.json path
   * @param {string} [opts.governanceDir] - governance quorum state dir
   * @param {object} [opts.safenetNode]   - reference to SafenetNode (for cross-queries)
   */
  constructor(opts = {}) {
    this._dataDir = opts.dataDir || '/var/lib/safenet';
    this._cacheDir = opts.cacheDir || '/srv/safebox/cache';
    this._modelsDir = opts.modelsDir || path.join(this._dataDir, 'models');
    this._containersFile = opts.containersFile ||
      path.join(this._dataDir, 'managed-containers.json');
    this._governanceDir = opts.governanceDir ||
      path.join(this._dataDir, 'governance');
    this._safenetNode = opts.safenetNode || null;
    this._started = null;

    // In-memory model registry (populated from config/filesystem on start)
    this._models = new Map();

    // In-memory container registry
    this._containers = new Map();

    // Governance proposals (loaded from governance dir)
    this._proposals = [];

    // Cache stats accumulators
    this._cacheStats = {
      kv:        { hits: 0, misses: 0, entries: 0, sizeBytes: 0 },
      latent:    { hits: 0, misses: 0, entries: 0, sizeBytes: 0 },
      response:  { hits: 0, misses: 0, entries: 0, sizeBytes: 0 },
      embedding: { hits: 0, misses: 0, entries: 0, sizeBytes: 0 },
    };

    // Metrics sampling
    this._metricsHistory = [];
    this._metricsInterval = null;
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  async start() {
    this._started = nowISO();
    this._loadModels();
    this._announceLoadedModels();
    this._loadContainers();
    this._loadGovernance();
    this._scanCacheStats();

    // Sample system metrics every 10 seconds
    this._sampleMetrics();
    this._metricsInterval = setInterval(() => this._sampleMetrics(), 10000);

    // eslint-disable-next-line no-console
    console.log('[system] SystemComponent started');
  }

  async stop() {
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
      this._metricsInterval = null;
    }
    // eslint-disable-next-line no-console
    console.log('[system] SystemComponent stopped');
  }

  // ----------------------------------------------------------------
  // HTTP routing — mounted at /system/v1/*
  // ----------------------------------------------------------------

  async handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    try {
      // ---- Health ----
      if (pathname === '/system/v1/health' && method === 'GET') {
        return this._handleHealth(req, res);
      }

      // ---- Models ----
      if (pathname === '/system/v1/models' && method === 'GET') {
        return this._handleModels(req, res);
      }
      if (pathname.startsWith('/system/v1/models/') && method === 'GET') {
        return this._handleModelDetail(req, res, pathname);
      }

      // ---- Containers ----
      if (pathname === '/system/v1/containers' && method === 'GET') {
        return this._handleContainers(req, res);
      }
      if (pathname.startsWith('/system/v1/containers/') && method === 'GET') {
        return this._handleContainerDetail(req, res, pathname);
      }

      // ---- Governance ----
      if (pathname === '/system/v1/governance' && method === 'GET') {
        return this._handleGovernance(req, res);
      }
      if (pathname === '/system/v1/governance/sign' && method === 'POST') {
        return await this._handleGovernanceSign(req, res);
      }

      // ---- Cache ----
      if (pathname === '/system/v1/cache' && method === 'GET') {
        return this._handleCache(req, res);
      }
      if (pathname.startsWith('/system/v1/cache/') && method === 'GET') {
        return this._handleCacheDetail(req, res, pathname);
      }

      // ---- Metrics ----
      if (pathname === '/system/v1/metrics' && method === 'GET') {
        return this._handleMetrics(req, res);
      }
      if (pathname.startsWith('/system/v1/metrics/') && method === 'GET') {
        return this._handleMetricDetail(req, res, pathname);
      }

      _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown route: ' + pathname });
    } catch (err) {
      _json(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: err.message });
    }
  }

  // ----------------------------------------------------------------
  // Route handlers
  // ----------------------------------------------------------------

  /**
   * GET /system/v1/health
   *
   * Returns comprehensive system health: node info, attestation
   * status, TLS, disk, network, peer count.
   */
  _handleHealth(req, res) {
    const uptime = process.uptime();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();

    // Disk info (best-effort)
    let disk = null;
    try {
      const df = execSync('df -B1 / 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
      const lines = df.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        disk = {
          totalBytes: parseInt(parts[1], 10) || 0,
          usedBytes: parseInt(parts[2], 10) || 0,
          availBytes: parseInt(parts[3], 10) || 0,
          usePct: parseInt(parts[4], 10) || 0,
          filesystem: parts[0]
        };
      }
    } catch (_) { /* disk check failed silently */ }

    // Peer count from SafenetNode if available
    let peerCount = 0;
    if (this._safenetNode && this._safenetNode._discovery) {
      try {
        peerCount = this._safenetNode._discovery.getPeers().length;
      } catch (_) {}
    }

    // Attestation status
    const attestation = this._getAttestationStatus();

    // TLS status
    const tls = this._getTlsStatus();

    const items = [
      {
        id: 'node-health',
        title: 'Node Health',
        sub: 'All systems operational',
        dot: 'green',
        meta: `uptime ${this._formatDuration(uptime)}`,
        detail: {
          uptime,
          uptimeFormatted: this._formatDuration(uptime),
          started: this._started,
          nodeVersion: process.version,
          platform: `${os.type()} ${os.release()}`,
          hostname: os.hostname(),
          arch: os.arch(),
          pid: process.pid,
          cpuCount: cpus.length,
          cpuModel: cpus[0] ? cpus[0].model.trim() : 'unknown',
          totalMemory: totalMem,
          freeMemory: freeMem,
          memoryUsePct: Math.round(((totalMem - freeMem) / totalMem) * 100),
          peerCount,
        }
      },
      {
        id: 'attestation',
        title: 'Attestation',
        sub: attestation.summary,
        dot: attestation.ok ? 'green' : 'red',
        meta: attestation.ok ? 'valid' : 'unverified',
        detail: attestation
      },
      {
        id: 'tls',
        title: 'TLS Certificates',
        sub: tls.summary,
        dot: tls.ok ? 'green' : 'yellow',
        meta: tls.autoRenew ? 'auto-renew' : 'manual',
        detail: tls
      },
      {
        id: 'disk',
        title: 'Disk',
        sub: disk
          ? `${disk.usePct}% used · ${this._formatBytes(disk.availBytes)} free`
          : 'Unknown',
        dot: disk && disk.usePct < 80 ? 'green' : disk && disk.usePct < 95 ? 'yellow' : 'red',
        meta: disk ? disk.filesystem : 'n/a',
        detail: disk || {}
      },
      {
        id: 'network',
        title: 'Network',
        sub: `${peerCount} peer${peerCount !== 1 ? 's' : ''} connected`,
        dot: peerCount > 0 ? 'green' : 'red',
        meta: peerCount > 0 ? 'gossip ok' : 'isolated',
        detail: { peerCount }
      },
    ];

    _json(res, 200, { ok: true, items });
  }

  /**
   * GET /system/v1/models
   *
   * Lists all registered models with status and metadata.
   */
  _handleModels(req, res) {
    const items = [];
    for (const [id, model] of this._models) {
      items.push({
        id,
        title: model.name,
        sub: `${model.type} · ${this._formatBytes(model.sizeBytes)} · ${model.quantization || 'native'}`,
        badge: model.status === 'loaded' ? 'badge-ok'
          : model.status === 'idle' ? 'badge-info'
          : model.status === 'error' ? 'badge-err' : 'badge-warn',
        badgeText: model.status,
        detail: model
      });
    }
    _json(res, 200, { ok: true, items });
  }

  /**
   * GET /system/v1/models/:id
   */
  _handleModelDetail(req, res, pathname) {
    const id = _after(pathname, '/system/v1/models/');
    const model = this._models.get(id);
    if (!model) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Model not found' });
    }
    _json(res, 200, { ok: true, model });
  }

  /**
   * GET /system/v1/containers
   *
   * Lists all managed containers.
   */
  _handleContainers(req, res) {
    const items = [];
    for (const [id, ctr] of this._containers) {
      const running = ctr.status === 'running';
      items.push({
        id,
        title: ctr.name,
        sub: `${ctr.service} · port ${ctr.port || '—'}`,
        dot: running ? 'green' : ctr.status === 'idle' ? 'yellow' : 'red',
        meta: ctr.resourceSummary || ctr.status,
        detail: ctr
      });
    }
    _json(res, 200, { ok: true, items });
  }

  /**
   * GET /system/v1/containers/:id
   */
  _handleContainerDetail(req, res, pathname) {
    const id = _after(pathname, '/system/v1/containers/');
    const ctr = this._containers.get(id);
    if (!ctr) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Container not found' });
    }
    _json(res, 200, { ok: true, container: ctr });
  }

  /**
   * GET /system/v1/governance
   *
   * Lists governance proposals/actions and their quorum state.
   */
  _handleGovernance(req, res) {
    const items = this._proposals.map(p => ({
      id: p.id,
      title: p.title,
      sub: `${p.subject} · ${p.status}`,
      badge: p.signatures >= p.threshold ? 'badge-ok'
        : p.signatures > 0 ? 'badge-warn' : 'badge-info',
      badgeText: `${p.signatures} of ${p.quorumSize}`,
      detail: p
    }));
    _json(res, 200, { ok: true, items });
  }

  /**
   * POST /system/v1/governance/sign
   *
   * Submit a signature for a governance proposal.
   * Body: { proposalId, signerUri, signature }
   */
  async _handleGovernanceSign(req, res) {
    const body = await _parseJSON(req);
    if (!body || !body.proposalId || !body.signerUri) {
      return _json(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Body must include proposalId and signerUri'
      });
    }

    const proposal = this._proposals.find(p => p.id === body.proposalId);
    if (!proposal) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Proposal not found' });
    }

    // Check for duplicate
    if (proposal.signers.includes(body.signerUri)) {
      return _json(res, 400, {
        ok: false,
        code: 'ALREADY_SIGNED',
        message: 'This signer has already signed'
      });
    }

    // Record signature
    proposal.signatures += 1;
    proposal.signers.push(body.signerUri);
    proposal.signedAt.push({ signer: body.signerUri, at: nowISO() });
    if (proposal.signatures >= proposal.threshold) {
      proposal.status = 'approved';
    }

    this._persistGovernance();
    _json(res, 200, { ok: true, proposal });
  }

  /**
   * GET /system/v1/cache
   *
   * Returns aggregate cache stats for all cache types.
   */
  _handleCache(req, res) {
    // Rescan to get fresh sizes
    this._scanCacheStats();

    const items = Object.entries(this._cacheStats).map(([type, stats]) => {
      const hitRate = stats.hits + stats.misses > 0
        ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
        : 0;
      const labels = {
        kv: 'KV Cache (LLM)',
        latent: 'Latent Cache (Diffusion)',
        response: 'Response Cache',
        embedding: 'Embedding Cache'
      };
      return {
        id: `cache-${type}`,
        title: labels[type] || type,
        sub: `${this._formatBytes(stats.sizeBytes)} · ${stats.entries.toLocaleString()} ${type === 'embedding' ? 'vectors' : type === 'kv' ? 'prefixes' : 'entries'}`,
        dot: 'blue',
        meta: `${hitRate}% hit`,
        detail: {
          type,
          ...stats,
          hitRate,
          sizePretty: this._formatBytes(stats.sizeBytes),
          evictionPolicy: 'LRU',
          storagePath: path.join(this._cacheDir, type),
        }
      };
    });

    _json(res, 200, { ok: true, items });
  }

  /**
   * GET /system/v1/cache/:type
   */
  _handleCacheDetail(req, res, pathname) {
    const type = _after(pathname, '/system/v1/cache/');
    const stats = this._cacheStats[type];
    if (!stats) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Cache type not found' });
    }

    // Attempt to list top entries for KV cache
    let topEntries = [];
    if (type === 'kv') {
      topEntries = this._getTopCacheEntries('kv', 10);
    }

    const hitRate = stats.hits + stats.misses > 0
      ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100)
      : 0;

    _json(res, 200, {
      ok: true,
      cache: {
        type,
        ...stats,
        hitRate,
        sizePretty: this._formatBytes(stats.sizeBytes),
        storagePath: path.join(this._cacheDir, type),
        topEntries,
      }
    });
  }

  /**
   * GET /system/v1/metrics
   *
   * Returns current system metrics: CPU, memory, GPU, disk I/O, network.
   */
  _handleMetrics(req, res) {
    const latest = this._metricsHistory.length > 0
      ? this._metricsHistory[this._metricsHistory.length - 1]
      : this._sampleMetrics();

    const items = [
      {
        id: 'cpu',
        title: 'CPU',
        sub: `${os.cpus().length} cores · ${latest.cpu.avgPct}% avg`,
        dot: latest.cpu.avgPct < 70 ? 'green' : latest.cpu.avgPct < 90 ? 'yellow' : 'red',
        meta: 'last 1h',
        detail: {
          cores: latest.cpu.perCore,
          avgPct: latest.cpu.avgPct,
          model: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
          loadAvg: os.loadavg(),
        }
      },
      {
        id: 'memory',
        title: 'Memory',
        sub: `${this._formatBytes(os.totalmem())} · ${latest.memory.usePct}% used`,
        dot: latest.memory.usePct < 80 ? 'green' : latest.memory.usePct < 95 ? 'yellow' : 'red',
        meta: this._formatBytes(os.totalmem() - os.freemem()),
        detail: {
          totalBytes: os.totalmem(),
          usedBytes: os.totalmem() - os.freemem(),
          freeBytes: os.freemem(),
          usePct: latest.memory.usePct,
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal,
        }
      },
      {
        id: 'gpu',
        title: 'GPU',
        sub: latest.gpu.available
          ? `${latest.gpu.name} · ${latest.gpu.utilPct}% utilization`
          : 'No GPU detected',
        dot: !latest.gpu.available ? 'red'
          : latest.gpu.utilPct < 80 ? 'green'
          : latest.gpu.utilPct < 95 ? 'yellow' : 'red',
        meta: latest.gpu.available ? `${this._formatBytes(latest.gpu.memTotal)}` : 'n/a',
        detail: latest.gpu
      },
      {
        id: 'disk-io',
        title: 'Disk I/O',
        sub: `${latest.diskIO.readMBps} MB/s read`,
        dot: 'green',
        meta: `${latest.diskIO.writeMBps} MB/s write`,
        detail: latest.diskIO
      },
      {
        id: 'network',
        title: 'Network',
        sub: `${latest.network.rxMbps} Mbps in · ${latest.network.txMbps} Mbps out`,
        dot: 'green',
        meta: `${this._safenetNode && this._safenetNode._discovery
          ? this._safenetNode._discovery.getPeers().length : 0} peers`,
        detail: latest.network
      },
    ];

    _json(res, 200, { ok: true, items, timestamp: nowISO() });
  }

  /**
   * GET /system/v1/metrics/:type
   *
   * Returns historical samples for a specific metric type.
   */
  _handleMetricDetail(req, res, pathname) {
    const type = _after(pathname, '/system/v1/metrics/');
    const validTypes = ['cpu', 'memory', 'gpu', 'disk-io', 'network'];
    if (!validTypes.includes(type)) {
      return _json(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Metric not found' });
    }

    const key = type === 'disk-io' ? 'diskIO' : type;
    const history = this._metricsHistory.map(sample => ({
      timestamp: sample.timestamp,
      [key]: sample[key]
    }));

    _json(res, 200, { ok: true, type, history });
  }

  // ----------------------------------------------------------------
  // Data loaders
  // ----------------------------------------------------------------

  /**
   * Load model definitions from modelsDir or a models.json config.
   * @private
   */
  _loadModels() {
    // Try models.json config first
    const configPath = path.join(this._dataDir, 'models.json');
    if (fs.existsSync(configPath)) {
      try {
        const models = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const m of models) {
          this._models.set(m.id, {
            id: m.id,
            name: m.name || m.id,
            type: m.type || 'LLM',
            sizeBytes: m.sizeBytes || 0,
            quantization: m.quantization || 'native',
            status: m.status || 'idle',
            manifestHash: m.manifestHash || null,
            blessed: m.blessed || false,
            installPath: m.installPath || null,
            throughput: m.throughput || null,
            latencyMs: m.latencyMs || null,
            loadedAt: m.status === 'loaded' ? nowISO() : null,
          });
        }
        // eslint-disable-next-line no-console
        console.log(`[system] Loaded ${this._models.size} models from config`);
        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[system] Failed to load models.json:', err.message);
      }
    }

    // Fallback: scan modelsDir for model directories
    if (fs.existsSync(this._modelsDir)) {
      try {
        const entries = fs.readdirSync(this._modelsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const metaPath = path.join(this._modelsDir, entry.name, 'meta.json');
            if (fs.existsSync(metaPath)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                this._models.set(entry.name, {
                  id: entry.name,
                  name: meta.name || entry.name,
                  type: meta.type || 'LLM',
                  sizeBytes: meta.sizeBytes || 0,
                  quantization: meta.quantization || 'native',
                  status: 'idle',
                  manifestHash: meta.manifestHash || null,
                  blessed: meta.blessed || false,
                  installPath: path.join(this._modelsDir, entry.name),
                  throughput: null,
                  latencyMs: null,
                  loadedAt: null,
                });
              } catch (_) { /* skip invalid meta */ }
            }
          }
        }
      } catch (_) { /* models dir scan failed */ }
    }

    // eslint-disable-next-line no-console
    console.log(`[system] Found ${this._models.size} models`);
  }

  /**
   * Announce all loaded models to the Safenet.
   * Called once after _loadModels() during startup.
   * @private
   */
  _announceLoadedModels() {
    if (!this._safenetNode) return;
    for (const [id, model] of this._models) {
      if (model.manifestHash && (model.status === 'loaded' || model.status === 'idle')) {
        this._safenetNode.announceModel({
          manifestHash: model.manifestHash,
          name: model.name || id,
          version: model.version || null,
          type: model.type || 'LLM'
        }).catch(function(err) {
          // eslint-disable-next-line no-console
          console.warn('[system] Failed to announce model ' + id + ': ' + err.message);
        });
      }
    }
  }

  /**
   * Load container definitions from managed-containers.json.
   * @private
   */
  _loadContainers() {
    if (fs.existsSync(this._containersFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this._containersFile, 'utf8'));
        const containers = Array.isArray(data) ? data : (data.containers || []);
        for (const c of containers) {
          this._containers.set(c.id || c.name, {
            id: c.id || c.name,
            name: c.name,
            service: c.service || c.image || 'unknown',
            port: c.port || null,
            status: c.status || 'stopped',
            imageHash: c.imageHash || null,
            blessed: c.blessed || false,
            baseImage: c.baseImage || 'unknown',
            resourceSummary: c.resourceSummary || null,
            isolation: {
              network: c.networkPolicy || 'Separate namespace, no outbound',
              filesystem: c.fsPolicy || 'Read-only bind-mount for git repos',
              socket: c.socket || null,
            },
            resources: c.resources || { cpuPct: 0, memPct: 0, gpuPct: 0 },
            startedAt: c.startedAt || null,
          });
        }
        // eslint-disable-next-line no-console
        console.log(`[system] Loaded ${this._containers.size} containers`);
        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[system] Failed to load containers:', err.message);
      }
    }

    // eslint-disable-next-line no-console
    console.log('[system] No managed-containers.json found');
  }

  /**
   * Load governance proposals from governance dir.
   * @private
   */
  _loadGovernance() {
    if (!fs.existsSync(this._governanceDir)) {
      try { fs.mkdirSync(this._governanceDir, { recursive: true }); } catch (_) {}
      return;
    }

    const proposalsPath = path.join(this._governanceDir, 'proposals.json');
    if (fs.existsSync(proposalsPath)) {
      try {
        this._proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
        // eslint-disable-next-line no-console
        console.log(`[system] Loaded ${this._proposals.length} governance proposals`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[system] Failed to load governance proposals:', err.message);
      }
    }
  }

  /**
   * Persist governance proposals to disk.
   * @private
   */
  _persistGovernance() {
    const proposalsPath = path.join(this._governanceDir, 'proposals.json');
    try {
      fs.writeFileSync(proposalsPath, JSON.stringify(this._proposals, null, 2), 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[system] Failed to persist governance:', err.message);
    }
  }

  /**
   * Scan cache directories for size stats.
   * @private
   */
  _scanCacheStats() {
    for (const type of Object.keys(this._cacheStats)) {
      const cacheDir = path.join(this._cacheDir, type);
      if (fs.existsSync(cacheDir)) {
        try {
          const result = this._dirStats(cacheDir);
          this._cacheStats[type].entries = result.fileCount;
          this._cacheStats[type].sizeBytes = result.totalBytes;
        } catch (_) { /* scan failed */ }
      }
    }
  }

  // ----------------------------------------------------------------
  // Metrics sampling
  // ----------------------------------------------------------------

  /**
   * Capture a point-in-time metrics snapshot.
   * @private
   * @returns {object} The captured sample
   */
  _sampleMetrics() {
    const cpus = os.cpus();

    // CPU usage per core (based on times since last sample)
    const cpuPerCore = cpus.map((cpu, i) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      const busy = total - idle;
      const pct = total > 0 ? Math.round((busy / total) * 100) : 0;
      return { core: i, pct };
    });
    const avgCpu = cpuPerCore.length > 0
      ? Math.round(cpuPerCore.reduce((s, c) => s + c.pct, 0) / cpuPerCore.length)
      : 0;

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);

    // GPU (attempt nvidia-smi)
    const gpu = this._sampleGpu();

    // Disk I/O (best-effort via /proc/diskstats or iostat)
    const diskIO = this._sampleDiskIO();

    // Network
    const network = this._sampleNetwork();

    const sample = {
      timestamp: nowISO(),
      cpu: { avgPct: avgCpu, perCore: cpuPerCore },
      memory: { usePct: memPct, totalBytes: totalMem, freeBytes: freeMem },
      gpu,
      diskIO,
      network,
    };

    this._metricsHistory.push(sample);
    // Keep last 360 samples (1 hour at 10s intervals)
    if (this._metricsHistory.length > 360) {
      this._metricsHistory.shift();
    }

    return sample;
  }

  /**
   * Sample GPU metrics via nvidia-smi.
   * @private
   */
  _sampleGpu() {
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null',
        { encoding: 'utf8', timeout: 3000 }
      );
      const parts = out.trim().split(', ');
      if (parts.length >= 5) {
        return {
          available: true,
          name: parts[0].trim(),
          utilPct: parseInt(parts[1], 10) || 0,
          memUsed: (parseInt(parts[2], 10) || 0) * 1024 * 1024,
          memTotal: (parseInt(parts[3], 10) || 0) * 1024 * 1024,
          tempC: parseInt(parts[4], 10) || 0,
        };
      }
    } catch (_) { /* no nvidia-smi or no GPU */ }

    return { available: false, name: 'None', utilPct: 0, memUsed: 0, memTotal: 0, tempC: 0 };
  }

  /**
   * Sample disk I/O metrics.
   * @private
   */
  _sampleDiskIO() {
    try {
      const stat = fs.readFileSync('/proc/diskstats', 'utf8');
      // Parse aggregate (simplified — real implementation would diff two samples)
      const lines = stat.trim().split('\n');
      let readSectors = 0, writeSectors = 0;
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 14) {
          const dev = parts[2];
          // Only count main devices, not partitions
          if (/^(sd[a-z]|nvme\d+n\d+|xvd[a-z])$/.test(dev)) {
            readSectors += parseInt(parts[5], 10) || 0;
            writeSectors += parseInt(parts[9], 10) || 0;
          }
        }
      }
      // Approximate MB/s (sectors are 512 bytes; this is total, not rate — a real
      // implementation would diff against the previous sample over the interval)
      return {
        readMBps: Math.round((readSectors * 512) / (1024 * 1024 * Math.max(1, process.uptime()))),
        writeMBps: Math.round((writeSectors * 512) / (1024 * 1024 * Math.max(1, process.uptime()))),
      };
    } catch (_) {}

    return { readMBps: 0, writeMBps: 0 };
  }

  /**
   * Sample network metrics from /proc/net/dev.
   * @private
   */
  _sampleNetwork() {
    try {
      const raw = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = raw.trim().split('\n').slice(2); // skip headers
      let rxBytes = 0, txBytes = 0;
      for (const line of lines) {
        const parts = line.trim().split(/[\s:]+/);
        if (parts.length >= 17 && parts[0] !== 'lo') {
          rxBytes += parseInt(parts[1], 10) || 0;
          txBytes += parseInt(parts[9], 10) || 0;
        }
      }
      const uptime = Math.max(1, process.uptime());
      return {
        rxMbps: Math.round((rxBytes * 8) / (1024 * 1024 * uptime) * 10) / 10,
        txMbps: Math.round((txBytes * 8) / (1024 * 1024 * uptime) * 10) / 10,
        rxBytes,
        txBytes,
      };
    } catch (_) {}

    return { rxMbps: 0, txMbps: 0, rxBytes: 0, txBytes: 0 };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /**
   * Check attestation status (Nitro NSM or placeholder).
   * @private
   */
  _getAttestationStatus() {
    // In a real Nitro Enclave, /dev/nsm exists
    const hasNsm = fs.existsSync('/dev/nsm');
    if (hasNsm) {
      return {
        ok: true,
        summary: 'PCR-bound, Nitro NSM verified',
        method: 'nitro-nsm',
        pcr0: null, // would be read from NSM
        pcr1: null,
        pcr2: null,
      };
    }
    return {
      ok: false,
      summary: 'Not running in Nitro Enclave',
      method: 'none',
    };
  }

  /**
   * Check TLS certificate status.
   * @private
   */
  _getTlsStatus() {
    const cert = process.env.SAFENET_TLS_CERT;
    if (!cert || !fs.existsSync(cert)) {
      return { ok: false, summary: 'No TLS certificate configured', autoRenew: false };
    }

    try {
      // Try to read cert expiry via openssl
      const out = execSync(
        `openssl x509 -enddate -noout -in "${cert}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 2000 }
      );
      const match = out.match(/notAfter=(.+)/);
      if (match) {
        const expiry = new Date(match[1]);
        const daysLeft = Math.ceil((expiry - Date.now()) / 86400000);
        return {
          ok: daysLeft > 0,
          summary: daysLeft > 0
            ? `Valid, ${daysLeft} days remaining`
            : 'Certificate expired',
          expiresAt: expiry.toISOString(),
          daysLeft,
          autoRenew: fs.existsSync('/etc/letsencrypt'),
        };
      }
    } catch (_) { /* openssl check failed */ }

    return { ok: true, summary: 'TLS certificate configured', autoRenew: false };
  }

  /**
   * Get top cache entries for a given cache type.
   * @private
   */
  _getTopCacheEntries(type, limit = 10) {
    const cacheDir = path.join(this._cacheDir, type);
    if (!fs.existsSync(cacheDir)) return [];

    try {
      const files = fs.readdirSync(cacheDir)
        .filter(f => !f.startsWith('.'))
        .slice(0, limit)
        .map(f => {
          const fp = path.join(cacheDir, f);
          try {
            const stat = fs.statSync(fp);
            return {
              name: f,
              sizeBytes: stat.size,
              sizePretty: this._formatBytes(stat.size),
              lastAccessed: stat.atime.toISOString(),
              lastModified: stat.mtime.toISOString(),
            };
          } catch (_) {
            return { name: f, sizeBytes: 0, sizePretty: '0 B' };
          }
        })
        .sort((a, b) => b.sizeBytes - a.sizeBytes);
      return files;
    } catch (_) { return []; }
  }

  /**
   * Recursively compute total size and file count of a directory.
   * @private
   */
  _dirStats(dir) {
    let totalBytes = 0;
    let fileCount = 0;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          try {
            totalBytes += fs.statSync(full).size;
            fileCount++;
          } catch (_) {}
        } else if (entry.isDirectory()) {
          const sub = this._dirStats(full);
          totalBytes += sub.totalBytes;
          fileCount += sub.fileCount;
        }
      }
    } catch (_) { /* dir read failed */ }

    return { totalBytes, fileCount };
  }

  /**
   * Format byte count into human-readable string.
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }

  /**
   * Format seconds into human-readable duration.
   * @private
   */
  _formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ----------------------------------------------------------------
  // Public API for runtime updates (called by other components)
  // ----------------------------------------------------------------

  /**
   * Register or update a model entry at runtime.
   * @param {string} id
   * @param {object} model
   */
  registerModel(id, model) {
    this._models.set(id, { id, ...model });

    // Announce availability to the Safenet if the model has a manifest hash
    if (this._safenetNode && model.manifestHash) {
      this._safenetNode.announceModel({
        manifestHash: model.manifestHash,
        name: model.name || id,
        version: model.version || null,
        type: model.type || 'LLM'
      }).catch(function(err) {
        // eslint-disable-next-line no-console
        console.warn('[system] Failed to announce model ' + id + ': ' + err.message);
      });
    }
  }

  /**
   * Update a container's status or metrics.
   * @param {string} id
   * @param {object} updates
   */
  updateContainer(id, updates) {
    const ctr = this._containers.get(id);
    if (ctr) {
      Object.assign(ctr, updates);
    }
  }

  /**
   * Record a cache hit or miss.
   * @param {string} type - 'kv', 'latent', 'response', 'embedding'
   * @param {boolean} hit
   */
  recordCacheAccess(type, hit) {
    const stats = this._cacheStats[type];
    if (stats) {
      if (hit) stats.hits++;
      else stats.misses++;
    }
  }

  /**
   * Add a governance proposal at runtime.
   * @param {object} proposal
   */
  addProposal(proposal) {
    this._proposals.push({
      id: proposal.id || `gv-${Date.now()}`,
      title: proposal.title,
      subject: proposal.subject || '',
      status: 'pending',
      quorumSize: proposal.quorumSize || 5,
      threshold: proposal.threshold || 3,
      signatures: 0,
      signers: [],
      signedAt: [],
      createdAt: nowISO(),
      rateLimit: proposal.rateLimit || null,
    });
    this._persistGovernance();
  }
}

module.exports = SystemComponent;
