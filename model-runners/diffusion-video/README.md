# diffusion-video — Video Generation Runner (planned)

**Model:** Mochi 1 (Genmo)
**License:** Apache 2.0
**Modality:** Video — text-to-video, 5.4s clips at 30fps
**Manifest:** [`config/artifacts/models/mochi-1-preview.json`](../../config/artifacts/models/mochi-1-preview.json)
**Status:** Skeleton

## Why this model

Mochi 1 from Genmo is the largest Apache-2.0-licensed video generation model in the open-weight space — 10B params (Asymmetric Diffusion Transformer). It's the cleanest licensing in a modality where Tencent (HunyuanVideo) and Alibaba (Wan) ship under their own community licenses with various restrictions.

Wan 2.2 is the quality leader and is also Apache 2.0; it'll likely become a second supported model in this runner directory. The architecture is the same diffusion-transformer family.

## Hardware

- 60 GB VRAM minimum
- H100 80GB or 4×A100 80GB recommended
- Quantized variants (FP8) drop the requirement to ~30 GB on consumer-grade hardware

## API surface

```
POST /v1/video/generate              ← text prompt → MP4 (async)
POST /v1/video/generate/image-to     ← reference image + prompt → MP4 (async)
GET  /v1/video/generate/{taskId}     ← poll status, fetch result
POST /v1/models/load                 ← M-of-N gated
POST /v1/models/unload               ← M-of-N gated
POST /v1/cache/flush                 ← M-of-N gated
GET  /v1/capabilities
GET  /health
```

Async-only by design — even on H100, single-clip generation takes 30-60 seconds and runners that block requests at that latency saturate quickly. The taskId pattern matches the LLM runners' load-task polling.

## Backend approach

Two viable paths:
1. **Direct diffusers library wrapping** — Hugging Face `diffusers` has Mochi pipeline support. Simpler, less moving parts.
2. **ComfyUI workflow backend** — more flexible (LoRAs, ControlNets), more dependencies.

Phase 1 will use diffusers. ComfyUI integration is roadmap.
