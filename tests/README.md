# Infrastructure test suite

`tests/run-all.sh` aggregates every suite that runs without a GPU, Docker
daemon, real TPM, or Nix evaluator, and exits non-zero if any fails.

```
pip install --break-system-packages pynacl fastapi uvicorn pydantic numpy httpx
tests/run-all.sh
```

## What it runs

| Suite | Location | Covers |
|-------|----------|--------|
| JS system suite | `aws/scripts/components/system/test/run.js` | auth/HMAC, attestation derive+roundtrip, sockets, container routing, canonical models, lockfile hash, per-container keys, workdir sanitizer (15 files / 296 assertions) |
| JS component tests | `aws/scripts/components/{dnsclient,autohost}/test/` | DNS challenge/config/challenge-server/E2E (×4), autohost splash |
| CLI | `cli/safebox-models/test/test-cli.js` | model-file discovery, SHA-256, sizes |
| Docker validators | `docker/test/testStmValidators.js` | pinned-commit verify hard-fail semantics (70 assertions) |
| Model-runner units | `model-runners/<runner>/test_runner.py` | request translation, capacity hints, headers, and HMAC delegation for all 13 runners |
| HMAC parity | `model-runners/_shared/test/test_hmac_parity.py` | strong canonical form accepted; endpoint-swap / replay / weak-form / expired rejected |
| Safebox interop | `model-runners/_shared/test/test_safebox_interop.sh` | **cross-language**: request signed the `auth.js`/LocalRunner way in Node, verified by the Python shared runner module |
| Attestation E2E | `attestation/test/e2e-attestation-test.sh` | real Ed25519 bless → combine (M-of-N) → verify; KOSHER + NOT-KOSHER (insufficient signers / tampered / revoked) + fail-closed on unverified quote |
| Structural | (inline) | every `.py` parses, every `.json` valid, every `.sh` `bash -n`, every `.nix` brace-balanced |

## Integration (skipped in CI — needs a live service)

`aws/scripts/components/system/test/smoke.js` spins up the system component on
port 7799 and drives it over HTTP. It needs the actual service running, so the
aggregator skips it; run it by hand against a live box.

## What it does NOT cover (needs real hardware / paired repo)

`nix flake check` and image build (no evaluator; nixpkgs pin is a placeholder);
live model serving (no GPU/Docker); real hardware attestation quotes (no
TPM/SEV-SNP); runner-launch env forwarding; and live-runner HMAC over the
socket. See `../E2E-TEST-RESULTS.md` for the full boundary and the pre-AMI
checklist.
