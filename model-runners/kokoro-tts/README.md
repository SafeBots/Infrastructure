# kokoro-tts — Speech Synthesis Runner (planned)

**Model:** Kokoro 82M v1.0 (hexgrad)
**License:** Apache 2.0
**Modality:** Text-to-speech, 9 languages, 10 voice presets
**Manifest:** [`config/artifacts/models/kokoro-82m.json`](../../config/artifacts/models/kokoro-82m.json)
**Status:** Skeleton

## Why this model

Kokoro is 82 million parameters — orders of magnitude smaller than ElevenLabs-class commercial models — and topped the TTS Arena leaderboard in January 2026. It runs at 36–96× real-time on a consumer GPU and produces serviceable speech on CPU alone, which makes it the right TTS model for the laptop and edge tier where llama.cpp also lives.

For voice cloning specifically, the planned roster includes Chatterbox (MIT, single-GPU voice cloning) as a separate runner. Kokoro itself does not support arbitrary voice cloning — it ships with curated voice presets.

## Hardware

- Runs on CPU. No GPU required.
- A consumer GPU (RTX 4060+) makes it real-time at 36× playback speed.
- Total weights are ~300 MB, smaller than most application bundles.

## API surface

```
POST /v1/speech                  ← text + voice_id → WAV
POST /v1/speech/stream           ← chunked streaming
POST /v1/models/load             ← M-of-N gated
POST /v1/models/unload           ← M-of-N gated
GET  /v1/voices                  ← list of available voice presets
GET  /v1/capabilities
GET  /health
```

## Backend approach

The upstream `kokoro` Python package is the reference implementation. The adapter wraps it directly — no separate server process needed because the model is small enough to fit in the adapter process itself. Single FastAPI process per runner instance.
