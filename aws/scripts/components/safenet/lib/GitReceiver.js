'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveQ, sha256hex, nowISO, generateClaimHash } = require('./utils');
const Data = require(resolveQ('Q/Data'));

/**
 * @module GitReceiver
 *
 * Git Smart HTTP protocol server for receiving pushes and serving
 * fetches in the Safenet package registry.
 *
 * This is a simplified reference implementation. It spawns `git`
 * sub-processes for the heavy lifting and layers Safenet-specific
 * authentication (OCP claims) and post-receive publication logic
 * on top.
 *
 * Typical usage with Express or a raw HTTP server:
 *
 *   const receiver = new GitReceiver({ reposDir, identity, registry, publisher });
 *
 *   // GET /:ns/:pkg/info/refs?service=git-receive-pack
 *   app.get('/:ns/:pkg/info/refs', (req, res) => {
 *     receiver.handleInfoRefs(req, res, req.params.ns, req.params.pkg, req.query.service);
 *   });
 *
 *   // POST /:ns/:pkg/git-receive-pack
 *   app.post('/:ns/:pkg/git-receive-pack', (req, res) => {
 *     receiver.handleReceivePack(req, res, req.params.ns, req.params.pkg);
 *   });
 */

class GitReceiver {
  /**
   * Create a new GitReceiver.
   *
   * @param {object} options
   * @param {string} options.reposDir   - Directory where bare git repos are stored
   * @param {object} options.identity   - The Safebox's Identity instance for
   *   verifying author claims
   * @param {object} options.registry   - The Registry instance for checking
   *   namespace ownership
   * @param {object} options.publisher  - The Publisher instance for creating
   *   publication claims
   * @param {function} [options.onPublish] - Optional callback invoked with
   *   the publication claim after a successful publish
   */
  constructor(options) {
    if (!options) throw new Error('options are required');
    if (!options.reposDir) throw new Error('reposDir is required');
    if (!options.identity) throw new Error('identity is required');
    if (!options.registry) throw new Error('registry is required');
    if (!options.publisher) throw new Error('publisher is required');

    /** @private */
    this._reposDir = options.reposDir;
    /** @private */
    this._identity = options.identity;
    /** @private */
    this._registry = options.registry;
    /** @private */
    this._publisher = options.publisher;
    /** @private */
    this._onPublish = options.onPublish || null;
  }

  // ------------------------------------------------------------------
  // Public API - HTTP handlers
  // ------------------------------------------------------------------

  /**
   * Handle GET /info/refs?service=<service>.
   *
   * Responds with the git ref advertisement for either
   * `git-receive-pack` or `git-upload-pack`.
   *
   * @param {object} req - HTTP request (must be readable as a stream)
   * @param {object} res - HTTP response (must be writable)
   * @param {string} namespace   - Package namespace
   * @param {string} packageName - Package name
   * @param {string} service     - "git-receive-pack" or "git-upload-pack"
   */
  async handleInfoRefs(req, res, namespace, packageName, service) {
    if (service !== 'git-receive-pack' && service !== 'git-upload-pack') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid service: ' + service);
      return;
    }

    const repoPath = this.getRepoPath(namespace, packageName);

    // For upload-pack, repo must exist
    if (service === 'git-upload-pack') {
      if (!fs.existsSync(repoPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Repository not found');
        return;
      }
    } else {
      // For receive-pack, create the repo if needed
      try {
        await this.ensureRepo(namespace, packageName);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to initialize repository: ' + err.message);
        return;
      }
    }

    // Strip the "git-" prefix to get the bare command name
    const command = service.replace(/^git-/, '');

    res.writeHead(200, {
      'Content-Type': 'application/x-' + service + '-advertisement',
      'Cache-Control': 'no-cache'
    });

    // Write the service announcement pkt-line
    const announcement = '# service=' + service + '\n';
    const pktLine = _pktLine(announcement);
    res.write(pktLine);
    // Flush packet (0000)
    res.write('0000');

    const git = spawn('git', [command, '--stateless-rpc', '--advertise-refs', repoPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    git.stdout.pipe(res, { end: false });

    git.stderr.on('data', () => {
      // Discard stderr in normal operation
    });

    git.on('close', (code) => {
      if (code !== 0) {
        // If headers already sent, best effort -- just end
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
      }
      res.end();
    });

    git.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('git error: ' + err.message);
    });
  }

  /**
   * Handle POST /git-receive-pack.
   *
   * Authenticates the push via an OCP claim in the Authorization header,
   * verifies namespace ownership, receives the pack data, extracts and
   * validates the safenet.json manifest from HEAD, computes the content
   * Merkle root, creates a publication claim, and calls the onPublish
   * callback.
   *
   * @param {object} req - HTTP request (readable stream with headers)
   * @param {object} res - HTTP response (writable)
   * @param {string} namespace   - Package namespace
   * @param {string} packageName - Package name
   */
  async handleReceivePack(req, res, namespace, packageName) {
    // Step 1: Authenticate
    const auth = await this._authenticate(req);
    if (!auth.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Authentication failed: ' + (auth.errors || []).join('; '));
      return;
    }

    // Verify the author owns this namespace
    const ownerCheck = await this._registry.checkNamespaceOwner(namespace, auth.authorUri);
    if (!ownerCheck) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Author ' + auth.authorUri + ' does not own namespace ' + namespace);
      return;
    }

    // Step 2: Ensure bare repo exists
    let repoPath;
    try {
      repoPath = await this.ensureRepo(namespace, packageName);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to initialize repository: ' + err.message);
      return;
    }

    // Step 3: Pipe request body to git receive-pack
    res.writeHead(200, {
      'Content-Type': 'application/x-git-receive-pack-result',
      'Cache-Control': 'no-cache'
    });

    const git = spawn('git', ['receive-pack', '--stateless-rpc', repoPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Collect git output to send to the client after post-receive processing
    const outputChunks = [];
    git.stdout.on('data', (chunk) => {
      outputChunks.push(chunk);
    });

    git.stderr.on('data', () => {
      // Discard stderr in normal operation
    });

    // Pipe request body to git stdin
    req.pipe(git.stdin);

    const exitCode = await new Promise((resolve) => {
      git.on('close', resolve);
      git.on('error', () => resolve(1));
    });

    if (exitCode !== 0) {
      // Write whatever git produced and end
      for (const chunk of outputChunks) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    // Step 4: Post-receive hook logic
    try {
      const ref = 'HEAD';

      // 4a: Extract safenet.json manifest
      const manifest = await this._extractManifest(repoPath, ref);
      if (!manifest) {
        // Push succeeded but no manifest -- write git output and note the issue
        for (const chunk of outputChunks) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      // 4b: Validate manifest
      if (!manifest.name || !manifest.version) {
        for (const chunk of outputChunks) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      // 4c: List all files in the commit tree
      const files = await this._listFiles(repoPath, ref);

      // 4d: Compute Merkle root over file contents
      const fileHashes = files.map(f => sha256hex(f.content));
      const tree = Data.Merkle.build(fileHashes);
      const merkleRoot = tree.root;

      // 4e: Create publication claim via publisher
      const publicationClaim = await this._publisher.publish({
        namespace,
        package: namespace + '/' + packageName,
        version: manifest.version,
        merkleRoot,
        manifestHash: sha256hex(JSON.stringify(manifest)),
        languages: manifest.languages,
        license: manifest.license,
        contentSize: files.reduce((sum, f) => sum + f.content.length, 0),
        fileCount: files.length,
        dependencies: manifest.dependencies
      });

      // 4f: Call onPublish callback
      if (this._onPublish) {
        try {
          await this._onPublish(publicationClaim);
        } catch (_) {
          // Best-effort callback -- do not fail the push
        }
      }
    } catch (err) {
      // Post-receive errors are logged but do not fail the push response.
      // The git data has already been received.
    }

    // Step 5: Pipe git output to response
    for (const chunk of outputChunks) {
      res.write(chunk);
    }
    res.end();
  }

  /**
   * Handle POST /git-upload-pack.
   *
   * Simply pipes the request to `git upload-pack --stateless-rpc`
   * and streams the result back. No authentication is required for
   * fetches in this reference implementation.
   *
   * @param {object} req - HTTP request (readable stream)
   * @param {object} res - HTTP response (writable)
   * @param {string} namespace   - Package namespace
   * @param {string} packageName - Package name
   */
  async handleUploadPack(req, res, namespace, packageName) {
    const repoPath = this.getRepoPath(namespace, packageName);

    if (!fs.existsSync(repoPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Repository not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache'
    });

    const git = spawn('git', ['upload-pack', '--stateless-rpc', repoPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    req.pipe(git.stdin);
    git.stdout.pipe(res);

    git.stderr.on('data', () => {
      // Discard stderr
    });

    git.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('git error: ' + err.message);
    });
  }

  // ------------------------------------------------------------------
  // Public API - Repo management
  // ------------------------------------------------------------------

  /**
   * Ensure a bare git repository exists for the given package.
   * Creates one with `git init --bare` if it does not already exist.
   *
   * @param {string} namespace   - Package namespace
   * @param {string} packageName - Package name
   * @returns {Promise<string>} The absolute path to the bare repo.
   */
  async ensureRepo(namespace, packageName) {
    const repoPath = this.getRepoPath(namespace, packageName);

    if (fs.existsSync(repoPath)) {
      return repoPath;
    }

    // Create parent directory
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const git = spawn('git', ['init', '--bare', repoPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';
      git.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      git.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('git init --bare failed (exit ' + code + '): ' + stderr));
        } else {
          resolve(repoPath);
        }
      });

      git.on('error', (err) => {
        reject(new Error('Failed to spawn git: ' + err.message));
      });
    });
  }

  /**
   * Construct the filesystem path for a bare repo.
   *
   * @param {string} namespace   - Package namespace
   * @param {string} packageName - Package name
   * @returns {string} `<reposDir>/<namespace>/<packageName>.git`
   */
  getRepoPath(namespace, packageName) {
    return path.join(this._reposDir, namespace, packageName + '.git');
  }

  // ------------------------------------------------------------------
  // Internal methods
  // ------------------------------------------------------------------

  /**
   * Extract and verify an OCP claim from the Authorization header.
   *
   * Expects `Authorization: OCP <base64-encoded-claim-json>`.
   *
   * @private
   * @param {object} req - HTTP request with headers
   * @returns {Promise<{ ok: boolean, authorUri?: string, errors?: string[] }>}
   */
  async _authenticate(req) {
    const authHeader = req.headers && req.headers.authorization;
    if (!authHeader) {
      return { ok: false, errors: ['Missing Authorization header'] };
    }

    const parts = authHeader.split(' ');
    if (parts.length < 2 || parts[0] !== 'OCP') {
      return { ok: false, errors: ['Authorization must use OCP scheme'] };
    }

    let claim;
    try {
      const json = Buffer.from(parts[1], 'base64').toString('utf8');
      claim = JSON.parse(json);
    } catch (err) {
      return { ok: false, errors: ['Malformed OCP claim: ' + err.message] };
    }

    if (!claim.sig) {
      return { ok: false, errors: ['OCP claim is not signed'] };
    }

    // Verify signature using the identity module
    let verified;
    try {
      verified = await this._identity.verify(claim);
    } catch (err) {
      return { ok: false, errors: ['Signature verification failed: ' + err.message] };
    }

    if (!verified) {
      return { ok: false, errors: ['Invalid signature'] };
    }

    // Extract author URI from the claim issuer
    const authorUri = claim.iss;
    if (!authorUri) {
      return { ok: false, errors: ['Claim has no issuer (iss)'] };
    }

    return { ok: true, authorUri };
  }

  /**
   * Extract safenet.json from a ref in a bare repo.
   *
   * @private
   * @param {string} repoPath - Path to the bare git repo
   * @param {string} ref      - Git ref (e.g. "HEAD", "refs/heads/main")
   * @returns {Promise<object|null>} Parsed manifest, or null if not found.
   */
  async _extractManifest(repoPath, ref) {
    return new Promise((resolve) => {
      const git = spawn('git', ['show', ref + ':safenet.json'], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const chunks = [];
      git.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      git.on('close', (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(raw));
        } catch (_) {
          resolve(null);
        }
      });

      git.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * List all files in a commit tree and read their contents.
   *
   * Uses `git ls-tree -r --name-only <ref>` to enumerate paths, then
   * `git show <ref>:<path>` for each file to read its content as a
   * Buffer. This is intentionally simple for a reference implementation;
   * a production system would use `git archive` or batch reads.
   *
   * @private
   * @param {string} repoPath - Path to the bare git repo
   * @param {string} ref      - Git ref
   * @returns {Promise<Array<{ path: string, content: Buffer }>>}
   */
  async _listFiles(repoPath, ref) {
    // Get file list
    const fileList = await new Promise((resolve, reject) => {
      const git = spawn('git', ['ls-tree', '-r', '--name-only', ref], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const chunks = [];
      git.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      let stderr = '';
      git.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      git.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('git ls-tree failed (exit ' + code + '): ' + stderr));
          return;
        }
        const output = Buffer.concat(chunks).toString('utf8').trim();
        if (!output) {
          resolve([]);
          return;
        }
        resolve(output.split('\n'));
      });

      git.on('error', (err) => {
        reject(new Error('Failed to spawn git ls-tree: ' + err.message));
      });
    });

    // Read each file's content
    const files = [];
    for (const filePath of fileList) {
      const content = await _gitShowFile(repoPath, ref, filePath);
      files.push({ path: filePath, content });
    }

    return files;
  }
}

// --------------------------------------------------------------------
// Module-level helpers
// --------------------------------------------------------------------

/**
 * Format a string as a git pkt-line.
 *
 * Pkt-line format: 4-digit hex length (including the 4 length bytes
 * themselves) followed by the payload. For example, a 22-byte payload
 * becomes "001a" + payload (0x1a = 26 = 22 + 4).
 *
 * @private
 * @param {string} data - The payload string
 * @returns {string} Formatted pkt-line
 */
function _pktLine(data) {
  const len = data.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return hex + data;
}

/**
 * Read a single file from a bare repo at a given ref.
 *
 * @private
 * @param {string} repoPath - Path to the bare git repo
 * @param {string} ref      - Git ref
 * @param {string} filePath - Path within the repo tree
 * @returns {Promise<Buffer>} File content
 */
function _gitShowFile(repoPath, ref, filePath) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['show', ref + ':' + filePath], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const chunks = [];
    git.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    let stderr = '';
    git.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    git.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          'git show ' + ref + ':' + filePath +
          ' failed (exit ' + code + '): ' + stderr
        ));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    git.on('error', (err) => {
      reject(new Error('Failed to spawn git show: ' + err.message));
    });
  });
}

module.exports = GitReceiver;
