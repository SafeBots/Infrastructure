#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-peer-discovery.sh — Multi-cloud peer discovery integration test
#
# Verifies that safeboxes on different clouds are healthy, produce valid
# attestation claims, and can discover each other via the peer API.
#
# Usage:
#   ./test-peer-discovery.sh --endpoints https://sb1.example.com,https://sb2.example.com
#
# Exit 0 on all-pass, 1 on any failure.
# ---------------------------------------------------------------------------
set -euo pipefail

# ── colours (disabled when stderr is not a tty) ─────────────────────────────
if [[ -t 2 ]]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'
    BOLD='\033[1m'; RESET='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi

# ── counters ────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0

pass() { ((PASS++)); echo -e "  ${GREEN}PASS${RESET}  $1" >&2; }
fail() { ((FAIL++)); echo -e "  ${RED}FAIL${RESET}  $1" >&2; }
skip() { ((SKIP++)); echo -e "  ${YELLOW}SKIP${RESET}  $1" >&2; }
banner() { echo -e "\n${BOLD}── $1${RESET}" >&2; }

# ── argument parsing ────────────────────────────────────────────────────────
ENDPOINTS=""
TIMEOUT=10

usage() {
    echo "Usage: $0 --endpoints <url1,url2[,url3,...]> [--timeout <seconds>]" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoints) ENDPOINTS="${2:-}"; shift 2 ;;
        --timeout)   TIMEOUT="${2:-10}"; shift 2 ;;
        -h|--help)   usage ;;
        *)           echo "Unknown option: $1" >&2; usage ;;
    esac
done

[[ -z "$ENDPOINTS" ]] && { echo "Error: --endpoints is required" >&2; usage; }

IFS=',' read -ra EP_LIST <<< "$ENDPOINTS"
[[ ${#EP_LIST[@]} -lt 2 ]] && {
    echo "Error: need at least 2 endpoints, got ${#EP_LIST[@]}" >&2
    exit 1
}

for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not found" >&2; exit 1; }
done

echo -e "${BOLD}Multi-cloud peer discovery test${RESET}" >&2
echo -e "Endpoints: ${#EP_LIST[@]}   Timeout: ${TIMEOUT}s\n" >&2

# ── 1. Health check ─────────────────────────────────────────────────────────
banner "1. Health checks"

declare -A HEALTHY   # endpoint → 1 if healthy
for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"   # strip scheme for display
    if curl -sf --max-time "$TIMEOUT" "$ep/api/health" >/dev/null 2>&1; then
        pass "$label  /api/health"
        HEALTHY["$ep"]=1
    else
        fail "$label  /api/health — unreachable or non-200"
        HEALTHY["$ep"]=0
    fi
done

# ── 2. Attestation claims ──────────────────────────────────────────────────
banner "2. Attestation claims"

REQUIRED_FIELDS=("safebox-id" "cloud" "timestamp" "signature")
declare -A CLAIMS    # endpoint → raw JSON claim

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ "${HEALTHY[$ep]}" != "1" ]] && { skip "$label  (unhealthy)"; continue; }

    claim=$(curl -sf --max-time "$TIMEOUT" "$ep/api/attestation" 2>/dev/null) || {
        fail "$label  /api/attestation — request failed"
        continue
    }

    # Validate JSON
    if ! echo "$claim" | jq empty 2>/dev/null; then
        fail "$label  /api/attestation — not valid JSON"
        continue
    fi

    # Check required fields
    missing=()
    for f in "${REQUIRED_FIELDS[@]}"; do
        val=$(echo "$claim" | jq -r --arg k "$f" '.[$k] // empty')
        [[ -z "$val" ]] && missing+=("$f")
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        fail "$label  /api/attestation — missing fields: ${missing[*]}"
    else
        cloud=$(echo "$claim" | jq -r '.cloud')
        sbid=$(echo "$claim" | jq -r '.["safebox-id"]')
        pass "$label  /api/attestation  cloud=$cloud  id=$sbid"
        CLAIMS["$ep"]="$claim"
    fi
done

# ── 3. Claim freshness (within 5 minutes) ──────────────────────────────────
banner "3. Claim freshness"

NOW=$(date +%s)
STALE_WINDOW=300   # 5 minutes

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ -z "${CLAIMS[$ep]:-}" ]] && { skip "$label  (no claim)"; continue; }

    ts=$(echo "${CLAIMS[$ep]}" | jq -r '.timestamp // empty')
    if [[ -z "$ts" ]]; then
        fail "$label  timestamp missing"
        continue
    fi

    # timestamp can be epoch seconds or ISO-8601; normalise to epoch
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        claim_epoch="$ts"
    else
        claim_epoch=$(date -d "$ts" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null || echo 0)
    fi

    age=$(( NOW - claim_epoch ))
    if [[ $age -lt 0 || $age -gt $STALE_WINDOW ]]; then
        fail "$label  claim age ${age}s (max ${STALE_WINDOW}s)"
    else
        pass "$label  claim age ${age}s"
    fi
done

# ── 4. Peer discovery ──────────────────────────────────────────────────────
banner "4. Peer discovery"

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ "${HEALTHY[$ep]}" != "1" ]] && { skip "$label  (unhealthy)"; continue; }

    peers_json=$(curl -sf --max-time "$TIMEOUT" "$ep/api/peers" 2>/dev/null) || {
        fail "$label  /api/peers — request failed"
        continue
    }

    if ! echo "$peers_json" | jq empty 2>/dev/null; then
        fail "$label  /api/peers — not valid JSON"
        continue
    fi

    peer_count=$(echo "$peers_json" | jq 'if type == "array" then length else .peers // [] | length end')

    # Each node should know about at least one other node
    if [[ "$peer_count" -ge 1 ]]; then
        pass "$label  /api/peers  count=$peer_count"
    else
        fail "$label  /api/peers  count=0 — no peers discovered"
    fi
done

# ── 5. Cross-visibility: each node should list every other node ─────────
banner "5. Cross-visibility"

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ "${HEALTHY[$ep]}" != "1" ]] && { skip "$label  (unhealthy)"; continue; }

    peers_json=$(curl -sf --max-time "$TIMEOUT" "$ep/api/peers" 2>/dev/null || echo '[]')

    for other in "${EP_LIST[@]}"; do
        [[ "$other" == "$ep" ]] && continue
        other_label="${other##*://}"

        # Get the other's safebox-id so we can search the peer list
        other_id=""
        if [[ -n "${CLAIMS[$other]:-}" ]]; then
            other_id=$(echo "${CLAIMS[$other]}" | jq -r '.["safebox-id"] // empty')
        fi

        if [[ -z "$other_id" ]]; then
            skip "$label → $other_label  (no claim to match)"
            continue
        fi

        # Check whether this node's peer list contains the other's id
        found=$(echo "$peers_json" | jq --arg id "$other_id" '
            if type == "array" then [.[] | select(.["safebox-id"] == $id or .id == $id)] | length
            else [(.peers // [])[] | select(.["safebox-id"] == $id or .id == $id)] | length
            end
        ')

        if [[ "$found" -ge 1 ]]; then
            pass "$label → $other_label  ($other_id visible)"
        else
            fail "$label → $other_label  ($other_id NOT in peer list)"
        fi
    done
done

# ── summary ─────────────────────────────────────────────────────────────────
banner "Summary"
echo -e "  ${GREEN}PASS${RESET} $PASS   ${RED}FAIL${RESET} $FAIL   ${YELLOW}SKIP${RESET} $SKIP" >&2

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
