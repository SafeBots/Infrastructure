# Whisper Runner — Safebox Local Service

**Safebox-canonical transcription runner backed by Faster-Whisper** (CTranslate2-based, ~4× faster than reference Whisper). One Docker image, one model per container, Safebox's standard wire format.

The runner converts audio (WAV, MP3, M4A, FLAC, OGG, Opus, WebM, MP4) into structured transcripts with timestamps, word-level confidence, and language detection. Optional VAD pre-filter strips silence. Optional SSE streaming yields segments as they're produced — useful for long audio where the UI wants to display progress.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**

- `POST /v1/transcribe` — transcribe one audio file. Streaming via `stream: true`.
- `POST /v1/transcribe/batch` — transcribe a list of files sequentially.
- `GET  /v1/capabilities` — what this runner can do (transcribe, translate, diarize, languages, etc.).
- `GET  /v1/capacity` — current load.
- `GET  /v1/models` — what's loaded.
- `GET  /health` — liveness; 200 once the model has finished loading, 503 while loading.

**Models supported (initial roster of five manifests in `manifests/`):**

| Manifest | Size | TR | Translate | Best for |
|---|---:|:---:|:---:|---|
| `whisper-large-v3-turbo.json` | 809M | ✓ | ✗ | Production sweet spot — multilingual at top speed |
| `whisper-large-v3.json` | 1.55B | ✓ | ✓ | Maximum accuracy + audio→English translation |
| `whisper-medium.json` | 769M | ✓ | ✓ | Laptops without dedicated GPU |
| `whisper-small.json` | 244M | ✓ | ✓ | CPU-only, edge, low VRAM |
| `distil-whisper-large-v3.json` | 756M | ✓ | ✗ | English-only at maximum throughput |

Adding a new variant is a one-file change. See [`manifests/README.md`](manifests/README.md).

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│                                                                     │
│  runner.py  (FastAPI + Faster-Whisper, single process)              │
│      ├─ Faster-Whisper model loaded into GPU (or CPU) memory        │
│      │   ctranslate2-based inference, Silero VAD pre-filter         │
│      └─ FastAPI listening on Unix socket                            │
│          /run/safebox/services/transcribe-1.sock                    │
│                                                                     │
│  Audio files mounted read-only at /data/                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
        ▲
        │ Safebox-canonical requests
        │
   Safebox Plugin → Protocol.Transcription.Local(...)
```

Faster-Whisper runs in-process — no separate inference server, no supervisord. The container is a single Python process serving the Safebox protocol. Simpler than the vLLM runner because Whisper models are small enough to load in seconds rather than minutes.

**Why one model per container:**

Whisper models load into VRAM at start time. Switching models means restarting the process. Match the pattern of the other Safebox runners — one container = one job. Multiple containers for multiple Whisper variants, route by model name at the Safebox plugin layer.

---

## 🚀 Quick start

### Build

```bash
cd model-runners/whisper

# CPU dev build (works on any machine, slower)
docker build -t safebox/whisper:latest .

# GPU production build (CUDA 12.x)
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             -t safebox/whisper:latest .

# Bake a specific model into the image (skip first-run download)
docker build --build-arg PREFETCH=large-v3-turbo \
             -t safebox/whisper:latest .
```

### Run

```bash
# Production: large-v3-turbo on GPU
docker run -d --name safebox-whisper-turbo \
    --gpus all \
    --network safebox-net \
    -e MODEL_NAME=whisper-large-v3-turbo \
    -e FASTER_WHISPER_MODEL=large-v3-turbo \
    -e WHISPER_DEVICE=cuda \
    -e WHISPER_COMPUTE_TYPE=float16 \
    -e SERVICE_ID=transcribe-1 \
    -e SAFEBOX_REQUIRE_HMAC=true \
    -v safebox-sockets:/run/safebox/services \
    -v /etc/safebox:/etc/safebox:ro \
    -v safebox-models:/root/.cache/huggingface \
    -v /data/audio:/data:ro \
    safebox/whisper:latest

# Laptop / CPU-only: small on int8
docker run -d --name safebox-whisper-small \
    --network safebox-net \
    -e MODEL_NAME=whisper-small \
    -e FASTER_WHISPER_MODEL=small \
    -e WHISPER_DEVICE=cpu \
    -e WHISPER_COMPUTE_TYPE=int8 \
    -e WHISPER_CPU_THREADS=4 \
    -v safebox-sockets:/run/safebox/services \
    -v /data/audio:/data:ro \
    safebox/whisper:latest
```

### Test

```bash
# Capabilities (works immediately, before model is loaded)
curl --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/transcribe-1.sock \
    http://localhost/v1/capabilities | jq .

# Transcribe a file (blocks until model is ready)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/transcribe-1.sock \
    http://localhost/v1/transcribe \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "whisper-large-v3-turbo",
      "source": "/data/meeting.mp3",
      "wordTimestamps": true,
      "vadFilter": true,
      "language": "en"
    }'

# Streaming (SSE) — segments arrive as they're produced
curl -N -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/transcribe-1.sock \
    http://localhost/v1/transcribe \
    -H "Content-Type: application/json" \
    -d '{
      "model": "whisper-large-v3-turbo",
      "source": "/data/podcast.mp3",
      "stream": true
    }'
```

**Sample response (non-streaming):**

```json
{
  "model":              "whisper-large-v3-turbo",
  "text":               "Welcome to the show. Today we're discussing...",
  "language":           "en",
  "languageConfidence": 0.991,
  "duration":           1842.3,
  "segments": [
    {
      "id":              0,
      "start":           0.0,
      "end":             4.2,
      "text":            " Welcome to the show.",
      "avgLogprob":      -0.18,
      "compressionRatio": 1.4,
      "noSpeechProb":    0.01,
      "words": [
        {"word": " Welcome", "start": 0.0, "end": 0.4, "probability": 0.99},
        {"word": " to",      "start": 0.4, "end": 0.6, "probability": 0.99},
        {"word": " the",     "start": 0.6, "end": 0.8, "probability": 0.99},
        {"word": " show.",   "start": 0.8, "end": 1.2, "probability": 0.97}
      ]
    }
  ],
  "speakers":     null,
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "audioSeconds":   1842.3,
    "elapsedMs":      48000,
    "realTimeFactor": 38.4
  }
}
```

---

## 📞 How Safebox calls it

### From Protocol.Transcription.Local

```javascript
// Inside Safebox
const result = await Protocol.Transcription.Local({
    model:           'whisper-large-v3-turbo',
    source:          '/data/meetings/2026-q2-board.mp3',
    language:        'en',
    wordTimestamps:  true,
    vadFilter:       true
});

console.log(result.text);                  // full transcript
console.log(result.segments.length);       // for chunked indexing
console.log(result.usage.realTimeFactor);  // how fast did it run
```

### As a Streams hook — auto-transcribe on audio upload

```php
<?php
// When a Files/file stream is created with an audio MIME type,
// extract its text into a sibling Streams/text stream.
Streams::listen('Streams/post/save', 'after', function($params) {
    $stream = $params['stream'];
    if ($stream->type !== 'Files/file') return;
    $mime = $stream->getAttribute('mimeType');
    if (!preg_match('#^audio/|video/#', $mime)) return;

    $result = Protocol_Transcription::Local([
        'model'  => 'whisper-large-v3-turbo',
        'source' => $stream->getAttribute('localPath'),
        'wordTimestamps' => true,
        'vadFilter'      => true
    ]);

    Streams::create([
        'publisherId' => $stream->publisherId,
        'name'        => 'Streams/text/transcribed-' . $stream->getId(),
        'type'        => 'Streams/text',
        'content'     => $result['text'],
        'attributes'  => [
            'sourceStream'    => $stream->name,
            'language'        => $result['language'],
            'audioSeconds'    => $result['duration'],
            'segments'        => count($result['segments']),
            'realTimeFactor'  => $result['usage']['realTimeFactor']
        ]
    ]);
});
```

### Composing with the other runners — meeting summary pipeline

```javascript
// 1. Transcribe the meeting audio
const transcript = await Protocol.Transcription.Local({
    model:  'whisper-large-v3-turbo',
    source: '/data/meetings/2026-06-28-board.mp3',
    wordTimestamps: true,
    language: 'en'
});

// 2. Redact PII from the transcript (privacy-filter)
const cleaned = await Protocol.Privacy.Local({
    model: 'privacy-filter',
    text:  transcript.text,
    mode:  'mask',
    entities: ['name', 'phone', 'email', 'ssn']
});

// 3. Generate a summary with structured action items (vLLM/Qwen)
const summary = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'Summarize this meeting transcript with sections: '
                                 + 'Decisions, Action Items (with owner + due date), Open Questions.' },
        { role: 'user', content: cleaned.redactedText }
    ],
    maxTokens: 2000,
    temperature: 0.2
});

// 4. Persist the chain for the audit log
await Q.Streams.create({
    type: 'AI/meeting-summary',
    attributes: {
        sourceAudio:    transcript.sourceSha256,
        transcriptSha:  transcript.outputSha256,
        cleanedSha:     await sha256(cleaned.redactedText),
        summarySha:     summary.outputSha256,
        modelChain:     [transcript.model, cleaned.model, summary.model],
        audioSeconds:   transcript.duration,
        totalTokens:    summary.usage.totalTokens
    },
    content: summary.content
});
```

Four runners composing through `Protocol.X.Local()`. Every step hashes its input and output for the Streams audit log. The whole pipeline is re-runnable from cold audio months later.

---

## 📊 Capabilities

`GET /v1/capabilities` returns:

```json
{
  "version":    "1.0",
  "runnerType": "transcription",
  "runnerId":   "safebox-whisper-1",
  "serviceId":  "transcribe-1",
  "transport": {
    "socket": {
      "path":        "/run/safebox/services/transcribe-1.sock",
      "permissions": "0660",
      "group":       "safebox-services"
    }
  },
  "models": {
    "loaded":     ["whisper-large-v3-turbo"],
    "loading":    [],
    "underlying": "large-v3-turbo"
  },
  "capabilities": {
    "transcribe":      true,
    "translate":       false,
    "diarize":         false,
    "wordTimestamps":  true,
    "vadFilter":       true,
    "batch":           true,
    "streaming":       true,
    "languages":       99,
    "inputFormats":    ["wav", "mp3", "m4a", "flac", "ogg", "opus", "webm", "mp4"]
  },
  "health": "healthy"
}
```

The capability flags come from the manifest. `/v1/transcribe` returns 400 if `task=translate` is requested on a runner whose manifest sets `capabilities.translate=false` (i.e. anything other than `whisper-large-v3`).

---

## 🔐 Privacy and trust

**Data path:**

- Audio stays local. The runner has no network egress except the Unix socket (and the in-process Faster-Whisper inference, which is GPU/CPU only).
- Source files are mounted read-only into the container at `/data/`. The runner never writes to the source.
- Output transcripts live in the Safebox response, not in the runner's process memory after the response is sent.
- The runner refuses `s3://`, `http://`, `https://`, `gs://` source URLs explicitly — stage the file into the Safebox first.

**HMAC:**

When `SAFEBOX_REQUIRE_HMAC=true`, every request must carry `X-Safebox-Timestamp`, `X-Safebox-Nonce`, and `X-Safebox-Signature` headers. The signature is `hex(hmac_sha256(timestamp + '.' + nonce + '.' + body, key))` where `key` is read at startup from `/etc/safebox/model-api.key`. Timestamps must be within ±300s of the runner clock; nonces are single-use.

**Audit trail:**

Every non-streaming response includes `sourceSha256` (hash of the source audio file bytes) and `outputSha256` (hash of the transcript text). Streaming responses include both in the final `done` event. These let an auditor verify months later that a specific transcript was produced from a specific audio file by a specific model — same input bytes plus same model version + parameters (greedy decoding, deterministic) yield the same output bytes.

For stochastic decoding (`temperature > 0`, beam search non-deterministic), the hashes still let you prove what the runner returned at a specific moment.

---

## ⚡ Performance

**Real-time factor** (audio seconds processed per wall-clock second):

| Model | Consumer GPU (e.g. RTX 3060) | Datacenter GPU (A100) | CPU (8-core) |
|---|---:|---:|---:|
| large-v3 | ~2x | ~55x | ~0.5x |
| large-v3-turbo | ~6x | ~129x | ~1.5x |
| medium | ~4x | ~70x | ~1x |
| small | ~8x | ~120x | ~2x |
| distil-large-v3 | ~10x batched | ~180x batched | ~1x |

So a 1-hour audio file on a Safebox with a single A100 transcribes through `whisper-large-v3-turbo` in roughly 30 seconds. The same file on a Safebox without a GPU, using `whisper-small` int8, transcribes in roughly 30 minutes. Pick the model to match the hardware.

**Cold start:** 5-30 seconds for the model load, depending on size. The wrapper comes up immediately and returns 503 from data endpoints until the model is ready; `/v1/capabilities` and `/health` work from the start.

**Memory:** 0.5 GB (small) to 6 GB (large-v3 at fp16) of VRAM. CPU int8 quantization halves these numbers. Disk: 0.5 GB (small) to 2.9 GB (large-v3).

---

## 💰 Compare to per-audio cloud APIs

For a team transcribing 1,000 hours of audio per month (call recordings, meetings, customer support):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| OpenAI Whisper API ($0.006/min) | $360 | ✗ sent to OpenAI |
| Deepgram Nova-3 ($0.0043/min) | $258 | ✗ sent to Deepgram |
| AssemblyAI ($0.65/hr) | $650 | ✗ sent to AssemblyAI |
| Rev.ai ($1.25/hr) | $1,250 | ✗ sent to Rev |
| **Self-hosted on Safebox** | **GPU power bill** | **✓ never leaves the box** |

A single A10 GPU amortized over depreciation + power + cooling typically lands around $250-400/month. Competitive with cloud at 1,000 hours/month, and dramatically better at higher volumes — the cloud costs scale linearly with minutes, the self-hosted cost is essentially flat once the hardware is in place. The exposure column is what makes the comparison interesting for medical records, depositions, attorney-client privileged calls, etc.

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as `privacy-filter`, `mineru`, and `vllm`:

- ✅ Safebox-canonical endpoints (`/v1/transcribe`, `/v1/transcribe/batch`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport with 0660 perms and `safebox-services` group ownership
- ✅ HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes on source and output
- ✅ Streaming SSE for long audio
- ✅ Capability enforcement (translate gated, diarize gated)
- ✅ Multi-model manifest system
- ✅ CPU and GPU deployment paths
- ✅ Idempotent restart (model reloads cleanly)

What it does NOT do (deliberately):

- **Live audio streaming.** This runner processes complete audio files. Real-time streaming transcription (microphone input from a browser) would need a separate runner with WebSocket transport and a chunked feeding loop into Faster-Whisper. Reasonable post-1.0 addition.
- **Speaker diarization.** The `diarize` capability flag exists in the protocol but the implementation is gated off. Adding it requires pyannote.audio as a dependency or NVIDIA Parakeet/Canary as an alternative ASR with built-in diarization. Post-1.0.
- **Multipart upload.** Audio files come from local paths. For uploading from a client, stage the file into the Safebox first (via the Files protocol) and then pass the local path here.

---

## 📚 References

- Faster-Whisper: https://github.com/SYSTRAN/faster-whisper
- Whisper paper (Radford et al., 2022): https://arxiv.org/abs/2212.04356
- Open ASR Leaderboard: https://huggingface.co/spaces/hf-audio/open_asr_leaderboard
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Other runners using this pattern: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/)
