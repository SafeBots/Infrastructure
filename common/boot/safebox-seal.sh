#!/bin/bash
# safebox-seal.sh - TPM 2.0 sealing library for the safebox initramfs.
#
# NOTE on PCR 15 (the "phase complete" register): HARDENING-PLAN.md fixes the
# seal policy at sha256:0,2,4,7,8,9,14,15, and PCR 15 is in that list on
# purpose. Nothing in firmware, the bootloader, or the kernel touches PCR 15,
# so it is still at its reset value (all zeros) when the policy digest is
# computed at seal time (first boot) and again when the policy session is
# evaluated at unseal time (every later boot); both see the same value and
# the policy matches. Once the secrets are out of the TPM the unseal script
# calls sb_extend_phase_complete, which extends PCR 15 with
# sha256("safebox-sealed-phase-complete"). From that point the measured PCR
# set no longer equals the set the blobs were sealed under, so tpm2_unseal
# fails with TPM_RC_POLICY_FAIL for the rest of this boot: no later process,
# root included, can unseal the blobs again until the machine resets and
# PCR 15 returns to zero. The control plane's quote check reads PCR 15 too,
# so a quote taken before the phase closed is distinguishable from one taken
# after.
#
# This file is SOURCED by safebox-unseal.sh; it is not an executable. It wraps
# tpm2-tools 5.x so that the unseal script reads as a sequence of named steps
# an auditor can check against docs/HARDENING-PLAN.md ("PCR policy" and
# "Runtime paths").
#
# Design notes for the auditor:
#   - Every function returns non-zero on any failure. There is no "|| true"
#     anywhere in this file. The caller (safebox-unseal.sh) runs under
#     "set -euo pipefail" and treats any non-zero return as fatal, which is
#     what makes the boot fail closed.
#   - All transient material (session handles, context files, policy digests)
#     lives under /run/safebox/tpm/ (tmpfs) with umask 077 and is removed by
#     an EXIT trap. Nothing in this directory is ever written to a disk.
#   - The TPM is always addressed through the kernel resource manager
#     (/dev/tpmrm0) so that transient handles are virtualised per process and
#     a failed boot cannot leave the TPM's transient slots exhausted.
#   - The PCR selection is fixed by the contract: sha256:0,2,4,7,8,9,14,15.
#     PCR 15 is the "phase complete" register; extending it after the keys are
#     out of the TPM makes the sealing policy stop matching for the rest of
#     this boot, so no later process (root included) can unseal the blobs.

# Guard against double-sourcing: the trap below must be installed once.
if [ -n "${SB_SEAL_LIB_LOADED:-}" ]; then
    # shellcheck disable=SC2317
    return 0 2>/dev/null || exit 0
fi
SB_SEAL_LIB_LOADED=1

# Contract constants. Do not edit without updating HARDENING-PLAN.md.
SB_TPM_DEVICE="${SB_TPM_DEVICE:-/dev/tpmrm0}"
SB_PCR_SELECTION="sha256:0,2,4,7,8,9,14,15"
SB_PHASE_PCR=15
SB_PHASE_STRING="safebox-sealed-phase-complete"
SB_SEAL_ATTRS="fixedtpm|fixedparent|adminwithpolicy|noda"
SB_TPM_DIR="/run/safebox/tpm"

# Make every tpm2_* invocation use the resource manager, regardless of what
# the environment says. tpm2-tools honours TPM2TOOLS_TCTI.
export TPM2TOOLS_TCTI="device:${SB_TPM_DEVICE}"

# Primary object context file. Created by sb_tpm_primary; consumed by
# sb_seal and sb_unseal.
SB_PRIMARY_CTX="${SB_TPM_DIR}/primary.ctx"

sb_log() {
    # Progress goes to the kernel log so it is visible on the cloud serial
    # console capture even when journald has not started yet.
    local msg="safebox-seal: $*"
    if [ -w /dev/kmsg ]; then
        echo "$msg" > /dev/kmsg
    fi
    echo "$msg" >&2
}

sb_err() {
    sb_log "ERROR: $*"
    return 1
}

sb_cleanup() {
    # Flush any policy session we may have left open, then wipe the scratch
    # directory. Both are best-effort by nature (we are already exiting), but
    # neither is allowed to mask an earlier failure, so this runs only from
    # the trap and never as part of a function's return value.
    local f
    if [ -d "$SB_TPM_DIR" ]; then
        for f in "$SB_TPM_DIR"/*.session; do
            [ -e "$f" ] || continue
            tpm2_flushcontext "$f" >/dev/null 2>&1
        done
        # Transient objects loaded by tpm2_load/tpm2_createprimary are owned by
        # the resource manager and go away with the process, but flush
        # explicitly so a long-lived caller does not accumulate them.
        tpm2_flushcontext --transient-object >/dev/null 2>&1
        shred -u "$SB_TPM_DIR"/* >/dev/null 2>&1
        rm -rf "$SB_TPM_DIR"
    fi
}

sb_tpm_init() {
    # Prepare the scratch directory. Called implicitly by every public
    # function so the library has no required ordering beyond
    # sb_tpm_primary before sb_seal/sb_unseal.
    umask 077
    if [ ! -c "$SB_TPM_DEVICE" ]; then
        sb_err "TPM device $SB_TPM_DEVICE is not present; a safebox requires a vTPM" || return 1
    fi
    mkdir -p "$SB_TPM_DIR" || return 1
    chmod 0700 "$SB_TPM_DIR" || return 1
    # Install the EXIT trap only when the caller has none of its own: a bash
    # `trap` replaces, it does not chain, and safebox-unseal.sh already owns
    # the EXIT trap (it shreds keys and unmounts /boot) and calls sb_cleanup
    # from it. Overriding it would leave /boot mounted across switch-root and
    # plaintext keys in /run on a failed boot.
    if [ -z "${SB_SEAL_TRAP_SET:-}" ]; then
        if [ -z "$(trap -p EXIT)" ]; then
            trap sb_cleanup EXIT
        fi
        SB_SEAL_TRAP_SET=1
    fi
    return 0
}

sb_tpm_primary() {
    # Create a primary key under the owner hierarchy and save its context to
    # a file. The primary is deterministic for a given TPM and template (the
    # owner seed never changes unless the TPM is cleared), which is what lets
    # a later boot re-derive the same parent and load the sealed blobs. It is
    # NOT persisted (no tpm2_evictcontrol): persistence would let a later
    # root process find the parent by handle, and persisting adds nothing
    # because re-creation is cheap and deterministic.
    sb_tpm_init || return 1
    sb_log "creating owner-hierarchy primary"
    tpm2_createprimary \
        --hierarchy o \
        --key-algorithm ecc256 \
        --hash-algorithm sha256 \
        --key-context "$SB_PRIMARY_CTX" \
        >/dev/null || sb_err "tpm2_createprimary failed" || return 1
    return 0
}

sb_policy_create() {
    # Compute the PCR policy digest for the contract's PCR set and write it
    # to $1. A trial session is used: it computes the digest without binding
    # it to any object, so this is safe to run at any time. The digest is
    # what tpm2_create's -L binds the sealed object to.
    local out="${1:?usage: sb_policy_create <policy.digest out>}"
    local session="${SB_TPM_DIR}/policy-trial.session"
    sb_tpm_init || return 1
    sb_log "computing PCR policy over ${SB_PCR_SELECTION}"
    tpm2_startauthsession --session "$session" >/dev/null \
        || sb_err "tpm2_startauthsession (trial) failed" || return 1
    if ! tpm2_policypcr --session "$session" \
            --pcr-list "$SB_PCR_SELECTION" \
            --policy "$out" >/dev/null; then
        tpm2_flushcontext "$session" >/dev/null 2>&1
        sb_err "tpm2_policypcr (trial) failed" || return 1
    fi
    tpm2_flushcontext "$session" >/dev/null \
        || sb_err "tpm2_flushcontext (trial) failed" || return 1
    rm -f "$session"
    [ -s "$out" ] || sb_err "policy digest $out is empty" || return 1
    return 0
}

sb_seal() {
    # Seal the contents of $1 under the primary, bound to the policy in $4.
    # Outputs: $2 (public portion) and $3 (private portion, wrapped by the
    # TPM's parent key so it is opaque off this TPM).
    #
    # Attributes (contract): fixedtpm|fixedparent (cannot be duplicated to
    # another TPM or re-parented), adminwithpolicy (admin role requires the
    # policy, not a password), noda (no dictionary-attack lockout; the only
    # auth is the PCR policy, so lockout would just be a boot-time DoS
    # vector). "userwithauth" is deliberately absent so the empty password
    # cannot satisfy user-role auth; only the policy can.
    local plaintext="${1:?usage: sb_seal <plaintext> <out.pub> <out.priv> <policy.digest>}"
    local out_pub="${2:?missing out.pub}"
    local out_priv="${3:?missing out.priv}"
    local policy="${4:?missing policy.digest}"
    sb_tpm_init || return 1
    [ -s "$plaintext" ] || sb_err "sb_seal: plaintext $plaintext missing or empty" || return 1
    [ -s "$policy" ] || sb_err "sb_seal: policy digest $policy missing or empty" || return 1
    [ -s "$SB_PRIMARY_CTX" ] || sb_err "sb_seal: primary context not loaded; call sb_tpm_primary" || return 1
    sb_log "sealing $(basename "$plaintext")"
    tpm2_create \
        --parent-context "$SB_PRIMARY_CTX" \
        --hash-algorithm sha256 \
        --policy "$policy" \
        --attributes "$SB_SEAL_ATTRS" \
        --sealing-input "$plaintext" \
        --public "$out_pub" \
        --private "$out_priv" \
        >/dev/null || sb_err "tpm2_create (seal) failed for $plaintext" || return 1
    [ -s "$out_pub" ] && [ -s "$out_priv" ] \
        || sb_err "sb_seal: output blobs missing" || return 1
    return 0
}

sb_unseal() {
    # Load the sealed object ($1 public, $2 private) under the primary and
    # unseal it into $3 using a real (non-trial) policy session satisfied by
    # the current PCR values. If the PCRs differ from the ones the blob was
    # sealed under, tpm2_policypcr succeeds but tpm2_unseal fails with
    # TPM_RC_POLICY_FAIL; we report that as a clear policy mismatch so the
    # console shows why the box did not boot.
    local in_pub="${1:?usage: sb_unseal <in.pub> <in.priv> <out-file>}"
    local in_priv="${2:?missing in.priv}"
    local out="${3:?missing out-file}"
    local obj_ctx="${SB_TPM_DIR}/unseal-$$-${RANDOM}.ctx"
    local session="${SB_TPM_DIR}/policy-auth-$$-${RANDOM}.session"
    local rc
    sb_tpm_init || return 1
    [ -s "$in_pub" ] || sb_err "sb_unseal: $in_pub missing or empty" || return 1
    [ -s "$in_priv" ] || sb_err "sb_unseal: $in_priv missing or empty" || return 1
    [ -s "$SB_PRIMARY_CTX" ] || sb_err "sb_unseal: primary context not loaded; call sb_tpm_primary" || return 1

    sb_log "loading sealed object $(basename "$in_priv")"
    tpm2_load \
        --parent-context "$SB_PRIMARY_CTX" \
        --public "$in_pub" \
        --private "$in_priv" \
        --key-context "$obj_ctx" \
        >/dev/null || sb_err "tpm2_load failed for $in_priv (blob not from this TPM or corrupt)" || return 1

    tpm2_startauthsession --policy-session --session "$session" >/dev/null \
        || sb_err "tpm2_startauthsession (policy) failed" || return 1

    if ! tpm2_policypcr --session "$session" --pcr-list "$SB_PCR_SELECTION" >/dev/null; then
        tpm2_flushcontext "$session" >/dev/null 2>&1
        sb_err "tpm2_policypcr (policy session) failed" || return 1
    fi

    # Write the unsealed secret straight to the output path; never through a
    # pipe or a variable, so it does not land in shell history or argv.
    rc=0
    tpm2_unseal \
        --object-context "$obj_ctx" \
        --auth "session:${session}" \
        --output "$out" \
        >/dev/null 2>"${SB_TPM_DIR}/unseal.err" || rc=$?
    tpm2_flushcontext "$session" >/dev/null 2>&1
    rm -f "$session" "$obj_ctx"
    if [ "$rc" -ne 0 ]; then
        rm -f "$out"
        if grep -qi 'policy' "${SB_TPM_DIR}/unseal.err" 2>/dev/null; then
            sb_err "PCR POLICY MISMATCH: the measured boot (PCRs ${SB_PCR_SELECTION}) does not match the values this blob was sealed under. The kernel, initramfs, command line, root hash, firmware, or Secure Boot state has changed. Refusing to boot." || return 1
        fi
        sb_err "tpm2_unseal failed (rc=$rc): $(tr '\n' ' ' < "${SB_TPM_DIR}/unseal.err")" || return 1
    fi
    rm -f "${SB_TPM_DIR}/unseal.err"
    [ -s "$out" ] || sb_err "sb_unseal: produced empty output" || return 1
    chmod 0400 "$out" || return 1
    return 0
}

sb_extend_phase_complete() {
    # Extend PCR 15 with sha256("safebox-sealed-phase-complete"). PCR 15 is
    # part of SB_PCR_SELECTION and was zero when the policy was satisfied, so
    # this single extend is what locks the blobs for the rest of the boot
    # (see the NOTE at the top of this file). The
    # digest is computed at runtime from the literal string so there is no
    # hard-coded constant that could silently drift from the contract text.
    local digest
    sb_tpm_init || return 1
    digest="$(printf '%s' "$SB_PHASE_STRING" | sha256sum | cut -d' ' -f1)" || return 1
    [ "${#digest}" -eq 64 ] || sb_err "sha256sum produced unexpected output" || return 1
    sb_log "extending PCR ${SB_PHASE_PCR} to close the sealed phase"
    tpm2_pcrextend "${SB_PHASE_PCR}:sha256=${digest}" >/dev/null \
        || sb_err "tpm2_pcrextend PCR ${SB_PHASE_PCR} failed" || return 1
    return 0
}

sb_pcr_snapshot() {
    # Record the policy PCRs' current values to $1 in tpm2_pcrread's text
    # format. Stored alongside the blobs so an operator diagnosing a policy
    # mismatch can diff the sealed-time values against a fresh tpm2_pcrread.
    local out="${1:?usage: sb_pcr_snapshot <out-file>}"
    sb_tpm_init || return 1
    tpm2_pcrread "$SB_PCR_SELECTION" > "$out" \
        || sb_err "tpm2_pcrread failed" || return 1
    [ -s "$out" ] || sb_err "sb_pcr_snapshot: empty output" || return 1
    return 0
}
