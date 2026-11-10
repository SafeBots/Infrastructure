#!/usr/bin/env bash
# safebox-imds.sh - installs the host firewall and metadata-service rules.
# Run by safebox-nftables.service BEFORE docker.service, which Requires= it
# through a drop-in, so the daemon (and any container it restarts) never
# runs without these rules. HARDENING-PLAN.md fix 6.
#
# Any failure here exits non-zero (set -e plus explicit checks below), which
# fails the unit and keeps docker.service from starting.
#
# Two layers, two mechanisms:
#
# 1. Container traffic (FORWARD path): a DROP in the DOCKER-USER chain.
#    Docker manages its own iptables chains and re-inserts its FORWARD jumps
#    whenever the daemon starts or a network is created. Any rule we put
#    directly in FORWARD can end up below Docker's ACCEPTs after a restart.
#    DOCKER-USER is the chain Docker documents for exactly this: it is jumped
#    to first from FORWARD, Docker creates it but never flushes it, and it
#    survives daemon restarts. We use the iptables-nft front end (the default
#    on AL2023, OL9, Debian and Ubuntu), so these rules land in the same
#    nf_tables backend as everything else and `nft list ruleset` shows them.
#
# 2. Host traffic: a native nftables table loaded from safebox-imds.nft.
#    Its INPUT chain (policy drop) admits only lo, established/related,
#    ICMP, TCP 80/443/8443 and DHCP replies. Its OUTPUT chain matches
#    metadata-bound packets on socket uid: root and safebox-infra (uid
#    990) are accepted, everything else dropped. One narrow exception:
#    _chrony may send UDP 123 to the address, because GCP and OCI serve NTP
#    there. The .nft file names that uid, so the user must exist before the
#    file can load; the check below turns a missing user into a clear error
#    instead of an nft parse failure.
#
# Idempotent: iptables rules are checked with -C before insertion; the nft
# file flushes its own table before repopulating it.

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly IMDS4=169.254.169.254
readonly IMDS6=fd00:ec2::254
readonly NFT_FILE=/etc/safebox/safebox-imds.nft

log() { printf 'safebox-imds: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ensure_rule <iptables|ip6tables> <chain> <rule...>
# Inserts at position 1 unless the identical rule already exists.
ensure_rule() {
    local bin=$1 chain=$2; shift 2
    if "$bin" -C "$chain" "$@" 2>/dev/null; then
        return 0
    fi
    "$bin" -I "$chain" 1 "$@" || die "$bin: could not insert into $chain: $*"
    "$bin" -C "$chain" "$@" || die "$bin: rule not present after insert in $chain: $*"
    log "$bin: inserted into $chain: $*"
}

docker_user_rules() {
    local bin=$1 addr=$2
    # Docker normally creates DOCKER-USER itself; create it if the daemon has
    # not yet (or is disabled) so the rule is in place either way. Docker
    # will not re-create a chain that exists.
    "$bin" -N DOCKER-USER 2>/dev/null || true
    # Make sure FORWARD actually jumps to DOCKER-USER even if Docker is not
    # running; Docker inserts the same jump at position 1 and -C keeps us from
    # adding a duplicate.
    ensure_rule "$bin" FORWARD -j DOCKER-USER
    ensure_rule "$bin" DOCKER-USER -d "$addr" -m comment --comment "safebox: no metadata from containers" -j DROP
}

main() {
    [[ $EUID -eq 0 ]] || die "must run as root"
    command -v iptables >/dev/null || die "iptables (iptables-nft) not installed"
    command -v nft >/dev/null || die "nft not installed"

    # Container isolation.
    docker_user_rules iptables "$IMDS4"
    if command -v ip6tables >/dev/null && ip6tables -L -n >/dev/null 2>&1; then
        docker_user_rules ip6tables "$IMDS6"
    else
        log "ip6tables unavailable; skipping IPv6 DOCKER-USER rule"
    fi

    # Host-side uid policy. The ruleset refers to the _chrony uid by name
    # (UDP 123 to the metadata address, for GCP and OCI time sync).
    [[ -r $NFT_FILE ]] || die "$NFT_FILE missing"
    getent passwd _chrony >/dev/null || die "user _chrony missing; $NFT_FILE cannot be loaded"
    nft -c -f "$NFT_FILE" || die "$NFT_FILE does not parse"
    nft -f "$NFT_FILE" || die "nft -f $NFT_FILE failed"
    # The load is atomic (the file flushes and repopulates the table in one
    # transaction), but confirm both chains exist before reporting success:
    # docker.service Requires= this unit, so a false "ok" here would let the
    # daemon start without the inbound policy.
    nft list chain inet safebox input  >/dev/null 2>&1 || die "inet safebox input chain missing after load"
    nft list chain inet safebox output >/dev/null 2>&1 || die "inet safebox output chain missing after load"
    iptables -C DOCKER-USER -d "$IMDS4" -m comment --comment "safebox: no metadata from containers" -j DROP \
        || die "DOCKER-USER metadata rule missing after install"
    log "loaded $NFT_FILE (input policy drop; metadata uid policy)"
}

main "$@"
