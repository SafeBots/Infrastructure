#!/usr/bin/env bash
# object-backend.sh - cloud-agnostic COLD/large-tier storage (weights, backups).
#
# WHY THIS EXISTS: the hot/transactional tier is ZFS on a block device
# (cloud-agnostic already; only the device name differs per cloud). This script
# is the OTHER tier: write-once/read-many large blobs (model weights,
# ZFS-snapshot backups, archives) on object storage, so THAT data is
# cloud-agnostic too - S3, GCS, Azure Blob, OCI Object, or any S3-compatible
# endpoint, picked by one config value: safebox.storage.objectBackend.kind.
#
# TWO NON-NEGOTIABLES:
#   1. NOT under ZFS. We never mount this via goofys/s3fs and put a filesystem
#      on it. Object stores are eventually-consistent whole-object stores; a
#      transactional FS on top corrupts under load. We read/write OBJECTS only.
#   2. CLIENT-SIDE ENCRYPTED before upload. The object store only ever sees
#      ciphertext. We do NOT use provider SSE - that hands the key to the
#      operator and breaks at-rest sovereignty. Encryption uses the box's own
#      key, never the cloud's.
#
# Uses rclone: robust, supports every provider plus S3-compatible, with far
# better semantics than goofys - and we only ever do object put/get, never
# mount-and-write. rclone's crypt remote provides the client-side encryption so
# plaintext never leaves the box.
set -euo pipefail

KIND="${SAFEBOX_OBJ_KIND:?set from safebox.storage.objectBackend.kind}"
BUCKET="${SAFEBOX_OBJ_BUCKET:?bucket or container name}"
PREFIX="${SAFEBOX_OBJ_PREFIX:-safebox}"
ENDPOINT="${SAFEBOX_OBJ_ENDPOINT:-}"          # required for s3-compatible / non-AWS
# The client-side encryption key is box-held, NOT the cloud's. In production it
# derives from the same TPM-sealed material the ZFS key uses (unsealed only under
# a blessed measurement), so backups are readable only by a blessed box.
CRYPT_KEY="${SAFEBOX_OBJ_CRYPT_KEY:?client-side key, box-held, never the cloud}"

# ── M-OF-N GATE: this mapping must be auditor-blessed before we touch it ───────
# Turning on the backend relaxes egress; each destination mapping is approved by
# M-of-N auditors, verified fail-closed here. Skippable ONLY in the self-contained
# test harness via SAFEBOX_OBJ_SKIP_BLESS_CHECK=1 (never set in production).
if [ "${SAFEBOX_OBJ_SKIP_BLESS_CHECK:-0}" != "1" ]; then
  BLESSED_SET="${SAFEBOX_OBJ_BLESSED_SET:-/etc/safebox/blessed-storage-mappings.json}"
  TRUSTED_KEYS="${SAFEBOX_OBJ_TRUSTED_KEYS:-/etc/safebox/trusted-auditor-keys.json}"
  REQ="$(mktemp)"; trap 'rm -f "$REQ"' EXIT
  printf '{"kind":"%s","bucket":"%s","endpoint":%s,"prefix":"%s"}' \
    "$KIND" "$BUCKET" \
    "$([ -n "$ENDPOINT" ] && printf '"%s"' "$ENDPOINT" || printf 'null')" \
    "$PREFIX" > "$REQ"
  if ! python3 "$(dirname "$0")/../attestation/storage-mappings/verify-mapping.py" \
        --mapping "$REQ" --blessed-set "$BLESSED_SET" --trusted-keys "$TRUSTED_KEYS"; then
    echo "[object-backend] REFUSED: this storage mapping is not M-of-N auditor-blessed." >&2
    exit 3
  fi
fi

# Map our kind to an rclone backend type. One line is the whole "which cloud" switch.
case "$KIND" in
  s3|s3-compatible) RC_TYPE=s3 ;;
  gcs)              RC_TYPE=gcs ;;
  azure-blob)       RC_TYPE=azureblob ;;
  oci-object)       RC_TYPE=s3 ;;   # OCI Object Storage speaks S3-compatible
  *) echo "unknown object backend kind: $KIND" >&2; exit 2 ;;
esac

# Ephemeral rclone config: a base remote for the provider, wrapped in a crypt
# remote so everything written goes up encrypted with the box's key.
RC_CONF="$(mktemp)"; trap 'rm -f "$RC_CONF"' EXIT
{
  echo "[base]"
  echo "type = $RC_TYPE"
  [ -n "$ENDPOINT" ] && echo "endpoint = $ENDPOINT"
  echo ""
  echo "[secure]"
  echo "type = crypt"
  echo "remote = base:$BUCKET/$PREFIX"
  echo "password = $(rclone obscure "$CRYPT_KEY")"
} > "$RC_CONF"
RC=(rclone --config "$RC_CONF")

usage(){ echo "usage: object-backend.sh {put FILE NAME | get NAME FILE | list PREFIX | backup-zfs DATASET NAME}"; }

case "${1:-}" in
  put)   "${RC[@]}" copyto "$2" "secure:$3" ;;
  get)   "${RC[@]}" copyto "secure:$2" "$3" ;;
  list)  "${RC[@]}" ls "secure:${2:-}" ;;
  backup-zfs)
    # Store the ZFS snapshot STREAM as an encrypted object. This is the correct
    # ZFS-to-object pattern: never run ZFS on top of the object store.
    ds="${2:?dataset}"; name="${3:?backup name}"
    snap="${ds}@obj-${name}-$(date +%Y%m%d-%H%M%S)"
    zfs snapshot "$snap"
    zfs send "$snap" | "${RC[@]}" rcat "secure:backups/${name}.zfs-stream"
    echo "backed up $snap to secure:backups/${name}.zfs-stream, client-encrypted"
    ;;
  *) usage; exit 2 ;;
esac
