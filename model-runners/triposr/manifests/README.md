# TripoSR Manifests

| File | Source | License | Min VRAM | Output Quality |
|---|---|---|---:|:---:|
| `triposr.json` | stabilityai/TripoSR | MIT | 6 GB | ★★★ |

One manifest for v1.0 — the original TripoSR (Stability AI + Tripo AI). Single-image to 3D mesh in under a second on consumer GPUs. MIT licensed.

## Why TripoSR for v1

In the 2026 open-source 3D landscape:

| Model | License | Min VRAM | Time | Quality | Why or why not |
|---|---|---:|---:|:---:|---|
| **TripoSR** | **MIT** | **6 GB** | **<1s** | **★★★** | **Smallest, fastest, cleanest license** ← shipped |
| Hunyuan3D 2.1 | Tencent Community | 16 GB | ~30s | ★★★★★ | Best quality + PBR textures; license has caveats |
| TRELLIS | MIT | 24 GB | ~2-5 min | ★★★★ | Clean reconstruction; future runner |
| Stable Fast 3D | Under-$1M-revenue | 8 GB | <2s | ★★★★ | Free only under revenue cap |
| Hi3DGen | MIT | 16 GB | ~1 min | ★★★★ | Best geometry; future runner |

For v1.0, TripoSR is the right primary: smallest disk footprint (2 GB), smallest VRAM requirement (6 GB), fastest inference, cleanest license. The output is vertex-colored meshes — fine for prototypes, game props, AR previews, draft assets. For production game/film assets that need PBR materials (albedo/normal/roughness/metallic maps), a future runner directory for Hunyuan3D 2.1 is the right addition; that's a different library and a different inference shape, so it deserves its own runner.

## Schema

```json
{
  "name":         "<canonical safebox name>",
  "manifestHash": "<sha256 of canonical JSON>",
  "version":      "<release>",
  "vendor":       "<who trained it>",
  "license":      "MIT",
  "homepage":     "<HF URL>",

  "triposr": {
    "huggingfaceModel":         "stabilityai/TripoSR",
    "defaultForegroundRatio":   <float, 0.0-1.0 — how much of the canvas the subject fills>,
    "defaultMeshResolution":    <int, 128/192/256/320/384/448/512 — mesh density>,
    "defaultFormat":            "glb | obj | ply",
    "defaultRemoveBackground":  <bool>
  },

  "capabilities": {
    "image2mesh":   true,
    "text2mesh":    false,
    "pbrTextures":  false,
    "vertexColors": true,
    "streaming":    false,
    "outputFormats": ["glb", "obj", "ply"]
  },

  "resources": { ... },
  "notes": "<free text>"
}
```

## Picking output format

**GLB** (default) — single binary file, includes geometry + materials + vertex colors. Drop directly into web (model-viewer, Three.js), AR (Apple Vision Pro, AR Quick Look), or game engines (Unity, Unreal — though you'll likely want to re-mesh for production). Best general-purpose choice.

**OBJ** — geometry only, materials in a sibling MTL file. Older format, broadly supported by every DCC tool (Blender, Maya, ZBrush). Use if you're handing the mesh to an artist.

**PLY** — point-cloud-friendly, useful for further processing (Open3D, CloudCompare). The mesh is exported with vertex colors. Use if you're piping into a 3D pipeline that prefers PLY.

## Adding new models

Different library = different runner directory:

- **Hunyuan3D 2.1** → `model-runners/hunyuan3d/` (post-1.0) — different pipeline (two-stage shape+paint), different deps, different license caveat to flag in the manifest
- **TRELLIS** → `model-runners/trellis/` (post-1.0) — multi-view diffusion pipeline, much higher VRAM
- **Hi3DGen** → `model-runners/hi3dgen/` (post-1.0) — geometry-focused, different output structure

Within this runner, adding new TripoSR variants (e.g. fine-tunes for specific object categories) is a one-file change — copy `triposr.json` and adjust the HF model id.
