#!/usr/bin/env bash
#
# flush-and-snapshot.sh — take a CLEAN ZFS snapshot of a MariaDB dataset.
#
# The governed `zfs-snapshot` action (opsSystem.js) snapshots a dataset
# atomically, which for InnoDB gives a *crash-consistent* image: restorable,
# but InnoDB has to run recovery on first start. For the cross-Safebox ship
# path (zfs send | ssh | zfs receive, used INSTEAD of SQL replication) we want
# a *clean* image — no pending writes, no recovery needed on the far side.
#
# This wraps the snapshot in FLUSH TABLES WITH READ LOCK so InnoDB has flushed
# everything to the .ibd files before the snapshot point, then releases the
# lock immediately after the (atomic, millisecond) snapshot.
#
# Lock duration is typically 1-5 seconds — the flush, not the snapshot, is the
# cost. Reads continue; writes block for the lock window. Run it off-peak or on
# a read replica dataset if the write pause matters.
#
# Usage:
#   flush-and-snapshot.sh <dataset> <snapshotName>
#   flush-and-snapshot.sh safebox-pool/mariadb pre-migration-20260709
#
# Requires: local root MariaDB access via unix_socket auth (the default on the
# Safebox AMI — the root account authenticates by socket peer credential, no
# password on disk). ZFS snapshot goes through sudo against the tight allowlist.

set -euo pipefail

DATASET="${1:-}"
SNAPNAME="${2:-}"

if [[ -z "$DATASET" || -z "$SNAPNAME" ]]; then
    echo "usage: $0 <dataset> <snapshotName>" >&2
    echo "  e.g. $0 safebox-pool/mariadb pre-migration-$(date +%Y%m%d)" >&2
    exit 2
fi

# Validate shape here too (defense in depth — the sudoers allowlist also
# constrains this, but fail early with a clear message).
if [[ ! "$DATASET" =~ ^safebox-pool/[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$ ]]; then
    echo "ERROR: dataset must be under safebox-pool/ with safe characters" >&2
    exit 2
fi
if [[ ! "$SNAPNAME" =~ ^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$ ]]; then
    echo "ERROR: snapshotName must be 1-64 chars [A-Za-z0-9._-], not starting with a dot" >&2
    exit 2
fi

FULLSNAP="${DATASET}@${SNAPNAME}"

# MariaDB client. unix_socket auth means no credentials on disk.
MYSQL=(mysql -u root --protocol=socket)

# We hold the read lock across the snapshot using a SINGLE mysql session,
# because FLUSH TABLES WITH READ LOCK only holds for the life of the connection
# that issued it. A second `mysql -e "UNLOCK TABLES"` would be a DIFFERENT
# session and would NOT release the first session's lock — and the lock would
# release on its own when the first session exits, defeating the point.
#
# So: open one session, flush+lock, run the snapshot from a subshell WHILE the
# session is held open on a coprocess FD, then unlock in the same session.

cleanup_done=0
coproc DBLOCK { "${MYSQL[@]}" 2>&1; }
DB_IN=${DBLOCK[1]}
DB_OUT=${DBLOCK[0]}

release_lock() {
    if [[ "$cleanup_done" == 1 ]]; then return; fi
    cleanup_done=1
    # Best-effort UNLOCK + close the session cleanly.
    { echo "UNLOCK TABLES;"; echo "EXIT"; } >&"$DB_IN" 2>/dev/null || true
    # Give the session a moment to process, then ensure the coproc is gone.
    wait "$DBLOCK_PID" 2>/dev/null || true
}
trap 'release_lock' EXIT INT TERM

echo "[flush-and-snapshot] flushing tables with read lock on the running server…"
# Tighten durability for the flush window so the on-disk state is fully clean.
{
    echo "SET GLOBAL innodb_flush_log_at_trx_commit=1;"
    echo "SET GLOBAL sync_binlog=1;"
    echo "FLUSH TABLES WITH READ LOCK;"
    echo "SELECT 'LOCK_ACQUIRED' AS status;"
} >&"$DB_IN"

# Wait for the lock-acquired sentinel before snapshotting.
lock_ok=0
while IFS= read -r -t 30 line <&"$DB_OUT"; do
    if [[ "$line" == *LOCK_ACQUIRED* ]]; then lock_ok=1; break; fi
done
if [[ "$lock_ok" != 1 ]]; then
    echo "ERROR: did not observe LOCK_ACQUIRED within 30s; aborting without snapshot" >&2
    exit 1
fi

echo "[flush-and-snapshot] taking ZFS snapshot ${FULLSNAP} (atomic)…"
sudo /usr/sbin/zfs snapshot -- "$FULLSNAP"

echo "[flush-and-snapshot] releasing read lock…"
release_lock

echo "[flush-and-snapshot] done: ${FULLSNAP}"
echo "  Ship to another Safebox with:"
echo "    sudo zfs send ${FULLSNAP} | ssh <remote> 'sudo zfs receive ${DATASET}'"
