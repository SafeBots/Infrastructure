#!/bin/bash
#
# lever-zstd-dict.sh — Layer 2 compression lever (installer)
#
# Installs everything needed for zstd-dictionary compression of
# streams_message.instructions:
#
#   1. libzstd development headers (system package)
#   2. php-zstd extension (via pecl) — for the Qbix Db hook
#   3. Builds and installs the MariaDB UDF — for SQL-level decompression
#   4. Creates the dictionary directory and sets ownership
#   5. Stages the Qbix hook file in /opt/safebox/hooks/
#
# Does NOT train a dictionary. That's a userland step.
# See ./qbix/README.md for the training flow.
#
# Usage:
#   sudo ./lever-zstd-dict.sh apply
#   sudo ./lever-zstd-dict.sh apply --dry-run
#   sudo ./lever-zstd-dict.sh revert        # uninstall UDF, leave package installed
#   sudo ./lever-zstd-dict.sh status
#

set -euo pipefail

DICT_DIR="${SAFEBOX_DICT_DIR:-/safebox/dicts}"
HOOK_DIR="${SAFEBOX_HOOK_DIR:-/opt/safebox/hooks}"
UDF_PLUGIN_DIR=""    # detected below
MARIADB_USER="${MARIADB_USER:-root}"

ACTION=""
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        apply|revert|status)   ACTION="$arg" ;;
        --dry-run)             DRY_RUN=1 ;;
        --dict-dir=*)          DICT_DIR="${arg#*=}" ;;
        --hook-dir=*)          HOOK_DIR="${arg#*=}" ;;
        --help|-h)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ -z "$ACTION" ]; then
    echo "Specify one of: apply | revert | status" >&2; exit 2
fi

LEVER_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── detection helpers ────────────────────────────────────────────
detect_distro() {
    if   [ -f /etc/debian_version ]; then echo debian
    elif [ -f /etc/redhat-release ]; then echo rhel
    elif [ -f /etc/amazon-linux-release ] || grep -qi 'amazon linux' /etc/os-release 2>/dev/null; then echo amazon
    elif [ -f /etc/alpine-release ]; then echo alpine
    else echo unknown
    fi
}

detect_mariadb_plugin_dir() {
    # Ask the running server first
    if command -v mariadb > /dev/null 2>&1; then
        local d
        d=$(mariadb -u"$MARIADB_USER" -BNe "SELECT @@plugin_dir" 2>/dev/null || true)
        if [ -n "$d" ] && [ -d "$d" ]; then echo "$d"; return; fi
    fi
    # Fallback: check common locations
    for d in /usr/lib/mysql/plugin /usr/lib64/mysql/plugin /usr/lib/mariadb/plugin /usr/lib64/mariadb/plugin; do
        if [ -d "$d" ]; then echo "$d"; return; fi
    done
    echo ""
}

detect_php_ini_dir() {
    if command -v php > /dev/null 2>&1; then
        php -i 2>/dev/null | awk -F'=> ' '/^Scan this dir for additional .ini/ {print $2}' | tr -d ' '
    fi
}

# ─── install steps ────────────────────────────────────────────────
install_libzstd() {
    local distro="$1"
    echo "[1/5] Installing libzstd headers and build deps for $distro..."
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would install libzstd-dev, build tools"; return; fi
    case "$distro" in
        debian)
            apt-get update -qq
            apt-get install -y libzstd-dev libmariadb-dev php-pear php-dev build-essential zstd
            ;;
        rhel|amazon)
            dnf install -y libzstd-devel mariadb-devel php-devel php-pear gcc make zstd \
                || yum install -y libzstd-devel mariadb-devel php-devel php-pear gcc make zstd
            ;;
        alpine)
            apk add --no-cache zstd-dev mariadb-dev php-dev php-pear build-base zstd
            ;;
        *)
            echo "Unknown distro. Install manually: libzstd-dev, mariadb-dev, php-dev, php-pear, build-essential, zstd CLI." >&2
            exit 1 ;;
    esac
}

install_php_zstd() {
    echo "[2/5] Installing php-zstd extension..."
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would pecl install zstd"; return; fi
    if php -m 2>/dev/null | grep -qi '^zstd$'; then
        echo "  php-zstd already loaded."
        return
    fi
    pecl install zstd || {
        echo "pecl install failed. Try: pecl install -f zstd" >&2; exit 1; }

    local ini_dir
    ini_dir=$(detect_php_ini_dir)
    if [ -n "$ini_dir" ] && [ -d "$ini_dir" ]; then
        echo "extension=zstd.so" > "$ini_dir/zstd.ini"
        echo "  enabled in $ini_dir/zstd.ini"
    else
        echo "  WARN: could not find PHP ini scan dir. Add 'extension=zstd.so' manually." >&2
    fi
}

build_udf() {
    echo "[3/5] Building MariaDB UDF..."
    UDF_PLUGIN_DIR=$(detect_mariadb_plugin_dir)
    if [ -z "$UDF_PLUGIN_DIR" ]; then
        echo "  ERROR: could not find MariaDB plugin_dir. Set it manually." >&2; exit 1
    fi
    echo "  plugin_dir: $UDF_PLUGIN_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would build and install streams_compress.so"; return; fi
    (cd "$LEVER_DIR/udf" && make clean && make)
    install -m 755 "$LEVER_DIR/udf/streams_compress.so" "$UDF_PLUGIN_DIR/streams_compress.so"
    echo "  installed: $UDF_PLUGIN_DIR/streams_compress.so"

    # Register functions
    mariadb -u"$MARIADB_USER" < "$LEVER_DIR/udf/register.sql"
    echo "  registered: streams_zcompress / streams_zuncompress"
}

setup_dict_dir() {
    echo "[4/5] Setting up dictionary directory..."
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would create $DICT_DIR"; return; fi
    mkdir -p "$DICT_DIR"
    # The MariaDB UDF and PHP both need read access. Set permissions appropriately.
    chmod 755 "$DICT_DIR"
    # If mysql user exists, make them the owner so UDF reads succeed even with restrictive umasks
    if id mysql > /dev/null 2>&1; then
        chown mysql:mysql "$DICT_DIR"
    fi
    echo "  dict dir: $DICT_DIR"
    echo "  NOTE: train and place dictionaries here as: streams_instructions-vN.zdict"
    echo "        (where N is the dict version, 1..15)"
}

stage_qbix_hook() {
    echo "[5/5] Staging Qbix hook..."
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would copy hook to $HOOK_DIR"; return; fi
    mkdir -p "$HOOK_DIR"
    install -m 644 "$LEVER_DIR/qbix/Streams_Message_Compression.php" "$HOOK_DIR/"
    echo "  staged: $HOOK_DIR/Streams_Message_Compression.php"
    echo "  see $LEVER_DIR/qbix/README.md for wire-up instructions"
}

# ─── actions ──────────────────────────────────────────────────────
do_apply() {
    local distro
    distro=$(detect_distro)
    if [ "$distro" = "unknown" ]; then
        echo "Could not detect distro. Aborting." >&2; exit 1
    fi
    echo "Applying Layer 2 (zstd-dictionary) compression lever on $distro"
    echo ""
    install_libzstd "$distro"
    install_php_zstd
    build_udf
    setup_dict_dir
    stage_qbix_hook
    echo ""
    echo "Done. Layer 2 installed but not active."
    echo ""
    echo "Next steps:"
    echo "  1. Train a dictionary: see $LEVER_DIR/qbix/README.md"
    echo "  2. Drop it in $DICT_DIR/streams_instructions-v1.zdict"
    echo "  3. Wire the Qbix hook (see $HOOK_DIR/Streams_Message_Compression.php)"
    echo "  4. Run ./status.sh to confirm everything is live"
}

do_revert() {
    echo "Reverting Layer 2: deregistering UDF, leaving packages in place."
    UDF_PLUGIN_DIR=$(detect_mariadb_plugin_dir)
    if [ "$DRY_RUN" -eq 1 ]; then echo "  [dry-run] would deregister UDF"; exit 0; fi
    mariadb -u"$MARIADB_USER" < "$LEVER_DIR/udf/deregister.sql" || true
    rm -f "$UDF_PLUGIN_DIR/streams_compress.so"
    echo "UDF removed. Reads of compressed rows will now require the Qbix hook layer."
    echo "Packages (libzstd, php-zstd) left installed; remove with your package manager if desired."
}

do_status() {
    echo "─── Layer 2 (zstd-dictionary) status ─────────────────────────"
    # libzstd
    if ldconfig -p | grep -q libzstd; then
        echo "libzstd:        installed"
    else
        echo "libzstd:        not found"
    fi
    # php-zstd
    if php -m 2>/dev/null | grep -qi '^zstd$'; then
        echo "php-zstd:       loaded ($(php -r 'echo phpversion("zstd");' 2>/dev/null))"
    else
        echo "php-zstd:       not loaded"
    fi
    # UDF
    if command -v mariadb > /dev/null 2>&1; then
        local udf_count
        udf_count=$(mariadb -u"$MARIADB_USER" -BNe \
            "SELECT COUNT(*) FROM mysql.func WHERE name IN ('streams_zcompress','streams_zuncompress')" \
            2>/dev/null || echo "?")
        echo "MariaDB UDF:    $udf_count / 2 registered"
    fi
    # Dict dir
    if [ -d "$DICT_DIR" ]; then
        local n
        n=$(find "$DICT_DIR" -name 'streams_instructions-v*.zdict' 2>/dev/null | wc -l)
        echo "Dictionaries:   $n in $DICT_DIR"
        find "$DICT_DIR" -name 'streams_instructions-v*.zdict' -printf '                %f  (%s bytes)\n' 2>/dev/null
    else
        echo "Dictionaries:   directory missing ($DICT_DIR)"
    fi
    # Hook
    if [ -f "$HOOK_DIR/Streams_Message_Compression.php" ]; then
        echo "Qbix hook:      staged at $HOOK_DIR/Streams_Message_Compression.php"
    else
        echo "Qbix hook:      not staged"
    fi
}

case "$ACTION" in
    apply)  do_apply ;;
    revert) do_revert ;;
    status) do_status ;;
esac
