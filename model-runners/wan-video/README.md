# Wan 2.2 Runner — Safebox Local Service

**Safebox-canonical text-to-video and image-to-video runner backed by Wan 2.2** (Alibaba, Apache 2.0). Mixture-of-Experts diffusion architecture — 27B total parameters with 14B active per denoising step — giving higher quality than LTX-Video at comparable VRAM, at the cost of longer inference time.

Same wire protocol as the [`ltx-video/`](../ltx-video/) runner. The two runners are sister services on the Video protocol; the Safebox plugin layer routes by model name to whichever container has the requested model loaded.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**
- `POST /v1/video/generate` — text → MP4 (with optional input image for image-to-video)
- `GET  /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`

**Models supported (three manifests):**

| Manifest | Variant | Min VRAM | T2V | I2V | Audio | Best For |
|---|---|---:|:---:|:---:|:---:|---|
| `wan-2-2-ti2v-5b.json` | 5B combined | 16 GB | ✅ | ✅ | ❌ | Consumer GPUs; both modes |
| `wan-2-2-t2v-a14b.json` | MoE A14B | 24 GB | ✅ | ❌ | ❌ | High-quality text-to-video |
| `wan-2-2-i2v-a14b.json` | MoE A14B | 24 GB | ❌ | ✅ | ❌ | High-quality image-to-video |

All three Apache 2.0, all three fully commercial-unrestricted.

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│  runner.py  (FastAPI + diffusers WanPipeline)                       │
│      ├─ Wan 2.2 model loaded into GPU                               │
│      │   ┌─────────────────────────┐                                │
│      │   │  high-noise expert (14B) │ — early denoising             │
│      │   ├─────────────────────────┤   (overall layout)             │
│      │   │  low-noise expert (14B)  │ — late denoising              │
│      │   └─────────────────────────┘   (texture, fine detail)       │
│      ├─ ffmpeg subprocess for MP4 encoding                          │
│      └─ FastAPI on Unix socket  /run/safebox/services/video-2.sock  │
│                                                                     │
│  MP4 output written to /data/output/                                │
└─────────────────────────────────────────────────────────────────────┘
```

**Why MoE matters.** Most diffusion models use a single network for all denoising steps. Wan 2.2 splits the work: a specialized expert for the noisy stages (when the model is establishing overall composition) and a separate specialized expert for the cleaner stages (when fine detail is being resolved). Each expert is 14B parameters, so VRAM stays at 14B-class while output quality reaches 27B-class. The transition between experts is governed by signal-to-noise ratio.

**The dual guidance scales.** Because there are two experts, there are two classifier-free guidance scales — `guidance` for the high-noise expert and `guidanceLowNoise` for the low-noise expert. The runner accepts both as request fields. Wan-AI's recommended defaults (4.0 / 3.0 for T2V-A14B) are good starting points.

**Sister to LTX-Video.** Same `/v1/video/generate` protocol, different container, different model. Operators typically run both — LTX-Video for fast iteration (8-step distilled), Wan 2.2 for high-quality finals (30-50 step MoE).

---

## 🚀 Quick start

```bash
# Build (GPU required)
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             -t safebox/wan-video:latest .

# Run the 5B variant (16 GB VRAM — consumer-friendly default)
docker run -d --name safebox-wan-video \
    --gpus all --network safebox-net --shm-size=4g \
    -e MODEL_NAME=wan-2-2-ti2v-5b \
    -e WAN_MODEL_PATH=Wan-AI/Wan2.2-TI2V-5B-Diffusers \
    -e WAN_VARIANT=ti2v-5b \
    -e SERVICE_ID=video-2 \
    -v safebox-sockets:/run/safebox/services \
    -v safebox-wan-cache:/root/.cache/huggingface \
    -v /data/video-out:/data/output \
    safebox/wan-video:latest

# Test — text-to-video
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/video-2.sock \
    http://localhost/v1/video/generate \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "wan-2-2-ti2v-5b",
      "prompt": "Two anthropomorphic cats in comfy boxing gear and bright gloves fight intensely on a spotlighted stage.",
      "width": 1280, "height": 704,
      "numFrames": 121, "fps": 24,
      "seed": 42
    }'

# Test — image-to-video (animate a still)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/video-2.sock \
    http://localhost/v1/video/generate \
    -H "Content-Type: application/json" \
    -d '{
      "model": "wan-2-2-ti2v-5b",
      "prompt": "the camera slowly orbits around the subject, gentle wind",
      "inputImage": "/data/input/product-photo.jpg",
      "numFrames": 81
    }'
```

**Sample response:**

```json
{
  "model": "wan-2-2-ti2v-5b",
  "prompt": "Two anthropomorphic cats...",
  "video": {
    "format":      "mp4",
    "codec":       "h264",
    "width":       1280,
    "height":      704,
    "numFrames":   121,
    "fps":         24,
    "durationSec": 5.042,
    "sizeBytes":   2143891,
    "hasAudio":    false,
    "path":        "/data/output/safebox-wan-video-3b9e7f4d.mp4"
  },
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "steps":            50,
    "elapsedMs":        82400,
    "realTimeFactor":   0.061,
    "seed":             42,
    "guidance":         5.0,
    "guidanceLowNoise": 3.0,
    "flowShift":        5.0
  }
}
```

---

## 📞 How Safebox calls it

```javascript
// High-quality text-to-video for a hero clip
const heroClip = await Protocol.Video.Local({
    model: 'wan-2-2-t2v-a14b',   // routes to the Wan A14B container
    prompt: 'aerial drone shot of a coastal town at sunrise, slow rotation, ' +
            'volumetric morning fog, cinematic color grading',
    width: 1280, height: 720,
    numFrames: 81, fps: 16,
    guidance: 4.0,
    guidanceLowNoise: 3.0,
    seed: 42
});

// Fast iteration draft using LTX-Video instead (same call shape)
const draftClip = await Protocol.Video.Local({
    model: 'ltx-2-3-distilled',   // routes to the LTX container
    prompt: '<same prompt>',
    seed: 42
});

// Operator can A/B the same prompt against both runners and pick the keeper
```

### Composing across runners — quality split

```javascript
// 1. Concept script (vLLM)
const script = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [{ role: 'user', content: 'Write 5 scene prompts for a product demo video.' }]
});

// 2. Draft each scene with LTX-Video (fast)
const drafts = await Promise.all(scenes.map(scenePrompt =>
    Protocol.Video.Local({ model: 'ltx-2-3-distilled', prompt: scenePrompt, seed: 1 })
));

// 3. Pick the keepers, then re-render with Wan 2.2 at quality
const finals = await Promise.all(approvedScenes.map(scenePrompt =>
    Protocol.Video.Local({
        model: 'wan-2-2-t2v-a14b',
        prompt: scenePrompt,
        seed: 1,  // same seed for consistency in iteration
        guidance: 4.0, guidanceLowNoise: 3.0
    })
));

// 4. Composer assembles. Every step hash-attested.
```

Two video runners side-by-side gives the operator a draft/final workflow that closed cloud APIs can't match — fast iteration on local hardware, then final-quality output also on local hardware.

---

## ⚠️ Constraints (read these)

- **Dimensions must be divisible by 16** (the runner clamps automatically). LTX-Video requires 32; Wan requires 16. The 16-multiple is more flexible.
- **A14B variants need 24 GB+ VRAM**, even with CPU offload. Don't try to run them on a 16 GB card — use the 5B variant instead.
- **The dual guidance scales** (`guidance` and `guidanceLowNoise`) are MoE-specific. The 5B single-stream variant ignores `guidanceLowNoise`. The A14B variants use both.
- **No audio.** Base Wan 2.2 generates video only. For synchronized audio+video, use the `ltx-video` runner. For background music, chain `stable-audio-3`. (Wan 2.2-S2V is a separate speech-to-video variant that isn't covered by this wrapper.)
- **First-clip cold start is 75-120 seconds** while the pipeline loads weights into VRAM. Subsequent clips are fast.

---

## ⚡ Performance

**5B TI2V on RTX 4090 (24 GB):**

| Resolution | Frames | Steps | Time |
|---|---:|---:|---:|
| 1280×704 | 81 (~3.4s) | 50 | ~45-75s |
| 1280×704 | 121 (~5s) | 50 | ~60-120s |

**A14B T2V on A100 (40 GB):**

| Resolution | Frames | Steps | Time |
|---|---:|---:|---:|
| 1280×720 | 81 (~5s) | 40 | ~75-180s |
| 1280×720 | 81 (~5s) | 50 | ~100-240s |

**A14B T2V on RTX 4090 (24 GB) with CPU offload:**

| Resolution | Frames | Steps | Time |
|---|---:|---:|---:|
| 1280×720 | 81 (~5s) | 40 | ~150-360s |

Roughly 3-5× slower than LTX-Video at comparable quality settings. The premium buys sharper textures, cleaner motion, and better prompt adherence on the A14B variants.

---

## 💰 Cost comparison

For a team generating 60 hero clips per month (each at 5 seconds, A14B quality):

| Provider | Per-clip | Monthly | Quality | Data exposure |
|---|---|---|:---:|---|
| Sora Pro (per-clip) | ~$1.00 | ~$60-100 | ★★★★★ | ✗ |
| Runway Gen-4.5 | ~$0.60 | ~$50-100 | ★★★★½ | ✗ |
| Kling Pro | ~$0.50 | ~$30-60 | ★★★★ | ✗ |
| **Self-hosted Wan 2.2 A14B** | **GPU power** | **~$15-40** | **★★★★** | **✓** |

For high-volume production with strict data-residency requirements (brand-confidential storyboards, unreleased product imagery, IP-licensed footage), self-hosted Wan 2.2 amortizes faster than any of the closed APIs and keeps everything on the box.

---

## ✅ Production status

This is a **production-ready runner**:

- ✅ Safebox-canonical endpoints (`/v1/video/generate`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport, HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes
- ✅ Three model manifests (5B, T2V A14B, I2V A14B)
- ✅ Text-to-video AND image-to-video (depending on variant)
- ✅ MoE dual guidance scales exposed as separate request fields
- ✅ CPU offload enabled by default for A14B (fits on RTX 4090)

What it does NOT do (deliberately for v1.0):
- **Audio.** Use the `ltx-video` runner for synchronized audio+video, or chain `stable-audio-3` for separate background music.
- **Video-to-video.** Wan 2.2 has VACE editing variants — would be a separate runner directory if added (different pipeline class, different inputs).
- **Wan 2.2-S2V.** Speech-to-video is a separate Wan variant — would be its own runner.
- **LoRA / fine-tunes.** The diffusers integration supports LoRA but the Safebox runner doesn't expose LoRA loading via the manifest. Post-1.0.

---

## 📚 References

- Wan 2.2: https://github.com/Wan-Video/Wan2.2
- HuggingFace org: https://huggingface.co/Wan-AI
- Diffusers Wan documentation: https://huggingface.co/docs/diffusers/api/pipelines/wan
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Sister runner: [`../ltx-video/`](../ltx-video/)
- Other Safebox runners: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/), [`../comfyui/`](../comfyui/), [`../kokoro-tts/`](../kokoro-tts/), [`../stable-audio-3/`](../stable-audio-3/), [`../triposr/`](../triposr/)
