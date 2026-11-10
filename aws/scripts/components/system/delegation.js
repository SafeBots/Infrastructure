'use strict';

/**
 * delegation.js — Delegation chain verification for cross-Safebox operations.
 *
 * A delegation is an OCP claim where the statement type is "delegation".
 * Delegations form chains: each claim's delegate becomes the next claim's
 * delegator. The first delegator must be a trusted root (known SPKI key).
 *
 * Chain verification produces an effective scope — the intersection of all
 * scopes in the chain. Operations are only allowed if they fall within the
 * effective scope.
 *
 * Uses ocpVerify.js for cryptographic signature verification.
 */

const crypto = require('crypto');
const ocpVerify = require('./ocpVerify');

/** Maximum delegation chain depth. Chains longer than this are rejected. */
const MAX_CHAIN_DEPTH = 5;

// ---------------------------------------------------------------------------
// Scope operations
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of two delegation scopes.
 *
 * - operations: set intersection of the two operation arrays
 * - maxBudget: per-currency minimum of the two budgets
 * - constraints: merged (intersection semantics — stricter wins)
 *
 * @param {object} scopeA
 * @param {object} scopeB
 * @returns {object} the restricted (intersected) scope
 */
function scopeIntersection(scopeA, scopeB) {
  if (!scopeA) return scopeB || { operations: [], maxBudget: {}, constraints: {} };
  if (!scopeB) return scopeA;

  // Operations: set intersection
  var opsA = new Set(scopeA.operations || []);
  var opsB = new Set(scopeB.operations || []);
  var operations = [];
  opsA.forEach(function (op) {
    if (opsB.has(op)) {
      operations.push(op);
    }
  });

  // Budget: per-currency minimum
  var budgetA = scopeA.maxBudget || {};
  var budgetB = scopeB.maxBudget || {};
  var allCurrencies = new Set(Object.keys(budgetA).concat(Object.keys(budgetB)));
  var maxBudget = {};
  allCurrencies.forEach(function (currency) {
    var a = budgetA[currency];
    var b = budgetB[currency];
    if (a !== undefined && b !== undefined) {
      maxBudget[currency] = Math.min(a, b);
    }
    // If only one scope mentions a currency, the other scope implicitly
    // does not grant it, so it is excluded from the intersection.
  });

  // Constraints: merge objects, stricter values win.
  var constraintsA = scopeA.constraints || {};
  var constraintsB = scopeB.constraints || {};
  var constraints = {};
  var allKeys = new Set(Object.keys(constraintsA).concat(Object.keys(constraintsB)));
  allKeys.forEach(function (key) {
    var a = constraintsA[key];
    var b = constraintsB[key];
    if (a !== undefined && b !== undefined) {
      // For numeric constraints, take the stricter (lower) value.
      // For boolean constraints, AND them.
      // For everything else, prefer the more restrictive (scopeB).
      if (typeof a === 'number' && typeof b === 'number') {
        constraints[key] = Math.min(a, b);
      } else if (typeof a === 'boolean' && typeof b === 'boolean') {
        constraints[key] = a && b;
      } else {
        constraints[key] = b;
      }
    } else {
      // Only present in one scope — include it (it is a restriction
      // the other scope didn't mention, so it applies).
      constraints[key] = a !== undefined ? a : b;
    }
  });

  return {
    operations: operations,
    maxBudget: maxBudget,
    constraints: constraints
  };
}

/**
 * Check whether an operation is allowed under the given effective scope.
 *
 * @param {object} effectiveScope — the intersected scope from a verified chain
 * @param {string} operation      — e.g. "LLM.chat", "embed"
 * @returns {boolean}
 */
function isOperationAllowed(effectiveScope, operation) {
  if (!effectiveScope || !effectiveScope.operations) return false;
  return effectiveScope.operations.indexOf(operation) !== -1;
}

// ---------------------------------------------------------------------------
// Single delegation verification
// ---------------------------------------------------------------------------

/**
 * Compute the SPKI hash used in safebox:// URIs.
 */
function spkiHash(publicKeyBase64) {
  return crypto.createHash('sha256').update(publicKeyBase64).digest('hex');
}

/**
 * Verify a single delegation claim.
 *
 * The delegator's key must be in trustedRoots (a Set of SPKI base64 keys)
 * or itself delegated from a trusted root (verified externally before calling).
 *
 * @param {object}      delegation   — the OCP claim object
 * @param {Set<string>} trustedRoots — Set of trusted SPKI base64 public keys
 * @returns {{ ok: boolean, delegator?: string, delegate?: string, scope?: object, code?: string, message?: string }}
 */
function verifyDelegation(delegation, trustedRoots) {
  // Structural checks
  if (!delegation || delegation.ocp !== 1) {
    return { ok: false, code: 'INVALID_FORMAT', message: 'Not a valid OCP v1 claim' };
  }

  var stm = delegation.stm;
  if (!stm || stm.type !== 'delegation') {
    return { ok: false, code: 'NOT_DELEGATION', message: 'Claim statement type is not "delegation"' };
  }

  if (!stm.delegator || !stm.delegate) {
    return { ok: false, code: 'MISSING_KEYS', message: 'Delegation must include delegator and delegate keys' };
  }

  if (!stm.scope) {
    return { ok: false, code: 'MISSING_SCOPE', message: 'Delegation must include a scope' };
  }

  // Check expiry
  var now = Math.floor(Date.now() / 1000);
  if (delegation.exp && delegation.exp < now) {
    return { ok: false, code: 'EXPIRED', message: 'Delegation has expired' };
  }
  if (delegation.nbf && delegation.nbf > now) {
    return { ok: false, code: 'NOT_YET_VALID', message: 'Delegation is not yet valid' };
  }

  // Check chain depth
  if (typeof stm.chainDepth === 'number' && stm.chainDepth > MAX_CHAIN_DEPTH) {
    return { ok: false, code: 'CHAIN_TOO_DEEP', message: 'Chain depth ' + stm.chainDepth + ' exceeds maximum ' + MAX_CHAIN_DEPTH };
  }

  // Verify the issuer matches the delegator
  var expectedIss = 'safebox://' + spkiHash(stm.delegator);
  if (delegation.iss !== expectedIss) {
    return { ok: false, code: 'ISSUER_MISMATCH', message: 'Issuer does not match delegator key hash' };
  }

  // Verify the delegator is trusted
  if (!trustedRoots.has(stm.delegator)) {
    return { ok: false, code: 'UNTRUSTED_DELEGATOR', message: 'Delegator key is not in the trusted roots set' };
  }

  // Verify the cryptographic signature using ocpVerify
  var sigResult = ocpVerify.verify(delegation);
  if (!sigResult.ok) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: 'OCP signature verification failed: ' + (sigResult.message || 'unknown error') };
  }

  return {
    ok: true,
    delegator: stm.delegator,
    delegate: stm.delegate,
    scope: stm.scope
  };
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

/**
 * Verify a delegation chain: an array of OCP claims where each stm.delegate
 * matches the next claim's stm.delegator (or signing key).
 *
 * The first delegator must be a trusted root. Effective scope is the
 * intersection of all scopes in the chain.
 *
 * @param {object[]}    chain        — array of OCP delegation claims, root-first
 * @param {Set<string>} trustedRoots — Set of trusted SPKI base64 public keys
 * @returns {{ ok: boolean, effectiveScope?: object, chainLength?: number, code?: string, message?: string }}
 */
function verifyChain(chain, trustedRoots) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, code: 'EMPTY_CHAIN', message: 'Delegation chain is empty' };
  }

  if (chain.length > MAX_CHAIN_DEPTH) {
    return { ok: false, code: 'CHAIN_TOO_DEEP', message: 'Chain length ' + chain.length + ' exceeds maximum ' + MAX_CHAIN_DEPTH };
  }

  // Verify the first link: delegator must be a trusted root.
  var firstResult = verifyDelegation(chain[0], trustedRoots);
  if (!firstResult.ok) {
    return { ok: false, code: firstResult.code, message: 'Link 0: ' + firstResult.message };
  }

  var effectiveScope = chain[0].stm.scope;

  // Verify each subsequent link in the chain.
  for (var i = 1; i < chain.length; i++) {
    var prev = chain[i - 1];
    var curr = chain[i];

    // The previous delegate must be the current delegator.
    if (prev.stm.delegate !== curr.stm.delegator) {
      return {
        ok: false,
        code: 'CHAIN_BREAK',
        message: 'Link ' + i + ': delegate of link ' + (i - 1) + ' does not match delegator of link ' + i
      };
    }

    // For links after the first, the delegator is trusted because the
    // previous link's delegate (which we just verified) vouches for it.
    // Build a temporary trusted set containing the previous delegate.
    var linkTrusted = new Set([prev.stm.delegate]);
    var linkResult = verifyDelegation(curr, linkTrusted);
    if (!linkResult.ok) {
      return { ok: false, code: linkResult.code, message: 'Link ' + i + ': ' + linkResult.message };
    }

    // Narrow the effective scope at each link.
    effectiveScope = scopeIntersection(effectiveScope, curr.stm.scope);
  }

  return {
    ok: true,
    effectiveScope: effectiveScope,
    chainLength: chain.length
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  verifyDelegation: verifyDelegation,
  verifyChain: verifyChain,
  scopeIntersection: scopeIntersection,
  isOperationAllowed: isOperationAllowed,
  MAX_CHAIN_DEPTH: MAX_CHAIN_DEPTH
};
