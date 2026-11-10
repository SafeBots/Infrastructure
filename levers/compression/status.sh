#!/bin/bash
#
# status.sh — report on both compression layers without changing anything.
#

set -u
LEVER_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══ Compression status ═══"
echo ""
"$LEVER_DIR/lever-zfs-compression.sh" status 2>/dev/null || echo "ZFS layer: lever script not runnable here"
echo ""
"$LEVER_DIR/lever-zstd-dict.sh" status 2>/dev/null || echo "zstd-dict layer: lever script not runnable here"
echo ""
echo "═══════════════════════════"
