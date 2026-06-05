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
| `privacy-filter/` | PII redaction (called from other runners, not a public protocol) | **Working** — 448-line FastAPI service, used pre-LLM-inference |
| `vllm/` | LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`) — production GPU serving | **Adapter complete + lifecycle stubs** — wraps vLLM 0.6.0's OpenAI server. Lifecycle endpoints (`/v1/models/load`, `/v1/models/unload`, `/v1/cache/flush`) return contract-shaped responses; full hot-swap support waits for vLLM multi-model. |
| `llama-cpp/` | LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`) — edge/laptop with explicit KV slots | **Skeleton** — adapter routes wired, llama-server build via Dockerfile, slot endpoints exposed (`/v1/cache/slots/*`). Production hardening (slot allocation policy, per-tenant pinning, observability) is next. |
| `stable-audio-3/` | Music & sound effects (`/v1/audio/generate`) | **Stub** — config loading and weight-verification path; inference loop pending integration of `stable-audio-tools` |
| `yue-music/` | Music — full-song generation from lyrics + style (`/v1/audio/generate`) | **Planned** — for YuE-s1-7B (Apache 2.0). Manifest at [`config/artifacts/models/yue-s1-7b.json`](../config/artifacts/models/yue-s1-7b.json) |
| `diffusion-video/` | Video (`/v1/video/generate`) | **Planned** — for Mochi 1 (Apache 2.0). Likely ComfyUI workflow backend. Manifest at [`config/artifacts/models/mochi-1-preview.json`](../config/artifacts/models/mochi-1-preview.json) |
| `comfyui-image/` | Image (`/v1/image/generate`) | **Planned** — for FLUX.1 schnell (Apache 2.0), SDXL. ComfyUI workflow backend. Manifest at [`config/artifacts/models/flux-1-schnell.json`](../config/artifacts/models/flux-1-schnell.json) |
| `kokoro-tts/` | Speech (`/v1/speech`) | **Planned** — for Kokoro 82M v1.0 (Apache 2.0). Tiny footprint, CPU-capable. Manifest at [`config/artifacts/models/kokoro-82m.json`](../config/artifacts/models/kokoro-82m.json) |
| `whisper-asr/` | Transcription (`/v1/transcribe`) | **Planned** — for Whisper Large v3 (MIT). faster-whisper backend likely. Manifest at [`config/artifacts/models/whisper-large-v3.json`](../config/artifacts/models/whisper-large-v3.json) |
| `triposr-3d/` | 3D mesh (`/v1/3d/generate`) | **Planned** — for TripoSR (MIT). Single-image feed-forward reconstruction. Manifest at [`config/artifacts/models/triposr.json`](../config/artifacts/models/triposr.json) |
| `nemotron-omni/` | Multimodal — vision + audio + video + text in one model | **Planned** — for Nemotron 3 Nano Omni (NVIDIA Open Model License). 30B params with 3B active, 1M context. Manifest at [`config/artifacts/models/nemotron-3-nano-omni.json`](../config/artifacts/models/nemotron-3-nano-omni.json) |

The six "planned" runners share the same shape: FastAPI adapter exposing the canonical Safebox endpoints, mounting weights read-only from `/srv/safebox/models/<manifestHash>/`, gated by the `verifiedOpToken` from M-of-N governance. None of them fetch their own weights. See [MODEL-UPDATES.md](../docs/MODEL-UPDATES.md) for the full install and update flow.

## When to use which LLM runner

The two LLM runners speak the same Safebox wire protocol. Pick by hardware tier and concurrency model.

|  | `vllm/` | `llama-cpp/` |
|---|---|---|
| **Hardware** | NVIDIA GPU required | CPU + optional GPU offload (CUDA, Metal, Vulkan, ROCm) |
| **Best for** | Server-grade GPU production (A100, H100) | Laptops, single-GPU consumer hardware, edge, the Gemma 4 12B / 16 GB story |
| **Quant formats** | safetensors (FP16/BF16/INT8) | GGUF (4/5/6/8-bit, K-quants, IQ-quants) |
| **KV cache** | PagedAttention. Prefix caching automatic via `--enable-prefix-caching`. No per-slot pinning. | Explicit `--slots N`. Save/restore slots by ID. Per-conversation pinning. Persistable across restarts. |
| **Concurrency** | Continuous batching; higher throughput, batching adds latency | One slot per concurrent conversation; lower throughput, lower latency at low load |
| **Tenancy** | Cache scopes via salt rotation | Cache scopes via slot membership; tenant/tag-scoped slot release |
| **Memory: 12B** | ~24 GB (FP16) | ~7 GB (Q4_K_M), ~9 GB (Q5_K_M), ~13 GB (Q8_0) |

**Rule of thumb:** use `vllm/` when you have server-grade GPUs and need throughput; use `llama-cpp/` when you don't, or when the per-conversation cache slot model matters for your agent's caching strategy. The Safebots LLM wrapper (`plugins/Safebots/classes/Safebots/LLM.js`) was designed around llama.cpp's explicit slots.

## Runners by protocol (planned + in scope)

- **LLM** → `vllm/` (production GPU) + `llama-cpp/` (edge/laptop, slot-based KV)
- **Image** → `comfyui/` (planned; ComfyUI workflows for SDXL, FLUX, etc.)
- **Speech (TTS)** → `vibevoice/` (planned)
- **Transcription (ASR)** → `whisper/`, `vibevoice-asr/` (planned)
- **Audio (music/SFX)** → `stable-audio-3/` (skeleton)
- **Video** → `hunyuan-video/` (planned)
- **3D** → `shap-e/` or `triposr/` (planned)
- **Privacy** → `privacy-filter/` (working)

For 1.0, `privacy-filter` is production-ready and `vllm/` + `llama-cpp/` provide the LLM tier with contract-conformant lifecycle endpoints. The others establish the shape and will be filled in for 1.1 in parallel with the per-tier installer scripts.

## Runner contract

Every runner directory contains:

- `README.md` — what the runner does, hardware requirements, API
- `Dockerfile` — builds the container image
- `runner.py` (or equivalent) — the inference service
- `requirements.txt` — Python deps if it is a Python runner
- `manifest.json` — declares `envVars`, `outputFiles`, `exitCodes`, `resourceHints` per the image manifest contract

A runner consumes:
- Model weights at `/srv/safebox/models/<manifestHash>/` (mounted read-only)
- Runner config at `/etc/safebox/runners/<runner-name>/config.json` (mounted read-only)

A runner exposes:
- HTTP on `127.0.0.1:<port>` (or a unix socket at `/run/safebox/services/<service-id>.sock`) with the protocol's standard endpoints
- A `/health` endpoint for the system component to probe
- A `/v1/capabilities` descriptor

LLM-shaped runners additionally expose the M-of-N-gated lifecycle endpoints:

- `POST /v1/models/load` — load a model (gated by `verifiedOpToken`)
- `GET /v1/models/load/{taskId}` — poll an async load
- `POST /v1/models/unload` — unload a model
- `POST /v1/cache/flush` — flush KV cache (scope = all / model / tenant / tag)

`llama-cpp/` also exposes slot-management endpoints:

- `GET /v1/cache/slots` — list active slots
- `POST /v1/cache/slots/allocate` — reserve a slot
- `POST /v1/cache/slots/save` — persist KV state
- `POST /v1/cache/slots/restore` — reload saved state
- `POST /v1/cache/slots/release` — free a slot

## Why this split

The supply chain separation matters. If the runner fetched its own weights, a runner-side bug could swap them out without governance. By making weight acquisition a separate, host-scoped System call, the runner's compromise surface is bounded — even a fully owned runner cannot substitute different model weights for the ones Safebox approved.

The same logic applies to `dnf upgrade`: it is a host-wide action, gated by `_host` scope, and the same governance applies. Model installs are in the same blast-radius category.
