# whisper-asr — Speech Transcription Runner (planned)

**Model:** Whisper Large v3 (OpenAI)
**License:** MIT
**Modality:** Speech-to-text, 99 languages, optional translation to English
**Manifest:** [`config/artifacts/models/whisper-large-v3.json`](../../config/artifacts/models/whisper-large-v3.json)
**Status:** Skeleton

## Why this model

Whisper Large v3 is the de facto open-source ASR baseline. MIT license, broad language coverage, predictable failure modes. It's the right default for transcription anywhere accuracy matters more than latency. The faster-whisper variant (CTranslate2-based) offers 4× speedup with a quantized version that doesn't materially hurt accuracy.

## Hardware

- 10 GB VRAM for FP16; ~5 GB for INT8 quantized
- CPU works for short clips (1–5 minutes); not practical for long-form
- Apple Silicon supported via MLX; runs well on M2+

## API surface

```
POST /v1/transcribe              ← audio file → text + timestamps
POST /v1/transcribe/stream       ← chunked streaming transcription
POST /v1/translate               ← audio (non-English) → English text
POST /v1/models/load             ← M-of-N gated
POST /v1/models/unload           ← M-of-N gated
GET  /v1/capabilities
GET  /health
```

## Backend approach

faster-whisper (CTranslate2 backend) for GPU. The mlx-whisper variant for Apple Silicon deployments. The HuggingFace transformers backend is the fallback for development. All three speak the same model weights from the install manifest; the runner picks the backend based on the host environment at startup.
