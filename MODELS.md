# Safebox Infrastructure — Supported Models

**Quick reference for which models run on which runners, with hardware and cost.**

For the full catalog with benchmarks and feature details, see [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md).

---

## LLM Models

| Model | Params | Runner | Hardware | Speed | Context | SAFEBUX |
|-------|--------|--------|----------|-------|---------|---------|
| DeepSeek-R1 | 671B MoE | vllm | 8× H100 80GB | 37 tok/s | 128K | 1.5 |
| DeepSeek-R1-Distill-70B | 70B | vllm | 2× A100 80GB | 85 tok/s | 128K | 0.8 |
| DeepSeek V4.1 Flash | 552B MoE | u-omni, vllm | 4× H100 80GB | ~120 tok/s | 128K | 0.6 |
| LLaMA 3.3 70B | 70B | vllm | 2× A100 80GB | 90 tok/s | 128K | 0.7 |
| Kimi K3.1 Pro | 2.8T MoE (104B active) | vllm | ~16× H100 80GB | TBD | 1M | TBD |
| Ornith-1.0-397B | 397B MoE | vllm | 8× H100 80GB | TBD | 256K | TBD |
| Ornith-1.0-35B | 35B MoE | vllm | 1× H100 80GB | TBD | 256K | 0.5 |
| Ornith-1.0-9B | 9B | vllm | 1× A100 40GB | TBD | 256K | 0.3 |
| GLM-5.1 (Z.ai) | — | vllm | 2× H100 80GB | ~60 tok/s | — | 1.2 |
| LLaMA 3.1 8B | 8B | vllm | 1× A100 40GB | 150 tok/s | 128K | 0.3 |
| Qwen 2.5 Coder 32B | 32B | vllm | 1× A100 80GB | 95 tok/s | 32K | 0.5 |
| Qwen 3.6-35B-A3B | 35B MoE | vllm | 1× RTX 4090 | ~100 tok/s | — | 0.5 |
| Qwen3.8-Flash-Next | ~35B MoE | u-omni, vllm | 1× H100 80GB | ~130 tok/s | 128K | 0.4 |
| Qwen3.8-Omni-Flash | ~35B MoE | u-omni | 1× H100 80GB | ~100 tok/s | 128K | 0.5 |
| Mistral Small 22B | 22B | vllm | 1× A100 80GB | 110 tok/s | 32K | 0.4 |
| BGE-Large-EN-v1.5 | 335M | vllm | 1× T4 | 2000 emb/s | — | 0.01 |

### U-Omni Native Models

These models run on the [U runtime](model-runners/u-omni/) for native multimodal inference with tree-structured KV cache management (fork-based CoW in RAM, ZFS CoW on disk).

| Model | Modalities | KV bytes/token | 4K ctx | 32K ctx | 128K ctx |
|-------|-----------|---------------|--------|---------|----------|
| DeepSeek V4.1 Flash (MLA) | text | ~890 | ~3.5MB | ~28MB | ~110MB |
| Qwen3.8-Flash-Next | text | ~640 | ~2.5MB | ~20MB | ~80MB |
| Qwen3.8-Omni-Flash | text, vision, audio | ~640 | ~2.5MB | ~20MB | ~80MB |

---

## Image Models

| Model | Runner | Hardware | Speed | SAFEBUX |
|-------|--------|----------|-------|---------|
| SDXL 1.0 | comfyui | 1× A100 40GB | 2-3 img/min @ 1024² | 2.0 |
| Flux.1 Dev | comfyui | 1× H100 80GB | 1 img/min @ 1024² | 3.5 |
| Flux.1 Schnell | comfyui | 1× A100 40GB | 4-5 img/min @ 1024² | 1.5 |
| InstantID | comfyui | 1× A100 40GB | — | 2.5 |
| ControlNet (SDXL) | comfyui | 1× A100 40GB | — | 2.5 |

---

## Speech Models (TTS)

| Model | Runner | Hardware | Speed | SAFEBUX |
|-------|--------|----------|-------|---------|
| VibeVoice-1.5B | kokoro-tts | 1× H100 80GB | 0.5× RT (90 min max) | 15/hr |
| VibeVoice-Realtime-0.5B | kokoro-tts | 1× H100 40GB | 1× RT (streaming) | 8/hr |
| VibeVoice-Large-7B | kokoro-tts | 1× H100 80GB | 0.3× RT | 20/hr |

---

## Transcription Models (STT)

| Model | Runner | Hardware | Speed | SAFEBUX |
|-------|--------|----------|-------|---------|
| VibeVoice-ASR-7B | whisper | 1× A100 80GB | 15× RT (60 min max) | 0.8/hr |
| Whisper Large v3 | whisper | 1× A100 40GB | 50× RT (30s chunks) | 0.3/hr |

---

## Audio Generation Models

| Model | Params | Runner | Hardware | Speed | SAFEBUX |
|-------|--------|--------|----------|-------|---------|
| Stable Audio 3 medium | 1.4B | stable-audio-3 | 8GB+ VRAM | 1.31s/gen on H200 | 2.0 |
| Stable Audio 3 small | 459M | stable-audio-3 | 4GB+ VRAM / M4 CPU | 0.44s on H200 | 0.5 |
| Stable Audio 3 large | 2.7B | stable-audio-3 | H100/H200 | 1.80s on H200 | — |

---

## Video Models

| Model | Params | Runner | Hardware | Pipelines | SAFEBUX |
|-------|--------|--------|----------|-----------|---------|
| Wan 2.1 14B | 14B | wan-video | 1× H100 80GB | T2V, I2V, FLF2V, V2V, VACE | 50 |
| Wan 2.1 1.3B | 1.3B | wan-video | 1× RTX 4090 | T2V, VACE | 15 |
| LTX-Video 0.9.5 | 700M | ltx-video | 1× H100 80GB | T2V | 30 |

### Wan 2.1 Pipelines

| Pipeline | Shorthand | What it does | Max resolution |
|----------|-----------|--------------|----------------|
| Text-to-Video | T2V | Prompt → video | 1080p / ~10s |
| Image-to-Video | I2V | Single image → animated video (14B only) | 720p / ~10s |
| First-Last-Frame | FLF2V | Keyframe A + keyframe B → interpolated video (14B only) | 720p / ~10s |
| Video-to-Video | V2V | Source video + prompt → restyled video (14B only) | 720p / ~10s |
| VACE | VACE | Controllable generation: depth, pose, sketch, flow, scribble, inpaint, outpaint, reference-image | 720p |

Wan 2.1 runs via [Diffusers](https://huggingface.co/docs/diffusers/main/en/api/pipelines/wan) or through the ComfyUI runner with community workflows. The 14B model is the quality leader on VBench; the 1.3B variant trades quality for speed on lighter hardware. Both are Apache 2.0.

---

## 3D Models

| Model | Runner | Hardware | SAFEBUX |
|-------|--------|----------|---------|
| TripoSR 1.0 | triposr | 1× A100 40GB | 8.0 |

---

## Runner Index

| Runner | Directory | Status | Protocol |
|--------|-----------|--------|----------|
| vllm | [`model-runners/vllm/`](model-runners/vllm/) | Production | LLM |
| u-omni | [`model-runners/u-omni/`](model-runners/u-omni/) | Development | LLM (native multimodal) |
| privacy-filter | [`model-runners/privacy-filter/`](model-runners/privacy-filter/) | Production | PII redaction |
| stable-audio-3 | [`model-runners/stable-audio-3/`](model-runners/stable-audio-3/) | Skeleton | Audio |
| comfyui | — | Planned | Image |
| kokoro-tts | — | Planned | Speech |
| whisper | — | Planned | Transcription |
| ltx-video | — | Planned | Video |
| wan-video | [`model-runners/wan-video/`](model-runners/wan-video/) | Skeleton | Video |
| triposr | — | Planned | 3D |
| mineru | — | Planned | Document |
| onnx | — | Planned | Edge inference |

---

## Shared Infrastructure

| Module | Path | Purpose |
|--------|------|---------|
| HMAC Auth | [`model-runners/safebox_auth.py`](model-runners/safebox_auth.py) | Strong canonical HMAC verification for all runners |
| Wire Protocol | [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md) | Safebox runner API contract |
| Model Catalog | [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md) | Full model details and benchmarks |
| U API Spec | [`docs/ulanguage-models-api.md`](docs/ulanguage-models-api.md) | Implementation spec for U runtime team |
