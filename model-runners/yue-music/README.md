# yue-music — Music Generation Runner (planned)

**Model:** YuE-s1-7B (HKUST + M-A-P)
**License:** Apache 2.0 — code and weights both
**Modality:** Music — full songs from lyrics + style prompt
**Manifest:** [`config/artifacts/models/yue-s1-7b.json`](../../config/artifacts/models/yue-s1-7b.json)
**Status:** Skeleton — no Dockerfile or runner.py yet

## Why this model

YuE relicensed from CC-BY-NC-SA to Apache 2.0 in January 2025, making it the cleanest-licensed serious option for full-song music generation in the open-weight space. It generates 5-minute multi-track outputs from lyrics + style prompts. The original release positioned it as "the open Suno" — and the relicense made that real for commercial deployment.

## Hardware

- 24 GB GPU minimum (the 7B variant)
- A100 80GB or 2×A6000 48GB recommended for production throughput
- CPU inference is not practical at this size

## API surface (to be implemented)

```
POST /v1/audio/generate       ← lyrics + style → multi-track WAV
GET  /v1/audio/generate/{taskId}  ← poll long-running generation
POST /v1/models/load          ← M-of-N gated
POST /v1/models/unload        ← M-of-N gated
POST /v1/cache/flush          ← M-of-N gated
GET  /v1/capabilities         ← runner descriptor
GET  /health                  ← liveness
```

## Backend approach (proposed)

Wrap the upstream `yue-generate` Python entry point (from `m-a-p/YuE`) in a FastAPI adapter mirroring the shape of `model-runners/privacy-filter/runner.py`. Multi-track output emerges as separate audio streams that can be remixed by downstream tools.

## Attribution

Per Apache 2.0 the LICENSE file must travel with redistributed weights. Per YuE's recommended labeling (from the GitHub README), outputs should be labeled "AI-generated" or "YuE-generated" when shared publicly. Surfacing this attribution requirement to downstream consumers is handled by the manifest's `attribution` block, which the Safebox plugin reads when producing output artifacts.
