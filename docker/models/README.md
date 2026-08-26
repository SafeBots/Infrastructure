# Model weights on Safebox — see the GOVERNED system

**This is a pointer. The real model architecture is not here.**

Model weights are installed and governed by the **system component**, not by the
static compose tier. The canonical flow:

```
Safebox M-of-N signs manifest hash
  -> POST /models/install  (system component downloads + SHA-256-verifies)
  -> weights land at /srv/safebox/models/<manifestHash>/  (read-only)
  -> POST /system start    (docker run the runner, mount weights read-only)
```

- **Runner definitions + manifests:** `../../model-runners/`
  (vllm, whisper, comfyui, kokoro-tts, stable-audio-3, ltx-video, wan-video,
  triposr, mineru, privacy-filter — each with SHA-256-manifested models).
- **Wire protocol:** `../../aws/docs/MODELS-PROTOCOL.md`.
- **Kimi K3 / Nemotron Omni:** new manifests under
  `../../model-runners/vllm/manifests/` — they run on the EXISTING governed vLLM
  runner, not as new static services.

## Why weights are on encrypted ZFS

The `models` ZFS dataset (`nixos/modules/zfs.nix`) provides the encrypted,
measurement-sealed store that `/srv/safebox/models/` lives on. Weights are
category-2 data: inert, hash-pinned, mounted read-only into runners. The
integrity guarantee is the system component's SHA-256 verification against the
M-of-N-signed manifest hash — not a separate mechanism.

## The pinning invariant (applies everywhere)

Nothing floating, anywhere in the chain — that's what inductive security means:

- OS base -> nixpkgs **commit** (flake.lock)
- Runner base images -> **@sha256 digest** (model-runners/*/Dockerfile)
- Runner source refs -> **pinned tag/commit** (never master/main)
- App-tier containers -> **@sha256 digest** (app-verify enforces, fail-closed)
- Model weights -> **SHA-256 manifest**, M-of-N-signed (system component enforces)
