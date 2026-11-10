#!/bin/bash
set -euo pipefail

# Fork a MariaDB instance via ZFS clone
#
# Creates a fully independent MariaDB instance (instance B) from an atomic
# ZFS snapshot of the running instance (instance A).  The clone shares
# unchanged blocks via copy-on-write and diverges only where it writes.
#
# InnoDB requires the ENTIRE data directory — ibdata1, redo logs, undo logs,
# .ibd files, and the data dictionary — to be on a single ZFS dataset so the
# snapshot is atomic.  Per-database cloning is NOT safe with InnoDB.
#
# Sequence:
#   1. FLUSH TABLES WITH READ LOCK  (quiesce writes)
#   2. zfs snapshot                  (atomic, instant)
#   3. UNLOCK TABLES                 (resume writes)
#   4. zfs clone                     (copy-on-write)
#   5. Delete auto.cnf from clone    (forces new server UUID)
#   6. Generate my.cnf for instance B (different port/socket/server-id/datadir)
#   7. Start instance B              (InnoDB crash-recovery runs automatically)
#
# Usage:
#   ./fork-database.sh <fork-name> [options]
#
# Options:
#   --port PORT           TCP port for instance B  (default: 3307)
#   --socket PATH         Unix socket path         (default: /run/mysqld/mysqld-<fork>.sock)
#   --server-id ID        MariaDB server-id        (default: random 1000-99999)
#   --container NAME      Source MariaDB container  (default: safebox-mariadb)
#   --pool POOL           ZFS pool name            (default: $ZFS_POOL or zpool)
#   --dataset DATASET     Source datadir dataset    (default: POOL/mysql-data)
#   --start               Start instance B immediately via Docker
#   --docker-network NET  Docker network to attach  (default: safebox-net)

FORK_NAME="${1:-}"
PORT=3307
SOCKET=""
SERVER_ID=""
MYSQL_CONTAINER="safebox-mariadb"
POOL="${ZFS_POOL:-zpool}"
SOURCE_DATASET=""
START_NOW=false
DOCKER_NETWORK="safebox-net"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
error() { log "ERROR: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: fork-database.sh <fork-name> [options]

Create a CoW clone of the running MariaDB instance.

Options:
  --port PORT           TCP port for instance B  (default: 3307)
  --socket PATH         Unix socket              (default: /run/mysqld/mysqld-<fork>.sock)
  --server-id ID        server-id                (default: random)
  --container NAME      Source container          (default: safebox-mariadb)
  --pool POOL           ZFS pool                 (default: $ZFS_POOL or zpool)
  --dataset DATASET     Source datadir dataset    (default: POOL/mysql-data)
  --start               Start instance B in Docker immediately
  --docker-network NET  Docker network           (default: safebox-net)

Examples:
  ./fork-database.sh staging
  ./fork-database.sh test-branch --port 3308 --start
  ./fork-database.sh migration-dry-run --server-id 42 --start
EOF
    exit 1
}

# ── Parse args ───────────────────────────────────────────────────────────────

[ -z "$FORK_NAME" ] && usage

shift  # past fork-name
while [ $# -gt 0 ]; do
    case "$1" in
        --port)        PORT="$2";            shift 2 ;;
        --socket)      SOCKET="$2";          shift 2 ;;
        --server-id)   SERVER_ID="$2";       shift 2 ;;
        --container)   MYSQL_CONTAINER="$2"; shift 2 ;;
        --pool)        POOL="$2";            shift 2 ;;
        --dataset)     SOURCE_DATASET="$2";  shift 2 ;;
        --start)       START_NOW=true;       shift   ;;
        --docker-network) DOCKER_NETWORK="$2"; shift 2 ;;
        *)             error "Unknown option: $1" ;;
    esac
done

# Defaults that depend on parsed values
SOURCE_DATASET="${SOURCE_DATASET:-$POOL/mysql-data}"
SOCKET="${SOCKET:-/run/mysqld/mysqld-${FORK_NAME}.sock}"
SERVER_ID="${SERVER_ID:-$((RANDOM % 99000 + 1000))}"

SNAPSHOT_NAME="fork-${FORK_NAME}-${TIMESTAMP}"
CLONE_DATASET="${SOURCE_DATASET}-fork-${FORK_NAME}"
FORK_CONTAINER="safebox-mariadb-${FORK_NAME}"

# ── Preflight ────────────────────────────────────────────────────────────────

if [ "$EUID" -ne 0 ]; then
    error "This script must be run as root"
fi

if ! zfs list "$SOURCE_DATASET" &>/dev/null; then
    error "Source dataset not found: $SOURCE_DATASET"
fi

if zfs list "$CLONE_DATASET" &>/dev/null; then
    error "Clone dataset already exists: $CLONE_DATASET.  Destroy it first or pick another fork name."
fi

if ! docker inspect "$MYSQL_CONTAINER" &>/dev/null; then
    error "Source container not found: $MYSQL_CONTAINER"
fi

# Verify InnoDB log/undo dirs are inside the datadir (same ZFS dataset).
# If they point elsewhere, the snapshot won't be atomic.
INNODB_LOG_DIR=$(docker exec "$MYSQL_CONTAINER" \
    mysql -NB -e "SELECT @@innodb_log_group_home_dir" 2>/dev/null || echo "./")
INNODB_UNDO_DIR=$(docker exec "$MYSQL_CONTAINER" \
    mysql -NB -e "SELECT @@innodb_undo_directory" 2>/dev/null || echo "./")

warn_external_dir() {
    local label="$1" val="$2"
    # "./" or empty means inside datadir — fine
    if [ -n "$val" ] && [ "$val" != "./" ] && [ "$val" != "." ] && [ "$val" != "" ]; then
        log "WARNING: $label is '$val' — verify it lives on $SOURCE_DATASET or the snapshot may not be atomic."
    fi
}

warn_external_dir "innodb_log_group_home_dir" "$INNODB_LOG_DIR"
warn_external_dir "innodb_undo_directory"     "$INNODB_UNDO_DIR"

log "=== Forking MariaDB Instance ==="
log "Fork name:      $FORK_NAME"
log "Source dataset:  $SOURCE_DATASET"
log "Clone dataset:   $CLONE_DATASET"
log "Port:            $PORT"
log "Socket:          $SOCKET"
log "Server ID:       $SERVER_ID"

# ── Step 1: FLUSH TABLES WITH READ LOCK ──────────────────────────────────────
#
# We hold FTWRL through a background mysql session that sleeps while we take
# the snapshot.  A named pipe lets us confirm the lock is actually acquired
# before proceeding — no fragile `sleep 1`.

LOCK_FIFO=$(mktemp -u /tmp/fork-lock-XXXXXX)
mkfifo "$LOCK_FIFO"

log "Acquiring FLUSH TABLES WITH READ LOCK..."

(
    # The SELECT writes "LOCKED" into the fifo once the lock is held.
    # Then it sleeps long enough for the snapshot, and finally unlocks.
    docker exec -i "$MYSQL_CONTAINER" mysql -NB <<'EOSQL'
FLUSH TABLES WITH READ LOCK;
SELECT 'LOCKED';
SYSTEM sleep 30
UNLOCK TABLES;
EOSQL
) > "$LOCK_FIFO" &

LOCK_PID=$!

# Wait for "LOCKED" with a 60-second timeout (FTWRL can block on long queries).
LOCK_CONFIRMED=""
if read -t 60 LOCK_CONFIRMED < "$LOCK_FIFO"; then
    if [ "$LOCK_CONFIRMED" = "LOCKED" ]; then
        log "✓ Tables flushed and locked"
    else
        rm -f "$LOCK_FIFO"
        kill "$LOCK_PID" 2>/dev/null || true
        error "Unexpected response from FTWRL session: $LOCK_CONFIRMED"
    fi
else
    rm -f "$LOCK_FIFO"
    kill "$LOCK_PID" 2>/dev/null || true
    error "Timed out waiting for FLUSH TABLES WITH READ LOCK (60s). A long-running query may be blocking it."
fi

rm -f "$LOCK_FIFO"

# ── Step 2: ZFS Snapshot (while tables are locked) ───────────────────────────

log "Creating ZFS snapshot: $SOURCE_DATASET@$SNAPSHOT_NAME"
if ! zfs snapshot "$SOURCE_DATASET@$SNAPSHOT_NAME"; then
    kill "$LOCK_PID" 2>/dev/null || true
    error "Failed to create ZFS snapshot"
fi
log "✓ Snapshot created: $SOURCE_DATASET@$SNAPSHOT_NAME"

# ── Step 3: Release lock ────────────────────────────────────────────────────
# Kill the background session — the SYSTEM sleep will exit, releasing the lock.

kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true
log "✓ Tables unlocked"

# ── Step 4: ZFS Clone ───────────────────────────────────────────────────────

log "Creating ZFS clone: $CLONE_DATASET"
zfs clone "$SOURCE_DATASET@$SNAPSHOT_NAME" "$CLONE_DATASET"
log "✓ Clone created"

CLONE_MOUNTPOINT=$(zfs get -H -o value mountpoint "$CLONE_DATASET")
log "Clone mountpoint: $CLONE_MOUNTPOINT"

# ── Step 5: Delete auto.cnf (forces new server UUID) ────────────────────────

if [ -f "$CLONE_MOUNTPOINT/auto.cnf" ]; then
    rm -f "$CLONE_MOUNTPOINT/auto.cnf"
    log "✓ Deleted auto.cnf — MariaDB will generate a new server UUID on startup"
fi

# Also remove any leftover pid/socket files from the source
rm -f "$CLONE_MOUNTPOINT"/*.pid 2>/dev/null || true

# ── Step 6: Generate my.cnf for instance B ──────────────────────────────────

FORK_CONF_DIR="/etc/mysql/fork-${FORK_NAME}"
mkdir -p "$FORK_CONF_DIR"

cat > "$FORK_CONF_DIR/my.cnf" <<EOF
# Auto-generated config for MariaDB fork: $FORK_NAME
# Created: $(date -Is)
# Source snapshot: $SOURCE_DATASET@$SNAPSHOT_NAME

[mysqld]
datadir          = /var/lib/mysql
port             = $PORT
socket           = $SOCKET
server-id        = $SERVER_ID

# InnoDB will run crash-recovery automatically on first start.
# Redo/undo logs stay inside datadir (same ZFS dataset = atomic).
innodb_log_group_home_dir = /var/lib/mysql
innodb_undo_directory     = /var/lib/mysql

# Skip binary log replication from source (this is a fresh fork)
skip-slave-start = 1

# Unique tmpdir to avoid collisions with instance A
tmpdir           = /tmp/mysql-${FORK_NAME}

[client]
port             = $PORT
socket           = $SOCKET
EOF

log "✓ Config written: $FORK_CONF_DIR/my.cnf"

# ── Step 7: Start instance B (optional) ─────────────────────────────────────

if [ "$START_NOW" = true ]; then
    log "Starting instance B as Docker container: $FORK_CONTAINER"

    # Create tmpdir
    mkdir -p "/tmp/mysql-${FORK_NAME}"

    docker run -d \
        --name "$FORK_CONTAINER" \
        --network "$DOCKER_NETWORK" \
        -v "$CLONE_MOUNTPOINT:/var/lib/mysql" \
        -v "$FORK_CONF_DIR/my.cnf:/etc/mysql/conf.d/fork.cnf:ro" \
        -p "127.0.0.1:${PORT}:${PORT}" \
        -e MYSQL_SKIP_GRANT_TABLES="" \
        --restart unless-stopped \
        mariadb:11.2 \
        --port="$PORT"

    log "Waiting for InnoDB crash-recovery to complete..."

    # Poll until MariaDB is accepting connections (up to 120s)
    TRIES=0
    MAX_TRIES=60
    while [ $TRIES -lt $MAX_TRIES ]; do
        if docker exec "$FORK_CONTAINER" mysql --port="$PORT" -e "SELECT 1" &>/dev/null; then
            break
        fi
        sleep 2
        ((TRIES++))
    done

    if [ $TRIES -ge $MAX_TRIES ]; then
        log "WARNING: Instance B did not become ready within 120s. Check logs:"
        log "  docker logs $FORK_CONTAINER"
    else
        log "✓ Instance B is running and accepting connections"
        log ""

        # Show the new server UUID
        NEW_UUID=$(docker exec "$FORK_CONTAINER" mysql --port="$PORT" -NB \
            -e "SELECT @@server_uuid" 2>/dev/null || echo "(pending)")
        log "New server UUID: $NEW_UUID"
    fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

log ""
log "=== Fork Complete ==="
log "Snapshot:       $SOURCE_DATASET@$SNAPSHOT_NAME"
log "Clone dataset:  $CLONE_DATASET"
log "Clone mount:    $CLONE_MOUNTPOINT"
log "Config:         $FORK_CONF_DIR/my.cnf"
log "Port:           $PORT"
log "Server ID:      $SERVER_ID"

if [ "$START_NOW" = true ]; then
    log "Container:      $FORK_CONTAINER"
    log ""
    log "Connect:  mysql -h 127.0.0.1 -P $PORT"
else
    log ""
    log "To start instance B manually:"
    log "  docker run -d --name $FORK_CONTAINER \\"
    log "    --network $DOCKER_NETWORK \\"
    log "    -v $CLONE_MOUNTPOINT:/var/lib/mysql \\"
    log "    -v $FORK_CONF_DIR/my.cnf:/etc/mysql/conf.d/fork.cnf:ro \\"
    log "    -p 127.0.0.1:${PORT}:${PORT} \\"
    log "    mariadb:11.2 --port=$PORT"
fi

log ""
log "To destroy this fork:"
log "  docker stop $FORK_CONTAINER && docker rm $FORK_CONTAINER"
log "  zfs destroy $CLONE_DATASET"
log "  zfs destroy $SOURCE_DATASET@$SNAPSHOT_NAME"
log "  rm -rf $FORK_CONF_DIR"
