// common/attestation/verifyNameClaim.js
//
// Relying-party verifier for name_claim OCP claims. Given a signed
// name_claim and a set of trusted owner/governance public keys, checks:
//
//   1. Structural validity (domain format, safeboxId format)
//   2. Ed25519 signature by a trusted key
//   3. Expiry (nbf/exp window)
//   4. Optional: that the named safebox has a valid announce in the registry
//
// Used by the zone compiler to decide which name_claims to include in
// the compiled zone, and by the nameserver integration service.

'use strict';

const { checkNameClaim, DOMAIN_RE, SAFEBOX_ID_RE } = require('./ocpClaim');

/**
 * Verify a name_claim for inclusion in the zone.
 *
 * @param {object} claim - Signed OCP name_claim
 * @param {object} opts
 * @param {string[]} opts.trustedOwners - Array of Ed25519 public key hex
 *   strings that are authorised to issue name_claims. If empty, any
 *   valid signature is accepted (open model).
 * @param {number}  [opts.now] - Unix seconds; defaults to Date.now()/1000
 * @param {object}  [opts.announceIndex] - Map of safeboxId -> announce
 *   record. When provided, the claim is rejected if the primary
 *   safeboxId has no active announce (box is offline).
 * @returns {{ ok: boolean, reasons: string[], name?: string, safeboxId?: string, failoverSafeboxId?: string }}
 */
function verifyNameClaim(claim, opts = {}) {
    const { trustedOwners = [], now = Math.floor(Date.now() / 1000), announceIndex } = opts;
    const reasons = [];

    if (!claim || typeof claim !== 'object' || !claim.stm) {
        return { ok: false, reasons: ['claim is not a valid object'] };
    }

    const s = claim.stm;

    // 1. Type check
    if (s.type !== 'name_claim') {
        return { ok: false, reasons: ['stm.type is not name_claim'] };
    }

    // 2. Structural checks via checkNameClaim
    const structural = checkNameClaim(claim);
    if (!structural.ok) {
        return { ok: false, reasons: structural.reasons };
    }

    // 3. Expiry check
    if (Number.isInteger(claim.nbf) && now < claim.nbf) {
        reasons.push('name_claim is not yet valid (nbf in the future)');
    }
    if (Number.isInteger(claim.exp) && now > claim.exp) {
        reasons.push('name_claim has expired');
    }

    // 4. Trusted owner check
    if (trustedOwners.length > 0) {
        const signerKeys = claim.key || [];
        const isTrusted = signerKeys.some(k => trustedOwners.includes(k));
        if (!isTrusted) {
            reasons.push('name_claim is not signed by any trusted owner key');
        }
    }

    // 5. Optional: check that the safebox has an active announce
    if (announceIndex && s.safeboxId) {
        const announce = announceIndex[s.safeboxId] || announceIndex.get?.(s.safeboxId);
        if (!announce) {
            reasons.push(`primary safeboxId "${s.safeboxId}" has no active announce`);
        }
    }

    if (reasons.length > 0) {
        return { ok: false, reasons };
    }

    return {
        ok: true,
        reasons: [],
        name: s.name,
        safeboxId: s.safeboxId,
        failoverSafeboxId: s.failoverSafeboxId || null,
    };
}

module.exports = { verifyNameClaim };
