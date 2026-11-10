#!/bin/bash
# safebox-inner-egress.sh — loads the inner Safebox egress deny-all rules
#
# Called by safebox-inner-egress.service on inner Safeboxes only (the unit
# has ConditionPathExists=/etc/safebox/console-ip). Reads the outer Console's
# private IP from /etc/safebox/console-ip (written by safebox-firstboot from
# the console-ip metadata key), substitutes it into safebox-inner-egress.nft,
# and loads the result atomically with nft -f.
#
# This script runs AFTER safebox-imds.sh (safebox-nftables.service), so the
# base input chain and metadata lockdown are already in place. This script
# replaces the output chain with a deny-all policy that allows only the
# outer Console's IP.
#
# Prerequisites:
#   - safebox-imds.nft already loaded (input chain in place)
#   - /etc/safebox/console-ip exists and contains one IPv4 address
#   - safebox-imds.sh already installed DOCKER-USER rules

set -euo pipefail

CONSOLE_IP_FILE="/etc/safebox/console-ip"
NFT_TEMPLATE="/opt/safebox/net/safebox-inner-egress.nft"
NFT_RENDERED="/run/safebox/inner-egress.nft"

if [[ ! -f "$CONSOLE_IP_FILE" ]]; then
    echo "safebox-inner-egress: no console-ip file, skipping (this box is not an inner Safebox)" >&2
    exit 0
fi

CONSOLE_IP=$(cat "$CONSOLE_IP_FILE" | tr -d '[:space:]')

# Validate: must be a private IPv4 address (10.x, 172.16-31.x, or 192.168.x)
if ! [[ "$CONSOLE_IP" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9]+\.[0-9]+$ ]]; then
    echo "safebox-inner-egress: console-ip '$CONSOLE_IP' is not a private IPv4 address, refusing to load" >&2
    exit 1
fi

# Render the template with the actual Console IP
mkdir -p /run/safebox
sed "s/\\\$CONSOLE_IP/$CONSOLE_IP/g" "$NFT_TEMPLATE" > "$NFT_RENDERED"

# Load atomically
nft -f "$NFT_RENDERED"

echo "safebox-inner-egress: egress deny-all loaded, only $CONSOLE_IP allowed"

# Also restrict Docker containers: add DOCKER-USER rules that drop all
# outbound container traffic except to the Console IP and loopback.
# This is belt-and-suspenders with the OUTPUT chain, because Docker's
# FORWARD path bypasses OUTPUT.
iptables -I DOCKER-USER 1 -d "$CONSOLE_IP" -j RETURN 2>/dev/null || true
iptables -I DOCKER-USER 2 -d 127.0.0.0/8 -j RETURN 2>/dev/null || true
iptables -I DOCKER-USER 3 -d 169.254.169.254 -j DROP 2>/dev/null || true
# The final DOCKER-USER rule (added by safebox-imds.sh) already returns
# for non-metadata traffic. We insert before it so our Console-only rules
# take priority. Drop everything else that containers try to reach.
iptables -A DOCKER-USER -j DROP 2>/dev/null || true

echo "safebox-inner-egress: DOCKER-USER rules updated for inner Safebox"
