# ComfyUI Model Manifests

One JSON per image-generation model the runner can serve. Lives at `manifests/<canonical-name>.json` here (development) and `/etc/safebox/runners/comfyui/manifests/<canonical-name>.json` at runtime.

## Initial roster

| File | Family | License | Commercial? | Notes |
|---|---|---|:---:|---|
| `sdxl-base-1.0.json` | sdxl | OpenRAIL++-M | ✅ | Classic SDXL, broad ecosystem |
| `flux-1-schnell.json` | flux | Apache-2.0 | ✅ | Fast (4 steps), commercial-OK FLUX |
| `flux-1-dev.json` | flux | Non-Commercial | ⚠️ | Higher quality FLUX; **commercial use requires paid BFL license** |

**License compliance is the operator's responsibility.** The runner will load FLUX.1 [dev] weights and serve images. If you deploy that in any revenue-generating context without a paid Black Forest Labs commercial license, you're in violation of the license terms. The manifest flags this explicitly, but enforcement is on the deployer. For unambiguous commercial deployment, `flux-1-schnell` (Apache 2.0) is the FLUX option that's safe everywhere.

## Schema

```json
{
  "name":         "<canonical safebox name, e.g. sdxl-base-1.0>",
  "manifestHash": "<sha256 of canonical JSON, populated by install protocol>",
  "version":      "<semver-ish>",
  "vendor":       "<who trained it>",
  "license":      "<SPDX or short tag>",
  "licenseUrl":   "<full license text URL>",
  "commercialLicenseUrl": "<if separate paid license is required>",
  "homepage":     "<HF or vendor URL>",

  "comfyui": {
    "workflowFamily":  "sdxl | flux | sd3",
    "checkpointName":  "<file in models/checkpoints/, SDXL/SD-style models>",
    "unetName":        "<file in models/unet/, FLUX-style models>",
    "vaeName":         "<file in models/vae/, FLUX-style models>",
    "clipNames":       "<comma-separated CLIP files, FLUX uses two>",
    "defaultSteps":    <int>,
    "defaultCfg":      <float — CFG for SDXL, distilled guidance for FLUX>,
    "defaultWidth":    <int>,
    "defaultHeight":   <int>,
    "defaultSampler":  "<euler | dpmpp_2m | ddim | ...>",
    "defaultScheduler": "<normal | karras | simple | ...>"
  },

  "capabilities": {
    "text2img":   true,
    "img2img":    false,
    "inpaint":    false,
    "controlnet": false,
    "lora":       false,
    "batch":      true
  },

  "resources": {
    "minGpuMemoryGb":     <int>,
    "recommendedGpu":     "<short string>",
    "approximateLoadSec": <int>,
    "diskSizeGb":         <float>,
    "imageSecondsTypical": "<informational string>"
  },

  "notes": "<free text — license caveats, known good configs>"
}
```

## Field semantics

**`workflowFamily`** — picks which workflow template the runner uses. SDXL uses `CheckpointLoaderSimple` (one file). FLUX uses separate `UNETLoader` + `VAELoader` + `DualCLIPLoader` (multiple files in different subdirectories of ComfyUI's `models/`). The wrapper loads `/app/workflows/<family>-text2image.json`, substitutes the user's values, and submits to ComfyUI.

**`checkpointName` vs `unetName/vaeName/clipNames`** — SDXL-family models are one self-contained `.safetensors` file in `models/checkpoints/`. FLUX-family models split into separate UNET (`models/unet/`), VAE (`models/vae/`), and CLIP (`models/clip/`) files. Use whichever fields fit the family; the others get ignored.

**`defaultCfg`** — for SDXL this is classical CFG (3-15 range, 7 typical). For FLUX it's the distilled-guidance value passed to the `FluxGuidance` node (3-5 typical for dev, 1.0 for schnell since it ignores guidance). The wrapper passes whatever the user sends; defaults fill in when omitted.

**`capabilities.text2img / img2img / inpaint / controlnet / lora`** — for v1.0, only `text2img` is implemented. The other flags exist in the protocol but currently all return 400. Adding img2img is post-1.0 — needs an `LoadImage` node and `ImageToLatent` plus a separate workflow template.

## Adding a new model

1. Decide the family. SDXL, SD 1.5, SD 3.x → `sdxl` family. FLUX.1 / FLUX.2 → `flux` family. If neither fits (e.g. Wan, HiDream, Sana), you'll need a new workflow template in `workflows/` and an extension in `runner.py` for the populate function.
2. Copy `flux-1-schnell.json` (FLUX family) or `sdxl-base-1.0.json` (SDXL family) as a starting point.
3. Update the canonical name, file paths, and license fields.
4. **Read the license carefully.** Note any commercial restrictions in the `notes` field. The runner does not enforce license terms — it loads and serves whatever you point it at.
5. Pre-stage weights into the ComfyUI models directory inside the container (mount `/srv/safebox/models/<manifestHash>/` over the appropriate subdirectory at run time).
6. Test in development:
   ```
   docker run -d --name comfyui-test --gpus all \
       -e MODEL_NAME=<canonical-name> \
       -e WORKFLOW_FAMILY=<sdxl|flux> \
       -e CHECKPOINT_NAME=<file> \
       -v safebox-sockets:/run/safebox/services \
       -v /data/output:/data/output \
       safebox/comfyui:latest
   ```

## License footnote — what's safe for commercial use today (June 2026)

Quick reference for the open-weights image-gen field. Cross-check before deployment because licenses change:

| Model | License | Commercial OK |
|---|---|:---:|
| SD 1.5 | CreativeML OpenRAIL-M | ✅ |
| SDXL Base 1.0 | OpenRAIL++-M | ✅ |
| SD 3.5 Large | Stability Community (free under $1M annual revenue) | ✅ (with revenue cap) |
| FLUX.1 schnell | Apache 2.0 | ✅ |
| FLUX.1 dev | Non-Commercial | ❌ (paid license required) |
| FLUX.1 pro | Closed weights | ❌ (API only) |
| FLUX.2 klein (4B) | Apache 2.0 | ✅ |
| FLUX.2 klein (9B) | Non-Commercial | ❌ |
| FLUX.2 dev | Non-Commercial | ❌ |

For Safebox tenants doing client work or running paid services, the safe bets are SDXL, FLUX.1 schnell, FLUX.2 klein 4B, and SD 3.5 Large (under the revenue cap).
