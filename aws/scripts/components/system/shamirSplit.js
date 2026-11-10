'use strict';

// Shamir Secret Sharing over GF(256) for governance recovery.
// Pure implementation, no dependencies beyond Node.js built-in crypto.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// GF(256) arithmetic using the AES irreducible polynomial 0x11B
// (x^8 + x^4 + x^3 + x + 1)
// ---------------------------------------------------------------------------

const GF_SIZE = 256;
const IRREDUCIBLE = 0x11B;

// Log and exp tables for fast multiplication/division.
// Generator is 3 (0x03), which has order 255 under the AES polynomial.
// (The element 2 has order 51 and does NOT generate the full group.)
// exp[log[a] + log[b]] = a * b, with indices mod 255.
const LOG = new Uint8Array(GF_SIZE);
const EXP = new Uint16Array(512); // 512 entries to avoid modular reduction in hot path

/**
 * Russian peasant multiplication in GF(256) — used to bootstrap the tables.
 */
function gfMulPeasant(a, b) {
  let result = 0;
  let aa = a;
  let bb = b;
  while (bb > 0) {
    if (bb & 1) result ^= aa;
    aa <<= 1;
    if (aa & 0x100) aa ^= IRREDUCIBLE;
    bb >>= 1;
  }
  return result & 0xFF;
}

(function buildTables() {
  // Build tables using generator 3.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = gfMulPeasant(x, 3);
  }
  // LOG[0] is undefined (log of 0 doesn't exist); we leave it as 0 and guard against it.
  // Extend EXP so that EXP[i] for i in [255, 509] wraps around, avoiding % 255 in hot paths.
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
})();

/**
 * Multiply two elements in GF(256) using log/exp tables.
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]]; // extended table avoids % 255
}

/**
 * Multiplicative inverse in GF(256) via log/exp tables.
 */
function gfInv(a) {
  if (a === 0) throw new Error('Cannot invert zero in GF(256)');
  return EXP[255 - LOG[a]];
}

/**
 * Division in GF(256): a / b = a * b^{-1}.
 */
function gfDiv(a, b) {
  if (b === 0) throw new Error('Division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]]; // extended table handles the wrap
}

/**
 * Exponentiation by squaring in GF(256).
 */
function gfPow(base, n) {
  if (n === 0) return 1;
  if (base === 0) return 0;
  let logResult = (LOG[base] * n) % 255;
  if (logResult < 0) logResult += 255;
  return EXP[logResult];
}

// ---------------------------------------------------------------------------
// Shamir Secret Sharing
// ---------------------------------------------------------------------------

/**
 * Evaluate a polynomial (coefficients in GF(256)) at point x.
 * coeffs[0] is the constant term (the secret byte).
 */
function evalPoly(coeffs, x) {
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ coeffs[i];
  }
  return result;
}

/**
 * Split a Buffer secret into n shares, any threshold of which can reconstruct it.
 *
 * @param {Buffer} secret — the secret to split (non-empty)
 * @param {number} n — number of shares to produce (2..255)
 * @param {number} threshold — minimum shares needed for reconstruction (2..n)
 * @returns {Array<{x: number, y: Buffer}>} — n shares, x values 1..n
 */
function split(secret, n, threshold) {
  if (!Buffer.isBuffer(secret) || secret.length === 0) {
    throw new Error('secret must be a non-empty Buffer');
  }
  if (typeof threshold !== 'number' || threshold < 2) {
    throw new Error('threshold must be >= 2');
  }
  if (typeof n !== 'number' || n < threshold) {
    throw new Error('n must be >= threshold');
  }
  if (n > 255) {
    throw new Error('n must be <= 255 (x values live in GF(256)\\{0})');
  }

  const secretLen = secret.length;
  const shares = [];
  for (let i = 0; i < n; i++) {
    shares.push({ x: i + 1, y: Buffer.alloc(secretLen) });
  }

  // For each byte of the secret, build a random polynomial of degree threshold-1
  // whose constant term is that byte, then evaluate at x = 1..n.
  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[byteIdx]; // constant term = secret byte
    const randomBytes = crypto.randomBytes(threshold - 1);
    for (let c = 1; c < threshold; c++) {
      coeffs[c] = randomBytes[c - 1];
    }

    for (let i = 0; i < n; i++) {
      shares[i].y[byteIdx] = evalPoly(coeffs, shares[i].x);
    }
  }

  return shares;
}

/**
 * Reconstruct the secret from threshold or more shares using Lagrange interpolation
 * in GF(256), evaluating the interpolation polynomial at x = 0.
 *
 * @param {Array<{x: number, y: Buffer}>} shares
 * @param {number} threshold — minimum shares needed
 * @returns {Buffer} — the reconstructed secret
 */
function reconstruct(shares, threshold) {
  if (!Array.isArray(shares) || shares.length < threshold) {
    throw new Error(`Need at least ${threshold} shares, got ${shares ? shares.length : 0}`);
  }

  // Use only the first threshold shares.
  const used = shares.slice(0, threshold);

  // Validate x uniqueness and range.
  const xs = new Set();
  for (const s of used) {
    if (s.x < 1 || s.x > 255) throw new Error(`Share x value ${s.x} out of range 1..255`);
    if (xs.has(s.x)) throw new Error(`Duplicate share x value: ${s.x}`);
    xs.add(s.x);
  }

  const secretLen = used[0].y.length;
  for (const s of used) {
    if (s.y.length !== secretLen) throw new Error('All shares must have the same y length');
  }

  const result = Buffer.alloc(secretLen);

  // Lagrange interpolation at x = 0 for each byte position.
  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    let value = 0;
    for (let i = 0; i < threshold; i++) {
      const xi = used[i].x;
      const yi = used[i].y[byteIdx];
      // Compute Lagrange basis polynomial L_i(0) = product_{j!=i} (0 - xj) / (xi - xj)
      //   = product_{j!=i} xj / (xi ^ xj)   [in GF(256), subtraction = XOR, negation = identity]
      let basis = 1;
      for (let j = 0; j < threshold; j++) {
        if (j === i) continue;
        const xj = used[j].x;
        basis = gfMul(basis, gfDiv(xj, xi ^ xj));
      }
      value ^= gfMul(yi, basis);
    }
    result[byteIdx] = value;
  }

  return result;
}

/**
 * Verify that a set of shares is consistent: every threshold-sized subset
 * reconstructs to the same secret.
 *
 * For efficiency, we reconstruct from the first threshold shares and then check
 * each remaining share against the polynomial defined by that subset.
 *
 * @param {Array<{x: number, y: Buffer}>} shares
 * @param {number} threshold
 * @returns {{ok: boolean, message?: string}}
 */
function verify(shares, threshold) {
  if (!Array.isArray(shares) || shares.length < threshold) {
    return { ok: false, message: `Need at least ${threshold} shares, got ${shares ? shares.length : 0}` };
  }

  try {
    const reference = reconstruct(shares.slice(0, threshold), threshold);

    // Check every other threshold-sized subset by reconstructing with each
    // remaining share swapped in for one of the base shares.
    for (let extra = threshold; extra < shares.length; extra++) {
      for (let swap = 0; swap < threshold; swap++) {
        const subset = shares.slice(0, threshold).map((s, i) => (i === swap ? shares[extra] : s));
        const rebuilt = reconstruct(subset, threshold);
        if (!rebuilt.equals(reference)) {
          return { ok: false, message: `Inconsistent reconstruction: share x=${shares[extra].x} disagrees when swapped for x=${shares[swap].x}` };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { split, reconstruct, verify, gfMul, gfMulPeasant, gfDiv, gfPow, gfInv };
