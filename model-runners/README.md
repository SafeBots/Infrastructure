# Model Runners

**AI/ML model inference containers consumed by the Safebox plugin via the system component's `/v1/<protocol>` endpoints.**

Runners are stateless containers that load a specific model from `/srv/safebox/models/<manifestHash>/` and expose an inference HTTP API. They don't fetch their own weights; the system component's `/models/install` endpoint handles all model acquisition with SHA-256-verified downloads and M-of-N governance from Safebox.

## Trust model

Every model on a Safebox is identified by the SHA-256 of its canonical manifest JSON. That hash is what Safebox M-of-N actually signs. The system component installs the model only after every weight file's SHA-256 matches the manifest. Runners read those weights read-only.

See [`aws/docs/MODELS-PROTOCOL.md`](../aws/docs/MODELS-PROTOCOL.md) for the wire spec.

## Everything is pinned — the whole chain, no exceptions

### Weight sources + mirrors (IPFS)

Weights are pinned by SHA-256 AND carry a `sources[]` list — our own
IPFS pinning node / Safecloud mirror first, upstream origin as fallback.
An IPFS **CID is itself the hash**, so a mirror needs no extra integrity
metadata; but content stays retrievable only if a node **pins** it, so we
run our own pin as the always-available source. See
[`WEIGHTS-SCHEMA.md`](./WEIGHTS-SCHEMA.md). This applies to every runner's
weights the same way image bases and the OS are pinned — one discipline,
top to bottom.


Inductive security means every layer starts from a known prior, all the way down.
A single floating reference (`:latest`, `master`, an unpinned base) is an
unpinned base case — "whatever the registry/repo serves at build time" — which is
exactly the trust-on-first-use hole the architecture exists to close. So the rule
is total:

| Layer | Pinned by | Never |
|---|---|---|
| OS base | nixpkgs **commit SHA** (flake.lock) | a channel/branch name |
| Runner **base image** (`FROM`/`ARG BASE`) | **`@sha256:` digest** | `python:3.11-slim`, `:latest` |
| Runner source ref (e.g. ComfyUI) | **pinned tag/commit** | `master`, `main` |
| App-tier containers | **`@sha256:` digest** (app-verify enforces) | floating tag |
| **Model weights** | **SHA-256 manifest**, M-of-N-signed | fetch-by-name at runtime |

Every `ARG BASE` in these Dockerfiles is a `@sha256:` digest placeholder
(`REPLACE_*_DIGEST`) resolved at build time with `docker manifest inspect`. Model
weights follow the manifest-hash discipline below. Nothing in the chain is
"latest" — that's what makes the base case of the induction a *known* value rather
than a moving one.

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
| `vllm/` | LLM (`/v1/chat`, `/v1/complete`, `/v1/embed`, `/v1/capabilities`, `/v1/capacity`) | **Working** — 774-line wrapper over vLLM's OpenAI-compatible server, Safebox-canonical protocol, streaming SSE, HMAC auth, audit-trail SHA-256 hashes, supervisord-managed container. Ships with manifests for Llama 3.3 70B, Qwen 3 32B, Mistral Small 3, Gemma 3 12B, DeepSeek V3. 41 unit tests pass. |
| `onnx/` | Embed/rerank/vision-encode (`/v1/embed`, `/v1/rerank`, `/v1/capabilities`) — the light 'not-LLM' tier | **New** — ONNX Runtime FastAPI service; embeddings, rerankers, CLIP/vision encoders, small classifiers. CPU-viable (lightest runner). Manifests: bge-small-en-v1.5 (embed), bge-reranker-base (rerank), clip-vit-base-patch32 (vision). Fills the embedding/vision-encoder gap the suite previously lacked. |
| `whisper/` | Transcription (`/v1/transcribe`, `/v1/transcribe/batch`) — audio → structured transcript with timestamps and language detection | **Working** — 648-line FastAPI service wrapping Faster-Whisper (CTranslate2-based, ~4× faster than reference). Streaming SSE for long audio, optional VAD filter, word-level timestamps, audit-trail SHA-256 hashes. Ships with manifests for large-v3-turbo, large-v3, medium, small, distil-large-v3. 33 unit tests pass. |
| `comfyui/` | Image (`/v1/image/generate`) — text-to-image diffusion (SDXL, FLUX) → PNG output | **Working** — 673-line FastAPI service translating Safebox protocol into ComfyUI workflow graphs, polling for completion, fetching output bytes. HMAC auth, audit-trail hashes, capability gating, output as file path or inline base64. Ships with workflow templates for SDXL and FLUX families, manifests for SDXL Base 1.0 (commercial OK), FLUX.1 schnell (Apache 2.0), FLUX.1 dev (non-commercial — flagged in the manifest). 53 unit tests pass. |
| `kokoro-tts/` | Speech (`/v1/speech`, `/v1/voices`) — text-to-audio synthesis with ~28 bundled voices | **Working** — 598-line FastAPI service wrapping Kokoro 82M (Apache 2.0, runs on CPU and consumer GPU). Streaming SSE for long-form text, WAV/MP3/OGG output, HMAC auth, audit-trail hashes. Ships with manifests for English and a multilingual variant (Japanese/Mandarin/French/Hindi/Italian/Portuguese). 41 unit tests pass. |
| `stable-audio-3/` | Audio (`/v1/audio/generate`) — text-to-audio diffusion (music, SFX, ambient) → WAV/MP3/OGG | **Working** — 544-line FastAPI service wrapping [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) for Stable Audio Open (Apache 2.0, free for commercial use). HMAC auth, audit hashes, output as file path or inline base64. Ships with two manifests: stable-audio-open-small (341M, 8-step pingpong, 11s clips, ~3-5s on consumer GPU) and stable-audio-open-1.0 (1.21B, 100-step DPM++ 3M-SDE, 47s clips, higher quality). 35 unit tests pass. |
| `ltx-video/` | Video (`/v1/video/generate`) — text-to-video and image-to-video diffusion → MP4 (with synchronized audio) | **Working** — 710-line FastAPI service wrapping LTX-Video 2.3 (Lightricks, Apache 2.0, March 2026 release). 16GB VRAM minimum, runs on consumer GPUs. Two manifests: ltx-2-3-distilled (8B distilled, 8 steps, ~20-40s per 5s clip on RTX 4090) and ltx-2-3-dev (22B base, 30 steps, higher quality). Image input optional for image-to-video. **Synchronized audio+video** generated in a single forward pass — best for ambient sound and foley. MAX_QUEUE_DEPTH=1 (video gen is slow). 49 unit tests pass. |
| `wan-video/` | Video (`/v1/video/generate`) — text-to-video and image-to-video, MoE diffusion → MP4 | **Working** — 616-line FastAPI service wrapping Wan 2.2 (Alibaba Tongyi Wanxiang, Apache 2.0). Sister runner to ltx-video — same protocol, complementary model. MoE architecture (27B total / 14B active per step) delivers higher quality at the cost of longer inference. Three manifests: wan-2-2-ti2v-5b (5B combined, 16GB VRAM), wan-2-2-t2v-a14b (MoE A14B, 24GB+ VRAM), wan-2-2-i2v-a14b (MoE A14B, image-to-video). Dual MoE guidance scales exposed as separate request fields. No native audio (use ltx-video for synced audio). 38 unit tests pass. |
| `triposr/` | 3D (`/v1/3d/generate`) — image-to-3D-mesh feed-forward reconstruction → GLB / OBJ / PLY | **Working** — 479-line FastAPI service wrapping TripoSR (Stability AI + Tripo AI, MIT). 6GB VRAM minimum, ~1 second per mesh on consumer GPU after cold start. Optional rembg background removal. Vertex colors only (PBR textures would require Hunyuan3D 2.1 — separate runner, post-1.0). One manifest. 36 unit tests pass. |
| `mineru/` | Document extraction (`/v1/extract`, `/v1/extract/batch`) — PDF / DOCX / PPTX / XLSX / images → Markdown / JSON | Working — wraps [opendatalab/MinerU 2.5](https://github.com/opendatalab/MinerU); pipeline and VLM backends both supported |

## Runners by protocol (planned + in scope)

Each protocol in [`docs/MODEL-CATALOG.md`](../docs/MODEL-CATALOG.md) has a corresponding runner directory shape:

- **LLM** → `vllm/` (working) — Safebox-canonical wrapper over vLLM; one model per container; ships with five manifests covering Llama / Qwen / Mistral / Gemma / DeepSeek families. Adding a new model is one JSON file.
- **Image** → `comfyui/` (working) — Safebox-canonical wrapper over ComfyUI; one model family per container; ships with SDXL and FLUX workflow templates and three manifests. License compliance is the operator's responsibility — manifests flag commercial-restricted models explicitly.
- **Speech (TTS)** → `kokoro-tts/` (working) — Kokoro 82M (Apache 2.0) as the production default; small enough to run on CPU, ~80-210× real-time on consumer GPU. Two manifests for English and multilingual configurations.
- **Transcription (ASR)** → `whisper/` (working) — Faster-Whisper-based; large-v3-turbo as the production default, large-v3 when translation is needed, smaller variants for laptop/CPU deployment.
- **Audio (music/SFX)** → `stable-audio-3/` (working) — Stable Audio Open (Apache 2.0) for music, sound effects, and ambient audio. Two manifests for the small (fast, 11s clips) and full (higher quality, 47s clips) variants.
- **Video** → `ltx-video/` and `wan-video/` (working — two complementary runners). `ltx-video/` wraps LTX-Video 2.3 (Lightricks, Apache 2.0) with synchronized audio+video in one model, 16GB VRAM, fast inference. `wan-video/` wraps Wan 2.2 (Alibaba, Apache 2.0) with MoE architecture for higher quality at the cost of longer inference; three manifests covering 5B and A14B variants. The two runners share the `/v1/video/generate` protocol so the Safebox plugin can route by model name to whichever container has the requested model loaded — typical pattern is to run both side-by-side, LTX for iteration drafts and Wan for finals.
- **3D** → `triposr/` (working) — TripoSR (Stability AI + Tripo AI, MIT). Image-to-mesh feed-forward reconstruction, ~1 second per mesh on consumer GPU. One manifest. PBR-texture-capable runner (Hunyuan3D 2.1) is post-1.0.
- **Privacy** → `privacy-filter/` (working)
- **Documents** → `mineru/` (working) — PDF, DOCX, PPTX, XLSX, scanned images into LLM-ready Markdown/JSON

For 1.0, **all nine protocols are production-ready across ten runners**: `privacy-filter`, `mineru`, `vllm`, `whisper`, `comfyui`, `kokoro-tts`, `stable-audio-3`, `ltx-video`, `wan-video`, and `triposr`. The complete media stack — text, image, audio, speech, transcription, video (two complementary models), 3D, documents, and privacy — ships locally on a single Safebox box. Post-1.0 work: a PBR-textured 3D runner (Hunyuan3D 2.1), audio-driven video (Wan 2.2-S2V), and video editing variants (Wan VACE).

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
