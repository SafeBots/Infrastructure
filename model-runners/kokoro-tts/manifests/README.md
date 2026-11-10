# Kokoro TTS Manifests

One JSON per Kokoro deployment configuration. Kokoro is a single trained model (~82M params, Apache 2.0, ~330 MB on disk) with a bundled voice library; "different manifests" correspond to different *language modes* of the same checkpoint, not different model weights.

## Initial roster

| File | Language Set | Voices | Notes |
|---|---|---:|---|
| `kokoro-82m.json` | American + British English | ~28 | The production default; what most tenants run |
| `kokoro-82m-multilingual.json` | Japanese, Mandarin, French, Hindi, Italian, Portuguese (BR) | ~23 | Same weights, multilingual phoneme path |

The two configs use the same model checkpoint. The difference is the `langCode` passed to Kokoro's pipeline at startup, which determines which voices are usable and which phoneme model is loaded. For a tenant serving both English and Japanese, run two containers with two manifest names.

## Schema

```json
{
  "name":         "<canonical safebox name>",
  "manifestHash": "<sha256 of canonical JSON, populated by install protocol>",
  "version":      "<kokoro release>",
  "vendor":       "hexgrad",
  "license":      "Apache-2.0",
  "homepage":     "<HF URL>",

  "kokoro": {
    "langCode":      "<a | b | j | z | f | h | i | p>",
    "defaultVoice":  "<voice id, e.g. af_heart>",
    "defaultSpeed":  <float, 1.0 = normal>,
    "defaultFormat": "<wav | mp3 | ogg>",
    "sampleRate":    24000
  },

  "capabilities": {
    "speech":      true,
    "voiceClone":  false,
    "emotion":     false,
    "streaming":   true,
    "languages":   ["en-US", "en-GB", ...]
  },

  "voices": ["<voice id 1>", "<voice id 2>", ...],

  "resources": {
    "minGpuMemoryGb":     <int — 0 for CPU>,
    "recommendedGpu":     "<short string>",
    "approximateLoadSec": <int>,
    "diskSizeGb":         <float>,
    "realTimeFactorTypical": "<informational string>"
  },

  "notes": "<free text>"
}
```

## Voice naming convention

Kokoro voices follow `<lang><gender>_<name>`:

- First char: language — `a` (American English), `b` (British English), `j` (Japanese), `z` (Mandarin), `f` (French), `h` (Hindi), `i` (Italian), `p` (Brazilian Portuguese)
- Second char: gender — `f` (female) or `m` (male)
- Underscore + name: voice identity

Examples: `af_heart` (American female, "Heart" voice), `bm_george` (British male, "George"), `jf_alpha` (Japanese female, "Alpha").

The runner exposes the bundled voices via `GET /v1/voices`. The list comes from the loaded model at runtime; the manifest's `voices` array is informational only.

## Why Kokoro vs the alternatives

This is documented at length in the runner README. Quick summary as of June 2026:

| Model | License | Size | Quality | Why Kokoro is the right Safebox default |
|---|---|---:|:---:|---|
| **Kokoro** | Apache 2.0 | 82M | ★★★★☆ | Permissive license, tiny, runs on any CPU, no per-use fees, ~210× RT on a consumer GPU |
| Chatterbox-Turbo | MIT | 350M | ★★★★★ | Better quality + voice cloning, but bigger; future second manifest |
| Fish Audio S2 Pro | Open weights, paid commercial | ~4B | ★★★★★ | Commercial use needs Fish Audio license — license trap |
| VibeVoice | Microsoft Research, custom | 1.5B-7B | ★★★★ | Watermarks, English+Chinese only, research-grade flag |
| Dia2 | Apache 2.0 | ~1.6B | ★★★★ | Multi-speaker dialogue specialty; second manifest if podcast use case |
| Hume TADA | MIT-ish | ~1B | ★★★★ | Long-form (700s), zero-hallucination — future addition |

Kokoro wins for the v1 default because of license + footprint + ubiquity. Adding Chatterbox or Dia2 as a second runner (separate directory, since they're different libraries) is a clean post-v1 addition.

## Adding a new model

Different TTS library = different runner directory. Stay within `kokoro-tts/` only for things Kokoro can do; for Chatterbox, F5-TTS, Dia2, etc., create a parallel runner with its own `runner.py` and `manifests/`.

Within Kokoro, adding a new language config is just a manifest:

1. Pick a `langCode` (see the Kokoro upstream docs — they have a comprehensive list)
2. List the voices that exist for that language
3. Set a sensible `defaultVoice`
4. Test:
   ```
   docker run -d --name kokoro-test \
       -e MODEL_NAME=<your-name> \
       -e KOKORO_LANG_CODE=<a-letter> \
       -e DEFAULT_VOICE=<voice-id> \
       safebox/kokoro-tts:latest
   ```
