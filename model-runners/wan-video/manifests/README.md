# Wan 2.2 Manifests

| File | Variant | Min VRAM | Default Res / Frames | Best For |
|---|---|---:|---|---|
| `wan-2-2-ti2v-5b.json` | Combined T2V+I2V, 5B | 16 GB | 1280×704 @ 24fps, 121 frames | Consumer GPUs; both T2V and I2V from one container |
| `wan-2-2-t2v-a14b.json` | T2V only, MoE A14B (27B total) | 24 GB | 1280×720 @ 16fps, 81 frames | High-quality text-to-video; sharper detail |
| `wan-2-2-i2v-a14b.json` | I2V only, MoE A14B | 24 GB | 1280×720 @ 16fps, 81 frames | High-quality image-to-video; hero stills |

All three are Apache 2.0, all three are fully commercial-unrestricted.

## What Wan 2.2 brings

**MoE diffusion architecture** is the headline. Wan 2.2 splits the denoising process across two specialized experts — a high-noise expert that handles the early stages (overall layout and composition) and a low-noise expert that takes over for the later stages (texture, fine detail). Each expert has ~14B parameters, totaling 27B, but only one is active per step. So compute and VRAM are 14B-class while quality is 27B-class.

The runner exposes both guidance scales separately: `guidance` (high-noise expert) and `guidanceLowNoise` (low-noise expert). Defaults are 4.0 / 3.0 for T2V-A14B and 3.5 / 3.0 for I2V-A14B, matching the Wan-AI documentation.

The 5B TI2V variant is single-stream (not MoE) — smaller, faster, and combines T2V + I2V in one model. The runner accepts inputImage as optional; when provided, the model conditions on it.

## Wan vs LTX-Video

Both are Apache 2.0, both ship as Safebox runners. They have complementary strengths:

| | LTX-Video 2.3 | Wan 2.2 |
|---|---|---|
| Speed (5s clip, RTX 4090) | ~20-40s (distilled) | ~60-300s (depending on variant) |
| Min VRAM | 16 GB | 16 GB (5B) / 24 GB (A14B) |
| Quality ceiling | Very good | Higher — MoE pulls ahead at the top end |
| Audio | ✅ Synchronized audio+video in one pass | ❌ Video only (-S2V is separate variant) |
| Native res | 1216×704 @ 30fps | 1280×720 @ 16fps |
| Best for | Iteration, agent workflows, social media | Hero content, final renders, product visualization |

For Safebox tenants, the right default is to run both — LTX-Video for fast drafts where iteration speed is key, Wan 2.2 for final renders where output quality is. They use different sockets (`video-1` for LTX, `video-2` for Wan) so the Safebox plugin can route by model name at the application layer.

## MoE guidance scales explained

The dual-guidance MoE in Wan 2.2 A14B is unusual. Most diffusion models have one classifier-free guidance scale. Wan 2.2 has two because the high-noise expert and low-noise expert have different optimal scales:

- **High noise (`guidance`)** — controls how strongly the early denoising steps follow the prompt. Higher = more aggressive composition matching. Wan recommends 4.0 for T2V.
- **Low noise (`guidanceLowNoise`)** — controls how strongly the late denoising steps follow the prompt. Higher = more aggressive detail enforcement. Wan recommends 3.0 for T2V.

Most operators won't need to tune these. The defaults are well-chosen. If output is over-saturated or too literal, lower both by 0.5; if it's drifting from the prompt, raise both by 0.5.

The 5B variant is single-stream — `guidanceLowNoise` is ignored, only `guidance` applies (Wan recommends 5.0 for the 5B).

## flow_shift

Wan 2.2 uses a UniPC scheduler with a tunable `flow_shift` parameter that affects the noise schedule. The default is 5.0 for 720p and 3.0 for 480p — the runner sets it automatically based on the requested resolution band. Manual override via the `flowShift` request field.

## Schema

```json
{
  "name":         "<canonical safebox name>",
  "manifestHash": "<sha256 of canonical JSON>",
  "version":      "<release>",
  "vendor":       "Alibaba (Tongyi Wanxiang)",
  "license":      "Apache-2.0",
  "homepage":     "<HF URL>",

  "wanVideo": {
    "huggingfaceModel":         "Wan-AI/Wan2.2-<variant>-Diffusers",
    "variant":                  "ti2v-5b | t2v-a14b | i2v-a14b",
    "architecture":             "<single-stream | Mixture-of-Experts>",
    "defaultWidth":             <int — divisible by 16>,
    "defaultHeight":            <int — divisible by 16>,
    "defaultNumFrames":         <int>,
    "defaultFps":               <int>,
    "defaultSteps":             <int>,
    "defaultGuidance":          <float — high-noise expert>,
    "defaultGuidanceLowNoise":  <float — low-noise expert; A14B only>,
    "defaultFlowShift":         <float — 5.0 for 720p, 3.0 for 480p>,
    "maxNumFrames":             <int — runner clamps>
  },

  "capabilities": { ... },
  "resources":    { ... },
  "notes":        "<free text>"
}
```
