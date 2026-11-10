#!/bin/bash
#
# bootstrap-safebox.sh
#
# One-shot installer for the paste-IP onboarding path. The user runs this
# on a fresh Linux VM (any cloud) after they've created an account on
# safebots.org and received a registration token:
#
#   curl -L https://safebots.org/bootstrap | sudo bash -s -- TOKEN
#
# Or, for clarity, the canonical form prints the script before piping:
#
#   curl -L https://safebots.org/bootstrap > /tmp/b.sh
#   less /tmp/b.sh        # read it first
#   sudo bash /tmp/b.sh TOKEN
#
# What this does:
#   1. Detects distro + package manager
#   2. Installs Node.js (>=18), nginx, openssl, jq, ca-certificates
#   3. Clones (or downloads tarball of) the Infrastructure repo
#   4. Runs each component installer in order:
#        install-system.sh
#        install-dnsclient.sh
#        install-autohost.sh
#   5. Posts the registration token + the box's public IP to the
#      Safebots control plane, receiving back a safeboxId and
#      accountToken; writes those to /etc/safebox/dnsclient.json
#   6. Starts the systemd units
#
# What this does NOT do:
#   - Run inside a Nitro Enclave. This is the host-OS path for the paste-IP
#     onboarding mode; full enclave-attested operation requires the AMI
#     path (CloudFormation one-click on AWS). The paste-IP path runs the
#     bots on the host OS and falls back to a less-strong attestation
#     story for cross-cloud deployments.
#   - Configure customer DNS. The user must point their domain at this
#     box's IP separately.
#   - Provision a real cert for the dashboard. Until a custom domain is
#     pointed at the box, the dashboard at https://<safeboxId>.safebots.org
#     uses a real cert issued by the central DNS API.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: bootstrap must run as root (use sudo)" >&2
    exit 1
fi

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
    echo "Usage: $0 <registration-token>" >&2
    echo "Get a token at https://safebots.org/console/boxes/new" >&2
    exit 1
fi

# Validate token format before sending it anywhere
if [[ ! "$TOKEN" =~ ^reg_[A-Za-z0-9_-]{16,128}$ ]]; then
    echo "ERROR: registration token format invalid (expected reg_<16-128 alphanumeric>)" >&2
    exit 1
fi

CONTROL_PLANE_URL="${SAFEBOX_CONTROL_PLANE_URL:-https://api.safebots.org/v1}"
REPO_TARBALL_URL="${SAFEBOX_REPO_TARBALL:-https://safebots.org/Infrastructure.tar.gz}"

# ── Distro detection ─────────────────────────────────────────────────────────
if command -v dnf >/dev/null 2>&1; then
    PKG_MGR=dnf
    PKG_INSTALL="dnf -y install"
    PKG_UPDATE="dnf -y update"
elif command -v apt-get >/dev/null 2>&1; then
    PKG_MGR=apt
    export DEBIAN_FRONTEND=noninteractive
    PKG_INSTALL="apt-get install -y"
    PKG_UPDATE="apt-get update"
else
    echo "ERROR: unsupported distro (need dnf or apt-get)" >&2
    exit 1
fi

echo "▶ Detected package manager: $PKG_MGR"

# ── Install dependencies ─────────────────────────────────────────────────────
echo "▶ Installing system dependencies..."
$PKG_UPDATE >/dev/null
$PKG_INSTALL curl ca-certificates openssl jq nginx >/dev/null

# Node.js: use NodeSource for both apt and dnf to guarantee >=18
if ! node --version 2>/dev/null | grep -qE 'v(1[89]|[2-9][0-9])\.'; then
    echo "▶ Installing Node.js (NodeSource 18.x)..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null
        $PKG_INSTALL nodejs >/dev/null
    else
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - >/dev/null
        $PKG_INSTALL nodejs >/dev/null
    fi
fi
NODE_VERSION=$(node --version)
echo "  node: $NODE_VERSION"

# ── Fetch the Infrastructure tree ────────────────────────────────────────────
WORK_DIR=$(mktemp -d -t safebox-bootstrap-XXXXXX)
trap "rm -rf $WORK_DIR" EXIT
echo "▶ Fetching Infrastructure tarball: $REPO_TARBALL_URL"
curl -fsSL "$REPO_TARBALL_URL" -o "$WORK_DIR/infra.tar.gz"
mkdir -p "$WORK_DIR/infra"
tar -xzf "$WORK_DIR/infra.tar.gz" -C "$WORK_DIR/infra" --strip-components=1
INFRA_ROOT="$WORK_DIR/infra"

# Sanity check
if [[ ! -d "$INFRA_ROOT/aws/scripts/components/system" ]]; then
    echo "ERROR: tarball missing expected layout" >&2
    exit 1
fi

# ── Discover our public IP (for control-plane registration) ──────────────────
PUBLIC_IP=""
# Try a few methods. AWS IMDSv2 first; if not on AWS, fall back to a few
# well-known echo services.
TOKEN_IMDS=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    'http://169.254.169.254/latest/api/token' --max-time 2 2>/dev/null || true)
if [[ -n "$TOKEN_IMDS" ]]; then
    PUBLIC_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN_IMDS" \
        'http://169.254.169.254/latest/meta-data/public-ipv4' --max-time 2 2>/dev/null || true)
fi
if [[ -z "$PUBLIC_IP" ]]; then
    # GCP metadata
    PUBLIC_IP=$(curl -fsS -H 'Metadata-Flavor: Google' \
        'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' \
        --max-time 2 2>/dev/null || true)
fi
if [[ -z "$PUBLIC_IP" ]]; then
    # Generic echo services as last resort
    PUBLIC_IP=$(curl -fsS https://api.ipify.org --max-time 5 2>/dev/null || \
                curl -fsS https://icanhazip.com --max-time 5 2>/dev/null || true)
fi
PUBLIC_IP=$(echo "$PUBLIC_IP" | tr -d '\r\n ')

if [[ -z "$PUBLIC_IP" || ! "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: could not determine public IP" >&2
    exit 1
fi
echo "▶ Detected public IP: $PUBLIC_IP"

# ── Register with control plane ──────────────────────────────────────────────
echo "▶ Registering with $CONTROL_PLANE_URL..."
REG_RESPONSE=$(curl -fsS -X POST \
    -H 'Content-Type: application/json' \
    --max-time 30 \
    -d "$(jq -n --arg t "$TOKEN" --arg ip "$PUBLIC_IP" \
        '{registrationToken:$t, publicIp:$ip, mode:"paste-ip"}')" \
    "$CONTROL_PLANE_URL/boxes/register") || {
    echo "ERROR: control-plane registration failed" >&2
    exit 1
}

SAFEBOX_ID=$(echo "$REG_RESPONSE" | jq -r '.safeboxId // empty')
ACCOUNT_TOKEN=$(echo "$REG_RESPONSE" | jq -r '.accountToken // empty')
DNS_API_URL=$(echo "$REG_RESPONSE" | jq -r '.dnsApiUrl // empty')

if [[ -z "$SAFEBOX_ID" || -z "$ACCOUNT_TOKEN" || -z "$DNS_API_URL" ]]; then
    echo "ERROR: control-plane response missing required fields" >&2
    echo "Response: $REG_RESPONSE" >&2
    exit 1
fi
echo "  safeboxId: $SAFEBOX_ID"

# ── Write dnsclient config (before component install so install can validate) ─
install -d -m 0755 -o root -g root /etc/safebox
DNS_CFG=$(jq -n \
    --arg id "$SAFEBOX_ID" \
    --arg tok "$ACCOUNT_TOKEN" \
    --arg url "$DNS_API_URL" \
    '{safeboxId:$id, accountToken:$tok, dnsApiUrl:$url, allowUnattested:true}')
# allowUnattested:true for paste-IP path; cross-cloud may not have NSM.
# The AMI path on AWS Nitro sets it false in cloud-init.
echo "$DNS_CFG" > /etc/safebox/dnsclient.json
chmod 0640 /etc/safebox/dnsclient.json
chown root:safebox-infra /etc/safebox/dnsclient.json 2>/dev/null || true

# ── Run component installers in order ────────────────────────────────────────
echo "▶ Installing system component..."
bash "$INFRA_ROOT/aws/scripts/components/system/install-system.sh" \
    "$INFRA_ROOT/aws/scripts/components/system"

echo "▶ Installing dnsclient component..."
bash "$INFRA_ROOT/aws/scripts/components/dnsclient/install-dnsclient.sh" \
    "$INFRA_ROOT/aws/scripts/components/dnsclient"

# The ownership of dnsclient.json got set to safebox-infra above; redo now
# that the user definitely exists.
chown root:safebox-infra /etc/safebox/dnsclient.json

echo "▶ Installing autohost component..."
bash "$INFRA_ROOT/aws/scripts/components/autohost/install-autohost.sh" \
    "$INFRA_ROOT/aws/scripts/components/autohost"

# ── Start services ───────────────────────────────────────────────────────────
echo "▶ Starting services..."
systemctl enable --now safebox-system.service     || true
systemctl enable --now safebox-dnsclient.service  || true
systemctl enable --now safebox-autohost.service  || true
systemctl reload nginx                            || systemctl restart nginx

# ── Final status ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Safebox bootstrap complete"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  safeboxId:  $SAFEBOX_ID"
echo "  public IP:  $PUBLIC_IP"
echo "  dashboard:  https://$SAFEBOX_ID.safebots.org"
echo ""
echo "  Wait ~30 seconds for DNS propagation, then visit the dashboard."
echo ""
echo "  To attach a custom domain:"
echo "    1. Point an A record at $PUBLIC_IP"
echo "    2. Visit your custom domain — autohost will issue a cert on first hit"
echo ""
echo "  Logs:"
echo "    journalctl -u safebox-system     -f"
echo "    journalctl -u safebox-dnsclient  -f"
echo "    journalctl -u safebox-autohost  -f"
echo ""
