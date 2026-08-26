#!/usr/bin/env bash
#
# run-all-tests.sh — run every test suite in the Infrastructure repo.
#
# Covers:
#   - System component (Node)      aws/scripts/components/system/test/run.js
#   - STM injection validators (Node)  docker/test/testStmValidators.js
#   - CLI (Node)                   cli/safebox-models/test/test-cli.js
#   - Model runners (Python)       model-runners/*/test_runner.py
#
# Exit non-zero if any suite fails. Prints a summary table at the end.
#
# Usage: ./run-all-tests.sh   (from repo root)

set -uo pipefail
cd "$(dirname "$0")"

PASS=0
FAIL=0
declare -a RESULTS

run() {
    local name="$1"; shift
    echo ""
    echo "═══ $name ═══"
    if "$@"; then
        RESULTS+=("PASS  $name")
        PASS=$((PASS + 1))
    else
        RESULTS+=("FAIL  $name")
        FAIL=$((FAIL + 1))
    fi
}

# ── Node suites ───────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
    run "system-component" node aws/scripts/components/system/test/run.js
    run "stm-validators"   node docker/test/testStmValidators.js
    if [ -f cli/safebox-models/test/test-cli.js ]; then
        run "cli-safebox-models" node cli/safebox-models/test/test-cli.js
    fi
    if [ -f aws/scripts/components/autohost/test/testAutohostSplash.js ]; then
        run "autohost-splash" node aws/scripts/components/autohost/test/testAutohostSplash.js
    fi
else
    echo "WARN: node not found; skipping Node suites"
fi

# ── Python runner suites ──────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
    for d in model-runners/*/; do
        name="$(basename "$d")"
        [ -f "${d}test_runner.py" ] || continue
        # Each runner's test_runner.py sets its own env defaults via
        # os.environ.setdefault, so we only need to disable HMAC + socket.
        run "runner:${name}" bash -c "cd '$d' && SAFEBOX_REQUIRE_HMAC=false ENABLE_UNIX_SOCKET=false python3 test_runner.py >/dev/null 2>&1"
    done
else
    echo "WARN: python3 not found; skipping runner suites"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "═══════════════════════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════"

exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
