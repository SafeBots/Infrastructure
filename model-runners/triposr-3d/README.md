# triposr-3d — Single-Image 3D Reconstruction Runner (planned)

**Model:** TripoSR (Stability AI + Tripo AI)
**License:** MIT
**Modality:** Single 2D image → 3D mesh
**Manifest:** [`config/artifacts/models/triposr.json`](../../config/artifacts/models/triposr.json)
**Status:** Skeleton

## Why this model

TripoSR is the fastest open-weight image-to-3D pipeline — sub-1-second generation on consumer GPU hardware. Feed-forward transformer reconstruction; no diffusion loop required. The MIT license makes it commercially clean without the Tencent Community License complications that come with Hunyuan3D.

The trade-off vs Hunyuan3D 2.1: TripoSR produces mesh with vertex colors only (no PBR materials), and the topology is rougher. Hunyuan3D produces PBR-textured meshes with cleaner topology, but its license requires per-deployment review.

For an MIT-clean 3D capability that's "good enough" for prototyping, e-commerce previews, AR catalog builders, and game-jam-tier asset generation, TripoSR is the right pick. For final-quality assets, the Batch 3 roster adds Hunyuan3D.

## Hardware

- 6 GB VRAM minimum
- Any consumer GPU works (RTX 3060+)
- CPU inference works for non-time-critical use; ~30s per generation on modern CPU

## API surface

```
POST /v1/3d/generate              ← image → GLB or OBJ mesh
POST /v1/models/load              ← M-of-N gated
POST /v1/models/unload            ← M-of-N gated
GET  /v1/capabilities
GET  /health
```

No 3D streaming endpoint — generation is fast enough that synchronous responses are reasonable.

## Backend approach

Upstream `triposr` Python package wrapped in a FastAPI adapter. The model is small and fast enough that the adapter and the model run in one process. Output mesh is serialized to GLB and returned in the response body.
