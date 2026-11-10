#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-cross-attestation.sh — Cross-cloud attestation verification
#
# For every ordered pair of safeboxes (A, B) on different clouds, fetches A's
# attestation claim and submits it to B's /api/verify endpoint.  Ed25519
# signature verification is cloud-neutral, so every pair should pass.
#
# Also checks that no claim is stale (older than 5 minutes).
#
# Usage:
#   ./test-cross-attestation.sh --endpoints https://sb1.example.com,https://sb2.example.com
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
STALE_WINDOW=300   # 5 minutes

while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoints)    ENDPOINTS="${2:-}"; shift 2 ;;
        --timeout)      TIMEOUT="${2:-10}";  shift 2 ;;
        --stale-window) STALE_WINDOW="${2:-300}"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 --endpoints <url1,url2[,...]> [--timeout s] [--stale-window s]" >&2
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

echo -e "${BOLD}Cross-cloud attestation verification${RESET}" >&2
echo -e "Endpoints: ${#EP_LIST[@]}   Stale window: ${STALE_WINDOW}s\n" >&2

# ── 1. Collect claims from every endpoint ──────────────────────────────────
banner "1. Collecting attestation claims"

declare -A CLAIMS     # endpoint → JSON
declare -A CLAIM_IDS  # endpoint → safebox-id
declare -A CLOUDS     # endpoint → cloud name

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    claim=$(curl -sf --max-time "$TIMEOUT" "$ep/api/attestation" 2>/dev/null) || {
        fail "$label  /api/attestation — request failed"
        continue
    }

    if ! echo "$claim" | jq empty 2>/dev/null; then
        fail "$label  response is not valid JSON"
        continue
    fi

    sbid=$(echo "$claim" | jq -r '.["safebox-id"] // empty')
    cloud=$(echo "$claim" | jq -r '.cloud // "unknown"')

    if [[ -z "$sbid" ]]; then
        fail "$label  claim has no safebox-id"
        continue
    fi

    CLAIMS["$ep"]="$claim"
    CLAIM_IDS["$ep"]="$sbid"
    CLOUDS["$ep"]="$cloud"
    pass "$label  id=$sbid  cloud=$cloud"
done

# ── 2. Freshness check ─────────────────────────────────────────────────────
banner "2. Claim freshness (max ${STALE_WINDOW}s)"

NOW=$(date +%s)

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ -z "${CLAIMS[$ep]:-}" ]] && { skip "$label"; continue; }

    ts=$(echo "${CLAIMS[$ep]}" | jq -r '.timestamp // empty')
    [[ -z "$ts" ]] && { fail "$label  no timestamp"; continue; }

    # Normalise to epoch
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        epoch="$ts"
    else
        epoch=$(date -d "$ts" +%s 2>/dev/null || echo 0)
    fi

    age=$(( NOW - epoch ))
    if [[ $age -ge 0 && $age -le $STALE_WINDOW ]]; then
        pass "$label  age=${age}s"
    else
        fail "$label  age=${age}s  (stale or clock skew)"
    fi
done

# ── 3. Cross-verification matrix ──────────────────────────────────────────
banner "3. Cross-verification (A's claim → B's /api/verify)"

# Build the matrix header
{
    printf "\n  %-20s" ""
    for verifier in "${EP_LIST[@]}"; do
        printf "%-14s" "${CLOUDS[$verifier]:-?}"
    done
    echo ""
}  >&2

for source in "${EP_LIST[@]}"; do
    src_label="${CLOUDS[$source]:-${source##*://}}"
    [[ -z "${CLAIMS[$source]:-}" ]] && continue

    printf "  %-20s" "$src_label →" >&2

    for verifier in "${EP_LIST[@]}"; do
        ver_label="${CLOUDS[$verifier]:-${verifier##*://}}"

        # Skip self-verification (not cross-cloud)
        if [[ "$source" == "$verifier" ]]; then
            printf "%-14s" "—" >&2
            continue
        fi

        [[ -z "${CLAIMS[$verifier]:-}" ]] && {
            printf "%-14s" "SKIP" >&2
            ((SKIP++))
            continue
        }

        # POST source's claim to verifier's /api/verify
        http_code=$(curl -sf --max-time "$TIMEOUT" \
            -X POST \
            -H "Content-Type: application/json" \
            -d "${CLAIMS[$source]}" \
            -o /tmp/verify_response.$$.json \
            -w "%{http_code}" \
            "$verifier/api/verify" 2>/dev/null) || http_code="000"

        if [[ "$http_code" == "200" ]]; then
            # Check the response body for a "valid" field
            valid="true"
            if [[ -f /tmp/verify_response.$$.json ]]; then
                resp_valid=$(jq -r '.valid // .verified // .ok // empty' /tmp/verify_response.$$.json 2>/dev/null)
                if [[ "$resp_valid" == "false" ]]; then
                    valid="false"
                fi
            fi

            if [[ "$valid" == "true" ]]; then
                printf "${GREEN}%-14s${RESET}" "PASS" >&2
                ((PASS++))
            else
                printf "${RED}%-14s${RESET}" "REJECTED" >&2
                ((FAIL++))
            fi
        else
            printf "${RED}%-14s${RESET}" "HTTP $http_code" >&2
            ((FAIL++))
        fi

        rm -f /tmp/verify_response.$$.json
    done
    echo "" >&2
done

# ── 4. Verify cloud-diversity ──────────────────────────────────────────────
banner "4. Cloud diversity check"

unique_clouds=$(for ep in "${EP_LIST[@]}"; do
    echo "${CLOUDS[$ep]:-unknown}"
done | sort -u | wc -l)

if [[ "$unique_clouds" -ge 2 ]]; then
    pass "endpoints span $unique_clouds distinct clouds"
else
    fail "all endpoints on the same cloud — this is not a cross-cloud test"
fi

# ── 5. Signature algorithm consistency ─────────────────────────────────────
banner "5. Signature algorithm"

for ep in "${EP_LIST[@]}"; do
    label="${ep##*://}"
    [[ -z "${CLAIMS[$ep]:-}" ]] && { skip "$label"; continue; }

    alg=$(echo "${CLAIMS[$ep]}" | jq -r '.algorithm // .signatureAlgorithm // empty')
    key_type=$(echo "${CLAIMS[$ep]}" | jq -r '.publicKey.type // .keyType // empty')

    if [[ "$alg" == "Ed25519" || "$key_type" == "Ed25519" ]]; then
        pass "$label  Ed25519"
    elif [[ -n "$alg" ]]; then
        fail "$label  unexpected algorithm: $alg (expected Ed25519)"
    else
        # Algorithm not in claim body — acceptable if the verify endpoint
        # handles it (the OCP spec uses Ed25519 by convention)
        skip "$label  algorithm not in claim body (verify endpoint decides)"
    fi
done

# ── summary ─────────────────────────────────────────────────────────────────
banner "Summary"
echo -e "  ${GREEN}PASS${RESET} $PASS   ${RED}FAIL${RESET} $FAIL   ${YELLOW}SKIP${RESET} $SKIP" >&2

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
