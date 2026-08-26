# Stable Audio Runner — Safebox Local Service

**Safebox-canonical audio generation runner backed by Stable Audio Open** (Stability AI, Apache 2.0). Music, sound effects, ambient audio, foley — anything text-to-audio diffusion can produce. Open weights, no commercial restrictions, runs locally on a Safebox.

This runner replaces an earlier stub (preserved as `runner.py.stub-pre-v1.0` etc.) with a production implementation. Mirrors the Kokoro TTS architecture — single Python process, FastAPI on Unix socket, lazy library import.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**

- `POST /v1/audio/generate` — text → audio
- `GET  /v1/capabilities`
- `GET  /v1/capacity`
- `GET  /v1/models`
- `GET  /health`

**Models supported (initial roster of two manifests):**

| Manifest | Variant | Max Duration | Best For |
|---|---|---:|---|
| `stable-audio-open-small.json` | 341M, 8 steps | 11s | SFX, voice-agent sounds, short loops — fast |
| `stable-audio-open-1.0.json` | 1.21B, 100 steps | 47s | Podcast intros, background music, foley — higher quality |

Both Apache 2.0, both fully commercial-unrestricted. See `manifests/README.md` for picking between them.

---

## 🏗 Architecture

Same shape as the Kokoro and Whisper runners — single process, lazy import, in-process inference:

```
┌─ container ─────────────────────────────────────────────────────────┐
│                                                                     │
│  runner.py  (FastAPI + stable-audio-tools)                          │
│      ├─ Stable Audio Open model loaded into GPU/CPU memory          │
│      │   diffusion UNet · VAE decoder · text conditioner            │
│      ├─ Optional ffmpeg subprocess for MP3/OGG encoding             │
│      └─ FastAPI listening on Unix socket                            │
│                                                                     │
│  Audio output written to /data/output/                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Why no streaming.** Diffusion is one-shot — the model produces the full clip in one forward pass. Mid-sample audio isn't useful. Unlike Whisper or Kokoro, this runner does not expose SSE.

**Why one model per container.** Same pattern as the other runners. Switching models means restarting the process. Run multiple containers for multiple variants; route by model name.

---

## 🚀 Quick start

```bash
# Build (GPU production)
docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
             -t safebox/stable-audio:latest .

# Run (small variant, fast)
docker run -d --name safebox-audio \
    --gpus all --network safebox-net \
    -e MODEL_NAME=stable-audio-open-small \
    -e SERVICE_ID=audio-1 \
    -v safebox-sockets:/run/safebox/services \
    -v safebox-audio-cache:/root/.cache/huggingface \
    -v /data/audio-out:/data/output \
    safebox/stable-audio:latest

# Test
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/audio-1.sock \
    http://localhost/v1/audio/generate \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "stable-audio-open-small",
      "prompt": "warm vintage synthesizer pad, slow attack, lofi tape saturation",
      "durationSec": 10,
      "seed": 42
    }'
```

**Sample response:**

```json
{
  "model": "stable-audio-open-small",
  "prompt": "warm vintage synthesizer pad, slow attack, lofi tape saturation",
  "audio": {
    "format": "wav",
    "sampleRate": 44100,
    "durationSec": 10.0,
    "sizeBytes": 1764044,
    "channels": 2,
    "path": "/data/output/safebox-audio-3b9e7f4d.wav"
  },
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "steps": 8,
    "elapsedMs": 3200,
    "realTimeFactor": 3.13,
    "seed": 42
  }
}
```

---

## 📞 How Safebox calls it

### From Protocol.Audio.Local

```javascript
const result = await Protocol.Audio.Local({
    model: 'stable-audio-open-small',
    prompt: 'crisp UI confirmation chime, 1 second, single bell-like tone',
    durationSec: 1
});
// result.audio.path — drop into the UI sound library
```

### Composing across runners — illustrated podcast

```javascript
// 1. Write the script (vLLM)
const script = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [{ role: 'user', content: 'Write a 90-second podcast intro about Safebox.' }]
});

// 2. Narrate it (Kokoro TTS)
const narration = await Protocol.Speech.Local({
    model: 'kokoro-82m',
    text:  script.content,
    voice: 'bm_george',
    format: 'wav'
});

// 3. Generate background music (Stable Audio)
const music = await Protocol.Audio.Local({
    model: 'stable-audio-open-1.0',
    prompt: 'understated electronic ambient, slow tempo, contemplative, '
          + 'low presence, suitable for podcast under-music',
    durationSec: 45
});

// 4. Mix and serve — handled by Safebox plugin
await Q.Streams.create({
    type: 'AI/podcast-segment',
    attributes: {
        scriptSha:    script.outputSha256,
        narrationSha: narration.outputSha256,
        musicSha:     music.outputSha256,
        narrationPath: narration.audio.path,
        musicPath:    music.audio.path,
        chain: [script.model, narration.model, music.model]
    }
});
```

Six runners composing through `Protocol.X.Local()` — privacy-filter, mineru, vllm, whisper, kokoro-tts, stable-audio-3 — all sharing the same wire format, same audit-trail discipline.

---

## ⚠️ Licensing — read this

**Stable Audio Open is Apache 2.0** — the Apache 2.0 license explicitly grants commercial use. No fees, no per-track licensing, no restrictions beyond standard Apache 2.0 terms (preserve copyright notice, no trademark grant, no warranty).

**Stable Audio 3 / Stable Audio Pro** (no "Open" in the name) are Stability AI's *closed* commercial products. Despite this runner's directory name being `stable-audio-3/` (historical), the manifests serve Stable Audio Open variants only. There are no shipped manifests for the closed products — they don't have downloadable weights.

For Safebox tenants doing commercial work: `stable-audio-open-small` and `stable-audio-open-1.0` are both safe choices.

---

## 🔐 Privacy and trust

Same as the other Safebox runners:

- Prompts and generated audio stay on the box; no network egress except the Unix socket.
- Output audio is written to `/data/output/` (host-mounted).
- Model weights are read from the HuggingFace cache or `/srv/safebox/models/<manifestHash>/` (production install).
- HMAC verification with timestamp + nonce + 5-minute replay window when `SAFEBOX_REQUIRE_HMAC=true`.
- Audit hashes on every response: `sourceSha256` over the canonical request (prompt + parameters + seed) and `outputSha256` over the audio bytes.
- With a fixed seed and deterministic sampler, regeneration produces byte-identical audio — useful for proving what audio was generated from what prompt.

---

## ⚡ Performance

**On consumer GPU (RTX 3090 / A10):**

| Model | Duration | Steps | Time | RTF |
|---|---:|---:|---:|---:|
| stable-audio-open-small | 11s | 8 | ~3-5s | ~2-3× |
| stable-audio-open-1.0 | 11s | 100 | ~15-25s | ~0.5× |
| stable-audio-open-1.0 | 47s | 100 | ~45-90s | ~0.5× |

**On datacenter GPU (A100 80GB):** roughly 2-3× faster across the board.

**Cold start:** ~30 seconds (Stable Audio + VAE + text conditioner load). The wrapper comes up immediately; `/v1/audio/generate` returns 503 until the model is ready.

---

## 💰 Compare to per-track cloud APIs

For a team generating 500 short audio clips per month (game sound effects, UI sounds, podcast bumpers):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| ElevenLabs SFX (per generation) | ~$100-300 | ✗ sent to ElevenLabs |
| Mubert API (royalty-tracked) | ~$50-200 + royalty share | ✗ sent to Mubert |
| Suno commercial | $30+/mo, per-track caps | ✗ sent to Suno |
| **Self-hosted Stable Audio Open** | **GPU power bill** | **✓ never leaves the box** |

For audio that includes brand-specific styling, voice talent references, or anything the operator considers IP, the self-hosted path eliminates the question of "where did this audio go after we generated it."

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as `privacy-filter`, `mineru`, `vllm`, `whisper`, `comfyui`, and `kokoro-tts`:

- ✅ Safebox-canonical endpoints (`/v1/audio/generate`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport with 0660 perms and `safebox-services` group ownership
- ✅ HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes on source and output
- ✅ Capability enforcement from manifest
- ✅ Multi-format output (WAV / MP3 / OGG)
- ✅ Two model manifests (small + full)

What it does NOT do (deliberately for v1.0):

- **Audio-to-audio.** Inpainting, style transfer, audio extension — capability flags exist but return 400. Adding requires loading the VAE separately and wiring a different sampling path.
- **Streaming.** Diffusion is one-shot. WebSocket / SSE wouldn't help — there's no incremental output.
- **Voice cloning or speech.** That's `kokoro-tts/`'s job. This runner is for music, SFX, ambient — not human speech.
- **MIDI / score conditioning.** Stable Audio Open is text-conditioned only. For score-conditioned music, a different model and runner.

---

## 📚 References

- Stable Audio Open: https://huggingface.co/stabilityai/stable-audio-open-1.0
- Stable Audio Open Small: https://huggingface.co/stabilityai/stable-audio-open-small
- stable-audio-tools: https://github.com/Stability-AI/stable-audio-tools
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Other runners using this pattern: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/), [`../comfyui/`](../comfyui/), [`../kokoro-tts/`](../kokoro-tts/)
