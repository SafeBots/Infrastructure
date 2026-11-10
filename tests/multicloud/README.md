# Multi-Cloud Integration Tests

End-to-end tests that verify safeboxes on different clouds can discover,
attest, and mesh with each other.  These are integration tests — they
require **running safebox instances on at least two different clouds**.

## Prerequisites

| Requirement | Notes |
|---|---|
| 2+ running safeboxes | Each on a different cloud (AWS, Azure, GCP, OCI) |
| Network connectivity | Each safebox must be reachable on ports 443 / 8443 |
| `curl` ≥ 7.76 | For `--fail-with-body` |
| `jq` ≥ 1.6 | JSON parsing |
| `openssl` ≥ 3.0 | Ed25519 signature verification in cross-attestation |

## Test scripts

| Script | What it tests |
|---|---|
| `test-peer-discovery.sh` | Health, attestation claims, peer discovery |
| `test-cross-attestation.sh` | Cross-cloud Ed25519 claim verification, staleness |
| `test-safenet-mesh.sh` | Registry membership, name-claim propagation, transparency-log consistency |

## Usage

Every script takes `--endpoints` with a comma-separated list of safebox
URLs (scheme + host, no trailing slash):

```bash
# Quick smoke test — two clouds
./test-peer-discovery.sh \
  --endpoints https://sb-abc.example.com,https://sb-xyz.example.com

# Full mesh — all four clouds
./test-safenet-mesh.sh \
  --endpoints https://aws-sb.example.com,https://az-sb.example.com,\
https://gcp-sb.example.com,https://oci-sb.example.com
```

Exit code 0 means all checks passed; exit code 1 means at least one
failed.  Coloured output (PASS / FAIL) is written to stderr so it can
be separated from machine-readable JSON on stdout when `--json` is
added in a future version.

## Running in CI

These tests are designed to run as a post-deploy gate in the
multi-cloud CI pipeline (`.github/workflows/build-images.yml`).  The
workflow spins up one safebox per cloud, waits for health, then runs
the three scripts in order.
