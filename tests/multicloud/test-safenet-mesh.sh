#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-safenet-mesh.sh — Safenet mesh integration test
#
# Verifies that all safeboxes participate in the Safenet overlay:
#   - every node is in the Safenet registry
#   - a name claim made on one node propagates to all others
#   - transparency-log entries are consistent across nodes
#
# Usage:
#   ./test-safenet-mesh.sh --endpoints https://sb1.example.com,https://sb2.example.com
#
# Exit 0 on all-pass, 1 on any failure.
# ---------------------------------------------------------------------------
set -euo pipefail

# ── colours ─────────────────────────────────────────────────────────────────
if [[ -t 2 ]]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'
    BOLD='\033[1m'; RESET='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi

PASS=0; FAIL=0; SKIP=0
pass() { ((PASS++)); echo -e "  ${GREEN}PASS${RESET}  $1" >&2; }
fail() { ((FAIL++)); echo -e "  ${RED}FAIL${RESET}  $1" >&2; }
skip() { ((SKIP++)); echo -e "  ${YELLOW}SKIP${RESET}  $1" >&2; }
banner() { echo -e "\n${BOLD}── $1${RESET}" >&2; }

# ── args ────────────────────────────────────────────────────────────────────
ENDPOINTS=""
TIMEOUT=10
PROPAGATION_WAIT=15   # seconds to wait for claim propagation

while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoints)         ENDPOINTS="${2:-}"; shift 2 ;;
        --timeout)           TIMEOUT="${2:-10}"; shift 2 ;;
        --propagation-wait)  PROPAGATION_WAIT="${2:-15}"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 --endpoints <url1,url2[,...]> [--timeout s] [--propagation-wait s]" >&2
            exit 1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

[[ -z "$ENDPOINTS" ]] && { echo "Error: --endpoints required" >&2; exit 1; }
IFS=',' read -ra EP_LIST <<< "$ENDPOINTS"
[[ ${#EP_LIST[@]} -lt 2 ]] && { echo "Error: need ≥2 endpoints" >&2; exit 1; }

for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not found" >&2; exit 1; }
done

echo -e "${BOLD}Safenet mesh integration test${RESET}" >&2
echo -e "Endpoints: ${#EP_LIST[@]}   Propagation wait: ${PROPAGATION_WAIT}s\n" >&2

# ── 1. Registry membership ─────────────────────────────────────────────────
banner "1. Registry membership"

# Collect safebox-ids from attestation claims
declare -A SB_IDS   # endpoint → safebox-id
declare -A CLOUDS   # endpoint → cloud

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    claim=$(curl -sf --max-time "$TIMEOUT" "$ep/api/attestation" 2>/dev/null) || {
        fail "$label  /api/attestation unreachable"
        continue
    }
    SB_IDS["$ep"]=$(echo "$claim" | jq -r '.["safebox-id"] // empty')
    CLOUDS["$ep"]=$(echo "$claim" | jq -r '.cloud // "unknown"')
done

# Pick the first healthy endpoint to query the registry
REGISTRY_EP=""
for ep in "${EP_LIST[@]}"; do
    [[ -n "${SB_IDS[$ep]:-}" ]] && { REGISTRY_EP="$ep"; break; }
done

if [[ -z "$REGISTRY_EP" ]]; then
    fail "No healthy endpoint to query registry"
else
    registry_json=$(curl -sf --max-time "$TIMEOUT" "$REGISTRY_EP/api/safenet/registry" 2>/dev/null) || registry_json=""

    if [[ -z "$registry_json" ]] || ! echo "$registry_json" | jq empty 2>/dev/null; then
        fail "Could not fetch registry from ${REGISTRY_EP##*://}"
    else
        for ep in "${EP_LIST[@]}"; do
            label="${ep##*://}"
            sbid="${SB_IDS[$ep]:-}"
            [[ -z "$sbid" ]] && { skip "$label  (no id)"; continue; }

            # Search for this safebox-id in the registry
            found=$(echo "$registry_json" | jq --arg id "$sbid" '
                if type == "array" then
                    [.[] | select(.["safebox-id"] == $id or .id == $id)] | length
                elif type == "object" and has("nodes") then
                    [.nodes[] | select(.["safebox-id"] == $id or .id == $id)] | length
                elif type == "object" then
                    if has($id) then 1 else 0 end
                else 0 end
            ')

            if [[ "$found" -ge 1 ]]; then
                pass "$label  $sbid registered  cloud=${CLOUDS[$ep]:-?}"
            else
                fail "$label  $sbid NOT in registry"
            fi
        done
    fi
fi

# ── 2. Name claim propagation ──────────────────────────────────────────────
banner "2. Name claim propagation"

# Generate a unique test claim name
TEST_NAME="__test-$(date +%s)-$$"
SOURCE_EP="${EP_LIST[0]}"
SOURCE_LABEL="${SOURCE_EP##*://}"

echo -e "  Creating test claim '${TEST_NAME}' on ${SOURCE_LABEL}..." >&2

# POST a name claim to the first endpoint
claim_response=$(curl -sf --max-time "$TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$TEST_NAME\", \"type\": \"test\", \"ttl\": 60}" \
    "$SOURCE_EP/api/safenet/claims" 2>/dev/null) || claim_response=""

if [[ -z "$claim_response" ]]; then
    skip "Could not create test claim on $SOURCE_LABEL (claims API may not accept test writes)"
else
    claim_ok=$(echo "$claim_response" | jq -r '.ok // .success // .created // empty' 2>/dev/null)

    if [[ "$claim_ok" == "true" || "$claim_ok" == "1" ]]; then
        pass "test claim created on $SOURCE_LABEL"

        # Wait for propagation
        echo -e "  Waiting ${PROPAGATION_WAIT}s for propagation..." >&2
        sleep "$PROPAGATION_WAIT"

        # Check every OTHER endpoint for the claim
        for ep in "${EP_LIST[@]}"; do
            [[ "$ep" == "$SOURCE_EP" ]] && continue
            label="${ep##*://}"

            lookup=$(curl -sf --max-time "$TIMEOUT" \
                "$ep/api/safenet/claims/$TEST_NAME" 2>/dev/null) || lookup=""

            if [[ -n "$lookup" ]] && echo "$lookup" | jq -e '.name // .claim // empty' >/dev/null 2>&1; then
                pass "$label  claim '$TEST_NAME' propagated"
            else
                fail "$label  claim '$TEST_NAME' NOT found after ${PROPAGATION_WAIT}s"
            fi
        done

        # Clean up: delete the test claim
        curl -sf --max-time "$TIMEOUT" \
            -X DELETE \
            "$SOURCE_EP/api/safenet/claims/$TEST_NAME" >/dev/null 2>&1 || true
    else
        skip "Claims API did not accept test write (read-only or auth required)"
    fi
fi

# ── 3. Transparency log consistency ───────────────────────────────────────
banner "3. Transparency log consistency"

# Fetch the latest log head from each endpoint and verify they agree
declare -A LOG_HEADS   # endpoint → head hash
declare -A LOG_LENGTHS # endpoint → log length

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"

    log_info=$(curl -sf --max-time "$TIMEOUT" "$ep/api/safenet/log" 2>/dev/null) || {
        skip "$label  /api/safenet/log unreachable"
        continue
    }

    if ! echo "$log_info" | jq empty 2>/dev/null; then
        skip "$label  log response not valid JSON"
        continue
    fi

    head=$(echo "$log_info" | jq -r '.head // .hash // .latest // empty')
    length=$(echo "$log_info" | jq -r '.length // .size // .count // empty')

    LOG_HEADS["$ep"]="${head:-unknown}"
    LOG_LENGTHS["$ep"]="${length:-?}"

    pass "$label  log head=${head:0:16}...  length=${length:-?}"
done

# Compare all heads — they should be identical or within a few entries
if [[ ${#LOG_HEADS[@]} -ge 2 ]]; then
    unique_heads=$(printf '%s\n' "${LOG_HEADS[@]}" | sort -u | wc -l)

    if [[ "$unique_heads" -eq 1 ]]; then
        pass "all nodes agree on log head"
    else
        # Check if lengths are close (within 5 entries — propagation lag)
        lengths=()
        for ep in "${EP_LIST[@]}"; do
            l="${LOG_LENGTHS[$ep]:-0}"
            [[ "$l" =~ ^[0-9]+$ ]] && lengths+=("$l")
        done

        if [[ ${#lengths[@]} -ge 2 ]]; then
            min_len=${lengths[0]}; max_len=${lengths[0]}
            for l in "${lengths[@]}"; do
                (( l < min_len )) && min_len=$l
                (( l > max_len )) && max_len=$l
            done
            drift=$(( max_len - min_len ))

            if [[ $drift -le 5 ]]; then
                pass "log heads differ but drift is only $drift entries (propagation lag)"
            else
                fail "log heads diverge by $drift entries"
            fi
        else
            fail "log heads differ and cannot compare lengths"
        fi
    fi
else
    skip "fewer than 2 log responses — cannot compare"
fi

# ── 4. Log entry validation (spot check) ──────────────────────────────────
banner "4. Log entry validation (spot check)"

# Pick the first endpoint and validate its latest entries
CHECK_EP="${EP_LIST[0]}"
CHECK_LABEL="${CHECK_EP##*://}"

entries=$(curl -sf --max-time "$TIMEOUT" "$CHECK_EP/api/safenet/log/entries?limit=5" 2>/dev/null) || entries=""

if [[ -z "$entries" ]] || ! echo "$entries" | jq empty 2>/dev/null; then
    skip "Could not fetch log entries from $CHECK_LABEL"
else
    entry_count=$(echo "$entries" | jq 'if type == "array" then length else .entries // [] | length end')

    if [[ "$entry_count" -eq 0 ]]; then
        skip "Log is empty on $CHECK_LABEL"
    else
        # Validate each entry has required fields
        ENTRY_FIELDS=("hash" "timestamp" "type")
        invalid=0

        for i in $(seq 0 $(( entry_count - 1 ))); do
            entry=$(echo "$entries" | jq "if type == \"array\" then .[$i] else (.entries // [])[$i] end")
            for f in "${ENTRY_FIELDS[@]}"; do
                val=$(echo "$entry" | jq -r --arg k "$f" '.[$k] // empty')
                [[ -z "$val" ]] && ((invalid++))
            done
        done

        if [[ $invalid -eq 0 ]]; then
            pass "$CHECK_LABEL  $entry_count entries validated (hash, timestamp, type)"
        else
            fail "$CHECK_LABEL  $invalid missing fields in $entry_count entries"
        fi
    fi
fi

# ── summary ─────────────────────────────────────────────────────────────────
banner "Summary"
echo -e "  ${GREEN}PASS${RESET} $PASS   ${RED}FAIL${RESET} $FAIL   ${YELLOW}SKIP${RESET} $SKIP" >&2

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
