#!/usr/bin/env bash
# attestation/seal/unseal-zfs-key.sh   (refactor.md Phase 3.3 — boot-time)
#
# Boot-time counterpart of seal-key-to-policy.sh. Unseals the ZFS key from the
# TPM, but ONLY if the box's current measurement is accompanied by an M-of-N
# blessing that satisfies the PolicyAuthorize the key was sealed under. This is
# what ties key release to "running an M-of-N-approved state."
#
# Ships INSIDE the measured base (environment.etc in nixos/modules/zfs.nix), so
# the unseal logic itself is measured — it can't be swapped for a version that
# skips the policy check without changing M0 and failing attestation.
#
# Requires a real TPM. Fails closed: no valid policy satisfaction => no key =>
# encrypted data stays sealed. A safebox that can't prove an approved state
# simply does not get its data.
set -euo pipefail

SEALED_BLOB="${1:?sealed key blob (from seal-key-to-policy.sh)}"
BLESSING="${2:?current M-of-N blessing for this measurement}"
OUT_KEY="${3:?where to write the unsealed key}"

command -v tpm2_unseal >/dev/null 2>&1 || {
  echo "unseal: tpm2-tools not found (need a TPM host)." >&2; exit 1; }
[ -c /dev/tpmrm0 ] || [ -c /dev/tpm0 ] || {
  echo "unseal: no TPM device." >&2; exit 1; }
[ -f "$SEALED_BLOB" ] || { echo "unseal: sealed blob $SEALED_BLOB missing." >&2; exit 1; }
[ -f "$BLESSING" ]    || { echo "unseal: blessing $BLESSING missing — box has no" \
                               "approved-measurement proof to satisfy the policy." >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
tar -C "$WORK" -xzf "$SEALED_BLOB"   # seal.pub, seal.priv, authorized.policy

# 1. Reconstruct the authorized policy session from the CURRENT measurement +
#    the blessing (the auditors' signature over this measurement). PolicyAuthorize
#    checks the blessing's signature against the auditor key baked at seal time.
tpm2_createprimary -C o -g sha256 -G ecc -c "$WORK/primary.ctx" >/dev/null
tpm2_load -C "$WORK/primary.ctx" \
  -u "$WORK/seal.pub" -r "$WORK/seal.priv" -c "$WORK/seal.ctx" >/dev/null

tpm2_startauthsession --policy-session -S "$WORK/session.dat" >/dev/null
# Bind the session to the current PCRs (the measurement), then authorize it with
# the blessing so ANY auditor-signed measurement satisfies the same sealed key.
tpm2_policypcr -S "$WORK/session.dat" -l "sha384:4,7,12" >/dev/null 2>&1 || \
  tpm2_policypcr -S "$WORK/session.dat" -l "sha256:4,7,12" >/dev/null
# policyauthorize verifies the blessing (signed policy) against the sealed
# authorizing key; failure here = not an approved measurement = no unseal.
if ! tpm2_policyauthorize -S "$WORK/session.dat" \
       -i "$BLESSING" -n "$WORK/authorized.policy" >/dev/null 2>&1; then
  echo "unseal: PolicyAuthorize NOT satisfied — current measurement is not" >&2
  echo "        blessed by M-of-N. Key stays sealed." >&2
  exit 1
fi

# 2. Unseal under the satisfied policy session.
if ! tpm2_unseal -c "$WORK/seal.ctx" -p "session:$WORK/session.dat" -o "$OUT_KEY" 2>/dev/null; then
  echo "unseal: TPM refused to release the key under the presented policy." >&2
  exit 1
fi
chmod 0400 "$OUT_KEY"
echo "unseal: ZFS key released under M-of-N-approved measurement."
