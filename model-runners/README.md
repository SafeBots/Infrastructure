# Model Runners

**AI/ML model inference containers consumed by the Safebox plugin via the system component's `/v1/<protocol>` endpoints.**

Runners are stateless containers that load a specific model from `/srv/safebox/models/<manifestHash>/` and expose an inference HTTP API. They don't fetch their own weights; the system component's `/models/install` endpoint handles all model acquisition with SHA-256-verified downloads and M-of-N governance from Safebox.

## Trust model

Every model on a Safebox is identified by the SHA-256 of its canonical manifest JSON. That hash is what Safebox M-of-N actually signs. The system component installs the model only after every weight file's SHA-256 matches the manifest. Runners read those weights read-only.

See [`aws/docs/MODELS-PROTOCOL.md`](../aws/docs/MODELS-PROTOCOL.md) for the wire spec.

```
Safebox (M-of-N gov)        System                        Runner
─────────────────           ────────                       ──────
sign manifest hash
POST /models/install   ───►  download files
                             verify SHA-256
                             move to /srv/safebox/
                             models/<hash>/
POST /system (start)   ───►  docker run --mount             load weights from
                             /srv/safebox/models/...        /srv/safebox/models/
                             ────────────────────────────►  <hash>/ (read-only)
                                                            expose :7790
POST /v1/audio/gen     ───►  proxy to runner          ───►  generate
                       ◄───  audio                    ◄───
```

## Available runners

| Runner | Protocol | Status |
|---|---|---|
| `privacy-filter/` | PII redaction (not a public protocol; called from other runners) | Working — 448-line FastAPI service, used pre-LLM-inference |
| `vllm/` | LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`) | Extension code for vLLM 0.6.0 (`runner_extensions.py`); integration with the Safebox image-manifest contract |
| `stable-audio-3/` | Music & sound effects (`/v1/audio/generate`) | Skeleton with config loading and weight-verification path; inference loop pending integration of `stable-audio-tools` |

## Runners by protocol (planned + in scope)

Each protocol in [`docs/MODEL-CATALOG.md`](../docs/MODEL-CATALOG.md) has a corresponding runner directory shape:

- **LLM** → `vllm/` (vLLM-based; covers chat, completion, embedding for OSS LLMs)
- **Image** → `comfyui/` (planned; ComfyUI workflows for SDXL, FLUX, etc.)
- **Speech (TTS)** → `vibevoice/` (planned)
- **Transcription (ASR)** → `whisper/`, `vibevoice-asr/` (planned)
- **Audio (music/SFX)** → `stable-audio-3/` (skeleton)
- **Video** → `hunyuan-video/` (planned)
- **3D** → `shap-e/` or `triposr/` (planned)
- **Privacy** → `privacy-filter/` (working)

For 1.0, only `privacy-filter` is production-ready. The others establish the shape and will be filled in for 1.1 in parallel with the per-tier installer scripts (`aws/scripts/components/llm-*`, etc.).

## Runner contract

Every runner directory contains:

- `README.md` — what the runner does, hardware requirements, API
- `Dockerfile` — builds the container image
- `runner.py` (or equivalent) — the inference service
- `requirements.txt` — Python deps if it's a Python runner
- `manifest.json` (at runtime, inside the container at `/app/manifest.json`) — declares `envVars`, `outputFiles`, `exitCodes`, `resourceHints` per the [image manifest contract](../docs/MODEL-RUNNER-API-SPEC.md)

A runner consumes:
- Model weights at `/srv/safebox/models/<manifestHash>/` (mounted read-only)
- Runner config at `/etc/safebox/runners/<runner-name>/config.json` (mounted read-only)

A runner exposes:
- HTTP on `127.0.0.1:<port>` with the protocol's standard endpoints
- A `/v1/healthz` for the system component to probe
- Capability descriptor at `GET /v1/capabilities` (see [`MODEL-RUNNER-API-SPEC.md`](../docs/MODEL-RUNNER-API-SPEC.md))

## Why this split

The supply chain separation matters. If the runner fetched its own weights, a runner-side bug could swap them out without governance. By making weight acquisition a separate, host-scoped System call, the runner's compromise surface is bounded — even a fully owned runner can't substitute different model weights for the ones Safebox approved.

The same logic applies to `dnf upgrade`: it's a host-wide action, gated by `_host` scope, and the same governance applies. Model installs are in the same blast-radius category.
