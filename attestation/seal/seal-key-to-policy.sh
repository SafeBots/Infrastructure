#!/usr/bin/env bash
# attestation/seal/seal-key-to-policy.sh   (refactor.md Phase 3.3)
#
# THE load-bearing subtlety of attestation-survives-updates (trust.html).
#
# Naive sealing binds a secret to a specific PCR value M1. Then any approved
# update to M2 makes the secret refuse to unseal — every update bricks key
# release. Wrong.
#
# Correct: seal to a SIGNED POLICY (TPM2 PolicyAuthorize), authorized by the
# M-of-N auditors' signing key. The secret then unseals under ANY measurement
# the auditors have signed — M1 OR M2 OR any future approved Mn — WITHOUT
# re-sealing on every update, while an UNAPPROVED measurement (tamper) still
# cannot unseal it.
#
#   seal(secret)  ->  "release iff the current measurement is accompanied by an
#                      M-of-N signature over that measurement"
#
# So an approved update flows: build -> measure (3.2) -> M-of-N bless (3.4) ->
# the box presents the new measurement + its blessing -> TPM PolicyAuthorize
# verifies the blessing against the auditors' public key -> secret unseals.
#
# This script wraps tpm2-tools' PolicyAuthorize construction. It MUST run on a
# machine with a TPM (the target confidential instance). It fails loudly
# without one rather than pretending — a fake seal is a security hole.
set -euo pipefail

AUDITOR_PUBKEY="${1:?usage: seal-key-to-policy.sh <auditor-authorizing-pubkey.pem> <secret-file> <sealed-out>}"
SECRET_FILE="${2:?missing secret file (e.g. the ZFS key)}"
SEALED_OUT="${3:?missing output path for the sealed blob}"

command -v tpm2_createpolicy >/dev/null 2>&1 || {
  echo "ERROR: tpm2-tools not found. This must run on the confidential instance" >&2
  echo "       with a TPM. Refusing to emit a fake sealed blob." >&2
  exit 1
}
[ -c /dev/tpmrm0 ] || [ -c /dev/tpm0 ] || {
  echo "ERROR: no TPM device (/dev/tpm0, /dev/tpmrm0)." >&2
  echo "       Measured-boot sealing requires a real (v)TPM." >&2
  exit 1
}

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# 1. Authorize policy: "any PCR policy that the auditor key has signed."
#    PolicyAuthorize makes the auditors' signing key the authority over WHICH
#    measurement policies are acceptable — the indirection that lets the
#    approved SET change without re-sealing.
tpm2_loadexternal -G rsa -C o \
  -u "$AUDITOR_PUBKEY" -c "$WORK/auth.ctx" -n "$WORK/auth.name"

tpm2_startauthsession -S "$WORK/session.dat"
tpm2_policyauthorize -S "$WORK/session.dat" \
  -L "$WORK/authorized.policy" \
  -n "$WORK/auth.name"
tpm2_flushcontext "$WORK/session.dat"

# 2. Seal the secret under the authorized policy.
tpm2_createprimary -C o -g sha256 -G ecc -c "$WORK/primary.ctx"
tpm2_create -C "$WORK/primary.ctx" \
  -u "$WORK/seal.pub" -r "$WORK/seal.priv" \
  -L "$WORK/authorized.policy" \
  -i "$SECRET_FILE"

# 3. Bundle the sealed object (pub+priv) for storage OFF the boot path.
tar -C "$WORK" -czf "$SEALED_OUT" seal.pub seal.priv authorized.policy
echo "Sealed secret to the M-of-N authorization policy -> $SEALED_OUT"
echo ""
echo "Unseal (at boot) will succeed iff the box presents a measurement whose"
echo "blessing verifies under the auditor key — i.e. an M-of-N-approved state."
echo "Approved updates (new measurement + new blessing) unseal WITHOUT re-seal."
