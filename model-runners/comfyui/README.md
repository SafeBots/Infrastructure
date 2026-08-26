# ComfyUI Runner — Safebox Local Service

**Safebox-canonical text-to-image runner backed by ComfyUI.** One Docker image, one model family per container, Safebox's standard wire format. Translates simple text-to-image requests into ComfyUI workflow graphs under the hood — the operator and the caller don't see any of the graph complexity.

The runner ships with workflow templates for SDXL and FLUX families, manifests for three production-ready models (SDXL Base 1.0, FLUX.1 schnell, FLUX.1 dev), and the same Safebox discipline as the other runners (HMAC, audit hashes, capability flags, Unix socket transport).

---

## 🎯 What it does

**Endpoints (Safebox canonical):**

- `POST /v1/image/generate` — text-to-image. Returns a path (default) or base64.
- `GET  /v1/capabilities` — what this runner can do; includes default sampler/steps/dimensions.
- `GET  /v1/capacity` — current load, cumulative image count.
- `GET  /v1/models` — what's loaded.
- `GET  /health` — liveness; 200 once ComfyUI has loaded, 503 while loading.

**Models supported (initial roster of three manifests):**

| Manifest | Family | License | Commercial? | Notes |
|---|---|---|:---:|---|
| `sdxl-base-1.0.json` | sdxl | OpenRAIL++-M | ✅ | Classic SDXL, broad ecosystem support |
| `flux-1-schnell.json` | flux | Apache-2.0 | ✅ | Step-distilled (4 steps), commercial-OK |
| `flux-1-dev.json` | flux | Non-Commercial | ⚠️ | Higher quality; **paid BFL license required** for commercial |

Adding a new model is a one-file change if it fits an existing workflow family (SDXL/FLUX); if it's a new architecture (Wan, HiDream, Sana), you also need to add a workflow template and an `populate_<family>_workflow` function. See [`manifests/README.md`](manifests/README.md) for the schema.

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│                                                                     │
│  ComfyUI (loads diffusion model into GPU)                           │
│      listens on 127.0.0.1:8188                                      │
│         ▲                                                           │
│         │ POST /prompt     — submit workflow JSON                   │
│         │ GET  /history    — poll for completion                    │
│         │ GET  /view       — fetch output image bytes               │
│         │                                                           │
│  runner.py  (Safebox protocol wrapper)                              │
│      listens on Unix socket  /run/safebox/services/image-1.sock     │
│      maps {prompt, width, height, steps, ...} → ComfyUI workflow    │
│      polls /history, fetches images, returns path or base64         │
│                                                                     │
│  Output images written to /data/output/  (host-mounted, persistent) │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

The caller never sees a ComfyUI workflow. They send `{prompt, width, height, ...}` and get `{images: [{path, width, height, format}]}`. The wrapper handles:

1. Loading a per-family workflow template from `/app/workflows/<family>-text2image.json`
2. Substituting user values (prompt, dimensions, steps, seed, etc.) at the right node IDs
3. Submitting via `POST /prompt` and getting a `prompt_id`
4. Polling `GET /history/{prompt_id}` until ComfyUI finishes
5. Walking the history's `outputs` for `SaveImage` results
6. Fetching image bytes via `GET /view?filename=...`
7. Returning either a file path (default) or inline base64

**Why one family per container.** ComfyUI loads weights into VRAM at first use. SDXL checkpoints and FLUX UNET/VAE/CLIP are completely different file layouts and would compete for memory. Match the pattern of the other Safebox runners — one container = one job. Multiple containers for SDXL + FLUX in the same tenant; route by model name at the Safebox plugin layer.

---

## 🚀 Quick start

### Build

```bash
cd model-runners/comfyui

# GPU production build (CUDA 12.x)
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             -t safebox/comfyui:latest .

# CPU dev build (compiles, but ComfyUI needs GPU to actually serve)
docker build -t safebox/comfyui:latest .
```

### Stage models

ComfyUI looks for weights in subdirectories of `models/`. For SDXL:

```
/opt/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors
```

For FLUX:

```
/opt/ComfyUI/models/unet/flux1-schnell.safetensors      (or flux1-dev.safetensors)
/opt/ComfyUI/models/vae/ae.safetensors
/opt/ComfyUI/models/clip/t5xxl_fp8_e4m3fn.safetensors
/opt/ComfyUI/models/clip/clip_l.safetensors
```

In a production Safebox deployment these come from `/srv/safebox/models/<manifestHash>/` (mounted via the Safebox model-install protocol after M-of-N approval). In development, mount a host directory:

```bash
docker run ... -v /path/to/your/models:/opt/ComfyUI/models ...
```

### Run

```bash
docker run -d --name safebox-comfyui-flux \
    --gpus all \
    --network safebox-net \
    -e MODEL_NAME=flux-1-schnell \
    -e SERVICE_ID=image-1 \
    -e SAFEBOX_REQUIRE_HMAC=true \
    -v safebox-sockets:/run/safebox/services \
    -v /etc/safebox:/etc/safebox:ro \
    -v safebox-comfyui-models:/opt/ComfyUI/models \
    -v /data/output:/data/output \
    safebox/comfyui:latest
```

First start: ComfyUI initializes (~10-30s), the wrapper comes up immediately. First image generation triggers model loading into VRAM (~45s for FLUX, ~20s for SDXL). Subsequent generations are fast.

### Test

```bash
# Capabilities (works immediately)
curl --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/image-1.sock \
    http://localhost/v1/capabilities | jq .

# Generate one image
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/image-1.sock \
    http://localhost/v1/image/generate \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "flux-1-schnell",
      "prompt": "a futuristic data center, photorealistic, cinematic lighting",
      "negativePrompt": "blurry, low quality",
      "width": 1024,
      "height": 1024,
      "seed": 42
    }' | jq .
```

**Sample response:**

```json
{
  "model": "flux-1-schnell",
  "images": [
    {
      "filename": "safebox_00001_.png",
      "width": 1024,
      "height": 1024,
      "format": "png",
      "path": "/data/output/safebox_00001_.png"
    }
  ],
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "imageCount": 1,
    "steps": 4,
    "elapsedMs": 4200
  }
}
```

For base64-inline output:

```bash
curl -X POST --unix-socket ... \
    -d '{"model":"flux-1-schnell", "prompt":"...", "outputMode":"base64"}'
# Response includes "base64": "iVBORw0KGgo..." instead of "path"
```

---

## 📞 How Safebox calls it

### From Protocol.Image.Local

```javascript
const result = await Protocol.Image.Local({
    model:    'flux-1-schnell',
    prompt:   'a corporate boardroom in the style of a Renaissance painting',
    width:    1024,
    height:   1024,
    seed:     12345
});

// Save the image into a Streams/image stream
await Q.Streams.create({
    publisherId: 'user-123',
    name: 'Streams/image/generated-' + Date.now(),
    type: 'Streams/image',
    attributes: {
        sourceFile:   result.images[0].path,
        prompt:       'a corporate boardroom in the style of a Renaissance painting',
        promptSha:    result.sourceSha256,
        imageSha:     result.outputSha256,
        model:        result.model,
        seed:         12345
    }
});
```

### Composing across runners — illustrated meeting summary

```javascript
// 1. Transcribe meeting audio (Whisper)
const transcript = await Protocol.Transcription.Local({
    model: 'whisper-large-v3-turbo',
    source: '/data/meetings/2026-06-board.mp3'
});

// 2. Generate a written summary (vLLM/Qwen)
const summary = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'Summarize this transcript in 3 sections: Decisions, Action Items, Open Questions.' },
        { role: 'user',   content: transcript.text }
    ],
    maxTokens: 1500
});

// 3. Generate an illustrative cover image (ComfyUI)
const cover = await Protocol.Image.Local({
    model:  'flux-1-schnell',
    prompt: 'minimalist illustration of a strategic planning meeting, '
          + 'overhead view of a circular table with documents, soft natural lighting',
    width:  1280,
    height: 720
});

// 4. Persist the whole chain to a Streams audit record
await Q.Streams.create({
    type: 'AI/meeting-package',
    attributes: {
        audioSha:      transcript.sourceSha256,
        transcriptSha: transcript.outputSha256,
        summarySha:    summary.outputSha256,
        coverSha:      cover.outputSha256,
        coverPath:     cover.images[0].path,
        modelChain:    [transcript.model, summary.model, cover.model]
    },
    content: summary.content
});
```

Five runners now compose through `Protocol.X.Local()` — privacy-filter, mineru, whisper, vllm, comfyui — all sharing the same wire format, the same audit-trail discipline, and the same Unix-socket transport.

---

## 📊 Capabilities

`GET /v1/capabilities` returns:

```json
{
  "version":    "1.0",
  "runnerType": "image",
  "runnerId":   "safebox-image-1",
  "serviceId":  "image-1",
  "transport": {
    "socket": {
      "path":        "/run/safebox/services/image-1.sock",
      "permissions": "0660",
      "group":       "safebox-services"
    }
  },
  "models": {
    "loaded":     ["flux-1-schnell"],
    "loading":    [],
    "family":     "flux",
    "checkpoint": null
  },
  "capabilities": {
    "text2img":   true,
    "img2img":    false,
    "inpaint":    false,
    "controlnet": false,
    "lora":       false,
    "batch":      true,
    "outputModes": ["path", "base64"]
  },
  "defaults": {
    "width":     1024,
    "height":    1024,
    "steps":     4,
    "cfg":       1.0,
    "sampler":   "euler",
    "scheduler": "simple"
  },
  "health": "healthy"
}
```

For v1.0, only `text2img` is implemented. The other flags (`img2img`, `inpaint`, `controlnet`, `lora`) exist in the protocol and the manifest schema but return 400. Adding them is a per-flag workflow-template + populate-function addition.

---

## ⚠️ Licensing — read this before deploying

Image generation models have wildly inconsistent licenses. The runner serves whatever weights you mount; **license compliance is the operator's responsibility.**

For the three shipped manifests:

- **`sdxl-base-1.0`** — OpenRAIL++-M. Commercial use OK. Use-restrictions apply (no CSAM, no defamation, no impersonation, etc. — see [the full license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md)).
- **`flux-1-schnell`** — Apache 2.0. Commercial use OK, no fees, no restrictions beyond Apache 2.0's standard terms. The safe FLUX default.
- **`flux-1-dev`** — Non-Commercial License. Personal use, research, and evaluation only. **Production deployment in any revenue-generating context requires a paid commercial license from Black Forest Labs.** The model weights are openly downloadable and the runner will load them; the operator must hold the commercial license.

For commercial deployment without paying anyone: use `sdxl-base-1.0` or `flux-1-schnell`. For peak quality + commercial use: license `flux-1-dev` from BFL or use the closed-weight FLUX.1 [pro] via their API (which means data leaves the Safebox).

Newer commercial-OK options (as of June 2026) that you can add as additional manifests:

- **FLUX.2 [klein] 4B** — Apache 2.0, released January 2026, near-instant generation, ~13 GB VRAM at fp16. Likely the right replacement for `flux-1-schnell` once tested.
- **SD 3.5 Large** — Stability Community License, free for orgs under $1M annual revenue.

---

## 🔐 Privacy and trust

**Data path:**

- Prompts and generated images stay inside the Safebox. The runner has no network egress except the in-container HTTP call to ComfyUI.
- Output images are written to `/data/output/` (host-mounted). The Safebox plugin reads them from there to create `Streams/image` streams.
- Model weights are read-only from `/opt/ComfyUI/models/` (host-mounted from the Safebox model-install layout).

**HMAC:**

Standard Safebox HMAC verification when `SAFEBOX_REQUIRE_HMAC=true`. Timestamp + nonce + body signed with the per-Safebox key from `/etc/safebox/model-api.key`. 5-minute window, single-use nonces.

**Audit trail:**

Every response includes `sourceSha256` (hash of the JSON request body — covers prompt + parameters + seed) and `outputSha256` (hash of the concatenated image bytes). Same input + same model version + same seed yields the same hashes if the underlying diffusion is deterministic. Stochastic samplers still let you prove what was generated when.

---

## ⚡ Performance

**Generation time, 1024×1024, single image, consumer GPU (RTX 3090 / A10):**

| Model | Steps | Time | Notes |
|---|---:|---:|---|
| FLUX.1 schnell | 4 | ~2-4s | Distilled; CFG=1.0 |
| SDXL base | 25 | ~10-15s | Default for most prompts |
| FLUX.1 dev | 20-30 | ~10-30s | Higher quality, slower |

**On datacenter GPU (A100 80GB):** roughly 2-3× faster across all of these.

**Memory:**
- SDXL: ~8-10 GB VRAM at fp16
- FLUX.1 schnell at fp8: ~12 GB VRAM
- FLUX.1 dev at fp16: ~24 GB VRAM
- FLUX.1 dev at Q4 GGUF: ~6 GB VRAM (via quantized loaders)

**Cold start:**
- ComfyUI process: 10-30 seconds to listen on port 8188
- First-prompt model load: 20-60 seconds depending on family
- Wrapper: <1 second to listen on the Unix socket

`/v1/capabilities` and `/health` work from the moment the wrapper starts; `/v1/image/generate` returns 503 until ComfyUI is ready.

---

## 💰 Compare to per-image cloud APIs

For a team generating 10,000 images/month (product photography, blog illustrations, design comps):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| OpenAI DALL·E 3 ($0.040/image at 1024×1024) | $400 | ✗ sent to OpenAI |
| FAL FLUX.1 dev ($0.025/image) | $250 | ✗ sent to FAL |
| Replicate SDXL ($0.0095/image average) | $95 | ✗ sent to Replicate |
| BFL API for FLUX.1 pro ($0.04/image) | $400 | ✗ sent to BFL |
| **Self-hosted on Safebox (SDXL or FLUX schnell)** | **GPU power bill** | **✓ never leaves the box** |

The self-hosted line is your GPU electricity, not metered per-image. A single A10 amortized over depreciation + power + cooling lands around $250-400/month and serves tens of thousands of images. The exposure column matters for marketing teams generating product imagery, designers iterating on internal comps, or anyone whose prompts contain client-confidential context.

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as `privacy-filter`, `mineru`, `vllm`, and `whisper`:

- ✅ Safebox-canonical endpoints (`/v1/image/generate`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport with 0660 perms and `safebox-services` group ownership
- ✅ HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes on source and output
- ✅ Capability enforcement from manifest
- ✅ Multi-model manifest system with per-family workflow templates
- ✅ Output as file path or inline base64

What it does NOT do (deliberately, for v1.0):

- **img2img / inpainting.** Capability flags exist; the workflow templates and populate functions need to be added.
- **ControlNet.** Same — capability flag exists but no template yet.
- **LoRA stacking.** Could be added to either family's template with optional `LoraLoader` nodes.
- **Live progress events.** ComfyUI exposes a WebSocket with progress, but the wrapper polls instead. Post-1.0 enhancement.
- **Batch as separate generation requests.** `batchSize > 1` works through ComfyUI's `EmptyLatentImage` batch dimension, but multi-request batching across users is single-process FIFO via `MAX_QUEUE_DEPTH`.

The deployment unit is a single container, one manifest, one model family. Compose them at the orchestration layer.

---

## 📚 References

- ComfyUI: https://github.com/comfyanonymous/ComfyUI
- Stable Diffusion XL: https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
- FLUX: https://github.com/black-forest-labs/flux
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Workflow template format: [`workflows/`](workflows/)
- Other runners using this pattern: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/)
