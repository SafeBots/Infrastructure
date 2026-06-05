# nemotron-omni — Multimodal Reasoning Runner (planned)

**Model:** Nemotron 3 Nano Omni (NVIDIA)
**License:** NVIDIA Open Model License (more permissive than Apache 2.0)
**Modality:** Vision + Audio + Video + Text — all in one model
**Manifest:** [`config/artifacts/models/nemotron-3-nano-omni.json`](../../config/artifacts/models/nemotron-3-nano-omni.json)
**Status:** Skeleton

## Why this model

Nemotron 3 Nano Omni is a 30B-parameter mixture-of-experts model with 3B active per inference, released by NVIDIA in April 2026 under the NVIDIA Open Model License. It handles vision, audio, video, and text in one architecture, with a 1M-token context window. At equivalent interactivity, it claims 9× higher throughput than competing open omni models and tops six leaderboards including VoiceBench, WorldSense, DailyOmni, OCRBenchV2, and MMlongbench-Doc.

For Safebox, this is structurally different from the other runners: one model instance can serve transcription (replacing whisper-asr), chat (replacing parts of vllm), image understanding (no current runner), video understanding (no current runner), and audio understanding (no current runner). Communities that prioritize operational simplicity can run Nemotron Omni instead of the split-by-modality stack; communities that need each modality at frontier quality keep the dedicated runners.

The 1M context is the other significant capability. None of our other runners reach 1M tokens. Document-intelligence workloads that need to ingest entire codebases, long legal documents, or hour-long video transcripts fit here naturally.

## Hardware

- 24 GB GPU minimum for BF16
- 16 GB GPU sufficient for NVFP4 quantized
- H100 80GB / A100 80GB / L40S recommended for production throughput
- Apple Silicon not supported (NVIDIA-specific quantization formats)
- Tested on DGX Spark and DGX Station per the NVIDIA developer blog

## API surface

The runner serves multiple modality endpoints from one model instance:

```
POST /v1/chat                       ← text in, text out (LLM)
POST /v1/chat/multimodal            ← text + image/audio/video in, text out
POST /v1/transcribe                 ← audio in, text out (replaces whisper for these workloads)
POST /v1/audio/understand           ← audio in, structured analysis out
POST /v1/video/understand           ← video in, structured analysis out
POST /v1/image/understand           ← image in, text description out
POST /v1/models/load                ← M-of-N gated
POST /v1/models/unload              ← M-of-N gated
POST /v1/cache/flush                ← M-of-N gated
GET  /v1/capabilities
GET  /health
```

The output of any understanding endpoint can be fed into another tool through the standard Safebox `Action.propose` flow. A video summarization workflow would compose video understanding (here) with text generation (vllm or here) without leaving the Protocol surface.

## Backend approach

Two paths, both supported by NVIDIA:

1. **NVIDIA NIM microservice** — official, packaged, supported. Fastest path to production. Requires NVIDIA NGC credentials at AMI build time.
2. **transformers + custom inference** — for communities that want to inspect every line of code that touches their data. Slower path; requires the runner to manage the multimodal preprocessing (image encoder, audio encoder, video frame extraction) explicitly.

Phase 1 will use NIM with the BF16 checkpoint. NVFP4 quantization is roadmap for laptop deployment. transformers-only is a long-term option for high-assurance deployments that decline to run NIM.

## Attribution

NVIDIA Open Model License is one of the few permissive licenses that explicitly does not require attribution in outputs. The LICENSE file must travel with redistributed weights; outputs can be used without credit. The manifest's `attribution.required` is `false` accordingly. The license terms are at https://developer.nvidia.com/downloads/license/nvidia-open-model-license-agreement-juno-2024.

## When to deploy this instead of split runners

| Workload | Better with Nemotron Omni | Better with split runners |
|---|---|---|
| Long-document analysis | ✓ (1M context) | ✗ (most LLMs ≤200k) |
| Real-time voice chat | ✗ (1B effective active params for voice) | ✓ (Kokoro + Whisper specialized) |
| Music generation | ✗ (not trained for generation) | ✓ (YuE) |
| Image generation | ✗ (understanding only, no generation) | ✓ (FLUX schnell) |
| Mixed document + audio + video review | ✓ (one model, no handoff latency) | ✗ (split adds 100-300ms per modality switch) |
| GPU-constrained deployment | ✓ (one model loaded) | ✗ (multiple models = more VRAM) |
| Bleeding-edge quality per modality | ✗ (3B active is less than dedicated 7B LLMs) | ✓ |

Most production Safebox deployments will benefit from running both: Nemotron Omni for the multimodal-mixed workloads and the split runners for everything where specialization wins. The two compose via the standard Protocol surface — capability code never sees which runner handled which request.
