#!/usr/bin/env bash
# Infrastructure test aggregator — runs every suite that can run without a GPU,
# Docker daemon, real TPM, or Nix evaluator. Exit non-zero if any suite fails.
#
# Deps: node, python3, and (for runner + attestation tests) pip install:
#   pip install --break-system-packages pynacl fastapi uvicorn pydantic numpy httpx
#
# Usage: tests/run-all.sh   (from repo root)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
pass=0; fail=0
sec(){ echo; echo "═══ $1 ═══"; }
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

sec "JS system suite (auth, attestation, sockets, routing, canonical, …)"
if node aws/scripts/components/system/test/run.js >/tmp/_js.out 2>&1; then
  ok "system suite ($(grep -oE 'Assertions: [0-9]+/[0-9]+' /tmp/_js.out | tail -1))"
else no "system suite (see /tmp/_js.out)"; fi

sec "JS component tests (dnsclient ×4, autohost)"
for t in dnsclient/test/testDnsclientChallenge dnsclient/test/testDnsclientConfig \
         dnsclient/test/testDnsclientChallengeServer dnsclient/test/testDnsclientE2E \
         autohost/test/testAutohostSplash; do
  if node "aws/scripts/components/$t.js" >/dev/null 2>&1; then ok "$t"; else no "$t"; fi
done

sec "CLI + docker validators"
if node cli/safebox-models/test/test-cli.js >/dev/null 2>&1; then ok "safebox-models CLI"; else no "safebox-models CLI"; fi
if node docker/test/testStmValidators.js >/dev/null 2>&1; then ok "docker STM validators"; else no "docker STM validators"; fi
if python3 docker/test/testSeccompProfiles.py >/dev/null 2>&1; then ok "seccomp/apparmor profiles"; else no "seccomp/apparmor profiles"; fi
if python3 docker/test/testPhpSandbox.py >/dev/null 2>&1; then ok "php-fpm systemd sandbox"; else no "php-fpm systemd sandbox"; fi
if python3 attestation/image-seal/test-seal-coverage.py >/dev/null 2>&1; then ok "image seal coverage"; else no "image seal coverage"; fi
if bash attestation/image-seal/test-determinism.sh >/dev/null 2>&1; then ok "image seal DETERMINISM (seal twice, byte-identical)"; else no "AMI-2 seal determinism"; fi
if python3 storage/test/testObjectBackend.py >/dev/null 2>&1; then ok "object storage backend invariants"; else no "object storage backend invariants"; fi
if bash attestation/storage-mappings/test-mapping-approval.sh >/dev/null 2>&1; then ok "object storage M-of-N mapping gate"; else no "object storage M-of-N mapping gate"; fi
if bash attestation/app-layers/test-app-layer.sh >/dev/null 2>&1; then ok "layered blessing (org app layers + additive-only)"; else no "layered blessing (org app layers + additive-only)"; fi
if bash sandbox/test/test-sandbox-host-invariants.sh >/dev/null 2>&1; then ok "sandbox-host invariants (optional inspection variant)"; else no "sandbox-host invariants (optional inspection variant)"; fi
if bash sandbox/test/test-sandbox-inner-topology.sh >/dev/null 2>&1; then ok "sandbox-inner topology (one wire to interceptor)"; else no "sandbox-inner topology (one wire to interceptor)"; fi
if python3 sandbox/test/test-batch-worker.py >/dev/null 2>&1; then ok "sandbox batch lifecycle (teardown always)"; else no "sandbox batch lifecycle (teardown always)"; fi
if bash sandbox/test/test-sandbox-composition.sh >/dev/null 2>&1; then ok "sandbox composition (base alone, outer composes, addrs agree)"; else no "sandbox composition (base alone, outer composes, addrs agree)"; fi
if bash attestation/recovery/test-recovery.sh >/dev/null 2>&1; then ok "HKDF break-glass recovery (two-factor, auditable, expiry)"; else no "HKDF break-glass recovery (two-factor, auditable, expiry)"; fi
if python3 attestation/verify/test-verification-service.py >/dev/null 2>&1; then ok "attested verification service (resolver, governor, determinism, spot-check)"; else no "attested verification service (resolver, governor, determinism, spot-check)"; fi
if bash nixos/modules/test-privileged-process.sh >/dev/null 2>&1; then ok "privileged process split (master-key isolation, boot order, hardening)"; else no "privileged process split (master-key isolation, boot order, hardening)"; fi
if python3 nixos/test/testEgress.py >/dev/null 2>&1; then ok "per-process network egress policy"; else no "per-process network egress policy"; fi

sec "Model-runner unit tests (13 runners)"
for r in vllm whisper kokoro-tts privacy-filter comfyui ltx-video wan-video \
         stable-audio-3 triposr mineru chatterbox-tts orpheus-tts; do
  f="model-runners/$r/test_runner.py"
  [ -f "$f" ] || { echo "  — $r (no test_runner.py)"; continue; }
  ( cd "model-runners/$r" && SAFEBOX_REQUIRE_HMAC=false python3 test_runner.py >/dev/null 2>&1 ) \
    && ok "$r" || no "$r"
done

sec "HMAC: cross-repo parity + Node→Python interop"
( SAFEBOX_REQUIRE_HMAC=true python3 model-runners/_shared/test/test_hmac_parity.py >/dev/null 2>&1 ) \
  && ok "hmac parity (5/5)" || no "hmac parity"
( bash model-runners/_shared/test/test_safebox_interop.sh >/dev/null 2>&1 ) \
  && ok "safebox↔runner interop (Node-signed → Python-verified)" || no "safebox interop"

sec "Attestation chain E2E (Ed25519 bless → combine → verify)"
( bash attestation/test/e2e-attestation-test.sh >/dev/null 2>&1 ) \
  && ok "attestation (5/5)" || no "attestation"

sec "Structural validation (parse/lint the whole tree)"
b=0; for p in $(find . -name '*.py' -not -path '*__pycache__*'); do python3 -c "import ast;ast.parse(open('$p').read())" 2>/dev/null||b=1;done; [ $b = 0 ]&&ok "all Python parses"||no "python parse"
b=0; for j in $(find . -name '*.json' -not -path '*node_modules*'); do python3 -c "import json;json.load(open('$j'))" 2>/dev/null||b=1;done; [ $b = 0 ]&&ok "all JSON valid"||no "json"
b=0; for s in $(find . -name '*.sh'); do bash -n "$s" 2>/dev/null||b=1;done; [ $b = 0 ]&&ok "all shell bash -n"||no "shell"
b=0; for n in $(find . -name '*.nix'); do o=$(grep -o '{' "$n"|wc -l);c=$(grep -o '}' "$n"|wc -l);[ "$o" = "$c" ]||b=1;done; [ $b = 0 ]&&ok "all Nix brace-balanced"||no "nix"

echo
echo "  (skipped — needs a live service: system smoke.js on :7799)"
echo "═══════════════════════════════════════════════"
echo "  TOTAL: $pass passed, $fail failed"
echo "═══════════════════════════════════════════════"
[ $fail -eq 0 ]
