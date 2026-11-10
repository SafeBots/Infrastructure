# Stable Audio 3 Runner

**Text-to-audio inference service for Stable Audio 3 small and medium.**

Serves the `/v1/audio/generate` protocol endpoint. Loads model weights from `/srv/safebox/models/<manifestHash>/` (populated by the system component's `/models/install` endpoint — see [`MODELS-PROTOCOL.md`](../../aws/docs/MODELS-PROTOCOL.md)).

---

## Status

**Spec + skeleton, not yet runnable.** This README and the Dockerfile establish the runner's contract; the actual inference loop (`runner.py`) is a stub pending integration of the [stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) library. Production deployment requires:

1. The model weights to be installed via `POST /models/install` against a published Stable Audio 3 manifest (manifest hashes will be published by Stability AI alongside the open-weight release)
2. The runner container to be built from this directory and started by the system component's test/serve infrastructure (1.1 work — system 1.0 doesn't yet spawn serving containers, only test containers)

The privacy-filter runner in the sibling directory is a worked example of the runner pattern with a real loaded model. This runner follows the same shape.

---

## What it does

Given a text prompt and a duration, generates stereo 44.1 kHz audio. Supports:

- **Text-to-audio generation** — prompts like "a jazz piano solo", "rain on a metal roof"
- **Variable-length output** — 1 second to 6 minutes 20 seconds (medium) or 2 minutes (small)
- **Inpainting** — single-segment, multi-segment, and continuation editing (post-1.1)
- **Both music and sound effects** — medium handles both; small ships as two specialized variants (`small-music`, `small-sfx`)

Based on the [Stable Audio 3 technical report](https://arxiv.org/abs/2605.17991), May 2026.

---

## Hardware

| Variant | Min VRAM | H200 generation time | MacBook Pro M4 (CoreML) |
|---|---|---|---|
| `small` (459M) | 4 GB | 0.44s | 3.09s for 120s output |
| `medium` (1.4B) | 8 GB | 1.31s for 6m 20s | — (use small for on-device) |

Numbers from the technical report (Section 5.9, Table 14). Medium runs comfortably on RTX 3060 / 4060 / 4070 consumer GPUs.

---

## API

### POST /v1/audio/generate

```json
{
  "prompt":       "a jazz piano solo",
  "durationSeconds": 30,
  "seed":         42,
  "samplingSteps": 8
}
```

**Response:** stereo 44.1 kHz audio (default WAV, configurable to FLAC/OGG).

**Optional fields:**
- `samplingSteps` (default 8) — ping-pong sampling steps. 8 is the recommended default from the paper.
- `seed` (default random) — deterministic generation when set.
- `cfgScale` — not used; Stable Audio 3 does not require CFG at inference.

### POST /v1/audio/inpaint (post-1.1)

```json
{
  "prompt":  "a louder ending",
  "audio":   "<base64 WAV of source audio>",
  "mask":    [
    { "startSeconds": 25.0, "endSeconds": 30.0 }
  ]
}
```

---

## Model selection

The runner reads `/etc/safebox/runners/stable-audio-3/config.json` at startup:

```json
{
  "modelManifestHash": "abc...",
  "variant":           "medium"
}
```

The `modelManifestHash` must match an installed model in `/srv/safebox/models/`. Switching models means updating this config and restarting the runner — there's no in-process hot-swap because we want the audit log to be clean (one model per runner lifetime).

---

## Governance integration

The runner itself is unprivileged — it can't fetch weights, can't update configs. Both happen via the system component:

- **Pulling a new model version:** Safebox sends `POST /models/install` with the new manifest. Safebox M-of-N gates this call. The System component downloads, verifies, installs.
- **Switching the runner to a new model:** Safebox sends `POST /system` with `managedContainer: "_host"`, `tool: "config"`, action to update the runner config. Same M-of-N gate.
- **Removing an old model:** Safebox sends `POST /models/<hash>/remove`. Same gate.

The runner doesn't participate in any of this. It just reads its config and serves inference.

---

## Files

- `Dockerfile` — runner container image
- `runner.py` — inference loop (stub)
- `requirements.txt` — Python dependencies
- `README.md` — this file
