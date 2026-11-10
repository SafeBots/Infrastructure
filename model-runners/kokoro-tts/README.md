# Kokoro TTS Runner — Safebox Local Service

**Safebox-canonical text-to-speech runner backed by Kokoro** (82M params, Apache 2.0, [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)). The right open-source TTS default for 2026: tiny model, permissive license, ~28 bundled English voices, runs on any laptop CPU, ~80-210× real-time on a consumer GPU.

This runner takes text in, produces audio out, returns either a file path (default) or inline base64. Supports WAV, MP3, OGG. Streaming SSE for long-form text where the UI wants to start playing while synthesis continues.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**

- `POST /v1/speech` — text → audio. Streaming via `stream: true`.
- `GET  /v1/voices` — list bundled voices loaded into this runner.
- `GET  /v1/capabilities` — what this runner can do.
- `GET  /v1/capacity` — current load, cumulative characters synthesized.
- `GET  /v1/models` — what's loaded.
- `GET  /health` — liveness; 200 once Kokoro has finished loading, 503 while loading.

**Voices:** ~28 American/British English voices ship with the default `kokoro-82m` manifest. The multilingual manifest (`kokoro-82m-multilingual`) covers Japanese, Mandarin, French, Hindi, Italian, and Brazilian Portuguese with ~23 more voices.

**Output formats:** WAV (always), MP3, OGG/Opus (via ffmpeg in the container).

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│                                                                     │
│  runner.py  (FastAPI + Kokoro library, single process)              │
│      ├─ Kokoro 82M model loaded into CPU/GPU memory                 │
│      │   espeak-ng phonemizer · StyleTTS2-derived synthesis         │
│      ├─ Voice library (~28 voices, ~100 KB each)                    │
│      ├─ Optional ffmpeg subprocess for MP3/OGG encoding             │
│      └─ FastAPI listening on Unix socket                            │
│          /run/safebox/services/speech-1.sock                        │
│                                                                     │
│  Audio output written to /data/output/                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
        ▲
        │ Safebox-canonical requests
        │
   Safebox Plugin → Protocol.Speech.Local(...)
```

Single Python process, no supervisord — Kokoro loads in-process via lazy import. Closer to the Whisper pattern than vLLM. Container is small (~1 GB image including the model), fast to start.

**Why one container per language family.** Kokoro loads one `langCode` at startup (American English by default). Switching languages means restarting the process. Match the Safebox runner pattern — one container per job — and run multiple containers if a tenant needs multiple language families. Route by model name at the Safebox plugin layer.

---

## 🚀 Quick start

### Build

```bash
cd model-runners/kokoro-tts

# CPU dev/prod build (Kokoro is small enough to run on CPU at usable speed)
docker build -t safebox/kokoro-tts:latest .

# GPU build (for max throughput)
docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
             -t safebox/kokoro-tts:latest .

# Bake the model into the image (skips first-run download)
docker build --build-arg PREFETCH=1 -t safebox/kokoro-tts:latest .
```

### Run

```bash
# American English (default)
docker run -d --name safebox-kokoro \
    --network safebox-net \
    -e MODEL_NAME=kokoro-82m \
    -e DEFAULT_VOICE=af_heart \
    -e SERVICE_ID=speech-1 \
    -e SAFEBOX_REQUIRE_HMAC=true \
    -v safebox-sockets:/run/safebox/services \
    -v /etc/safebox:/etc/safebox:ro \
    -v safebox-kokoro-cache:/root/.cache/huggingface \
    -v /data/audio-out:/data/output \
    safebox/kokoro-tts:latest

# British English on the same Safebox (different container, different socket)
docker run -d --name safebox-kokoro-uk \
    --network safebox-net \
    -e MODEL_NAME=kokoro-82m \
    -e DEFAULT_VOICE=bm_george \
    -e SERVICE_ID=speech-uk \
    ... safebox/kokoro-tts:latest

# Japanese on the same Safebox
docker run -d --name safebox-kokoro-jp \
    -e MODEL_NAME=kokoro-82m-multilingual \
    -e KOKORO_LANG_CODE=j \
    -e DEFAULT_VOICE=jf_alpha \
    -e SERVICE_ID=speech-jp \
    ... safebox/kokoro-tts:latest
```

### Test

```bash
# Capabilities (works immediately, before model is loaded)
curl --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/speech-1.sock \
    http://localhost/v1/capabilities | jq .

# Voices
curl --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/speech-1.sock \
    http://localhost/v1/voices | jq .

# Synthesize (blocks until model is ready)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/speech-1.sock \
    http://localhost/v1/speech \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "kokoro-82m",
      "text": "Welcome to the Safebox. Your data stays on this box.",
      "voice": "af_heart",
      "speed": 1.0,
      "format": "wav"
    }' | jq .

# Streaming SSE (chunks arrive as Kokoro produces them)
curl -N -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/speech-1.sock \
    http://localhost/v1/speech \
    -H "Content-Type: application/json" \
    -d '{
      "model": "kokoro-82m",
      "text": "This is a longer paragraph that gets split on punctuation. Each sentence comes back as its own SSE chunk so the UI can play audio while later sentences are still being generated. Useful for audiobook playback.",
      "stream": true
    }'
```

**Sample response (non-streaming):**

```json
{
  "model": "kokoro-82m",
  "voice": "af_heart",
  "audio": {
    "format":      "wav",
    "sampleRate":  24000,
    "durationSec": 3.42,
    "sizeBytes":   164256,
    "path":        "/data/output/safebox-speech-3b9e7f4d.wav"
  },
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "characters":     52,
    "audioSeconds":   3.42,
    "elapsedMs":      280,
    "realTimeFactor": 12.2
  }
}
```

---

## 📞 How Safebox calls it

### From Protocol.Speech.Local

```javascript
const result = await Protocol.Speech.Local({
    model: 'kokoro-82m',
    text:  'Your contract review is complete. Three clauses need attention.',
    voice: 'af_heart',
    format: 'wav'
});

console.log(result.audio.path);       // /data/output/safebox-speech-abc.wav
console.log(result.audio.durationSec); // 4.1
```

### Voice agent — closing the loop with the other runners

```javascript
// Voice agent: user speaks, we transcribe, generate a reply, speak it back.

// 1. Transcribe the user's audio (Whisper)
const heard = await Protocol.Transcription.Local({
    model:  'whisper-large-v3-turbo',
    source: '/data/uploads/user-question.wav'
});

// 2. Generate a response (vLLM)
const reply = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'You are a helpful and concise assistant.' },
        { role: 'user',   content: heard.text }
    ],
    maxTokens: 200
});

// 3. Speak the response (Kokoro)
const speech = await Protocol.Speech.Local({
    model: 'kokoro-82m',
    text:  reply.content,
    voice: 'af_heart',
    format: 'mp3'
});

// 4. Audit the round trip
await Q.Streams.create({
    type: 'AI/voice-turn',
    attributes: {
        userAudioSha:    heard.sourceSha256,
        transcriptSha:   heard.outputSha256,
        replyText:       reply.content,
        replyTextSha:    reply.outputSha256,
        responseAudioSha: speech.outputSha256,
        responseAudioPath: speech.audio.path,
        chain:           [heard.model, reply.model, speech.model],
        rtUserSpeech:    heard.usage.audioSeconds,
        rtSystemSpeech:  speech.audio.durationSec
    }
});

// Play speech.audio.path back to the user — voice agent loop closed,
// entirely local, hash-attested end-to-end.
```

Three runners, one voice interaction, every step recorded with content hashes. The pipeline is re-runnable from cold input months later — exactly what an audit looks like for an AI system that has to defend specific outputs.

### Auto-narration of generated content

```javascript
// User asks for an article. We write it, then narrate it.

const article = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'Write a 200-word explainer.' },
        { role: 'user',   content: userPrompt }
    ]
});

// Split into chunks of ~1000 chars (Kokoro handles this internally too,
// but explicit chunking lets us start playback sooner)
const chunks = chunkText(article.content, 1000);
for (const chunk of chunks) {
    const audio = await Protocol.Speech.Local({
        model: 'kokoro-82m',
        text:  chunk,
        voice: 'bm_george',
        format: 'mp3'
    });
    playAudio(audio.audio.path);
}
```

---

## 📊 Capabilities

`GET /v1/capabilities` returns:

```json
{
  "version":    "1.0",
  "runnerType": "speech-tts",
  "runnerId":   "safebox-kokoro-1",
  "serviceId":  "speech-1",
  "transport": {
    "socket": {
      "path":        "/run/safebox/services/speech-1.sock",
      "permissions": "0660",
      "group":       "safebox-services"
    }
  },
  "models": {
    "loaded":     ["kokoro-82m"],
    "loading":    [],
    "underlying": "kokoro"
  },
  "capabilities": {
    "speech":       true,
    "voiceClone":   false,
    "emotion":      false,
    "streaming":    true,
    "voiceCount":   28,
    "languages":    ["en-US", "en-GB"],
    "outputFormats": ["wav", "mp3", "ogg"],
    "sampleRate":   24000
  },
  "defaults": {
    "voice":  "af_heart",
    "speed":  1.0,
    "format": "wav"
  },
  "health": "healthy"
}
```

The capability flags reflect Kokoro's actual capabilities. **Voice cloning** is not supported by Kokoro (it's a fixed-voice model) — the `voiceClone` flag is gated off and the protocol returns 400 for requests asking for cloning. For voice cloning, a different runner (Chatterbox, F5-TTS) is the right addition post-1.0.

---

## 🔐 Privacy and trust

**Data path:**
- Text in, audio out, both stay local. The runner has no network egress except the Unix socket.
- Audio output written to `/data/output/` (host-mounted). The Safebox plugin reads from there to create `Streams/audio` streams.
- Model weights are read from the HuggingFace cache (mounted in) or `/srv/safebox/models/<manifestHash>/` (production path via Safebox install).
- Source text is hashed (`sourceSha256`) for the audit log but not persisted by the runner.

**HMAC:**
- Standard Safebox HMAC when `SAFEBOX_REQUIRE_HMAC=true`. Same convention as the other runners — timestamp + nonce + 5-minute replay window.

**Audit trail:**
- Every non-streaming response includes `sourceSha256` (hash of the input text bytes) and `outputSha256` (hash of the audio bytes).
- Kokoro is deterministic given a fixed text + voice + speed — re-runs produce byte-identical audio. The hashes let you prove that a specific audio file came from specific input text on a specific date.

---

## ⚡ Performance

**Real-time factor** (seconds of audio synthesized per second of wall clock):

| Hardware | RTF | Notes |
|---|---:|---|
| Apple Silicon (M2, 8-core) | ~8-15× | CPU-only, default config |
| Intel/AMD desktop (8-core) | ~5-10× | CPU-only |
| Intel/AMD server (16-core) | ~10-20× | CPU-only |
| NVIDIA T4 (16 GB) | ~80× | Mid-tier datacenter GPU |
| NVIDIA L4 (24 GB) | ~120× | Newer datacenter GPU |
| NVIDIA RTX 4090 (24 GB) | ~210× | Consumer flagship |

So a 5-minute audiobook chapter synthesizes through `kokoro-82m` in 25-30 seconds on a CPU laptop and 1.5 seconds on a 4090. Throughput scales linearly with the number of containers; multiple containers behind a load balancer is the production scaling pattern.

**Memory:**
- Model: ~330 MB on disk, ~500 MB resident
- Per-request: negligible (the audio buffer is tiny — 24kHz mono × few seconds = ~200 KB)
- Suitable for shared deployment with other small models on the same machine

**Cold start:**
- Container: <5 seconds
- Kokoro library import + model load: 5-15 seconds
- Voice library scan: included in load
- Wrapper comes up immediately; `/v1/capabilities` and `/health` work from the start; data endpoints return 503 until the model is loaded.

---

## 💰 Compare to per-character cloud APIs

For a team generating 5 million characters per month of TTS (call confirmations, agent voiceovers, audiobook chapters):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| ElevenLabs Creator ($22/mo for ~100k chars then $0.30/1k) | ~$1,500 | ✗ sent to ElevenLabs |
| OpenAI TTS ($15/1M chars) | $75 | ✗ sent to OpenAI |
| Azure Neural TTS ($16/1M chars) | $80 | ✗ sent to Azure |
| Amazon Polly Neural ($16/1M chars) | $80 | ✗ sent to Amazon |
| Fish Audio ($15/1M chars, premium tier) | $75 | ✗ sent to Fish Audio + commercial license |
| **Self-hosted Kokoro on Safebox** | **GPU/CPU power bill** | **✓ never leaves the box** |

At 5M chars/month a CPU-only Safebox amortizes faster than any cloud option. At 50M chars/month, even API-friendly OpenAI pricing crosses $750/month while a GPU-equipped Safebox handles it on the existing inference hardware.

The exposure column matters for any voice content that includes user names, transaction details, medical context, customer-confidential content, or anything regulated. Kokoro on Safebox means the text-to-speech step is invisible to anyone outside the deployment.

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as `privacy-filter`, `mineru`, `vllm`, `whisper`, and `comfyui`:

- ✅ Safebox-canonical endpoints (`/v1/speech`, `/v1/voices`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport with 0660 perms and `safebox-services` group ownership
- ✅ HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes on source and output
- ✅ Streaming SSE for long-form text
- ✅ Capability enforcement from manifest (voice cloning gated off — Kokoro doesn't support it)
- ✅ Multi-language manifest support (American English, multilingual variants)
- ✅ CPU and GPU deployment paths
- ✅ Multi-format output (WAV / MP3 / OGG via ffmpeg)

What it does NOT do (deliberately for v1.0):

- **Voice cloning.** Kokoro is a fixed-voice model. For zero-shot voice cloning add a Chatterbox or F5-TTS runner post-1.0.
- **Emotion / style control.** Kokoro doesn't expose per-utterance style controls. The voice selection IS the style (af_heart vs af_nicole vs am_michael). For finer emotion control add a runner that supports it.
- **SSML or per-phoneme overrides.** Kokoro takes plain text. The phonemizer runs internally on espeak-ng.
- **WebSocket transport.** Kokoro is fast enough on a GPU that the HTTP+streaming-SSE pattern is sufficient. For sub-200ms first-byte latency in a voice agent, a WebSocket transport would help — post-1.0.

---

## 📚 References

- Kokoro: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- TTS Arena: https://huggingface.co/spaces/Pendrokar/TTS-Spaces-Arena
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Other runners using this pattern: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/), [`../comfyui/`](../comfyui/)
