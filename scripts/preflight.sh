#!/bin/bash
#
# preflight.sh
#
# Fail-fast prerequisite check, run BEFORE any component installer touches the
# box. Every check here corresponds to something a later installer or the
# running system hard-requires — the point is to turn a half-installed mystery
# box into a single clear error at second zero.
#
# Exit codes:
#   0  all checks passed (or passed with non-fatal warnings)
#   1  a fatal prerequisite is missing — do not proceed with install
#
# Usage:  sudo bash scripts/preflight.sh [--strict]
#   --strict   treat warnings (e.g. not on Nitro) as fatal too. Use for real
#              production AMI builds; omit for host-OS / cross-cloud dev boxes.

set -uo pipefail

STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

fatal=0
warns=0

ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1" >&2; fatal=$((fatal+1)); }
warn() {
    if [[ $STRICT -eq 1 ]]; then echo "  ✗ (strict) $1" >&2; fatal=$((fatal+1));
    else echo "  ⚠ $1" >&2; warns=$((warns+1)); fi
}

echo "── Safebox preflight ─────────────────────────────────────────"

# ── Must run as root ─────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "  ✗ preflight must run as root (sudo)" >&2
    exit 1
fi

# ── Required binaries ────────────────────────────────────────────
echo "[binaries]"
for bin in node npm systemctl sudo visudo openssl zpool zfs docker; do
    if command -v "$bin" >/dev/null 2>&1; then ok "$bin present"
    else bad "$bin not found in PATH"; fi
done

# Node >= 20
if command -v node >/dev/null 2>&1; then
    if node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' 2>/dev/null; then
        ok "node >= 20 ($(node -v))"
    else
        bad "node >= 20 required (have $(node -v 2>/dev/null || echo none))"
    fi
fi

# ── ZFS pool (install-base.sh hard-fails without exactly this name) ──
echo "[storage]"
if zpool list safebox-pool >/dev/null 2>&1; then
    ok "ZFS pool 'safebox-pool' exists"
else
    bad "ZFS pool 'safebox-pool' not found — create it before install:
        zpool create -o ashift=12 -O compression=lz4 -O atime=off safebox-pool <device>"
fi

# ── HMAC key for the system-protocol-api broker ──────────────────
# The broker reads /etc/safebox/system-api.key at startup and refuses to run
# without it. It can be generated now if absent (openssl rand -hex 64), so a
# missing key is a WARNING (installer/this script can create it), not fatal —
# unless --strict, where we expect it pre-provisioned.
echo "[secrets]"
KEY=/etc/safebox/system-api.key
if [[ -f "$KEY" ]]; then
    # sanity: must be non-empty and look like hex
    if [[ -s "$KEY" ]] && grep -qE '^[0-9a-f]+$' "$KEY"; then ok "system-api.key present and well-formed"
    else bad "system-api.key exists but is empty or malformed"; fi
else
    warn "system-api.key not present at $KEY (generate: openssl rand -hex 64 > $KEY; chmod 0640)"
fi

# ── Nitro attestation prerequisites ──────────────────────────────
# The system component derives its master key from Nitro PCRs via /dev/nsm and
# validates attestation docs against the AWS Nitro root cert. Off-Nitro (dev,
# cross-cloud) the box runs with a weaker attestation story, so these are
# warnings unless --strict.
echo "[attestation]"
NSM="${SAFEBOX_SYSTEM_NSM_DEVICE:-/dev/nsm}"
if [[ -e "$NSM" ]]; then ok "Nitro NSM device present ($NSM)"
else warn "Nitro NSM device $NSM not present — not running under Nitro (attestation will be degraded)"; fi

ROOT_PEM="${SAFEBOX_SYSTEM_NITRO_ROOT:-/etc/safebox/aws-nitro-root.pem}"
if [[ -f "$ROOT_PEM" ]]; then ok "AWS Nitro root cert present ($ROOT_PEM)"
else warn "AWS Nitro root cert $ROOT_PEM not present — attestation validation can't run"; fi

if command -v nsm-cli >/dev/null 2>&1; then ok "nsm-cli present"
else warn "nsm-cli not found (part of aws-nitro-enclaves-cli) — attestation doc generation unavailable"; fi

# ── Docker daemon reachable ──────────────────────────────────────
echo "[docker]"
if docker info >/dev/null 2>&1; then ok "docker daemon reachable"
else warn "docker daemon not reachable yet (base install configures + starts it)"; fi

# ── Verdict ──────────────────────────────────────────────────────
echo "──────────────────────────────────────────────────────────────"
if [[ $fatal -gt 0 ]]; then
    echo "PREFLIGHT FAILED: $fatal fatal, $warns warning(s). Fix the ✗ items before installing." >&2
    exit 1
fi
if [[ $warns -gt 0 ]]; then
    echo "PREFLIGHT PASSED with $warns warning(s). Review ⚠ items — acceptable for host-OS/dev, NOT for a production Nitro AMI (use --strict there)."
else
    echo "PREFLIGHT PASSED: all checks green."
fi
exit 0
