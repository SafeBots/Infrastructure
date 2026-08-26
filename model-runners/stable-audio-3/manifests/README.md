# Stable Audio Manifests

One JSON per Stable Audio Open deployment configuration. These manifests configure the `stable-audio-3` runner to load a specific Stable Audio Open checkpoint and serve audio generation.

## Initial roster

| File | Variant | Max Duration | Quality | License |
|---|---|---:|:---:|---|
| `stable-audio-open-small.json` | 341M params, 8 steps | 11s | ★★★☆ | Apache 2.0 |
| `stable-audio-open-1.0.json` | 1.21B params, 100 steps | 47s | ★★★★★ | Apache 2.0 |

Both are Stability AI's open-weights releases. Both ship under Apache 2.0 with **no commercial restrictions** — distinct from the closed Stable Audio 3 commercial product (different naming despite the runner directory being `stable-audio-3/`).

## Schema

```json
{
  "name":         "<canonical safebox name>",
  "manifestHash": "<sha256 of canonical JSON>",
  "version":      "<release>",
  "vendor":       "Stability AI",
  "license":      "Apache-2.0",
  "homepage":     "<HF URL>",

  "stableAudio": {
    "huggingfaceModel":     "<HF model id, e.g. stabilityai/stable-audio-open-small>",
    "defaultDurationSec":   <float>,
    "maxDurationSec":       <float — clamped by the runner>,
    "defaultSteps":         <int — diffusion sampler steps>,
    "defaultCfgScale":      <float — classifier-free guidance>,
    "defaultSampler":       "<pingpong | dpmpp-3m-sde | dpmpp-2m | ...>",
    "defaultFormat":        "<wav | mp3 | ogg>",
    "sampleRate":           44100
  },

  "capabilities": {
    "text2audio":  true,
    "audio2audio": <bool — post-1.0>,
    "inpaint":     <bool — post-1.0>,
    "streaming":   false,
    "outputFormats": ["wav", "mp3", "ogg"]
  },

  "resources": { ... },
  "notes": "<free text>"
}
```

## Picking between the two

**`stable-audio-open-small`** — when latency matters. 8 steps with the pingpong sampler completes in 2-5 seconds on a consumer GPU. Capped at 11-second clips. Good for voice-agent SFX (button beeps, transition sounds), short music loops, ambient stings.

**`stable-audio-open-1.0`** — when quality matters. 100 steps with DPM++ 3M-SDE takes 15-45 seconds on the same GPU but produces noticeably better output. Supports clips up to 47 seconds. Right for podcast intros, background music for video, longer ambient soundscapes.

A tenant doing both kinds of work runs both manifests in parallel containers and routes by model name at the Safebox plugin layer.

## Why "stable-audio-3" as the directory name

Historical — the runner directory was created early in the Safebox 1.0 design when "Stable Audio 3" was the working assumption for the audio protocol. Stability AI then split into closed (Stable Audio 2.x / Stable Audio Pro, API-only) and open (Stable Audio Open, Apache 2.0 weights). The directory keeps its name to avoid breaking references; the manifests serve the open variants.

Adding a non-Stable-Audio music model (e.g. ACE-Step under Apache 2.0, or AudioCraft if its licensing changes) would be a separate runner directory (`ace-step/`, etc.).

## Adding new variants

Within the Stable Audio family:

1. Copy `stable-audio-open-small.json` as a starting point.
2. Update `huggingfaceModel` to the new variant.
3. Adjust `defaultSteps`, `defaultCfgScale`, `defaultSampler`, `maxDurationSec` based on what the variant expects (see the upstream model card).
4. Set `resources` based on parameter count.
5. Test:
   ```
   docker run -d --name audio-test --gpus all \
       -e MODEL_NAME=<your-name> \
       -e STABLE_AUDIO_MODEL=<HF id> \
       -v safebox-sockets:/run/safebox/services \
       safebox/stable-audio:latest
   ```
