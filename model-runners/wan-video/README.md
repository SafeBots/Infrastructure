# Wan-Video Runner

**Video generation service for the Wan 2.1 model family — text-to-video, image-to-video, keyframe interpolation, video-to-video, and controllable generation.**

Serves multiple protocol endpoints under `/v1/video/`. Loads model weights from `/srv/safebox/models/<manifestHash>/` (populated by the system component's `/models/install` endpoint — see [`MODELS-PROTOCOL.md`](../../aws/docs/MODELS-PROTOCOL.md)).

---

## Status

**Spec + skeleton, not yet runnable.** This README and the Dockerfile establish the runner's contract; the actual inference loop (`runner.py`) is a stub pending integration of the [Diffusers](https://huggingface.co/docs/diffusers/main/en/api/pipelines/wan) Wan 2.1 pipelines. Production deployment requires:

1. The model weights to be installed via `POST /models/install` against a published Wan 2.1 manifest (checkpoints available from [Wan-AI on HuggingFace](https://huggingface.co/Wan-AI))
2. The runner container to be built from this directory and started by the system component's test/serve infrastructure

The stable-audio-3 runner in the sibling directory is the closest skeleton example. This runner follows the same pattern.

---

## What it does

Wan 2.1 is the current open-source quality leader for video generation (VBench 2026). It ships as two sizes — 14B (full pipeline set) and 1.3B (text-to-video and VACE only) — both Apache 2.0.

### Pipelines

| Pipeline | Endpoint | 14B | 1.3B | Description |
|----------|----------|-----|------|-------------|
| Text-to-Video | `/v1/video/generate` | Yes | Yes | Prompt → video, up to 1080p ~10s |
| Image-to-Video | `/v1/video/animate` | Yes | — | Single image → animated video, up to 720p |
| First-Last-Frame | `/v1/video/interpolate` | Yes | — | Two keyframes → interpolated video between them |
| Video-to-Video | `/v1/video/restyle` | Yes | — | Source video + prompt → restyled output |
| VACE Control | `/v1/video/control` | Yes | Yes | Controllable generation with depth, pose, sketch, flow, scribble, inpaint, outpaint, reference-image |

The keyframe interpolation pipeline (FLF2V) is the standout feature: given a first frame and a last frame, the model generates a coherent video that transitions between them. This enables storyboard-to-video workflows where an artist provides key poses or scenes and the model fills in the motion.

---

## Hardware

| Variant | Min VRAM | Resolution | Notes |
|---------|----------|------------|-------|
| 14B (all pipelines) | 24 GB | up to 1080p (T2V), 720p (I2V/FLF2V/V2V/VACE) | 1× H100 80GB recommended |
| 1.3B (T2V + VACE) | 16 GB | up to 720p | Runs on RTX 4090; faster, lower quality |

Generation time depends on resolution, frame count, and sampling steps. Expect 1–3 minutes per 5-second 720p clip on H100.

---

## API

### POST /v1/video/generate (Text-to-Video)

```json
{
  "prompt":     "a cat walking across a sunlit windowsill",
  "width":      1280,
  "height":     720,
  "numFrames":  81,
  "seed":       42,
  "guidanceScale": 5.5,
  "numInferenceSteps": 50
}
```

**Response:** MP4 video file (H.264, AAC silent track).

### POST /v1/video/animate (Image-to-Video)

```json
{
  "prompt":     "the flower blooms and petals fall",
  "image":      "<base64 PNG of starting frame>",
  "width":      1280,
  "height":     720,
  "numFrames":  81,
  "guidanceScale": 5.5
}
```

**Response:** MP4 video starting from the provided image.

### POST /v1/video/interpolate (First-Last-Frame)

```json
{
  "prompt":       "smooth camera pan from left to right",
  "firstFrame":   "<base64 PNG>",
  "lastFrame":    "<base64 PNG>",
  "width":        1280,
  "height":       720,
  "numFrames":    81,
  "guidanceScale": 5.5
}
```

**Response:** MP4 video interpolating between the two keyframes.

### POST /v1/video/restyle (Video-to-Video)

```json
{
  "prompt":     "same scene but in watercolor style",
  "video":      "<base64 MP4 of source>",
  "strength":   0.8,
  "guidanceScale": 5.5
}
```

**Response:** MP4 video with the source motion preserved, appearance restyled. `strength` controls divergence from the source (0.0 = identical, 1.0 = fully regenerated).

### POST /v1/video/control (VACE)

```json
{
  "prompt":     "a person dancing in a studio",
  "controlType": "pose",
  "controlVideo": "<base64 MP4 of pose reference>",
  "width":      1280,
  "height":     720,
  "numFrames":  81
}
```

**Supported `controlType` values:** `depth`, `pose`, `sketch`, `flow`, `scribble`, `inpaint`, `outpaint`, `reference`

**Response:** MP4 video following the control signal.

---

## Model selection

The runner reads `/etc/safebox/runners/wan-video/config.json` at startup:

```json
{
  "modelManifestHash": "abc...",
  "variant":           "14B",
  "pipeline":          "all"
}
```

The `modelManifestHash` must match an installed model in `/srv/safebox/models/`. The `variant` determines which checkpoint to load (`14B` or `1.3B`). The `pipeline` field can restrict which endpoints are active (`all`, `t2v`, `i2v`, `flf2v`, `v2v`, `vace`) — useful for dedicating a runner instance to a single pipeline on constrained hardware.

Switching models means updating this config and restarting the runner — there's no in-process hot-swap because we want the audit log to be clean (one model per runner lifetime).

---

## Diffusers integration

Under the hood, each endpoint maps to a Diffusers pipeline:

| Endpoint | Diffusers Pipeline |
|----------|--------------------|
| `/v1/video/generate` | `WanPipeline` |
| `/v1/video/animate` | `WanImageToVideoPipeline` |
| `/v1/video/interpolate` | `WanImageToVideoPipeline` (with `last_image`) |
| `/v1/video/restyle` | `WanVideoToVideoPipeline` |
| `/v1/video/control` | `WanVACEPipeline` |

Model checkpoints on HuggingFace:

- `Wan-AI/Wan2.1-T2V-14B-diffusers` — text-to-video 14B
- `Wan-AI/Wan2.1-T2V-1.3B-diffusers` — text-to-video 1.3B
- `Wan-AI/Wan2.1-I2V-14B-720P-diffusers` — image-to-video 14B
- `Wan-AI/Wan2.1-FLF2V-14B-720P-diffusers` — first-last-frame 14B
- `Wan-AI/Wan2.1-VACE-14B-diffusers` — VACE controllable 14B
- `Wan-AI/Wan2.1-VACE-1.3B-diffusers` — VACE controllable 1.3B

LoRA weights are supported via `load_lora_weights()` for fine-tuned styles.

---

## Governance integration

The runner itself is unprivileged — it can't fetch weights, can't update configs. Both happen via the system component:

- **Pulling a new model version:** Safebox sends `POST /models/install` with the new manifest. Safebox M-of-N gates this call. The System component downloads, verifies, installs.
- **Switching the runner to a new model:** Safebox sends `POST /system` with `managedContainer: "_host"`, `tool: "config"`, action to update the runner config. Same M-of-N gate.
- **Removing an old model:** Safebox sends `POST /models/<hash>/remove`. Same gate.

The runner doesn't participate in any of this. It just reads its config and serves inference.

---

## Runner Contract

This runner follows the standard Safebox runner contract:

- Exposes HTTP on `127.0.0.1:7792` (or Unix socket)
- `/v1/healthz` for system component probing
- `/v1/capabilities` for feature discovery (reports which pipelines are loaded)
- `/v1/capacity` for load balancing (reports GPU utilization and queue depth)
- HMAC auth via shared `safebox_auth.py` (strong canonical form)
- All responses include `X-Safebox-*` telemetry headers

---

## Files

- `Dockerfile` — runner container image
- `runner.py` — inference loop (stub)
- `requirements.txt` — Python dependencies
- `README.md` — this file
