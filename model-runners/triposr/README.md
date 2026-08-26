# TripoSR Runner — Safebox Local Service

**Safebox-canonical image-to-3D-mesh runner backed by TripoSR** (Stability AI + Tripo AI, MIT license). Single image in, textured 3D mesh out in under a second on a consumer GPU. The fastest open-source 3D reconstruction option in 2026 and the cleanest license.

Same architecture as the other Safebox runners — single Python process, FastAPI on Unix socket, lazy library import.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**
- `POST /v1/3d/generate` — image → 3D mesh (GLB / OBJ / PLY)
- `GET  /v1/capabilities`, `GET /v1/capacity`, `GET /v1/models`, `GET /health`

**Capabilities:**
- ✅ image-to-mesh (single image input)
- ✅ vertex colors baked into the mesh
- ✅ optional background removal via rembg
- ❌ text-to-mesh (TripoSR is image-only — chain ComfyUI for text→image→mesh)
- ❌ PBR textures (albedo / normal / roughness / metallic) — TripoSR produces vertex colors only

For PBR materials, the right model is Hunyuan3D 2.1, which deserves its own runner directory because the library and inference shape are completely different. v1.1 work.

---

## 🚀 Quick start

```bash
# Build (GPU)
docker build --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 \
             -t safebox/triposr:latest .

# Run
docker run -d --name safebox-3d \
    --gpus all --network safebox-net \
    -e MODEL_NAME=triposr \
    -e SERVICE_ID=3d-1 \
    -v safebox-sockets:/run/safebox/services \
    -v safebox-3d-cache:/root/.cache/huggingface \
    -v /data/3d-out:/data/output \
    safebox/triposr:latest

# Test — image input via file path
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/3d-1.sock \
    http://localhost/v1/3d/generate \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "triposr",
      "inputImage": "/data/input/teacup.png",
      "format": "glb"
    }'

# Test — image as data: URL (base64 inline)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/3d-1.sock \
    http://localhost/v1/3d/generate \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"triposr\",
      \"inputImage\": \"data:image/png;base64,$(base64 -w0 teacup.png)\",
      \"meshResolution\": 320,
      \"removeBackground\": true
    }"
```

**Sample response:**

```json
{
  "model": "triposr",
  "mesh": {
    "format":      "glb",
    "vertices":    24832,
    "faces":       49664,
    "sizeBytes":   1284113,
    "hasVertexColors": true,
    "path":        "/data/output/safebox-mesh-3b9e7f4d.glb"
  },
  "sourceSha256": "8f3a7b4d...",
  "outputSha256": "1c4e9f02...",
  "usage": {
    "meshResolution":    256,
    "foregroundRatio":   0.85,
    "removedBackground": true,
    "elapsedMs":         842
  }
}
```

Drop the GLB directly into `<model-viewer>`, Three.js, or any AR-capable client.

---

## 📞 How Safebox calls it

```javascript
const mesh = await Protocol.Mesh.Local({
    model: 'triposr',
    inputImage: '/data/uploads/product-photo.jpg',
    format: 'glb',
    meshResolution: 320
});

await Q.Streams.create({
    type: 'Streams/3d',
    attributes: {
        imageSha:  mesh.sourceSha256,
        meshSha:   mesh.outputSha256,
        meshPath:  mesh.mesh.path,
        vertices:  mesh.mesh.vertices,
        faces:     mesh.mesh.faces
    }
});
```

### Composing — text-to-3D via image-to-3D

TripoSR is image-only, but chaining with ComfyUI gives effective text-to-3D:

```javascript
// 1. Text → image (ComfyUI)
const concept = await Protocol.Image.Local({
    model: 'flux-1-schnell',
    prompt: 'studio shot of a vintage telephone, white background, frontal view',
    width: 1024, height: 1024
});

// 2. Image → 3D mesh (TripoSR)
const mesh = await Protocol.Mesh.Local({
    model: 'triposr',
    inputImage: concept.images[0].path,
    format: 'glb'
});

// 3. Animate the mesh in the scene (LTX-Video, if you want motion)
// (requires multi-view rendering first — post-1.0)

await Q.Streams.create({
    type: 'AI/3d-asset',
    attributes: {
        prompt:        'studio shot of a vintage telephone',
        conceptImage:  concept.images[0].path,
        meshPath:      mesh.mesh.path,
        chain:         [concept.model, mesh.model]
    }
});
```

This pattern — text → image → 3D mesh, three runners — is how Safebox tenants get text-to-3D without needing a separate text-to-3D model. ComfyUI does the heavy lifting on style/composition; TripoSR turns the result into geometry.

---

## ⚡ Performance

| Hardware | Cold start | Per-mesh inference |
|---|---:|---:|
| RTX 3060 (12 GB) | ~60s | ~1s |
| RTX 4090 (24 GB) | ~45s | ~0.5s |
| A10 (24 GB) | ~60s | ~0.7s |
| Apple Silicon M2 | ~90s | ~3-5s |
| CPU (16-core) | ~120s | ~20-30s |

The cold start is dominated by torch + tsr import + model load. Inference itself is fast — well under a second on any modern GPU. The runner sustains ~30-50 meshes per minute on a single 4090.

**Memory:** ~2 GB for model weights, ~4 GB peak during inference (for the 3D field evaluation). Fits comfortably on 8 GB cards.

---

## 🔧 Tunable parameters

| Field | Default | Range | Effect |
|---|---|---|---|
| `foregroundRatio` | 0.85 | 0.5 – 0.95 | Where the subject sits in the canvas. Lower = more padding around the subject. 0.85 is a good general-purpose value for product shots. |
| `meshResolution` | 256 | 128 – 512 | Mesh density. 128 = ~6k vertices, 256 = ~25k, 512 = ~100k+. Higher is sharper but slower to extract. |
| `removeBackground` | true | bool | Whether to run rembg first. Turn off if the input is already on a transparent or solid background. |
| `format` | "glb" | glb / obj / ply | Output format. GLB is the right default for web/AR; OBJ for DCC pipelines; PLY for further processing. |

---

## 💰 Compare to per-mesh cloud APIs

For a team generating 500 meshes per month (product catalog 3D-ification, game asset prototyping, AR shopping):

| Provider | Per-mesh cost | Monthly | Data exposure |
|---|---|---|---|
| Meshy Pro | ~$0.20-0.30 | $100-150 | ✗ sent to Meshy |
| Tripo Pro | ~$0.15-0.30 | $75-150 | ✗ sent to Tripo |
| Rodin Pro | ~$0.20 | $100 | ✗ sent to Rodin |
| **Self-hosted TripoSR on Safebox** | **GPU power bill** | **~$10-30** | **✓ never leaves the box** |

At 500/month a self-hosted Safebox amortizes faster than any cloud option. The exposure column is the lead argument for catalog work involving unreleased products, brand-confidential imagery, or licensed IP that can't be sent to third parties.

---

## ✅ Production status

This is a **production-ready runner** following the same conventions as all the other Safebox runners:

- ✅ Safebox-canonical endpoints (`/v1/3d/generate`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`)
- ✅ Unix socket transport, HMAC verification with replay protection
- ✅ Audit-trail SHA-256 hashes (over canonical request + over mesh bytes)
- ✅ Capability flags from manifest
- ✅ Three output formats (GLB / OBJ / PLY)
- ✅ Input as file path OR data: URL base64
- ✅ Optional background removal

What it does NOT do (deliberately for v1.0):

- **Text-to-3D.** TripoSR is image-only. For text-to-3D, chain ComfyUI → TripoSR (see above).
- **PBR textures.** Vertex colors only. For game/film-ready assets with PBR materials, future Hunyuan3D 2.1 runner.
- **Multi-view input.** TripoSR is single-image. Multi-view models (TRELLIS, Hunyuan3D-2mv) are different runners.
- **Mesh editing / remeshing.** Output is what the model produces. Cleanup/retopology is a downstream DCC step.

---

## 📚 References

- TripoSR: https://github.com/VAST-AI-Research/TripoSR
- Stability AI + Tripo AI announcement: https://stability.ai/news/triposr-3d-generation
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Sibling runners: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/), [`../vllm/`](../vllm/), [`../whisper/`](../whisper/), [`../comfyui/`](../comfyui/), [`../kokoro-tts/`](../kokoro-tts/), [`../stable-audio-3/`](../stable-audio-3/), [`../ltx-video/`](../ltx-video/)
