# Safebox Composable AMI Architecture

## Design Philosophy

**Composable, not tiered.** Each component is a labeled module that can be independently included or excluded. The build system composes AMI flavors by combining component labels.

**Why Composable?**
- Maps to Safebox stream architecture (each component = capability namespace)
- Maximum flexibility (tenants pick exactly what they need)
- Clean build scripts (each component has own installer)
- License transparency (each component declares license posture)
- Easier maintenance (update one component without rebuilding everything)
- Predictable sizing (disk/RAM = sum of included components)

---

## Component Taxonomy

### **Component Labels**

Each component has a **unique label** used in build scripts and AMI naming:

```
Format: safebox-<base>-<component1>-<component2>-...

Examples:
- safebox-base                                    # Minimal (no AI)
- safebox-base-vision-embed-llm-small            # Vision + embeddings + small LLM
- safebox-base-media-vision-llm-large            # Full media + vision + large LLM
- safebox-base-all-cpu                           # Everything (CPU variant)
- safebox-base-all-gpu                           # Everything (GPU variant)
```

---

## Component Catalog

### **SAFEBOX-BASE (Always Included)**

**Label:** `base`  
**License:** GPL-free (Apache 2.0, MIT, BSD, LGPL dynamic-link)  
**Disk:** ~8 GB  
**Idle RAM:** ~2 GB

**Contents:**
```
Core System:
├── Amazon Linux 2023 (minimal)
├── Nitro TPM 2.0 + attestation tools
├── Triple encryption (Nitro + EBS + ZFS)
├── MariaDB 10.5 (InnoDB, ZFS-optimized)
├── PHP 8.2 (APCu, sodium, opcache)
├── Nginx (X-Accel-Redirect, WebSocket)
├── Docker (overlay2 on ZFS)
├── Node.js 18 + PM2
├── ZFS 2.2 (CoW, compression, snapshots)
├── Percona XtraBackup
├── Certbot + Route53 plugin
├── CloudWatch Agent
├── Git + Mercurial (governance)
├── Python 3.11 + pip
└── Safebox binary + governance

Security Hardening:
├── Zero remote access (SSH/telnet/FTP removed)
├── CVE-2026-32746 mitigated (telnet removed)
├── Network hardening (ICMP off, stealth mode)
├── Kernel blacklists (unused protocols)
├── Immutable (no package manager)
└── TPM-measured (attestation manifests)

Directory Structure:
├── /srv/safebox/          # Core executables + config
├── /srv/encrypted/        # ZFS mount point
│   ├── mysql/
│   ├── apps/
│   ├── backups/
│   └── docker/
└── /opt/safebox/          # Reserved for AI/ML components
```

**Build Script:** `install-base.sh`  
**Installer Location:** `/opt/safebox-build/components/base/`

---

### **MEDIA (Optional)**

**Label:** `media`  
**License:** LGPL 2.1+ (no GPL codecs)  
**Disk:** ~370 MB  
**Idle RAM:** <20 MB  
**Dependencies:** None (standalone)

**Contents:**
```
Audio/Video:
├── FFmpeg (LGPL build, source-compiled)
│   └── --enable-lgpl --disable-gpl --disable-nonfree
├── Codecs (LGPL/BSD only):
│   ├── Opus, Vorbis, FLAC (audio)
│   ├── H.264 (openh264), AV1 (libaom/dav1d), VP8/VP9
│   └── EXCLUDED: x264, x265, fdk-aac (GPL/proprietary)
└── sox (audio conversion fallback)

Images:
├── libvips (fast preprocessing)
├── Pillow-SIMD (Python drop-in)
├── ImageMagick (no GPL delegates)
├── libheif (HEIC/HEIF - iOS images)
├── libwebp, libjxl, libavif
└── libexiv2 (metadata, not exiftool which is GPL)

Documents:
├── pdfium (PDF render + text, not poppler which is GPL)
├── markdown-it (Markdown parsing)
├── libarchive (tar/zip/7z extraction)
└── zstd, xz, brotli, gzip (compression)

Directory:
└── /opt/safebox/media/
    ├── bin/ffmpeg, bin/vips
    └── lib/ (all shared libraries)
```

**Capabilities Enabled:**
- `media/transcode` - Audio/video conversion
- `media/extract-frames` - Video → image frames
- `image/convert` - Format conversion
- `image/resize` - Image preprocessing
- `document/extract-text` - PDF text extraction
- `archive/extract` - Decompress archives

**Build Script:** `install-media.sh`  
**Installer Location:** `/opt/safebox-build/components/media/`

---

### **LIBREOFFICE (Optional)**

**Label:** `libreoffice`  
**License:** MPL 2.0  
**Disk:** ~600 MB  
**Idle RAM:** ~150 MB (when active)  
**Dependencies:** `media` (for PDF output)

**Contents:**
```
├── LibreOffice headless (no GUI)
├── Document converters:
│   ├── .docx → PDF
│   ├── .xlsx → PDF
│   ├── .pptx → PDF
│   └── Office formats → text extraction
└── /opt/safebox/libreoffice/
```

**Capabilities Enabled:**
- `document/office-to-pdf` - Convert Office docs
- `document/office-extract-text` - Extract text from Office docs

**Build Script:** `install-libreoffice.sh`  
**Installer Location:** `/opt/safebox-build/components/libreoffice/`

---

### **VISION (Optional)**

**Label:** `vision` or `vision-hq`  
**License:** Apache 2.0, MIT  
**Disk:** ~1.5 GB (standard) or ~3 GB (HQ)  
**Active RAM:** ~2 GB (standard) or ~5 GB (HQ)  
**Dependencies:** None (ONNX Runtime bundled)

**Standard Vision:**
```
Models (ONNX format):
├── SigLIP 2 base patch16-256 (~600 MB)
│   └── Image embeddings (512-dim)
├── BiRefNet-lite (~180 MB)
│   └── Background matting/removal
└── SAM 2 base (~400 MB)
    └── Segmentation masks

Directory:
└── /opt/safebox/vision/
    ├── runtimes/onnxruntime/
    └── models/
```

**HQ Vision (vision-hq):**
```
Models (ONNX format):
├── SigLIP 2 SO400M patch14-384 (~1.8 GB)
├── BiRefNet-HR (~900 MB)
└── SAM 2 base (~400 MB)

Disk: ~3 GB
Active RAM: ~5 GB
```

**Capabilities Enabled:**
- `vision/embed` - Image embeddings (eager on mutations)
- `vision/matte` - Background removal (lazy)
- `vision/segment` - Object segmentation (lazy)

**Writes on Mutation:**
- `Safebox/visualEmbedding` - 512-dim vector
- `Safebox/visualTags` - Top-K from precomputed vocab

**Build Script:** `install-vision.sh` or `install-vision-hq.sh`  
**Installer Location:** `/opt/safebox-build/components/vision/`

---

### **EMBED (Optional)**

**Label:** `embed`  
**License:** MIT, Apache 2.0  
**Disk:** ~1.5 GB  
**Active RAM:** ~2 GB  
**Dependencies:** None (ONNX Runtime bundled)

**Contents:**
```
Models (ONNX format):
├── BGE-M3 (~600 MB)
│   └── Multilingual embeddings (1024-dim)
├── Nomic Embed v2 (~550 MB)
│   └── English embeddings (768-dim)
├── Jina Embeddings v3 (~600 MB)
│   └── Long-context embeddings (1024-dim)
├── BGE Reranker v2-m3 (~600 MB)
│   └── Semantic reranking
└── MS MARCO MiniLM (~90 MB)
    └── Cross-encoder similarity

Directory:
└── /opt/safebox/embed/
    ├── runtimes/onnxruntime/
    └── models/
```

**Capabilities Enabled:**
- `text/embed` - Text embeddings (multilingual, English, long-context)
- `text/rerank` - Semantic reranking (second stage after retrieval)
- `text/similarity` - Cross-encoder similarity scoring

**Build Script:** `install-embed.sh`  
**Installer Location:** `/opt/safebox-build/components/embed/`

---

### **SPEECH (Optional)**

**Label:** `speech` or `speech-hq`  
**License:** MIT, Apache 2.0  
**Disk:** ~1.2 GB (standard) or ~2 GB (HQ)  
**Active RAM:** ~2 GB (standard) or ~3.5 GB (HQ)  
**Dependencies:** None (whisper.cpp bundled)

**Standard Speech:**
```
Models:
├── Whisper Turbo (GGUF, ~800 MB)
│   └── Speech-to-text transcription
├── Silero VAD (ONNX, ~2 MB)
│   └── Voice activity detection
└── Kokoro TTS (ONNX, ~330 MB)
    └── Text-to-speech synthesis

Directory:
└── /opt/safebox/speech/
    ├── runtimes/whisper.cpp/
    └── models/
```

**HQ Speech (speech-hq):**
```
Models:
├── Whisper Large v3 (GGUF, ~1.6 GB)
├── Silero VAD (~2 MB)
└── Kokoro TTS (~330 MB)

Disk: ~2 GB
Active RAM: ~3.5 GB
```

**Capabilities Enabled:**
- `speech/transcribe` - Audio → text transcription
- `speech/vad` - Voice activity detection (chunking)
- `speech/synthesize` - Text → audio synthesis

**Build Script:** `install-speech.sh` or `install-speech-hq.sh`  
**Installer Location:** `/opt/safebox-build/components/speech/`

---

### **OCR (Optional)**

**Label:** `ocr`  
**License:** Apache 2.0  
**Disk:** ~50 MB  
**Active RAM:** ~500 MB  
**Dependencies:** `media` (for image preprocessing)

**Contents:**
```
Models (ONNX format):
└── PaddleOCR (~50 MB)
    ├── Detection model
    ├── Recognition model
    └── Classification model

Directory:
└── /opt/safebox/ocr/
    ├── runtimes/onnxruntime/
    └── models/paddleocr/
```

**Capabilities Enabled:**
- `ocr/extract` - Extract text from images/PDFs

**Build Script:** `install-ocr.sh`  
**Installer Location:** `/opt/safebox-build/components/ocr/`

---

## LLM Capabilities - April 2026 Model Selection

**Context:** Open-weight landscape dominated by Chinese labs (Zhipu/GLM, Alibaba/Qwen, Moonshot/Kimi, DeepSeek, Xiaomi/MiMo). Google's Gemma 4 strongest Western entry at consumer-runnable scale.

**Selection Criteria:**
- Permissive license (Apache 2.0, MIT, or commercially-usable community license)
- GGUF availability and llama.cpp maturity
- Quality/parameter ratio
- All quantized to Q4_K_M (with Q5_K_M/Q6_K/Q8_0 upgrade paths in larger SKUs)

### **Tiny SKU LLMs (2-4 GB RAM headroom)**

| Model | License | Source | Disk (Q4_K_M) | Active RAM |
|-------|---------|--------|---------------|------------|
| Gemma 4 E2B (efficient 2B) | Gemma Terms | huggingface.co/google/gemma-4-e2b-it | ~1.6 GB | ~3 GB |
| Qwen 3.6 4B Instruct | Apache 2.0 | huggingface.co/Qwen/Qwen3.6-4B-Instruct | ~2.5 GB | ~4 GB |
| Phi-4-mini (3.8B) | MIT | huggingface.co/microsoft/Phi-4-mini-instruct | ~2.4 GB | ~4 GB |

**Use:** Routing, classification, simple extractions  
**Total Disk:** ~6.5 GB

### **Small SKU LLMs (8-16 GB RAM)**

| Model | License | Source | Disk (Q4_K_M) | Active RAM |
|-------|---------|--------|---------------|------------|
| Qwen 3.6 8B Instruct | Apache 2.0 | huggingface.co/Qwen/Qwen3.6-8B-Instruct | ~5 GB | ~7 GB |
| Mistral Nemo 12B Instruct | Apache 2.0 | huggingface.co/mistralai/Mistral-Nemo-Instruct-2407 | ~7 GB | ~9 GB |
| Phi-4 14B | MIT | huggingface.co/microsoft/Phi-4 | ~8 GB | ~10 GB |
| Gemma 4 9B Instruct | Gemma Terms | huggingface.co/google/gemma-4-9b-it | ~5.5 GB | ~7 GB |

**Use:** General assistant tier  
**Total Disk:** ~25.5 GB

### **Medium SKU LLMs (32-64 GB RAM)**

| Model | License | Source | Disk (Q4_K_M) | Active RAM |
|-------|---------|--------|---------------|------------|
| Qwen 3.6 35B-A3B (MoE, 3B active) | Apache 2.0 | huggingface.co/Qwen/Qwen3.6-35B-A3B-Instruct | ~21 GB | ~24 GB |
| Mistral Small 4 24B | Apache 2.0 | huggingface.co/mistralai/Mistral-Small-4-24B | ~14 GB | ~17 GB |
| Gemma 4 26B (MoE) | Gemma Terms | huggingface.co/google/gemma-4-26b-it | ~16 GB | ~19 GB |
| Qwen 3.6 32B Instruct | Apache 2.0 | huggingface.co/Qwen/Qwen3.6-32B-Instruct | ~19 GB | ~22 GB |

**Use:** Strong reasoning and coding tier  
**Note:** Qwen 3.6 35B-A3B is MoE sweet spot (runs on 32GB Mac Studio at ~21GB)  
**Total Disk:** ~70 GB

### **Large SKU LLMs (64-128 GB RAM or mid-range GPU)**

| Model | License | Source | Disk (Q4_K_M) | Active RAM/VRAM |
|-------|---------|--------|---------------|-----------------|
| Llama 4 Scout 109B (MoE, 17B active) | Llama 4 Community | huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct | ~60 GB | ~65 GB |
| Qwen 3.6 72B Instruct | Qwen License | huggingface.co/Qwen/Qwen3.6-72B-Instruct | ~41 GB | ~46 GB |
| Llama 3.3 70B Instruct | Llama Community | huggingface.co/meta-llama/Llama-3.3-70B-Instruct | ~40 GB | ~45 GB |
| Nemotron Super 49B | NVIDIA Open Model | huggingface.co/nvidia/Nemotron-Super-49B | ~28 GB | ~32 GB |

**Use:** Frontier consumer-runnable models  
**Note:** Llama 4 Scout's 17B-active MoE makes 109B total tractable  
**Total Disk:** ~169 GB

### **XL SKU LLMs (multi-GPU, 200+ GB VRAM)**

| Model | License | Source | Disk (Q4_K_M) | Active RAM/VRAM |
|-------|---------|--------|---------------|-----------------|
| DeepSeek V3.2 685B (MoE, 32B active) | MIT | huggingface.co/deepseek-ai/DeepSeek-V3.2 | ~380 GB | ~400 GB (with offload) |
| GLM-5.1 (MoE, 40B active) | MIT | huggingface.co/zai-org/GLM-5.1 | ~420 GB | ~450 GB |
| Qwen 3.5 397B (Reasoning) | Apache 2.0 | huggingface.co/Qwen/Qwen3.5-397B-Reasoning | ~225 GB | ~250 GB |
| Kimi K2.5 1T (MoE, 32B active) | Modified MIT ⚠️ | huggingface.co/moonshotai/Kimi-K2.5 | ~580 GB | ~620 GB |
| Llama 4 Maverick 400B | Llama 4 Community | huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct | ~225 GB | ~250 GB |

**Use:** Frontier-class self-hosted reasoning  
**Note:** DeepSeek V3.2 and GLM-5.1 are MIT-licensed standouts  
**⚠️ Warning:** Kimi K2.5 "Modified MIT" requires verification before commercial deployment  
**Total Disk:** 225-580 GB per model

### **Specialized Models (Optional, Add-On)**

| Model | License | Source | Purpose | Disk (Q4_K_M) |
|-------|---------|--------|---------|---------------|
| Qwen 2.5 Coder 32B | Apache 2.0 | huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct | Code generation | ~19 GB |
| Qwen 3 Coder Next 80B (MoE) | Apache 2.0 | huggingface.co/Qwen/Qwen3-Coder-Next | Frontier code generation | ~45 GB |
| DeepSeek-Coder-V2 16B | DeepSeek License | huggingface.co/deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct | Code generation | ~9 GB |
| DS-R1-Distill-Qwen 14B/32B | MIT | huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B | Reasoning distillates | ~9-19 GB |

**Usage:** Ship as add-ons, include in SKU bundles where use case warrants

---

## Document Ingestion Capabilities

### **Document Processing Components**

| Capability | Model / Tool | License | Format | Disk | Active RAM |
|------------|--------------|---------|--------|------|------------|
| `document/render` | pdfium | BSD-3 | native | (counted in media) | (counted) |
| `document/extract-text` | pdfium + python-docx + python-pptx + openpyxl | BSD-3 / MIT | native | ~30 MB | <100 MB |
| `document/visual-embed` (fast) | ColFlor | MIT | ONNX | ~700 MB | ~1.5 GB |
| `document/visual-embed` (HQ) | ColQwen2-v1.0 (2B) | Apache 2.0 / MIT | ONNX | ~2 GB | ~5 GB |

### **Document Ingestion Pipeline (Composed Workflow)**

For every PDF page on ingestion:

```javascript
// Safebox/workflow/ingest-document

Step 1: Render
- Input: PDF stream
- Tool: pdfium
- Output: Image per page → derived stream
- Attributes: {pageIndex, width, height}

Step 2: Extract Text + Layout
- Input: PDF stream
- Tool: pdfium text extraction
- Output: Text content + layout data
- Measure: text density (chars/page, printable ratio)

Step 3: Text Processing (Conditional)
- IF text density ≥ 200 chars/page AND ≥ 80% printable:
  - Chunk text (semantic chunking)
  - Embed via BGE-M3 → int8-quantized
  - Store chunks as Safebox/documentText/{chunkId}
  
- ELSE (low text density):
  - Run PaddleOCR on page image
  - Embed extracted text via BGE-M3 → int8-quantized
  - Store as Safebox/ocrText/{pageId}

Step 4: Visual Embedding (Eager)
- Input: Rendered page image
- Tool: SigLIP 2 (vision/embed)
- Output: Safebox/visualEmbedding (int8, 512-dim)
- Output: Safebox/visualTags (top-K from precomputed vocab)

Step 5: Document-Specific Embedding (Lazy)
- Input: Rendered page image
- Tool: ColQwen2 (document/visual-embed)
- Output: Multi-vector embedding → int8-quantized
- Output: Dimension-reduced (128-dim or 512-dim per token)
- Storage: FalkorDB with MaxSim scoring support

Step 6: Store Relations
- All outputs stored as related streams under parent document
- Attributes: {pageIndex, timestamp, contentHash}
- Searchable via: text-embed, visual-embed, visual-tags, multi-vector
```

**For DOCX/XLSX/PPTX:**
```javascript
Option 1 (Fast): Extract text via native parsers
- python-docx, python-pptx, openpyxl
- Direct text embedding via BGE-M3

Option 2 (Complete): Render via LibreOffice headless → PDF
- Convert to PDF
- Route through full PDF pipeline above
```

---

## Video Ingestion Capabilities

### **Video Processing Components**

| Capability | Tool | License | Format | Disk | Active RAM |
|------------|------|---------|--------|------|------------|
| `video/probe` | FFmpeg | LGPL | native | (counted) | (counted) |
| `video/scene-detect` | PySceneDetect | BSD-3 | native | ~5 MB | <50 MB |
| `video/keyframe-extract` | FFmpeg | LGPL | native | (counted) | (counted) |
| `video/transcribe` | (composed) | — | — | — | — |
| `video/embed` | (composed) | — | — | — | — |
| `video/spatiotemporal-embed` (v2) | InternVideo2-L14 distilled | Apache 2.0 | ONNX | ~600 MB | ~2 GB |

### **Video Ingestion Pipeline (Composed Workflow)**

For every video on ingestion:

```javascript
// Safebox/workflow/ingest-video

Step 1: Probe Metadata
- Input: Video stream
- Tool: FFmpeg
- Output: {duration, resolution, codec, hasAudio, fps}
- Store as: Safebox/videoMetadata

Step 2: Scene Detection
- Input: Video stream
- Tool: PySceneDetect
- Output: List of (t_start, t_end) scene ranges
- Algorithm: Adaptive threshold or content-aware
- Store as: Safebox/videoScenes

Step 3: Keyframe Extraction
- Input: Video stream + scene list
- Tool: FFmpeg
- Output: One keyframe per scene → image files
- Store as: Safebox/videoKeyframe/{sceneIndex}

Step 4: Visual Embedding (Per Keyframe)
- Input: Each keyframe image
- Tool: SigLIP 2 (vision/embed)
- Output: Safebox/visualEmbedding (int8, 512-dim)
- Output: Safebox/visualTags
- Metadata: {videoUri, sceneIndex, t_start, t_end}

Step 5: Audio Transcription (If Present)
- IF hasAudio:
  - Extract audio via FFmpeg
  - Run Silero VAD → speech regions
  - Transcribe speech via Whisper Turbo
  - Embed transcript chunks via BGE-M3 → int8-quantized
  - Store as: Safebox/videoTranscript/{chunkId}
  - Metadata: {t_start, t_end, text, embedding}

Step 6: Spatiotemporal Embedding (Lazy, Optional v2)
- Input: Full video
- Tool: InternVideo2-L14
- Output: Temporal-aware embedding
- Use: Explicit user requests only
- Note: Deferred to v2 unless high demand

Result: Four parallel retrieval surfaces per video:
1. Visual keyframes (SigLIP embeddings)
2. Visual tags (precomputed vocab)
3. Transcript text (BGE-M3 embeddings)
4. Optional: Spatiotemporal (InternVideo2, v2)
```

---

## Quantization & Dimension Reduction Policy

**Apply uniformly across all embedding capabilities:**

### **Single-Vector Embeddings**

```
Storage Format:
├── Default: int8 quantized (~4× compression vs float32)
├── Corpus >100K: Add binary (1-bit hamming) for first-stage retrieval
└── Matryoshka: Optional 512-dim projection for storage-constrained tenants

Retrieval Pipeline (Two-Phase):
1. First-stage: Binary hamming distance (cheap, fast)
2. Rerank: int8 cosine similarity on top-K

Example: BGE-M3 (1024-dim)
- Full precision: 1024 × 4 bytes = 4 KB
- int8: 1024 × 1 byte = 1 KB (4× compression)
- Binary: 1024 ÷ 8 = 128 bytes (32× compression)
```

### **Multi-Vector Embeddings (ColQwen, ColPali)**

```
Storage Format:
├── Dimension reduction: 128-dim or 512-dim per token (linear projection)
├── Quantization: int8
├── Binary variants: For first-stage at large corpus
└── Per Nemotron ablations: 128-dim retains ~95% accuracy at 3% storage

Example: ColQwen2 (2B, ~2048-dim per token, avg 128 tokens/page)
- Full precision: 2048 × 4 × 128 = 1 MB per page
- 128-dim int8: 128 × 1 × 128 = 16 KB per page (~64× compression)

Retrieval Pipeline (Three-Phase):
1. First-stage: Binary hamming on mean-pooled vector
2. Second-stage: int8 MaxSim on top-K (full multi-vector)
3. Rerank: Full-precision MaxSim on top-10

FalkorDB Schema:
- HNSW index on mean-pooled vectors (first-stage)
- Original multi-vectors stored as byte arrays (reranking)
- Supports MaxSim scoring natively
```

### **LLM Weights**

```
Default: Q4_K_M (4-bit quantization)
Upgrade paths (where RAM allows):
├── Q5_K_M: ~20% larger, ~5% better quality
├── Q6_K: ~50% larger, ~10% better quality
└── Q8_0: ~100% larger, near-original quality

Medium+ SKUs: Include Q5_K_M variants
Large SKUs: Include Q6_K variants
XL SKUs: Q8_0 for critical models
```

### **Vision Embeddings (SigLIP)**

```
Default: int8 quantization of full 1152-dim vector
Optional: 512-dim Matryoshka projection
Storage per image:
- Full precision: 1152 × 4 = 4.6 KB
- int8: 1152 × 1 = 1.2 KB
- Matryoshka 512-dim int8: 512 bytes
```

---

### **VLLM (Optional, GPU Only)**

**Label:** `vllm`  
**License:** Apache 2.0  
**Disk:** ~3 GB  
**Idle RAM:** ~500 MB  
**Dependencies:** `llm-*` (reuses models), CUDA runtime

**Contents:**
```
Runtime:
└── vLLM + dependencies (Python venv)

Directory:
└── /opt/safebox/vllm/
    └── (Python virtual environment)

Note: Reuses GGUF models from llm-* components
Converts to vLLM format at runtime (first load)
```

**Capabilities Enabled:**
- `llm/batch` - High-throughput batched inference
- `llm/serve` - Multi-tenant serving with continuous batching

**Build Script:** `install-vllm.sh`  
**Installer Location:** `/opt/safebox-build/components/vllm/`

---

### **CUDA (Optional, GPU Only)**

**Label:** `cuda`  
**License:** NVIDIA EULA (redistributable)  
**Disk:** ~3 GB  
**Idle RAM:** ~100 MB  
**Dependencies:** None

**Contents:**
```
NVIDIA Stack:
├── CUDA runtime (~2 GB)
├── cuDNN (~600 MB)
├── NVENC/NVDEC (GPU video encode/decode)
└── TensorRT (optional, ~400 MB)

Directory:
└── /opt/safebox/cuda/
    ├── cuda-12.x/
    └── cudnn/

Modifies:
├── ONNX Runtime → CUDA execution provider
├── llama.cpp → CUDA-accelerated build
├── whisper.cpp → CUDA-accelerated build
└── FFmpeg → NVENC/NVDEC support
```

**Build Script:** `install-cuda.sh`  
**Installer Location:** `/opt/safebox-build/components/cuda/`

---

### **DIFFUSION-SMALL (Optional, Research License)**

**Label:** `diffusion-small`  
**License:** AGPL (CreativeML OpenRAIL++)  
**Disk:** ~8 GB  
**Active RAM:** ~6 GB (CPU) or ~4 GB VRAM (GPU)  
**Dependencies:** `cuda` (GPU variant)

**⚠️ License Notice:** AGPL - not default permissive. Flag for tenants.

**Contents:**
```
Models:
├── Stable Diffusion 1.5 (~4 GB)
├── Stable Diffusion XL Turbo (~7 GB)
└── ControlNet models (~1.5 GB each)

Runtime:
└── Diffusers (Python, Hugging Face)

Directory:
└── /opt/safebox/diffusion-small/
    ├── models/
    └── runtime/
```

**Capabilities Enabled:**
- `image/generate` - Text-to-image generation
- `image/inpaint` - Inpainting
- `image/controlnet` - Controlled generation

**Build Script:** `install-diffusion-small.sh`  
**Installer Location:** `/opt/safebox-build/components/diffusion-small/`

---

### **INDEX (Optional)**

**Label:** `index`  
**License:** SSPL v1 (FalkorDB), MIT (sqlite-vec)  
**Disk:** ~300 MB  
**Idle RAM:** ~200 MB  
**Dependencies:** None

**⚠️ License Notice:** SSPL acceptable for self-hosted, flag for managed services.

**Contents:**
```
Vector & Graph:
├── FalkorDB (~150 MB)
│   └── Graph database + vector index
├── sqlite-vec (~2 MB)
│   └── Embedded vector store (fallback)
├── FastText language detection (~150 MB)
└── Multilingual tokenizer assets (~50 MB)

Directory:
└── /opt/safebox/index/
    ├── falkordb/
    ├── sqlite-vec/
    └── fasttext/
```

**Capabilities Enabled:**
- `index/vector` - Vector similarity search
- `index/graph` - Graph traversal queries
- `index/language-detect` - Per-document language ID

**Build Script:** `install-index.sh`  
**Installer Location:** `/opt/safebox-build/components/index/`

---

## Deterministic Inference (Seeded RNG)

### **Problem: Non-Determinism in AI Models**

Most inference frameworks use random number generators for:
- Sampling (temperature > 0 in LLMs)
- Dropout (if not disabled at inference)
- Token selection stochastic processes

**Without seeding:** Same input → different output (not reproducible)

### **Solution: Seed Injection Wrapper**

Create a wrapper that intercepts RNG calls and injects a deterministic seed:

```python
# /opt/safebox/lib/deterministic_wrapper.py

import os
import random
import numpy as np
import torch

class DeterministicInference:
    """
    Wrapper to make AI inference deterministic via RNG seeding.
    
    Usage:
        with DeterministicInference(seed=42):
            result = model.generate(prompt)
    """
    
    def __init__(self, seed=None):
        """
        Args:
            seed: Integer seed. If None, reads from SAFEBOX_INFERENCE_SEED env var.
        """
        self.seed = seed or int(os.environ.get('SAFEBOX_INFERENCE_SEED', 42))
        self.original_states = {}
    
    def __enter__(self):
        # Save original RNG states
        self.original_states['random'] = random.getstate()
        self.original_states['numpy'] = np.random.get_state()
        if torch.cuda.is_available():
            self.original_states['torch_cuda'] = torch.cuda.get_rng_state_all()
        self.original_states['torch'] = torch.get_rng_state()
        
        # Set deterministic seeds
        random.seed(self.seed)
        np.random.seed(self.seed)
        torch.manual_seed(self.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(self.seed)
            # Enable deterministic CUDA ops
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
        
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        # Restore original RNG states
        random.setstate(self.original_states['random'])
        np.random.set_state(self.original_states['numpy'])
        torch.set_rng_state(self.original_states['torch'])
        if torch.cuda.is_available():
            torch.cuda.set_rng_state_all(self.original_states['torch_cuda'])
            torch.backends.cudnn.deterministic = False
            torch.backends.cudnn.benchmark = True
```

### **Integration Points**

**llama.cpp:**
```c
// Patch llama.cpp to respect SAFEBOX_INFERENCE_SEED
// In llama.cpp/common/sampling.cpp:

uint32_t get_safebox_seed() {
    const char* seed_env = getenv("SAFEBOX_INFERENCE_SEED");
    return seed_env ? (uint32_t)atoi(seed_env) : (uint32_t)time(NULL);
}

// In llama_sampling_sample():
if (ctx_sampling->params.seed == LLAMA_DEFAULT_SEED) {
    ctx_sampling->params.seed = get_safebox_seed();
}
```

**ONNX Runtime:**
```python
# Wrapper for ONNX models
import onnxruntime as ort
from deterministic_wrapper import DeterministicInference

def run_onnx_deterministic(session, inputs, seed=None):
    with DeterministicInference(seed):
        return session.run(None, inputs)
```

**whisper.cpp:**
```c
// Similar patch to llama.cpp
// In whisper.cpp/whisper.cpp:

uint32_t get_safebox_seed() {
    const char* seed_env = getenv("SAFEBOX_INFERENCE_SEED");
    return seed_env ? (uint32_t)atoi(seed_env) : (uint32_t)time(NULL);
}
```

**vLLM:**
```python
# In vLLM sampling params
from vllm import SamplingParams
import os

def get_deterministic_sampling_params(**kwargs):
    seed = int(os.environ.get('SAFEBOX_INFERENCE_SEED', 42))
    return SamplingParams(seed=seed, **kwargs)
```

### **Capability-Level Enforcement**

Every capability that calls inference includes seed parameter:

```javascript
// Safebox capability wrapper
async function invokeCapability(capabilityURI, input, options = {}) {
    const seed = options.seed || parseInt(process.env.SAFEBOX_INFERENCE_SEED) || 42;
    
    // Set seed in environment for child processes
    process.env.SAFEBOX_INFERENCE_SEED = seed.toString();
    
    // Call inference
    const result = await actualInference(input);
    
    // Result includes seed used for reproducibility
    return {
        ...result,
        metadata: {
            seed: seed,
            timestamp: Date.now(),
            reproducible: true
        }
    };
}
```

### **Stream Metadata**

Store seed in stream attributes for reproducibility:

```javascript
// After inference completes
Streams.setAttribute(resultStreamName, 'Safebox/inferenceSeed', seed);
Streams.setAttribute(resultStreamName, 'Safebox/reproducible', 'true');

// Later: reproduce exact result
const originalSeed = await Streams.getAttribute(streamName, 'Safebox/inferenceSeed');
const reproduced = await invokeCapability(capabilityURI, input, { seed: originalSeed });
// reproduced === original (bit-exact if no external randomness)
```

---

## Build System Architecture

### **Master Build Script**

```bash
#!/bin/bash
# /opt/safebox-build/build-ami.sh

set -euo pipefail

# Component selection (comma-separated labels)
COMPONENTS="${1:-base}"  # Default: base only

# Parse components
IFS=',' read -ra COMPONENT_LIST <<< "$COMPONENTS"

echo "Building Safebox AMI with components: ${COMPONENT_LIST[*]}"

# Always build base first
./components/base/install-base.sh

# Install selected components
for component in "${COMPONENT_LIST[@]}"; do
    if [[ "$component" == "base" ]]; then
        continue  # Already installed
    fi
    
    if [[ ! -f "./components/$component/install-$component.sh" ]]; then
        echo "ERROR: Unknown component: $component"
        exit 1
    fi
    
    echo "Installing component: $component"
    ./components/$component/install-$component.sh
done

# Generate final manifests
./generate-manifests.sh "${COMPONENT_LIST[*]}"

echo "AMI build complete: safebox-${COMPONENTS}"
```

### **Component Directory Structure**

```
/opt/safebox-build/
├── build-ami.sh                  # Master build script
├── generate-manifests.sh         # Generate attestation manifests
│
├── components/
│   ├── base/
│   │   ├── install-base.sh       # Install core Safebox
│   │   ├── packages.txt          # RPM list
│   │   └── config/               # Config templates
│   │
│   ├── media/
│   │   ├── install-media.sh      # Install media toolchain
│   │   ├── ffmpeg-build.sh       # Build FFmpeg from source
│   │   └── codecs.txt            # Codec list
│   │
│   ├── vision/
│   │   ├── install-vision.sh     # Install vision models
│   │   ├── models.txt            # Model URLs + hashes
│   │   └── convert-models.py     # Convert to ONNX
│   │
│   ├── llm-small/
│   │   ├── install-llm-small.sh  # Install small LLMs
│   │   ├── models.txt            # GGUF URLs + hashes
│   │   └── verify-hashes.sh      # Verify model integrity
│   │
│   └── ... (one directory per component)
│
└── manifests/
    ├── model-hashes.txt          # Generated during build
    ├── license-audit.txt         # Generated during build
    └── component-inventory.json  # Which components included
```

### **Example Build Commands**

```bash
# Minimal (base only)
./build-ami.sh base

# Web + media processing
./build-ami.sh base,media,libreoffice

# Vision AI
./build-ami.sh base,media,vision,embed,ocr

# Small LLM assistant
./build-ami.sh base,media,vision,embed,speech,ocr,llm-small

# Medium LLM with vision
./build-ami.sh base,media,vision,embed,llm-medium

# Full CPU stack
./build-ami.sh base,media,libreoffice,vision-hq,embed,speech-hq,ocr,llm-large,index

# GPU variant
./build-ami.sh base,media,vision,embed,llm-medium,cuda,vllm

# Everything (CPU)
./build-ami.sh base,media,libreoffice,vision-hq,embed,speech-hq,ocr,llm-large,index

# Everything (GPU)
./build-ami.sh base,media,libreoffice,vision-hq,embed,speech-hq,ocr,llm-xl,cuda,vllm,index,diffusion-small
```

---

## AMI Naming Convention

```
Format: safebox-<instance-tier>-<components>-<version>

Examples:
- safebox-tiny-base-v1.0.0
- safebox-small-base-media-vision-llm-small-v1.0.0
- safebox-medium-base-media-vision-embed-speech-llm-medium-v1.0.0
- safebox-large-cpu-all-v1.0.0
- safebox-large-gpu-all-v1.0.0

Shortened for common configs:
- safebox-assistant-small-v1.0.0  (base,media,vision,embed,speech,llm-small)
- safebox-assistant-medium-v1.0.0 (base,media,vision,embed,speech,llm-medium)
- safebox-coder-large-v1.0.0      (base,media,llm-large,index)
```

---

## Final Architecture Summary

### **Composable Component Model**

**27 Total Components:**
1. `base` (always included)
2. `media` (LGPL media toolchain)
3. `libreoffice` (Office doc conversion)
4. `vision` (standard vision models)
5. `vision-hq` (high-quality vision models)
6. `embed` (text embeddings)
7. `speech` (standard speech)
8. `speech-hq` (high-quality speech)
9. `ocr` (optical character recognition)
10. `llm-tiny` (1-2B models)
11. `llm-small` (7-14B models)
12. `llm-medium` (24-32B models)
13. `llm-large` (70B models)
14. `llm-xl` (671B MoE)
15. `vllm` (GPU batched serving)
16. `cuda` (NVIDIA GPU support)
17. `diffusion-small` (image generation, AGPL)
18. `index` (vector + graph index, SSPL)

**Each component:**
- ✅ Has unique label
- ✅ Declares license posture
- ✅ Has own installer script
- ✅ Can be independently included/excluded
- ✅ Declares disk/RAM requirements
- ✅ Declares dependencies (if any)
- ✅ Registers capabilities in Safebox streams
- ✅ Contributes to TPM attestation manifest

**Benefits:**
- Maximum flexibility (compose exactly what's needed)
- Predictable sizing (sum of components)
- License transparency (per-component)
- Clean upgrades (replace one component)
- Easy testing (enable/disable components)
- Maps to Safebox streams (each component = capability namespace)

This is production-ready composable architecture! 🚀
