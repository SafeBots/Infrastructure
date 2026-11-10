#!/bin/bash
# common/nameserver/delegation-monitor.sh
#
# Monitors the health of the Safenet DNS delegation:
#
#   1. DS records at the parent (.org) match our KSKs
#   2. NS records at the parent point to our nameservers
#   3. All nameservers respond and serve the same serial
#   4. Certificate Transparency logs for unexpected certs
#
# Runs as a systemd timer (safebox-delegation-monitor.timer) and logs
# to syslog. Exits 0 on success, 1 on warning, 2 on critical.
#
# See docs/DNS-ARCHITECTURE.md for the full design.

set -euo pipefail

DOMAIN="${SAFEBOX_DOMAIN:-safenet.org}"
EXPECTED_NS_FILE="${SAFEBOX_NS_FILE:-/etc/safebox/expected-nameservers.txt}"
DS_RECORDS_FILE="${SAFEBOX_DS_FILE:-/var/lib/safebox/knot/keys/ds-records.txt}"
CT_LOG_STATE="${SAFEBOX_CT_STATE:-/var/lib/safebox/knot/ct-last-check}"
LOG_TAG="delegation-monitor"

warn()  { logger -t "$LOG_TAG" -p daemon.warning "$*"; EXITCODE=1; }
crit()  { logger -t "$LOG_TAG" -p daemon.crit "$*"; EXITCODE=2; }
info()  { logger -t "$LOG_TAG" -p daemon.info "$*"; }

EXITCODE=0

# --- 1. Check NS records at the parent ---
info "checking NS records for $DOMAIN at parent"
PARENT_NS="$(dig +short NS "$DOMAIN" @a0.org.afilias-nst.info. 2>/dev/null | sort)" || true

if [[ -f "$EXPECTED_NS_FILE" ]]; then
    EXPECTED_NS="$(sort "$EXPECTED_NS_FILE")"
    if [[ "$PARENT_NS" != "$EXPECTED_NS" ]]; then
        crit "NS records at parent do not match expected: got [$PARENT_NS], expected [$EXPECTED_NS]"
    else
        info "NS records at parent match expected"
    fi
else
    info "no expected-nameservers.txt; skipping NS comparison"
fi

# --- 2. Check DS records at the parent ---
info "checking DS records for $DOMAIN at parent"
PARENT_DS="$(dig +short DS "$DOMAIN" @a0.org.afilias-nst.info. 2>/dev/null | sort)" || true

if [[ -n "$PARENT_DS" ]]; then
    info "DS records present at parent: $(echo "$PARENT_DS" | wc -l) record(s)"
    if [[ -f "$DS_RECORDS_FILE" ]]; then
        # Check our DS is among the parent's DS records
        while IFS= read -r local_ds; do
            # Extract key tag from our local DS record
            local_keytag="$(echo "$local_ds" | awk '{print $4}')"
            if echo "$PARENT_DS" | grep -q "$local_keytag"; then
                info "local KSK key tag $local_keytag found in parent DS"
            else
                warn "local KSK key tag $local_keytag NOT found in parent DS records"
            fi
        done < <(grep -v '^;' "$DS_RECORDS_FILE" | grep -v '^$')
    fi
else
    warn "no DS records at parent for $DOMAIN (DNSSEC not fully delegated)"
fi

# --- 3. Query each nameserver and compare serials ---
info "checking nameserver consistency"
SERIALS=()
for ns in $PARENT_NS; do
    ns_clean="${ns%.}"
    serial="$(dig +short SOA "$DOMAIN" "@$ns_clean" 2>/dev/null | awk '{print $3}')" || true
    if [[ -z "$serial" ]]; then
        warn "nameserver $ns_clean did not respond with SOA"
    else
        info "nameserver $ns_clean serial=$serial"
        SERIALS+=("$serial")
    fi
done

if [[ ${#SERIALS[@]} -gt 1 ]]; then
    UNIQUE_SERIALS="$(printf '%s\n' "${SERIALS[@]}" | sort -u | wc -l)"
    if [[ "$UNIQUE_SERIALS" -ne 1 ]]; then
        warn "nameservers report different serials: ${SERIALS[*]}"
    else
        info "all nameservers agree on serial ${SERIALS[0]}"
    fi
fi

# --- 4. Certificate Transparency check ---
# Query crt.sh for recent certificates issued for our domain
info "checking Certificate Transparency logs"
CT_LAST=0
if [[ -f "$CT_LOG_STATE" ]]; then
    CT_LAST="$(cat "$CT_LOG_STATE" 2>/dev/null)" || CT_LAST=0
fi

CT_RESULT="$(curl -sf "https://crt.sh/?q=%25.$DOMAIN&output=json" 2>/dev/null)" || CT_RESULT=""
if [[ -n "$CT_RESULT" ]]; then
    # Check for certificates issued after our last check
    CT_COUNT="$(echo "$CT_RESULT" | jq '[.[] | select(.not_before > "'"$(date -d "@$CT_LAST" -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "2020-01-01T00:00:00")"'")] | length' 2>/dev/null)" || CT_COUNT=0
    if [[ "$CT_COUNT" -gt 0 ]]; then
        info "CT: $CT_COUNT new certificate(s) found since last check"
        # Log the issuers for review
        echo "$CT_RESULT" | jq -r '.[] | select(.not_before > "'"$(date -d "@$CT_LAST" -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "2020-01-01T00:00:00")"'") | "\(.common_name) issued by \(.issuer_name) at \(.not_before)"' 2>/dev/null \
            | head -20 | while IFS= read -r line; do
            info "CT cert: $line"
        done
    else
        info "CT: no new certificates since last check"
    fi
    date +%s > "$CT_LOG_STATE"
else
    info "CT: could not query crt.sh (network issue?)"
fi

info "delegation monitor complete (exit=$EXITCODE)"
exit "$EXITCODE"
