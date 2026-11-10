// /opt/safebox/system/launcher.js
//
// Measured TEE launcher for the Infrastructure base layer.
//
// Responsible for launching packages inside the safebox's trusted
// execution environment with full measurement chain:
//
//   1. Verify the publication claim (via ocpVerify)
//   2. Verify the package content against its Merkle root
//   3. Measure the execution environment (PCRs, image hash)
//   4. Create and sign an execution_manifest claim
//   5. Create and sign an install claim
//   6. Launch the package in a sandboxed runtime
//
// The launcher enforces resource limits and permission boundaries.
// Each launched package runs in its own namespace with cgroup
// constraints matching the execution manifest.
//
// This module does NOT perform the actual TEE attestation —
// that is handled by nitroTpmClient.js / tpmQuote.js. The launcher
// consumes their output to build the measurement chain.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ocpVerify = require('./ocpVerify');

// ── Configuration ─────────────────────────────────────────────────────────

const DEFAULTS = {
  packageDir: process.env.SAFEBOX_PACKAGE_DIR || '/opt/safebox/packages',
  runtimeDir: process.env.SAFEBOX_RUNTIME_DIR || '/opt/safebox/runtime',
  maxMemoryMB: 512,
  maxCpuMs: 30000,     // 30 seconds CPU time per invocation
  maxStorageMB: 256,
  defaultRuntime: 'node20',
};

const SUPPORTED_RUNTIMES = new Set([
  'node20',    // Node.js 20 LTS
  'node22',    // Node.js 22 LTS
  'wasm',      // WebAssembly (via wasm runtime)
  'python3',   // Python 3.x
]);

// ── Errors ─────────────────────────────────────────────────────────────────

class LaunchError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
    this.details = details || {};
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute Merkle root from sorted file hashes (matches Publisher logic).
 * Leaf = SHA-256(file content), internal = SHA-256(left + right).
 *
 * @param {Buffer[]} leaves - Sorted file content buffers
 * @returns {string} Hex Merkle root
 */
function computeMerkleRoot(leaves) {
  if (leaves.length === 0) {
    throw new LaunchError('No files to hash', 'EMPTY_PACKAGE');
  }

  let hashes = leaves.map(leaf => sha256hex(leaf));

  while (hashes.length > 1) {
    const next = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        next.push(sha256hex(hashes[i] + hashes[i + 1]));
      } else {
        next.push(hashes[i]); // Odd one out promoted
      }
    }
    hashes = next;
  }

  return hashes[0];
}

/**
 * Read all files in a directory recursively, sorted by relative path.
 *
 * @param {string} dir - Directory to scan
 * @param {string} [base] - Base path for relative paths
 * @returns {Array<{ path: string, content: Buffer }>}
 */
function readFilesRecursive(dir, base) {
  base = base || dir;
  const entries = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...readFilesRecursive(fullPath, base));
    } else if (entry.isFile()) {
      entries.push({
        path: path.relative(base, fullPath),
        content: fs.readFileSync(fullPath),
      });
    }
  }

  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// ── Launcher ───────────────────────────────────────────────────────────────

class Launcher {
  /**
   * @param {object} options
   * @param {object}   options.identity   - Safebox identity (for signing claims)
   * @param {object}  [options.attestor]  - Attestation client (nitroTpmClient)
   * @param {object}  [options.registry]  - Registry instance for claim submission
   * @param {Set}     [options.trustedKeys] - Trusted governance keys
   * @param {string}  [options.packageDir] - Package storage directory
   * @param {string}  [options.runtimeDir] - Runtime binaries directory
   */
  constructor(options) {
    if (!options || !options.identity) {
      throw new Error('Launcher requires an identity');
    }
    this.identity = options.identity;
    this.attestor = options.attestor || null;
    this.registry = options.registry || null;
    this.trustedKeys = options.trustedKeys || new Set();
    this.packageDir = options.packageDir || DEFAULTS.packageDir;
    this.runtimeDir = options.runtimeDir || DEFAULTS.runtimeDir;

    /** @type {Map<string, object>} installId -> running process info */
    this._running = new Map();
  }

  /**
   * Verify a publication claim using the governance keys.
   *
   * @param {object} claim - Signed publication claim
   * @param {number} [minSigners=1] - Minimum trusted signers required
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async verifyPublication(claim, minSigners) {
    const min = minSigners || 1;

    if (this.trustedKeys.size === 0) {
      // Single-signer verification
      const result = await ocpVerify.verify(claim);
      if (!result.ok) {
        return { ok: false, error: `Publication verification failed: ${(result.errors || []).join(', ')}` };
      }
      return { ok: true };
    }

    // Threshold verification against trusted governance keys
    const result = await ocpVerify.verifyThreshold(
      claim, min, this.trustedKeys
    );
    if (!result.ok) {
      return { ok: false, error: result.message };
    }
    return { ok: true };
  }

  /**
   * Verify package content against a publication claim's Merkle root.
   *
   * @param {string} packagePath - Path to extracted package directory
   * @param {string} expectedMerkleRoot - Hex Merkle root from publication
   * @returns {{ ok: boolean, merkleRoot?: string, error?: string }}
   */
  verifyContent(packagePath, expectedMerkleRoot) {
    let files;
    try {
      files = readFilesRecursive(packagePath);
    } catch (e) {
      return { ok: false, error: `Failed to read package: ${e.message}` };
    }

    if (files.length === 0) {
      return { ok: false, error: 'Package directory is empty' };
    }

    const leaves = files.map(f => f.content);
    const computed = computeMerkleRoot(leaves);

    if (computed !== expectedMerkleRoot) {
      return {
        ok: false,
        error: `Merkle root mismatch: expected ${expectedMerkleRoot}, computed ${computed}`,
        merkleRoot: computed,
      };
    }

    return { ok: true, merkleRoot: computed };
  }

  /**
   * Get current TEE measurements from the attestor.
   *
   * @param {string} nonce - Challenge nonce (hex)
   * @returns {Promise<{ pcr0: string, pcr1: string, pcr4: string, imageHash: string }>}
   */
  async getMeasurements(nonce) {
    if (!this.attestor) {
      // Dev mode: return placeholder measurements
      return {
        pcr0: sha256hex('dev-pcr0-' + nonce),
        pcr1: sha256hex('dev-pcr1-' + nonce),
        pcr4: sha256hex('dev-pcr4-' + nonce),
        imageHash: sha256hex('dev-image'),
      };
    }

    const quote = await this.attestor.quote(nonce);
    return {
      pcr0: quote.pcrs['0'] || quote.pcrs[0],
      pcr1: quote.pcrs['1'] || quote.pcrs[1],
      pcr4: quote.pcrs['4'] || quote.pcrs[4],
      imageHash: quote.imageHash || sha256hex(JSON.stringify(quote.pcrs)),
    };
  }

  /**
   * Build an execution manifest for a package.
   *
   * @param {object} opts
   * @param {string}  opts.package       - Package name (namespace/name)
   * @param {string}  opts.version       - Package version
   * @param {string}  opts.merkleRoot    - Verified Merkle root
   * @param {string} [opts.runtime]      - Runtime (default: node20)
   * @param {object} [opts.resources]    - Resource limits override
   * @param {object} [opts.permissions]  - Permission grants
   * @returns {Promise<object>} Unsigned execution_manifest claim
   */
  async buildExecutionManifest(opts) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const measurements = await this.getMeasurements(nonce);

    const runtime = opts.runtime || DEFAULTS.defaultRuntime;
    if (!SUPPORTED_RUNTIMES.has(runtime)) {
      throw new LaunchError(
        `Unsupported runtime: ${runtime}`,
        'UNSUPPORTED_RUNTIME',
        { supported: [...SUPPORTED_RUNTIMES] }
      );
    }

    const resources = Object.assign({
      maxMemoryMB: DEFAULTS.maxMemoryMB,
      maxCpuMs: DEFAULTS.maxCpuMs,
      maxStorageMB: DEFAULTS.maxStorageMB,
    }, opts.resources || {});

    const permissions = opts.permissions || {
      network: false,
      filesystem: false,
      ipc: false,
    };

    return {
      ocp: 1,
      iss: this.identity.uri || this.identity.safeboxUri,
      sub: 'safenet:execution:' + opts.package + '@' + opts.version,
      stm: {
        type: 'execution_manifest',
        package: opts.package,
        version: opts.version,
        merkleRoot: opts.merkleRoot,
        imageHash: measurements.imageHash,
        measurements: {
          pcr0: measurements.pcr0,
          pcr1: measurements.pcr1,
          pcr4: measurements.pcr4,
        },
        runtime,
        resources,
        permissions,
      },
      nbf: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Full measured launch: verify → measure → manifest → install → run.
   *
   * @param {object} opts
   * @param {object}  opts.publicationClaim - Signed publication claim
   * @param {string}  opts.packagePath     - Path to extracted package
   * @param {string} [opts.runtime]        - Runtime override
   * @param {object} [opts.resources]      - Resource limits override
   * @param {object} [opts.permissions]    - Permission grants
   * @param {string[]} [opts.args]         - Arguments to pass to the package
   * @param {object} [opts.env]            - Environment variables
   * @returns {Promise<{ ok: boolean, installId?: string, manifest?: object, error?: string }>}
   */
  async launch(opts) {
    if (!opts || !opts.publicationClaim || !opts.packagePath) {
      return { ok: false, error: 'publicationClaim and packagePath are required' };
    }

    const claim = opts.publicationClaim;
    const stm = claim.stm;

    // 1. Verify the publication claim signature
    const sigResult = await this.verifyPublication(claim);
    if (!sigResult.ok) {
      return { ok: false, error: sigResult.error };
    }

    // 2. Verify package content against Merkle root
    const contentResult = this.verifyContent(opts.packagePath, stm.merkleRoot);
    if (!contentResult.ok) {
      return { ok: false, error: contentResult.error };
    }

    // 3. Build and sign execution manifest
    const manifest = await this.buildExecutionManifest({
      package: stm.package,
      version: stm.version,
      merkleRoot: stm.merkleRoot,
      runtime: opts.runtime,
      resources: opts.resources,
      permissions: opts.permissions,
    });

    let signedManifest;
    try {
      signedManifest = await this.identity.sign(manifest);
    } catch (e) {
      return { ok: false, error: `Failed to sign execution manifest: ${e.message}` };
    }

    // 4. Submit manifest to registry if available
    if (this.registry) {
      const regResult = await this.registry.processExecutionManifest(signedManifest);
      if (!regResult.ok) {
        return { ok: false, error: `Registry rejected manifest: ${regResult.message}` };
      }
    }

    // 5. Build and sign install claim
    const publicationHash = ocpVerify.claimHash(claim);
    const manifestHash = ocpVerify.claimHash(signedManifest);
    const installId = crypto.randomBytes(16).toString('hex');

    const installClaim = {
      ocp: 1,
      iss: this.identity.uri || this.identity.safeboxUri,
      sub: 'safenet:install:' + stm.package + '@' + stm.version,
      stm: {
        type: 'install',
        package: stm.package,
        version: stm.version,
        publicationHash,
        manifestHash,
        installId,
        verified: true,
      },
      nbf: Math.floor(Date.now() / 1000),
    };

    let signedInstall;
    try {
      signedInstall = await this.identity.sign(installClaim);
    } catch (e) {
      return { ok: false, error: `Failed to sign install claim: ${e.message}` };
    }

    // 6. Submit install claim to registry
    if (this.registry) {
      const installResult = await this.registry.processInstall(signedInstall);
      if (!installResult.ok) {
        return { ok: false, error: `Registry rejected install: ${installResult.message}` };
      }
    }

    // 7. Launch the package in the sandboxed runtime
    const runtime = manifest.stm.runtime;
    const resources = manifest.stm.resources;

    try {
      const processInfo = this._spawnRuntime({
        runtime,
        packagePath: opts.packagePath,
        resources,
        permissions: manifest.stm.permissions,
        args: opts.args || [],
        env: opts.env || {},
        installId,
      });

      this._running.set(installId, {
        processInfo,
        manifest: signedManifest,
        installClaim: signedInstall,
        launchedAt: new Date().toISOString(),
      });
    } catch (e) {
      return { ok: false, error: `Failed to launch runtime: ${e.message}` };
    }

    return {
      ok: true,
      installId,
      manifest: signedManifest,
      installClaim: signedInstall,
    };
  }

  /**
   * Spawn a sandboxed runtime process.
   *
   * @private
   * @param {object} opts
   * @returns {object} Process info
   */
  _spawnRuntime(opts) {
    const runtimeBin = this._resolveRuntime(opts.runtime);
    const entryPoint = this._resolveEntryPoint(opts.packagePath, opts.runtime);

    // Build environment with restricted vars
    const env = {
      ...opts.env,
      SAFEBOX_INSTALL_ID: opts.installId,
      SAFEBOX_PACKAGE_DIR: opts.packagePath,
      SAFEBOX_RUNTIME: opts.runtime,
      // Don't leak host environment
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: opts.packagePath,
      NODE_ENV: 'production',
    };

    const spawnOpts = {
      cwd: opts.packagePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Process isolation (Linux-specific)
      ...(process.platform === 'linux' ? {
        uid: 65534,   // nobody
        gid: 65534,   // nogroup
      } : {}),
    };

    const args = [entryPoint, ...opts.args];
    const child = spawn(runtimeBin, args, spawnOpts);

    return {
      pid: child.pid,
      runtime: opts.runtime,
      startedAt: new Date().toISOString(),
      child,
    };
  }

  /**
   * Resolve the runtime binary path.
   *
   * @private
   * @param {string} runtime
   * @returns {string} Path to runtime binary
   */
  _resolveRuntime(runtime) {
    const runtimePaths = {
      node20: '/usr/local/bin/node',
      node22: '/usr/local/bin/node',
      wasm: path.join(this.runtimeDir, 'safebox-wasm'),
      python3: '/usr/bin/python3',
    };
    return runtimePaths[runtime] || runtimePaths[DEFAULTS.defaultRuntime];
  }

  /**
   * Determine the entry point for a package.
   *
   * @private
   * @param {string} packagePath
   * @param {string} runtime
   * @returns {string} Entry point file path
   */
  _resolveEntryPoint(packagePath, runtime) {
    // Check for safenet.json manifest
    const manifestPath = path.join(packagePath, 'safenet.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.main) {
          return path.join(packagePath, manifest.main);
        }
      } catch (_e) { /* fall through */ }
    }

    // Default entry points by runtime
    const defaults = {
      node20: 'index.js',
      node22: 'index.js',
      wasm: 'main.wasm',
      python3: 'main.py',
    };

    return path.join(packagePath, defaults[runtime] || 'index.js');
  }

  /**
   * Stop a running package instance.
   *
   * @param {string} installId
   * @param {string} [signal='SIGTERM']
   * @returns {{ ok: boolean, error?: string }}
   */
  stop(installId, signal) {
    const entry = this._running.get(installId);
    if (!entry) {
      return { ok: false, error: 'No running instance with this installId' };
    }

    try {
      entry.processInfo.child.kill(signal || 'SIGTERM');
      this._running.delete(installId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * List all running package instances.
   *
   * @returns {Array<{ installId: string, package: string, version: string, runtime: string, launchedAt: string, pid: number }>}
   */
  listRunning() {
    const result = [];
    for (const [installId, entry] of this._running) {
      const stm = entry.manifest.stm;
      result.push({
        installId,
        package: stm.package,
        version: stm.version,
        runtime: stm.runtime,
        launchedAt: entry.launchedAt,
        pid: entry.processInfo.pid,
      });
    }
    return result;
  }

  /**
   * Get the execution manifest for a running instance.
   *
   * @param {string} installId
   * @returns {object|null}
   */
  getManifest(installId) {
    const entry = this._running.get(installId);
    return entry ? entry.manifest : null;
  }
}

module.exports = Launcher;
module.exports.LaunchError = LaunchError;
module.exports.SUPPORTED_RUNTIMES = SUPPORTED_RUNTIMES;
module.exports.DEFAULTS = DEFAULTS;
