# LTX-Video Manifests

| File | Variant | Min VRAM | Default Res | Best For |
|---|---|---:|---|---|
| `ltx-2-3-distilled.json` | distilled (~8B) | 16 GB | 768×512 @ 24fps | Iteration, preview, agent workflows |
| `ltx-2-3-dev.json` | dev (22B base) | 24 GB | 1216×704 @ 30fps | Final renders, hero content |

Both Apache 2.0, both safe for commercial use without licensing fees.

## Picking

**distilled** is the right default for any Safebox tenant using video as a feature inside a larger workflow (illustrated podcasts, agent demos, social media drafts, product mockups). 8 inference steps with the distilled checkpoint gives a 5-second clip in 20-40 seconds on an RTX 4090. Output quality is "very good" — competitive with closed APIs at 1080p — not "best in class."

**dev** is the right choice for final renders. 30 steps with the full 22B base gives noticeably sharper detail, cleaner motion, and better prompt adherence. Costs 3-5× more compute. Use it when the clip is going somewhere a human will judge it (a client deliverable, a website hero, a movie pitch).

For a tenant doing both, run two containers with two manifest names and route at the plugin layer based on which workflow stage is asking.

## Schema

```json
{
  "name":         "<canonical safebox name>",
  "manifestHash": "<sha256 of canonical JSON>",
  "version":      "<LTX release>",
  "vendor":       "Lightricks",
  "license":      "Apache-2.0",
  "homepage":     "<HF URL>",

  "ltxVideo": {
    "huggingfaceModel":   "Lightricks/LTX-Video",
    "variant":            "distilled | dev",
    "defaultWidth":       <int — multiple of 32>,
    "defaultHeight":      <int — multiple of 32>,
    "defaultNumFrames":   <int — form 8k+1, e.g. 121 for ~5s at 24fps>,
    "defaultFps":         <int>,
    "defaultSteps":       <int>,
    "defaultGuidance":    <float>,
    "maxNumFrames":       <int — runner clamps>
  },

  "capabilities": {
    "text2video":  true,
    "image2video": true,
    "video2video": <bool — post-1.0>,
    "audio":       <bool — LTX-2.3 supports audio; v1 runner does not>,
    "streaming":   false,
    "outputFormats": ["mp4"]
  },

  "resources": { ... },
  "notes": "<free text>"
}
```

## Why LTX-Video for v1

In the 2026 open-source video landscape:

| Model | License | Min VRAM | Why or why not |
|---|---|---:|---|
| **LTX-Video 2.3** | **Apache 2.0** | **16 GB** | **Fastest open model, cleanest license, consumer-GPU-friendly** ← shipped |
| Wan 2.2 | Apache 2.0 | 24 GB | Higher quality, slower; future second runner |
| HunyuanVideo | Tencent custom license | 24 GB | License caveats, best facial detail; future option |
| CogVideoX | Mixed (5B has restrictions) | 24 GB | Strong prompt adherence; future option |
| Sora / Runway / Veo | Closed | — | Cloud API only — not relevant for Safebox |

For Safebox tenants, LTX-Video is the right default because of license + footprint + speed. Adding Wan 2.2 or HunyuanVideo as a separate runner directory (different library, different model loader) is clean post-v1 work.
