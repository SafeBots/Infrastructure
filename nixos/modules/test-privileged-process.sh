#!/usr/bin/env bash
# Config-level invariants for the orchestrator/privileged process split.
set -uo pipefail
M="$(cd "$(dirname "$0")" && pwd)/privileged-process.nix"
fails=0; ok(){ echo "  PASS $1"; }; no(){ echo "  FAIL $1"; fails=$((fails+1)); }

grep -q "safebox-privileged" "$M" && ok "creates safebox-privileged system user" || no "user missing"
grep -q "privileged.sock" "$M" && ok "socket at /run/safebox/privileged.sock" || no "socket path missing"
grep -q "chmod 0400" "$M" && ok "master key chmod 0400 (orchestrator cannot read)" || no "master key perms not enforced"
grep -q "chown safebox-privileged" "$M" && ok "master key owned by safebox-privileged only" || no "master key ownership not set"
grep -q "safebox-infra.service" "$M" && ok "boot order: after safebox-infra" || no "boot ordering missing"
grep -q "NoNewPrivileges" "$M" && ok "systemd hardening (NoNewPrivileges)" || no "hardening missing"
grep -q "CapabilityBoundingSet = \"\"" "$M" && ok "no capabilities (local-only process)" || no "capabilities not empty"
grep -q "ReadOnlyPaths" "$M" && ok "filesystem restricted (ReadOnlyPaths)" || no "fs restrictions missing"
grep -q "~1,800 lines to ~248 lines" "$M" && ok "documents the audit surface reduction" || no "audit surface not documented"

echo ""
[ $fails -eq 0 ] && echo "✓ privileged process split: user, socket, master-key isolation, boot order, hardening" || { echo "✗ $fails failed"; exit 1; }
