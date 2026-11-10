'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VOLUMES_DIR = process.env.SAFEBOX_VOLUMES_DIR || '/srv/safebox/volumes';
const STAGING_DIR = path.join(VOLUMES_DIR, '.staging');
// The volume registry is mutable runtime state and lives on the encrypted
// pool under the module's own subdirectory of /var/lib/safebox (the root
// filesystem is read-only; /etc is a non-persistent tmpfs overlay).
// SAFEBOX_SYSTEM_VOLUMES_STATE_DIR relocates the directory for tests.
const STATE_DIR = process.env.SAFEBOX_SYSTEM_VOLUMES_STATE_DIR || '/var/lib/safebox/volumes';
const REGISTRY_PATH = path.join(STATE_DIR, 'volume-registry.json');

const ALLOWED_VOLUME_TYPES = ['model', 'app', 'config', 'plugin', 'runner'];

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 30000;
const READ_TIMEOUT_MS = 300000; // 5 minutes for large files

// ---------------------------------------------------------------------------
// RFC 8785 Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Produce RFC 8785 (JCS) canonical JSON for a value.
 * Object keys are sorted by their UTF-16 code-unit ordering (which is what
 * Array.prototype.sort gives for strings in JS). Numbers use ES2015
 * serialization (JSON.stringify already does this). No whitespace.
 */
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalize(item));
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error('canonicalize: unsupported type ' + typeof value);
}

// ---------------------------------------------------------------------------
// Manifest hashing
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of the canonical JSON form of a manifest.
 * This hash is the volume's identity in the registry.
 */
function computeManifestHash(manifest) {
  const canonical = canonicalize(manifest);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Validate a manifest object. Throws on the first error found.
 * Checks structure, path safety (no traversal), sizes, hash formats, and type.
 */
function validateManifest(m) {
  if (!m || typeof m !== 'object') {
    throw new Error('Manifest must be a non-null object');
  }
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new Error('Manifest name must be a non-empty string');
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    throw new Error('Manifest version must be a non-empty string');
  }
  if (!ALLOWED_VOLUME_TYPES.includes(m.type)) {
    throw new Error('Manifest type must be one of: ' + ALLOWED_VOLUME_TYPES.join(', '));
  }
  if (typeof m.mountPath !== 'string' || !m.mountPath.startsWith('/')) {
    throw new Error('Manifest mountPath must be an absolute path');
  }
  if (typeof m.totalSizeBytes !== 'number' || m.totalSizeBytes < 0 || !Number.isFinite(m.totalSizeBytes)) {
    throw new Error('Manifest totalSizeBytes must be a non-negative finite number');
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new Error('Manifest files must be a non-empty array');
  }

  let computedTotal = 0;
  const seenPaths = new Set();

  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i];
    if (!f || typeof f !== 'object') {
      throw new Error('File entry ' + i + ' must be an object');
    }

    // Path validation
    if (typeof f.path !== 'string' || f.path.length === 0) {
      throw new Error('File ' + i + ': path must be a non-empty string');
    }
    if (f.path.startsWith('/') || f.path.startsWith('\\')) {
      throw new Error('File ' + i + ': path must be relative, not absolute');
    }
    const normalized = path.normalize(f.path);
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
      throw new Error('File ' + i + ': path traversal detected in "' + f.path + '"');
    }
    if (normalized.includes('\0')) {
      throw new Error('File ' + i + ': path contains null byte');
    }
    if (seenPaths.has(normalized)) {
      throw new Error('File ' + i + ': duplicate path "' + f.path + '"');
    }
    seenPaths.add(normalized);

    // Size validation
    if (typeof f.sizeBytes !== 'number' || f.sizeBytes < 0 || !Number.isFinite(f.sizeBytes)) {
      throw new Error('File ' + i + ': sizeBytes must be a non-negative finite number');
    }
    computedTotal += f.sizeBytes;

    // Hash validation
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(f.sha256)) {
      throw new Error('File ' + i + ': sha256 must be a 64-character hex string');
    }

    // Sources validation
    if (!Array.isArray(f.sources) || f.sources.length === 0) {
      throw new Error('File ' + i + ': sources must be a non-empty array');
    }
    for (let j = 0; j < f.sources.length; j++) {
      if (typeof f.sources[j] !== 'string') {
        throw new Error('File ' + i + ', source ' + j + ': must be a string');
      }
    }
  }

  if (computedTotal !== m.totalSizeBytes) {
    throw new Error(
      'totalSizeBytes (' + m.totalSizeBytes + ') does not match sum of file sizes (' + computedTotal + ')'
    );
  }

  // metadata is optional but must be an object if present
  if (m.metadata !== undefined && (typeof m.metadata !== 'object' || m.metadata === null || Array.isArray(m.metadata))) {
    throw new Error('Manifest metadata must be a plain object if provided');
  }

  return true;
}

// ---------------------------------------------------------------------------
// Registry management
// ---------------------------------------------------------------------------

function loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { volumes: {} };
    }
    throw err;
  }
}

function saveRegistry(registry) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o750 });
  const tmp = REGISTRY_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, REGISTRY_PATH);
}

// ---------------------------------------------------------------------------
// File download helpers
// ---------------------------------------------------------------------------

/**
 * Download a file from an HTTPS URL to a local path, following up to maxRedirects redirects.
 * Verifies file size against expectedSize. Returns a promise.
 */
function downloadHttps(url, destPath, expectedSize, redirectCount) {
  if (redirectCount === undefined) redirectCount = 0;

  return new Promise(function (resolve, reject) {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error('Too many redirects (>' + MAX_REDIRECTS + ') for ' + url));
    }

    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;

    const req = proto.get(url, { timeout: CONNECT_TIMEOUT_MS }, function (res) {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain the response
        const redirectUrl = new URL(res.headers.location, url).toString();
        return downloadHttps(redirectUrl, destPath, expectedSize, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
      }

      const dir = path.dirname(destPath);
      fs.mkdirSync(dir, { recursive: true });

      const partialPath = destPath + '.partial';
      const ws = fs.createWriteStream(partialPath);
      let received = 0;

      res.on('data', function (chunk) {
        received += chunk.length;
        if (received > expectedSize * 1.01 + 1024) {
          // Allow a tiny margin but reject clearly oversized downloads
          req.destroy();
          ws.destroy();
          reject(new Error('Download exceeds expected size for ' + url));
        }
      });

      res.pipe(ws);

      ws.on('finish', function () {
        if (received !== expectedSize) {
          try { fs.unlinkSync(partialPath); } catch (_e) { /* ignore */ }
          return reject(new Error(
            'Size mismatch for ' + url + ': expected ' + expectedSize + ', got ' + received
          ));
        }
        // Atomic rename from .partial to final path
        fs.renameSync(partialPath, destPath);
        resolve();
      });

      ws.on('error', function (err) {
        try { fs.unlinkSync(partialPath); } catch (_e) { /* ignore */ }
        reject(err);
      });
    });

    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Connect timeout for ' + url));
    });

    req.on('error', function (err) {
      reject(err);
    });

    // Set an overall read timeout
    req.setTimeout(READ_TIMEOUT_MS, function () {
      req.destroy();
      reject(new Error('Read timeout for ' + url));
    });
  });
}

/**
 * Copy a local file (file:///... source) to destPath.
 */
function copyLocalFile(sourceUrl, destPath, expectedSize) {
  return new Promise(function (resolve, reject) {
    const sourcePath = sourceUrl.replace(/^file:\/\//, '');
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      return reject(new Error('Local source not found: ' + sourcePath));
    }
    if (stat.size !== expectedSize) {
      return reject(new Error(
        'Size mismatch for local file ' + sourcePath + ': expected ' + expectedSize + ', got ' + stat.size
      ));
    }

    const partialPath = destPath + '.partial';
    const rs = fs.createReadStream(sourcePath);
    const ws = fs.createWriteStream(partialPath);

    rs.pipe(ws);
    ws.on('finish', function () {
      fs.renameSync(partialPath, destPath);
      resolve();
    });
    ws.on('error', function (err) {
      try { fs.unlinkSync(partialPath); } catch (_e) { /* ignore */ }
      reject(err);
    });
    rs.on('error', function (err) {
      try { fs.unlinkSync(partialPath); } catch (_e) { /* ignore */ }
      reject(err);
    });
  });
}

/**
 * Download a single file from one of its sources with fallback.
 * Tries each source in order until one succeeds.
 */
function downloadFileFromSources(sources, destPath, expectedSize) {
  let lastErr = null;
  let idx = 0;

  function tryNext() {
    if (idx >= sources.length) {
      return Promise.reject(lastErr || new Error('No sources available'));
    }
    const source = sources[idx];
    idx++;

    if (source.startsWith('safecloud:')) {
      console.log('  Safecloud source not yet implemented, skipping: ' + source);
      return tryNext();
    }
    if (source.startsWith('file://')) {
      return copyLocalFile(source, destPath, expectedSize).catch(function (err) {
        lastErr = err;
        console.log('  Source failed (' + source + '): ' + err.message);
        return tryNext();
      });
    }
    if (source.startsWith('https://') || source.startsWith('http://')) {
      return downloadHttps(source, destPath, expectedSize).catch(function (err) {
        lastErr = err;
        console.log('  Source failed (' + source + '): ' + err.message);
        return tryNext();
      });
    }

    console.log('  Unknown source scheme, skipping: ' + source);
    return tryNext();
  }

  return tryNext();
}

// ---------------------------------------------------------------------------
// SHA-256 file verification
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a file on disk.
 */
function hashFile(filePath) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('data', function (chunk) { hash.update(chunk); });
    rs.on('end', function () { resolve(hash.digest('hex')); });
    rs.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Volume install
// ---------------------------------------------------------------------------

/**
 * Install a volume: download files to a staging directory, verify each file's
 * SHA-256, then atomically move to the final mount path and register.
 */
async function installVolume(manifest, requestSources, ocpBlessingHash) {
  validateManifest(manifest);

  const manifestHash = computeManifestHash(manifest);
  const registry = loadRegistry();

  if (registry.volumes[manifestHash]) {
    return { status: 'already_installed', manifestHash: manifestHash };
  }

  const stagingPath = path.join(STAGING_DIR, manifestHash);
  const mountPath = manifest.mountPath;

  // Clean up any leftover staging
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
  fs.mkdirSync(stagingPath, { recursive: true });

  console.log('Installing volume ' + manifest.name + ' (' + manifestHash.slice(0, 12) + '...)');

  // Download each file
  for (let i = 0; i < manifest.files.length; i++) {
    const fileEntry = manifest.files[i];
    const destPath = path.join(stagingPath, fileEntry.path);
    console.log('  Downloading file ' + (i + 1) + '/' + manifest.files.length + ': ' + fileEntry.path);

    // Merge manifest sources with any request-level overrides
    const sources = fileEntry.sources.concat(requestSources || []);
    await downloadFileFromSources(sources, destPath, fileEntry.sizeBytes);

    // Verify SHA-256
    const actualHash = await hashFile(destPath);
    if (actualHash.toLowerCase() !== fileEntry.sha256.toLowerCase()) {
      // Clean up staging on verification failure
      try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
      throw new Error(
        'SHA-256 mismatch for ' + fileEntry.path +
        ': expected ' + fileEntry.sha256 + ', got ' + actualHash
      );
    }
    console.log('  Verified: ' + fileEntry.path);
  }

  // Move staging to mount path atomically
  fs.mkdirSync(path.dirname(mountPath), { recursive: true });
  // If mount path already exists (shouldn't, but be safe), remove it
  try {
    fs.rmSync(mountPath, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
  fs.renameSync(stagingPath, mountPath);

  // Update registry
  registry.volumes[manifestHash] = {
    type: manifest.type,
    name: manifest.name,
    mountPath: mountPath,
    installedAt: new Date().toISOString(),
    blessingClaimHash: ocpBlessingHash || null,
    files: manifest.files.length,
    totalBytes: manifest.totalSizeBytes
  };
  saveRegistry(registry);

  console.log('Volume ' + manifest.name + ' installed at ' + mountPath);
  return { status: 'installed', manifestHash: manifestHash, mountPath: mountPath };
}

// ---------------------------------------------------------------------------
// Volume verification
// ---------------------------------------------------------------------------

/**
 * Re-verify all files in an installed volume against their manifest hashes.
 */
async function verifyVolume(manifestHash, manifest) {
  validateManifest(manifest);

  const registry = loadRegistry();
  const entry = registry.volumes[manifestHash];
  if (!entry) {
    throw new Error('Volume not found in registry: ' + manifestHash);
  }

  const mountPath = entry.mountPath;
  const results = [];
  let allValid = true;

  for (let i = 0; i < manifest.files.length; i++) {
    const fileEntry = manifest.files[i];
    const filePath = path.join(mountPath, fileEntry.path);

    let status = 'ok';
    try {
      const stat = fs.statSync(filePath);
      if (stat.size !== fileEntry.sizeBytes) {
        status = 'size_mismatch';
        allValid = false;
      } else {
        const actualHash = await hashFile(filePath);
        if (actualHash.toLowerCase() !== fileEntry.sha256.toLowerCase()) {
          status = 'hash_mismatch';
          allValid = false;
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        status = 'missing';
      } else {
        status = 'error: ' + err.message;
      }
      allValid = false;
    }
    results.push({ path: fileEntry.path, status: status });
  }

  return { valid: allValid, files: results };
}

// ---------------------------------------------------------------------------
// Volume removal
// ---------------------------------------------------------------------------

/**
 * Remove an installed volume from disk and the registry.
 */
function removeVolume(manifestHash) {
  const registry = loadRegistry();
  const entry = registry.volumes[manifestHash];
  if (!entry) {
    throw new Error('Volume not found in registry: ' + manifestHash);
  }

  // Remove files from disk
  try {
    fs.rmSync(entry.mountPath, { recursive: true, force: true });
  } catch (err) {
    console.error('Warning: could not fully remove volume files at ' + entry.mountPath + ': ' + err.message);
  }

  // Remove from registry
  delete registry.volumes[manifestHash];
  saveRegistry(registry);

  return { status: 'removed', manifestHash: manifestHash };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Handle HTTP requests for volume operations.
 * @param {string} method - HTTP method (GET, POST)
 * @param {string} pathname - URL path
 * @param {object|null} body - Parsed request body for POST requests
 * @returns {Promise<{statusCode: number, body: object}>}
 */
async function handle(method, pathname, body) {
  try {
    // GET /volumes — list installed volumes
    if (method === 'GET' && pathname === '/volumes') {
      const registry = loadRegistry();
      return {
        statusCode: 200,
        body: {
          volumes: registry.volumes
        }
      };
    }

    // POST /volumes/install — install a new volume
    if (method === 'POST' && pathname === '/volumes/install') {
      if (!body || !body.manifest) {
        return { statusCode: 400, body: { error: 'Request body must include manifest' } };
      }

      try {
        validateManifest(body.manifest);
      } catch (err) {
        return { statusCode: 400, body: { error: 'Invalid manifest: ' + err.message } };
      }

      // The ocpBlessing field is expected to have been verified by the caller (server.js via governance gate) before reaching this handler.
      const blessingHash = body.ocpBlessing
        ? crypto.createHash('sha256').update(canonicalize(body.ocpBlessing)).digest('hex')
        : null;

      const result = await installVolume(body.manifest, body.sources || [], blessingHash);
      const statusCode = result.status === 'already_installed' ? 200 : 201;
      return { statusCode: statusCode, body: result };
    }

    // POST /volumes/verify — re-verify an installed volume
    if (method === 'POST' && pathname === '/volumes/verify') {
      if (!body || !body.manifestHash || !body.manifest) {
        return { statusCode: 400, body: { error: 'Request body must include manifestHash and manifest' } };
      }
      const result = await verifyVolume(body.manifestHash, body.manifest);
      return { statusCode: 200, body: result };
    }

    // POST /volumes/remove — remove a volume
    if (method === 'POST' && pathname === '/volumes/remove') {
      if (!body || !body.manifestHash) {
        return { statusCode: 400, body: { error: 'Request body must include manifestHash' } };
      }
      const result = removeVolume(body.manifestHash);
      return { statusCode: 200, body: result };
    }

    return { statusCode: 404, body: { error: 'Not found' } };
  } catch (err) {
    console.error('opsVolumes error:', err);
    return { statusCode: 500, body: { error: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handle: handle,
  canonicalize: canonicalize,
  computeManifestHash: computeManifestHash,
  validateManifest: validateManifest
};
