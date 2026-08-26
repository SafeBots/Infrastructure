# End-to-end testing — results and honest scope

**Run:** finalization pass. **Environment:** CI container — no Nix toolchain, no
GPU, no Docker daemon, no real TPM/SEV-SNP hardware, no Safebox plugin repo.

This document records exactly what was tested end-to-end, what passed, and what
genuinely cannot be exercised here and needs real hardware or the paired repo.

---

## What is VERIFIED end-to-end (ran, passed)

### 1. Safebox ↔ runner HMAC seam — cross-language, the real interop contract
The seam that matters most: a request signed the way `auth.js` / the Safebox
`LocalRunner` signs it must authenticate against every model runner.

- **`model-runners/_shared/test/test_safebox_interop.sh`** — signs a request in
  **Node** using the exact `auth.js` canonical form
  (`ts\nnonce\nmethod\npath\nsha256(body)-hex`), verifies it with the **Python**
  shared module every runner delegates to. **PASS.** Confirmed `auth.js` uses
  the identical `canonicalize()` function, so this is a true cross-repo proof.
- **`model-runners/_shared/test/test_hmac_parity.py`** — 5/5 PASS: strong-form
  accepted; endpoint-swap, nonce-replay, legacy weak-form, and expired-timestamp
  all rejected.
- **All 11 runners** confirmed to delegate to the one shared verifier
  (`from safebox_auth import verify_hmac as _sb_verify; return _sb_verify(...)`),
  and all 11 vendored copies are byte-identical to `_shared/safebox_auth.py`
  (canonical sha256 `e66e7f21…`).

### 2. Attestation trust decision — real Ed25519, full chain
- **`attestation/test/e2e-attestation-test.sh`** — 5/5 PASS:
  - measurement → auditorA + auditorB **bless** (Ed25519) → **combine** M-of-N
    → **verify** ⇒ **KOSHER ✅**
  - insufficient trusted signers (M=2, user trusts 1) ⇒ **NOT KOSHER**
  - tampered measurement ⇒ **NOT KOSHER**
  - revoked measurement ⇒ **NOT KOSHER**
  - bare doc without hardware-root verification ⇒ **REFUSED** (fail-closed)
- The verifier correctly **refuses to trust a measurement whose hardware quote
  has not been validated** by the per-cloud validator — a security property, not
  a bug. The test sets `_hardware_verified` to exercise the software
  trust-decision logic past that gate.

### 3. Whole-tree structural validation (all PASS)
- 43/43 JSON files valid
- 44/44 Python files parse
- 30/30 shell scripts pass `bash -n`
- 9/9 Nix files brace-balanced (no evaluator in container — see below)
- system JS components pass `node --check`
- 34/34 model manifests carry `name` + `license` and correct `sources[]`
  ordering (ipfs first, HF-origin-at-pinned-rev last)

---

## Issue found and fixed by this pass

- **Two TTS runners had manifests but no implementation** (`chatterbox-tts`, `orpheus-tts`): only README + manifests existed, so they could not build or launch. Implemented from the `kokoro-tts` scaffold with model-specific loaders; all 13 runners now map to a Dockerfile + runner.py and share one HMAC verifier.

## What CANNOT be tested here (needs real hardware / paired repo)

These are not failures — they are outside a CI container's reach. Listed so
nobody mistakes "structurally valid" for "booted and served."

- **NixOS image build / boot.** No Nix evaluator in-container. Nix validation is
  brace-balance only; it has NOT been through `nixos-rebuild` or a real
  `nix flake check`. **Before AMI cut: run a real `nix flake check` and a test
  build.**
- **Live model serving.** No GPU / no Docker daemon. Runners are import- and
  syntax-validated and their HMAC path is proven, but no runner has actually
  loaded weights or served a token here. Manifests' per-shard SHA-256 and CIDs
  remain build-time placeholders by design.
- **Real hardware attestation quote.** No TPM/SEV-SNP. The per-cloud validators
  (`attestation/verify/hardware/`) that set `_hardware_verified` chain to real
  cloud cert chains and can only be exercised on the actual instance.
- **The runner-launch env forwarding.** `SAFEBOX_REQUIRE_HMAC=true` is set in
  the attested `hosts/safebox.nix` profile with a build assertion, but whether
  the launch unit forwards the env to `docker run` must be confirmed on a real
  boot (see `HMAC-CANONICAL-FORM-FIX.md`).

---

## Pre-AMI checklist (the real-hardware half)

1. `nix flake check` + test build of the `safebox` host.
2. Boot an instance; run the per-cloud hardware validator; confirm
   `verify-attestation.py` returns KOSHER on a genuine quote.
3. Confirm the runner-launch unit forwards `SAFEBOX_REQUIRE_HMAC` (or add `-e`).
4. Pull one real model per runner family; capture per-shard SHA-256 + pin
   revisions; pin CIDs after IPFS add.
5. Re-run both HMAC harnesses against a *live* runner over the socket, not just
   the shared module.
