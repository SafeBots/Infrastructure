'use strict';

/**
 * imageDistribution.js — Image chunking and verification for Safecloud-style distribution.
 *
 * Splits a raw filesystem image into fixed-size chunks, computes SHA-256 CIDs,
 * builds an N-ary Merkle tree, and produces volume manifests compatible with
 * opsVolumes.js format.
 *
 * The Merkle tree structure:
 *   - Leaves are chunk CIDs (SHA-256 hex of chunk bytes)
 *   - Parents are SHA-256(child_cid_1 || child_cid_2 || ... || child_cid_N) where
 *     || is hex string concatenation
 *   - Root = the image identity = matches PCR0 for blessed images
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

/** Default chunk size: 1 MiB. Configurable per call. */
const CHUNK_SIZE = 1024 * 1024;

/** Default Merkle tree fan-out. */
const DEFAULT_FANOUT = 16;

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a Buffer.
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the parent CID from an array of child CID hex strings.
 * Parent = SHA-256 of the concatenated hex CIDs (no separator).
 */
function parentCid(childCids) {
  const concatenated = childCids.join('');
  return sha256(Buffer.from(concatenated, 'utf8'));
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Read a raw filesystem image and split it into fixed-size chunks.
 *
 * @param {string} imagePath   — absolute path to the image file
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=CHUNK_SIZE] — bytes per chunk
 * @param {number} [opts.fanout=16]            — Merkle tree fan-out
 * @returns {{ root: string, chunks: Array<{index: number, cid: string, offset: number, size: number}>, tree: object }}
 */
function chunkImage(imagePath, opts) {
  const chunkSize = (opts && opts.chunkSize) || CHUNK_SIZE;
  const fanout = (opts && opts.fanout) || DEFAULT_FANOUT;

  const fd = fs.openSync(imagePath, 'r');
  const stat = fs.fstatSync(fd);
  const totalSize = stat.size;

  const chunks = [];
  let offset = 0;
  let index = 0;

  while (offset < totalSize) {
    const remaining = totalSize - offset;
    const size = Math.min(chunkSize, remaining);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, offset);

    const cid = sha256(buf);
    chunks.push({ index, cid, offset, size });

    offset += size;
    index += 1;
  }

  fs.closeSync(fd);

  const tree = buildMerkleTree(chunks.map(function (c) { return c.cid; }), fanout);

  return { root: tree.root, chunks: chunks, tree: tree };
}

// ---------------------------------------------------------------------------
// Merkle tree construction
// ---------------------------------------------------------------------------

/**
 * Build an N-ary Merkle tree from an array of leaf CIDs.
 *
 * @param {string[]} leafCids — hex CID strings
 * @param {number}   fanout   — children per internal node
 * @returns {{ root: string, children: Array }}
 */
function buildMerkleTree(leafCids, fanout) {
  if (leafCids.length === 0) {
    return { root: sha256(Buffer.alloc(0)), children: [] };
  }

  // Wrap each leaf CID as a tree node (no children).
  var currentLevel = leafCids.map(function (cid) {
    return { root: cid, children: [] };
  });

  // Iteratively combine nodes until only one root remains.
  while (currentLevel.length > 1) {
    var nextLevel = [];

    for (var i = 0; i < currentLevel.length; i += fanout) {
      var group = currentLevel.slice(i, i + fanout);
      var childCids = group.map(function (node) { return node.root; });
      var pCid = parentCid(childCids);
      nextLevel.push({ root: pCid, children: group });
    }

    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a chunk's CID matches the SHA-256 of its bytes.
 *
 * @param {Buffer} chunkData    — raw chunk bytes
 * @param {string} expectedCid  — expected SHA-256 hex
 * @returns {{ ok: boolean, actual: string }}
 */
function verifyChunk(chunkData, expectedCid) {
  var actual = sha256(chunkData);
  return { ok: actual === expectedCid, actual: actual };
}

/**
 * Verify the Merkle tree is internally consistent:
 *   - Leaf CIDs match the provided chunk CIDs
 *   - Parent nodes are SHA-256 of concatenated child CIDs
 *
 * @param {{ root: string, children: Array }} tree   — the tree to verify
 * @param {Array<{ cid: string }>}            chunks — chunk metadata with CIDs
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyMerkleTree(tree, chunks) {
  var errors = [];
  var leafIndex = { value: 0 };

  function verify(node) {
    // Leaf node: no children — compare against chunk CID.
    if (!node.children || node.children.length === 0) {
      if (leafIndex.value >= chunks.length) {
        errors.push('Tree has more leaves than chunks');
        return;
      }
      var expected = chunks[leafIndex.value].cid;
      if (node.root !== expected) {
        errors.push(
          'Leaf ' + leafIndex.value + ': expected ' + expected + ', got ' + node.root
        );
      }
      leafIndex.value += 1;
      return;
    }

    // Internal node: recurse into children, then verify parent hash.
    for (var i = 0; i < node.children.length; i++) {
      verify(node.children[i]);
    }

    var childCids = node.children.map(function (c) { return c.root; });
    var expectedParent = parentCid(childCids);
    if (node.root !== expectedParent) {
      errors.push(
        'Internal node: expected ' + expectedParent + ', got ' + node.root
      );
    }
  }

  verify(tree);

  if (leafIndex.value !== chunks.length) {
    errors.push(
      'Leaf count mismatch: tree has ' + leafIndex.value + ' leaves, expected ' + chunks.length
    );
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

/**
 * Build a volume manifest for an image, compatible with opsVolumes.js format.
 *
 * Each chunk is listed as a separate source entry with type `safecloud:<root-cid>`.
 *
 * @param {string} imagePath  — path to the image file (used for metadata)
 * @param {string} imageHash  — the image root hash / PCR0
 * @returns {object} manifest object
 */
function buildManifest(imagePath, imageHash) {
  var result = chunkImage(imagePath);

  var sources = result.chunks.map(function (chunk) {
    return {
      type: 'safecloud:' + result.root,
      cid: chunk.cid,
      index: chunk.index,
      offset: chunk.offset,
      size: chunk.size
    };
  });

  return {
    version: 1,
    image: path.basename(imagePath),
    hash: imageHash,
    rootCid: result.root,
    totalChunks: result.chunks.length,
    chunkSize: CHUNK_SIZE,
    sources: sources,
    tree: result.tree,
    createdAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  chunkImage: chunkImage,
  verifyChunk: verifyChunk,
  verifyMerkleTree: verifyMerkleTree,
  buildManifest: buildManifest,
  CHUNK_SIZE: CHUNK_SIZE
};
