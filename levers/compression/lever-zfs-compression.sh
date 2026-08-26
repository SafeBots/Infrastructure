#!/bin/bash
#
# lever-zfs-compression.sh — Layer 1 compression lever
#
# Switches the MariaDB data dataset to zstd-3 compression. Idempotent.
# New writes are compressed; existing data is not rewritten until InnoDB
# touches the page (or you run a manual rewrite).
#
# Usage:
#   sudo ./lever-zfs-compression.sh apply              # set zstd-3
#   sudo ./lever-zfs-compression.sh apply --dataset=POOL/db
#   sudo ./lever-zfs-compression.sh apply --level=zstd-6
#   sudo ./lever-zfs-compression.sh apply --dry-run    # preview only
#   sudo ./lever-zfs-compression.sh revert             # back to lz4 (default)
#   sudo ./lever-zfs-compression.sh status             # report current state
#

set -euo pipefail

DATASET_DEFAULT="safebox/mariadb"
LEVEL_DEFAULT="zstd-3"
REVERT_LEVEL="lz4"

DATASET="$DATASET_DEFAULT"
LEVEL="$LEVEL_DEFAULT"
DRY_RUN=0
ACTION=""

# ─── arg parsing ───────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        apply|revert|status)        ACTION="$arg" ;;
        --dataset=*)                DATASET="${arg#*=}" ;;
        --level=*)                  LEVEL="${arg#*=}" ;;
        --dry-run)                  DRY_RUN=1 ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 2 ;;
    esac
done

if [ -z "$ACTION" ]; then
    echo "Specify one of: apply | revert | status" >&2
    echo "Run with --help for usage." >&2
    exit 2
fi

# ─── checks ────────────────────────────────────────────────────────
require_zfs() {
    if ! command -v zfs > /dev/null 2>&1; then
        echo "zfs command not found. This lever requires ZFS." >&2
        exit 1
    fi
}

require_dataset() {
    if ! zfs list -H -o name "$DATASET" > /dev/null 2>&1; then
        echo "ZFS dataset not found: $DATASET" >&2
        echo "Override with --dataset=POOL/path" >&2
        exit 1
    fi
}

# ─── actions ───────────────────────────────────────────────────────
do_status() {
    require_zfs
    require_dataset
    local current ratio used logicalused
    current=$(zfs get -H -o value compression "$DATASET")
    ratio=$(zfs get -H -o value compressratio "$DATASET")
    used=$(zfs get -H -o value used "$DATASET")
    logicalused=$(zfs get -H -o value logicalused "$DATASET")
    printf "Dataset:           %s\n" "$DATASET"
    printf "Compression mode:  %s\n" "$current"
    printf "Compress ratio:    %s\n" "$ratio"
    printf "Used on disk:      %s\n" "$used"
    printf "Logical (uncompr): %s\n" "$logicalused"
}

do_apply() {
    require_zfs
    require_dataset
    local current
    current=$(zfs get -H -o value compression "$DATASET")
    if [ "$current" = "$LEVEL" ]; then
        echo "Already set: $DATASET compression=$LEVEL — nothing to do."
        exit 0
    fi
    echo "Plan: set compression=$LEVEL on $DATASET (was: $current)"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] no changes made"
        exit 0
    fi
    zfs set compression="$LEVEL" "$DATASET"
    echo "Set compression=$LEVEL on $DATASET"
    echo ""
    echo "Note: existing pages are not rewritten. New writes will be compressed."
    echo "To force-rewrite a portion, run InnoDB OPTIMIZE TABLE on the target tables,"
    echo "or use 'zfs send -R | zfs recv' to a sibling dataset and swap."
    echo ""
    do_status
}

do_revert() {
    LEVEL="$REVERT_LEVEL"
    do_apply
}

case "$ACTION" in
    apply)  do_apply ;;
    revert) do_revert ;;
    status) do_status ;;
esac
