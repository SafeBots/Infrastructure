# Whisper Model Manifests

One JSON per Whisper variant the runner can serve. Lives at `manifests/<canonical-name>.json` here (development) and `/etc/safebox/runners/whisper/manifests/<canonical-name>.json` at runtime.

## Initial roster

| File | Underlying | Size | TR | Translate | Best for |
|---|---|---:|:---:|:---:|---|
| `whisper-large-v3-turbo.json` | `large-v3-turbo` | 809M | ✓ | ✗ | Production sweet spot — speed + multilingual |
| `whisper-large-v3.json` | `large-v3` | 1.55B | ✓ | ✓ | Maximum accuracy; the only one that translates |
| `whisper-medium.json` | `medium` | 769M | ✓ | ✓ | Laptops without dedicated GPU |
| `whisper-small.json` | `small` | 244M | ✓ | ✓ | CPU-only, edge, low-VRAM |
| `distil-whisper-large-v3.json` | `distil-large-v3` | 756M | ✓ | ✗ | English-only at top speed |

## Schema

```json
{
  "name":               "<canonical safebox name, e.g. whisper-large-v3-turbo>",
  "fasterWhisperModel": "<faster-whisper identifier, e.g. large-v3-turbo>",
  "manifestHash":       "<sha256 of canonical JSON form, populated by install protocol>",
  "version":            "<semver-ish>",
  "vendor":             "<who made it>",
  "license":            "<SPDX or short tag>",
  "homepage":           "<url>",

  "whisper": {
    "device":      "auto | cuda | cpu",
    "computeType": "auto | float16 | int8_float16 | int8 | float32",
    "numWorkers":  <int, default 1>,
    "cpuThreads":  <int, 0 = auto>
  },

  "capabilities": {
    "transcribe":      true,
    "translate":       <bool — only large-v3 supports it>,
    "diarize":         <bool — post-1.0>,
    "wordTimestamps":  true,
    "vadFilter":       true,
    "batch":           true
  },

  "resources": {
    "minGpuMemoryGb":     <int — 0 for CPU>,
    "recommendedGpu":     "<short string>",
    "approximateLoadSec": <int>,
    "diskSizeGb":         <float>,
    "realTimeFactor":     "<informational string>"
  },

  "notes": "<free text — known good configurations, caveats>"
}
```

## Two things worth knowing

**`computeType` defaults matter.** For most GPU deployments, `float16` is the right pick on Ampere and newer. For CPU-only deployments, `int8` brings the model into the 1-2× realtime range on consumer laptops with minimal accuracy loss. The Faster-Whisper docs cover the full matrix; the manifests here pick reasonable defaults.

**Translation is large-v3-only.** Whisper Turbo was distilled without translation training data, so `task=translate` only works on the full large-v3 model. The runner enforces the manifest's `capabilities.translate` flag — a translate request to a turbo runner returns 400. Pick the manifest accordingly.

## Adding a new model

The Whisper family is small enough that the five manifests here cover most real deployments. If you do need a new one (a newer release, a quantized variant, a custom fine-tune):

1. Copy `whisper-large-v3-turbo.json` as a starting point.
2. Set `name`, `fasterWhisperModel`, and the `resources` block.
3. Update `whisper.computeType` if the model needs something specific (most don't).
4. Set `capabilities.translate` to `true` only if the model actually supports translation.
5. Run it in development:
   ```
   docker run -d --name whisper-test \
       -e MODEL_NAME=<canonical-name> \
       -e FASTER_WHISPER_MODEL=<faster-whisper-id> \
       -v safebox-sockets:/run/safebox/services \
       safebox/whisper:latest
   ```
