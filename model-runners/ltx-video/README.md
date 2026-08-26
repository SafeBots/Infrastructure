# LTX-Video Runner — Safebox Local Service

**Safebox-canonical text-to-video and image-to-video runner backed by LTX-Video 2.3** (Lightricks, Apache 2.0, released March 2026). The fastest open-source video model in 2026, the cleanest commercial license, and the only top-tier option that runs comfortably on 16 GB consumer GPUs.

Same pattern as the other Safebox runners — single Python process, FastAPI on Unix socket, lazy library import.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**
- `POST /v1/video/generate` — text → MP4 (with optional input image for image-to-video)
- `GET  /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`

**Models supported:**

| Manifest | Variant | Min VRAM | Time per 5s clip |
|---|---|---:|---|
| `ltx-2-3-distilled.json` | distilled (~8B params) | 16 GB | 20-40s on RTX 4090 |
| `ltx-2-3-dev.json` | dev (22B params) | 24 GB | 60-180s on RTX 4090 |

Both Apache 2.0, both fully commercial-unrestricted.

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│  runner.py  (FastAPI + LTX-Video library)                           │
│      ├─ LTX-Video pipeline loaded into GPU                          │
│      │   DiT transformer · text encoder · VAE                       │
│      ├─ ffmpeg subprocess for MP4 encoding (h264 + yuv420p)         │
│      └─ FastAPI on Unix socket  /run/safebox/services/video-1.sock  │
│                                                                     │
│  MP4 output written to /data/output/                                │
└─────────────────────────────────────────────────────────────────────┘
```

**One model per container.** Same pattern as Kokoro and Stable Audio. The LTX pipeline holds the full model in VRAM; switching variants = restart the container.

**MAX_QUEUE_DEPTH defaults to 1.** Video inference is slow enough (15-180 seconds) that queuing more than one request per container creates pathological wait times. Operators who need higher throughput run multiple containers behind a load balancer.

**No streaming.** Diffusion is one-shot. Frame-level progress events would require modifying the LTX pipeline; that's post-1.0.

---

## 🚀 Quick start

```bash
# Build (GPU required)
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             -t safebox/ltx-video:latest .

# Run (distilled — the fast variant)
docker run -d --name safebox-video \
    --gpus all --network safebox-net --shm-size=4g \
    -e MODEL_NAME=ltx-2-3-distilled \
    -e SERVICE_ID=video-1 \
    -v safebox-sockets:/run/safebox/services \
    -v safebox-video-cache:/root/.cache/huggingface \
    -v /data/video-out:/data/output \
    safebox/ltx-video:latest

# Test — text-to-video
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/video-1.sock \
    http://localhost/v1/video/generate \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "ltx-2-3-distilled",
      "prompt": "cinematic close-up of a sunflower opening at sunrise, golden hour lighting, slow zoom-in",
      "negativePrompt": "blurry, low quality",
      "width": 768, "height": 512,
      "numFrames": 121, "fps": 24,
      "enableAudio": true,
      "audioPrompt": "soft morning breeze through grass, distant birdsong",
      "modalityScale": 3.0,
      "seed": 42
    }'

# Test — image-to-video (animate a still image)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/video-1.sock \
    http://localhost/v1/video/generate \
    -H "Content-Type: application/json" \
    -d '{
      "model": "ltx-2-3-distilled",
      "prompt": "subtle camera push-in, leaves gently rustling",
      "inputImage": "/data/input/garden.png",
      "numFrames": 49
    }'
```

**Sample response:**

```json
{
  "model": "ltx-2-3-distilled",
  "prompt": "cinematic close-up of a sunflower opening at sunrise...",
  "video": {
    "format": "mp4",
    "codec":  "h264",
    "width":  768,
    "height": 512,
    "numFrames": 121,
    "fps": 24,
    "durationSec": 5.042,
    "sizeBytes": 1284311,
    "path": "/data/output/safebox-video-3b9e7f4d.mp4"
  },
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "steps": 8,
    "elapsedMs": 28400,
    "realTimeFactor": 0.178,
    "seed": 42
  }
}
```

---

## 📞 How Safebox calls it

```javascript
// Text-to-video
const clip = await Protocol.Video.Local({
    model: 'ltx-2-3-distilled',
    prompt: 'aerial drone shot of a coastal town at dawn, slow rotation',
    width: 768, height: 512,
    numFrames: 121, fps: 24,
    seed: 42
});

// Image-to-video — animate a still
const animated = await Protocol.Video.Local({
    model: 'ltx-2-3-distilled',
    prompt: 'leaves gently swaying in the breeze',
    inputImage: comfyuiResult.images[0].path,  // chain from comfyui
    numFrames: 49
});

await Q.Streams.create({
    type: 'Streams/video',
    attributes: {
        prompt:    animated.prompt,
        promptSha: animated.sourceSha256,
        videoSha:  animated.outputSha256,
        videoPath: animated.video.path,
        durationSec: animated.video.durationSec
    }
});
```

### Composing across runners — end-to-end illustrated explainer

```javascript
// 1. Script (vLLM)
const script = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [{ role: 'user', content: 'Write a 30-second product explainer for Safebox.' }]
});

// 2. Narration (Kokoro)
const narration = await Protocol.Speech.Local({
    model: 'kokoro-82m', text: script.content, voice: 'bm_george'
});

// 3. Cover illustration (ComfyUI)
const cover = await Protocol.Image.Local({
    model: 'flux-1-schnell',
    prompt: 'minimalist illustration of a secure data vault, clean lines, blue palette',
    width: 1216, height: 704
});

// 4. Animate the illustration (LTX-Video) — chains from cover
const motion = await Protocol.Video.Local({
    model: 'ltx-2-3-distilled',
    prompt: 'subtle camera push-in, particles drifting through frame',
    inputImage: cover.images[0].path,
    numFrames: 121, fps: 24
});

// 5. Background music (Stable Audio)
const music = await Protocol.Audio.Local({
    model: 'stable-audio-open-1.0',
    prompt: 'understated cinematic ambient with light percussion, contemplative',
    durationSec: 5.0
});

// Hand the four artifacts to a downstream video editor to assemble
await Q.Streams.create({
    type: 'AI/explainer-package',
    attributes: {
        scriptSha:  script.outputSha256,
        narrationSha: narration.outputSha256,
        coverSha:   cover.outputSha256,
        motionSha:  motion.outputSha256,
        musicSha:   music.outputSha256,
        chain: [script.model, narration.model, cover.model, motion.model, music.model]
    }
});
```

Five runners chained, four media types produced, every step hash-attested. The pipeline is re-runnable from the original prompt months later. This was a single-runner aspirational claim three weeks ago; with LTX-Video added it's a real demo.

---

## ⚠️ Constraints (read these)

- **Dimensions must be divisible by 32.** The runner clamps automatically (e.g. 770 → 768). Plan for it.
- **Frame counts must be of the form 8k+1** (1, 9, 17, ..., 121, 129, ...). The runner rounds automatically. Default of 121 gives ~5 seconds at 24fps.
- **GPU memory is the binding constraint.** Even distilled needs 16 GB during inference. CPU inference is technically possible but takes 10-30 minutes per clip; the manifest's `minGpuMemoryGb` is 16 for a reason.
- **First-clip cold start is 60-90 seconds** while the pipeline loads weights into VRAM. Subsequent clips are fast.
- **Audio generation in LTX-2.3 is a separate code path** that this runner does not yet expose. The model can produce synced audio; the wrapper currently doesn't wire it up. `CAP_AUDIO=false` advertised. Post-1.0 work.

---

## ⚡ Performance

**Distilled, RTX 4090 (24 GB):**

| Resolution | Frames | Steps | Time |
|---|---:|---:|---:|
| 768×512 | 49 (~2s) | 8 | ~12-18s |
| 768×512 | 121 (~5s) | 8 | ~20-40s |
| 1216×704 | 121 (~5s) | 8 | ~30-60s |

**Dev, A100 (40 GB):**

| Resolution | Frames | Steps | Time |
|---|---:|---:|---:|
| 1216×704 | 121 (~5s) | 30 | ~45-90s |
| 1216×704 | 241 (~10s) | 30 | ~90-180s |

For real-time use cases (live agent video, immediate feedback loops), even the distilled variant is too slow on most hardware. The realistic deployment pattern is: text/image agents return immediately, video gets generated in the background with a "processing" placeholder until the MP4 is ready.

---

## 💰 Compare to per-second cloud APIs

For a team generating 60 short clips per month (product demos, ad creatives, agent video responses, social media draft loops at ~5s each):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| Runway Gen-3 ($0.30/sec) | ~$90 | ✗ sent to Runway |
| Sora Pro ($20/mo + ~$0.10/sec) | ~$50 | ✗ sent to OpenAI |
| Pika Pro ($30/mo + per-clip) | ~$60-150 | ✗ sent to Pika |
| **Self-hosted LTX-Video on Safebox** | **GPU power bill** | **✓ never leaves the box** |

The volume break-even is fast for video — even moderate use (100 clips/month) typically beats subscription pricing once the GPU is paid for, and the data-sovereignty story is the lead argument for brand-confidential or unreleased-IP content.

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as all the other Safebox runners:

- ✅ Safebox-canonical endpoints (`/v1/video/generate`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport, HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes on source and output
- ✅ Capability flags from manifest
- ✅ MP4 output via ffmpeg
- ✅ Text-to-video AND image-to-video
- ✅ Two model manifests (distilled + dev)

What it does NOT do (deliberately for v1.0):
- **Video-to-video.** Style transfer, editing, extension. Capability flag exists, returns 400.
- **Streaming progress.** Diffusion is one-shot; per-frame progress would require pipeline modifications.
- **WebM / GIF output.** MP4 only. ffmpeg can do the conversion in a post-step if needed.

What it DOES do that the previous revision didn't:
- ✅ **Synchronized audio + video** in a single forward pass via LTX-2.3's dual-stream architecture. Best for ambient sound, foley, and environmental effects — automatic foley as a side effect of generating the video. For music, use the `stable-audio-3` runner; for voice, use `kokoro-tts`. `enableAudio` defaults to true, `modalityScale: 3.0` for tight sync (1.0 for loose), optional separate `audioPrompt` if the desired sonic character differs from the visual prompt.

---

## 📚 References

- LTX-Video: https://github.com/Lightricks/LTX-Video
- LTX-2.3 release notes: https://ltx.io/release-notes
- Diffusers integration: https://huggingface.co/docs/diffusers
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Other runners: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/), [`../comfyui/`](../comfyui/), [`../kokoro-tts/`](../kokoro-tts/), [`../stable-audio-3/`](../stable-audio-3/)
