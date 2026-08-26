# ONNX Runner

**The light "not-LLM" tier** — embeddings, rerankers, CLIP/vision encoders, and
small classifiers. Models that are a forward pass in, a vector or label out; they
don't need vLLM's generation machinery, so this runner is small and close to
auditable (ONNX Runtime, minimal deps) — the opposite end of the surface
spectrum from the heavy Python/CUDA runners.

## Protocol

| Endpoint | Purpose |
|---|---|
| `POST /v1/embed` | Text (or image, for CLIP) → embedding vector(s) |
| `POST /v1/rerank` | (query, documents) → scored/reordered results |
| `GET /v1/capabilities` | What this loaded model can do |
| `GET /v1/capacity` | ready/cold, device |
| `GET /v1/models` | baked manifests + loaded model |
| `GET /health` | liveness |

Same conventions as the rest of the suite: HMAC auth over the unix socket,
audit-trail SHA-256 of the output in `X-Safebox-Output-Sha256`, weights loaded
read-only from `/models/<...>` (installed + SHA-256-verified by the system
component — this runner never fetches).

## Manifests

| Model | Task | Notes |
|---|---|---|
| `bge-small-en-v1.5` | embed | Default English embedding, CPU-viable, 384-dim |
| `bge-reranker-base` | rerank | Cross-encoder; pairs with the embedder |
| `clip-vit-base-patch32` | vision-embed | Shared image/text space; image search, zero-shot |

Add manifests for multilingual (bge-m3), larger embedders, or task classifiers
as needed — same shape.

## Why this runner exists

Every other modality had a runner (whisper, comfyui, kokoro-tts, stable-audio,
ltx-video, wan-video, triposr, mineru) — but the embedding/rerank/vision-encoder
tier had none, so retrieval, semantic search, image search, and reranking had no
home. This fills that gap with the lightest runner in the suite.

## Build

```
# CPU (default, lightest):
docker build -t safebox/onnx:latest .
# GPU:
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             --build-arg ONNX_GPU=1 -t safebox/onnx:latest .
```

Base image is `@sha256`-pinned (`ARG BASE`), resolved at build via
`../resolve-digests.sh`.
