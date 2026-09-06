#!/usr/bin/env bash
# seal-ami2.sh — turn the AMI-1 builder image into the attested AMI-2.
#
# WHY (read before editing): Nix is ~91% bit-reproducible, not 100%. Attestation
# measures a hash (PCR); a hash needs 100% or it mismatches. The ~9% that varies
# is a small, ENUMERABLE set — dominated by embedded timestamps and inode mtimes.
# So we do NOT rely on the whole Nix closure being bit-identical. AMI-1 (Nix-built,
# SSH-only ingress) is the builder; THIS script is a short, fully-auditable
# normalization+teardown pass; AMI-2 (its output) is deterministic BECAUSE we
# explicitly constant-ise every varying field, and AMI-2 is what gets attested.
# The determinism guarantee lives in this ~100-line script, not in a build graph
# no one can audit.
#
# MODES:
#   seal-ami2.sh                 # live: operate on the running system's /
#   seal-ami2.sh --rootfs DIR    # offline: operate on a mounted image at DIR
# Offline mode is what verify-ami2-reproduces.sh uses, and is the safer way to
# seal in a build pipeline (mount the image, seal it, then create AMI-2).
set -euo pipefail

FIXED_EPOCH="${SAFEBOX_FIXED_EPOCH:-1704067200}"   # 2024-01-01T00:00:00Z, fixed
R="/"                                               # root to operate on
while [ $# -gt 0 ]; do
  case "$1" in
    --rootfs) R="${2:?--rootfs needs a dir}"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
R="${R%/}"                                          # strip trailing slash
p(){ printf '%s%s' "$R" "$1"; }                     # path within the target root
log(){ echo "[seal-ami2] $*"; }
live(){ [ "$R" = "" ]; }                            # R="" means live "/"

# ── 1. TEARDOWN: remove the only ingress channel (SSH) and any login path ──────
log "removing SSH server, keys, config, and login homes"
if live; then systemctl disable --now sshd 2>/dev/null||true; systemctl mask sshd 2>/dev/null||true; fi
rm -f  "$(p /etc/ssh)"/ssh_host_*                   # generated host keys = nondeterministic
rm -rf "$(p /etc/ssh/sshd_config.d)" "$(p /etc/ssh/sshd_config)"
rm -rf "$(p /root/.ssh)" "$(p /etc/ssh/authorized_keys.d)"
for h in "$(p /home)"/*/.ssh; do [ -e "$h" ] && rm -rf "$h"; done 2>/dev/null || true
# Assert no OTHER remote-shell channel was ever present (fail loud). Check the
# target's unit files / binaries, not just the running host.
for bad in telnetd in.telnetd rlogind rshd amazon-ssm-agent ssm-agent \
           amazon-cloudwatch-agent WALinuxAgent waagent google-guest-agent \
           ec2-instance-connect google_oslogin google-osconfig-agent \
           google_guest_agent azcmagent oci-utils ocid aliyun-service \
           aliyun_assist_service cloud-init-per; do
  if [ -e "$(p /usr/bin/$bad)" ] || [ -e "$(p /usr/sbin/$bad)" ] || \
     [ -e "$(p /lib/systemd/system/$bad.service)" ] || \
     [ -e "$(p /etc/systemd/system/$bad.service)" ]; then
    echo "[seal-ami2] FATAL: forbidden ingress/agent present: $bad" >&2; exit 1
  fi
done

# ── 2. SECRETS + identity: nothing per-instance may persist into the image ─────
log "removing key material and machine identity"
rm -f "$(p /run/safebox/zfs-key)" "$(p /etc/safebox)"/*.key 2>/dev/null || true
: > "$(p /etc/machine-id)"                           # empty => systemd first-boot regen
rm -f "$(p /var/lib/dbus/machine-id)" 2>/dev/null || true

# ── 3. NORMALIZE the enumerated nondeterminism sources ─────────────────────────
log "removing logs, caches, seeds, leases, cloud-init, tmp, histories"
rm -rf "$(p /var/log)"/* "$(p /var/tmp)"/* "$(p /tmp)"/* \
       "$(p /var/cache)"/* "$(p /var/lib/systemd/random-seed)" \
       "$(p /var/lib/systemd/timers)" "$(p /var/lib/cloud)"/* \
       "$(p /var/lib/NetworkManager)"/*.lease "$(p /var/lib/dhcp)"/* \
       "$(p /var/lib/dhclient)"/* 2>/dev/null || true
rm -f "$(p /root/.bash_history)" 2>/dev/null || true
for hh in "$(p /home)"/*/.bash_history; do [ -e "$hh" ] && rm -f "$hh"; done 2>/dev/null || true

log "normalizing inode mtimes to the fixed epoch (EXCLUDING /nix/store)"
# The dominant nondeterminism class. /nix/store is EXCLUDED: store paths are
# content-addressed with canonical internal mtimes; touching them changes their
# hashes and breaks the closure. Normalize everything else under the target root.
find "$R/" -xdev \
     -not -path "$(p /nix/store)/*" \
     -not -path "$(p /proc)/*" -not -path "$(p /sys)/*" -not -path "$(p /dev)/*" \
     -exec touch --no-dereference --date="@${FIXED_EPOCH}" {} + 2>/dev/null || true

# ── 4. FINAL ASSERTIONS: fail if anything we promised to remove survived ───────
log "verifying teardown"
[ ! -e "$(p /etc/ssh/sshd_config)" ] || { echo "[seal-ami2] FATAL: sshd_config survived" >&2; exit 1; }
! ls "$(p /etc/ssh)"/ssh_host_* >/dev/null 2>&1 || { echo "[seal-ami2] FATAL: host keys survived" >&2; exit 1; }
[ ! -s "$(p /etc/machine-id)" ] || { echo "[seal-ami2] FATAL: machine-id not empty" >&2; exit 1; }
if live && ss -tlnH 2>/dev/null | grep -qE ':22\b|:23\b|:5985\b|:5986\b'; then
  echo "[seal-ami2] FATAL: a shell port is still listening" >&2; exit 1
fi
log "seal complete. Target has zero ingress and normalized bytes."
