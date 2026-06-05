# comfyui-image — Image Generation Runner (planned)

**Primary model:** FLUX.1 [schnell] (Black Forest Labs)
**License:** Apache 2.0
**Also supports:** SDXL (CreativeML Open RAIL++-M), Stable Diffusion 3.5 (Stability Community)
**Manifest:** [`config/artifacts/models/flux-1-schnell.json`](../../config/artifacts/models/flux-1-schnell.json)
**Status:** Skeleton

## Why ComfyUI

ComfyUI is the de facto workflow engine for diffusion models in 2026. Its node-based graph runtime supports LoRAs, ControlNets, IP-Adapters, and the long tail of community refinements that make production image generation more than "prompt in, image out." This runner wraps the ComfyUI server in the Safebox adapter shape.

FLUX.1 [schnell] is the headline Apache-2.0 picture-quality option. FLUX.1 [dev] and [pro] require separate commercial licensing from Black Forest Labs and are NOT installed by this runner from the curated roster — a deployment that wants them must add a separate manifest with the BFL license terms acknowledged.

## Hardware

- FLUX.1 schnell at FP8: 17 GB VRAM (RTX 4090, L40S, A100 40GB)
- FLUX.1 schnell at FP16: 33 GB VRAM
- SDXL: 8 GB VRAM works; 12+ recommended

Apple Silicon supported via MLX with FP4 quantization (FLUX runs on M3 Pro and above).

## API surface

```
POST /v1/image/generate           ← text → image
POST /v1/image/edit               ← image + mask + prompt → image (inpaint)
POST /v1/image/generate/img2img   ← reference image + prompt → image
POST /v1/models/load              ← M-of-N gated
POST /v1/models/unload            ← M-of-N gated
POST /v1/cache/flush              ← M-of-N gated
GET  /v1/capabilities
GET  /health
```

## Backend approach

ComfyUI server runs on an internal port. The adapter translates Safebox canonical requests into ComfyUI workflow JSON, posts to ComfyUI's `/prompt` endpoint, polls `/history/{prompt_id}` for completion, fetches the resulting image, returns it through the Safebox response.
