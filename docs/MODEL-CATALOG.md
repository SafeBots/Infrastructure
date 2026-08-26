# Safebox Model Catalog — Complete Protocol Coverage

**Comprehensive list of open-source models for all Safebox protocols**

**Last Updated:** June 22, 2026

---

## 📊 Protocol Overview

| Protocol | Endpoint | Purpose | SAFEBUX Cost |
|----------|----------|---------|--------------|
| **LLM** | `/v1/chat`, `/v1/complete`, `/v1/embed` | Text generation, reasoning | Medium |
| **Image** | `/v1/image/generate` | Text-to-image, image editing | Medium-High |
| **Speech** | `/v1/speech` | Text-to-speech synthesis | High |
| **Transcription** | `/v1/transcribe` | Audio-to-text, diarization | Medium |
| **Audio** | `/v1/audio/generate` | Text-to-music, sound effects, audio editing | Medium |
| **Video** | `/v1/video/generate` | Text-to-video, image-to-video | **Very High** |
| **3D** | `/v1/3d/generate` | Text-to-3D, image-to-3D | High |
| **Documents** | `/v1/extract`, `/v1/extract/batch` | PDF / DOCX / PPTX / XLSX / scanned images → Markdown / JSON | Low-Medium |

**SAFEBUX Cost Tiers:**
- **Low:** <0.1 SAFEBUX/request (embeddings, simple inference)
- **Medium:** 0.1-1 SAFEBUX/request (chat, transcription)
- **Medium-High:** 1-5 SAFEBUX/request (image generation)
- **High:** 5-20 SAFEBUX/request (TTS, 3D generation)
- **Very High:** 20-100 SAFEBUX/request (video generation)

---

## 🤖 LLM Protocol (`/v1/chat`, `/v1/complete`, `/v1/embed`)

### **Tier 1: Frontier Models**

**1. DeepSeek-R1 (671B params)**
- License: MIT
- Hardware: 8× H100 80GB
- Speed: 37 tok/sec on 8×H100
- Context: 128K tokens
- Benchmark: SWE-Bench Pro 57.7%, competitive with GPT-5.4/Opus 4.6
- Use: Complex reasoning, agentic tasks, production workloads
- SAFEBUX: 1.5/request

**2. DeepSeek-R1-Distill-70B**
- License: MIT
- Hardware: 2× A100 80GB
- Speed: 85 tok/sec
- Context: 128K tokens
- Benchmark: SWE-Bench Pro ~52%
- Use: Reasoning on consumer hardware
- SAFEBUX: 0.8/request

**3. LLaMA 3.3 70B**
- License: Llama 3.3 Community
- Hardware: 2× A100 80GB
- Speed: 90 tok/sec
- Context: 128K tokens
- Use: General-purpose, strong instruction-following
- SAFEBUX: 0.7/request

**4. GLM 5.2 (Z.ai / Zhipu AI)** — *released June 13, 2026*
- License: MIT — weights on HuggingFace under the `zai-org` organization
- Architecture: Mixture-of-Experts, ~753B total parameters with ~40B active per token
- Context: 1,000,000 tokens (5× the GLM-5.1 limit), up to 131,072 tokens of output
- Architecture novelties:
  - IndexShare: reuses one indexer across every four sparse-attention layers, reducing per-token FLOPs by ~2.9× at the full 1M-token context
  - Improved Multi-Token Prediction layer — speculative-decoding acceptance length up ~20%
  - Selectable "Thinking Modes" (Max default, High)
- Hardware (self-hosted, full precision):
  - ~1.5 TB of GPU memory; reference deployment is 8× NVIDIA H200 with tensor parallelism
  - Unsloth 1-bit GGUF runs ~21.6 tok/s on a Mac Studio M3 Ultra (256 GB unified memory) — viable consumer-tier inference
- Benchmarks (vendor and third-party):
  - SWE-bench Pro: 62.1, beating GPT-5.5 (58.6) and GLM-5.1 (58.4)
  - Terminal-Bench 2.1: 81.0 vs Claude Opus 4.8's 85.0
  - FrontierSWE: 74.4% (Opus 4.8 at 75.1%, GPT-5.5 at 72.6%)
  - MCP-Atlas (tool use): 77.0 (Opus 4.8 at 77.8, GPT-5.5 at 75.3)
  - Design Arena: #1 with 1360 ELO, edging Claude Fable 5
  - ARC-AGI-2: 22.8% at ~$0.25/task (vs GPT-5.5 at 85% but ~7× the per-task cost)
- Z.ai API pricing (cloud route): $1.40 per million input tokens / $4.40 per million output tokens — roughly one-sixth of GPT-5.5's blended cost
- GLM Coding Plan (subscription, cloud only): tiers at $10 / $30 / $80 per month
- Use on Safebox: production agent work, software engineering, repository-scale coding, long-horizon multi-step tasks where the 1M context window matters
- SAFEBUX (self-hosted on Safebox): 1.2/request
- ⚠️ **Note on the cloud route:** the US Bureau of Industry and Security added Zhipu AI to its Entity List in January 2025. The MIT-licensed weights are fully usable; self-hosted GLM 5.2 on a Safebox has no data flow to Z.ai's infrastructure. The Z.ai cloud API does and carries the same data-jurisdiction considerations as any Chinese AI service. Safebox's value proposition (run open weights locally with attestation) sidesteps this — but a tenant who routes through Z.ai's cloud instead of self-hosting is choosing a different trust model.

### **Tier 2: Efficient Models**

**5. LLaMA 3.1 8B**
- License: Llama 3.1 Community
- Hardware: 1× A100 40GB
- Speed: 150 tok/sec
- Context: 128K tokens
- Use: Fast inference, edge deployment
- SAFEBUX: 0.3/request

**6. Qwen 2.5 Coder 32B**
- License: Apache 2.0
- Hardware: 1× A100 80GB or 2× A100 40GB
- Speed: 95 tok/sec
- Context: 32K tokens
- Use: Code generation, debugging
- SAFEBUX: 0.5/request

**7. Mistral Small 22B**
- License: Apache 2.0
- Hardware: 1× A100 80GB
- Speed: 110 tok/sec
- Context: 32K tokens
- Use: Multilingual, function calling
- SAFEBUX: 0.4/request

**8. Qwen 3.6-35B-A3B**
- License: Apache 2.0
- Hardware: 1× RTX 4090
- Speed: ~100 tok/sec
- Benchmark: SWE-Bench Pro ~52%
- Use: Consumer GPU deployment
- SAFEBUX: 0.5/request

### **Embeddings**

**9. BGE-Large-EN-v1.5**
- License: MIT
- Hardware: 1× T4 GPU
- Speed: 2,000 embeddings/sec
- Dimensions: 1024
- Use: Semantic search, RAG
- SAFEBUX: 0.01/request

---

## 🎨 Image Protocol (`/v1/image/generate`)

### **Text-to-Image**

**1. SDXL 1.0 (Stable Diffusion XL)**
- License: OpenRAIL++-M
- Hardware: 1× A100 40GB
- Speed: 2-3 images/min at 1024×1024
- Resolution: Up to 2048×2048
- Use: General image generation, product images, art
- SAFEBUX: 2.0/image

**2. Flux.1 Dev**
- License: Non-commercial (Flux.1 Dev License)
- Hardware: 1× H100 80GB
- Speed: 1 image/min at 1024×1024
- Resolution: Up to 2048×2048
- Quality: Superior to SDXL, competitive with Midjourney
- Use: High-quality art, marketing materials
- SAFEBUX: 3.5/image

**3. Flux.1 Schnell**
- License: Apache 2.0
- Hardware: 1× A100 40GB
- Speed: 4-5 images/min at 1024×1024
- Quality: Fast, good for iteration
- Use: Rapid prototyping, batch generation
- SAFEBUX: 1.5/image

### **Image Editing**

**4. InstantID**
- License: Apache 2.0
- Hardware: 1× A100 40GB
- Use: Face-consistent image generation
- SAFEBUX: 2.5/image

**5. ControlNet (SDXL)**
- License: OpenRAIL++-M
- Hardware: 1× A100 40GB
- Use: Precise control (pose, depth, canny edge)
- SAFEBUX: 2.5/image

---

## 🎙️ Speech Protocol (`/v1/speech`)

### **Text-to-Speech**

**1. VibeVoice-1.5B** ⭐ **FLAGSHIP**
- License: MIT
- Hardware: 1× H100 80GB
- Speed: 0.5× real-time (90 min → 3 hours)
- Max Length: 90 minutes single-pass
- Speakers: Up to 4 simultaneous
- Languages: English, Chinese
- Features: Multi-speaker, voice cloning, long-form
- Use: Podcasts, audiobooks, training videos
- SAFEBUX: 15/hour of audio

**2. VibeVoice-Realtime-0.5B**
- License: MIT
- Hardware: 1× H100 40GB
- Speed: 1× real-time (streaming)
- Speakers: 1
- Languages: English
- Features: Streaming, low latency
- Use: Real-time applications, chatbots
- SAFEBUX: 8/hour of audio

**3. VibeVoice-Large-7B**
- License: MIT
- Hardware: 1× H100 80GB
- Speed: 0.3× real-time
- Quality: Superior Chinese pronunciation
- Use: High-quality Chinese TTS
- SAFEBUX: 20/hour of audio

---

## 🎧 Transcription Protocol (`/v1/transcribe`)

### **Speech-to-Text**

**1. VibeVoice-ASR-7B** ⭐ **FLAGSHIP for Multi-Speaker**
- License: MIT
- Hardware: 1× A100 80GB or 2× A100 40GB
- Speed: 15× real-time (60 min → 4 min)
- Max Length: 60 minutes single-pass
- Languages: 50+ (EN, ZH, ES, FR, DE, JA, KO, AR, HI, PT, RU, +40 more)
- Features: Built-in speaker diarization, timestamps, code-switching
- Use: Medical consultations, legal depositions, podcasts, meetings
- SAFEBUX: 0.8/hour of audio

**2. Whisper Large v3**
- License: MIT (OpenAI)
- Hardware: 1× A100 40GB
- Speed: 50× real-time (60 min → 1.2 min)
- Max Length: 30 seconds (requires chunking for longer)
- Languages: 99
- Features: Fast, accurate for single-speaker
- Use: Quick dictation, subtitles, real-time transcription
- SAFEBUX: 0.3/hour of audio

---

## 🎵 Music & Audio Generation Protocol (`/v1/audio/generate`)

### **Text-to-Audio (Music and Sound Effects)**

**1. Stable Audio 3 medium (1.4B params)** ⭐ **FLAGSHIP for Music + SFX**
- License: Stability Community License (open weights, licensed + Creative Commons training data only)
- Hardware: Consumer GPU with 8 GB+ VRAM (RTX 3060, 4060, 4070) for long-form generation
- Speed: 1.31s on H200 for up to 6m 20s of stereo 44.1 kHz audio
- Max Length: 6 minutes 20 seconds
- Sample Rate: 44.1 kHz stereo
- Quality: State-of-the-art for open-weight instrumental music and sound effects (Stable Audio 3 technical report, May 2026)
- Features: Variable-length generation, inpainting (single-segment, multi-segment, continuation), 8 ping-pong sampling steps, no CFG required
- Use: Royalty-free music for video, sound effect generation, audio editing, podcast intros, game audio
- **SAFEBUX: 2/generation (up to 6m 20s)**

**2. Stable Audio 3 small (459M params)** ⭐ **CONSUMER-HARDWARE FLAGSHIP**
- License: Stability Community License
- Hardware: MacBook Pro M4 (CPU-only via CoreML), or any GPU with 4 GB+ VRAM
- Speed: 0.44s on H200, 3.09s for 120s output on MacBook Pro M4 with CoreML
- Max Length: 2 minutes
- Sample Rate: 44.1 kHz stereo
- Specialized variants: `small-music` (instrumental music only) and `small-sfx` (sound effects only); the split improves quality at small scale
- Features: Same architecture as medium — variable-length, inpainting, 8 sampling steps
- Use: On-device generation, mobile applications, edge deployment, low-cost real-time audio
- **SAFEBUX: 0.5/generation**

**3. Stable Audio 3 large (2.7B params)** — DATACENTER ONLY
- License: Closed weights (Stability commercial only)
- Hardware: H100/H200 class GPU
- Speed: 1.80s on H200 for up to 6m 20s
- Quality: Best in the Stable Audio 3 family
- Status: NOT distributed via Infrastructure — listed for completeness; we ship small and medium only

> Stable Audio 3 small and medium are open-weight, trained exclusively on licensed and Creative Commons data, and can natively handle both instrumental music and sound effects with the medium variant. The small models are split into music-only and SFX-only variants because at that parameter budget the unified training degrades both. See the [Stable Audio 3 technical report](https://arxiv.org/abs/2605.17991) for full details.

### **Sound Effects (specialized)**

**1. Woosh Flow** — open-weight flow matching model for short SFX
- License: Open
- Max Length: 5 seconds
- Use: Quick sound effect synthesis where 5s is sufficient
- **SAFEBUX: 0.3/generation**
- Note: Stable Audio 3 medium outperforms Woosh Flow on FAD and CLAP at the same duration; included for benchmark comparison

**2. Stable Audio Open** — predecessor, kept for backwards compatibility
- License: Open weights, CC-licensed training data
- Max Length: 47 seconds (full) or 11 seconds (small)
- Use: Legacy deployments; Stable Audio 3 supersedes for new installs

---

## 🎬 Video Protocol (`/v1/video/generate`) — PRODUCTION

> **Shipped runners (two complementary):**
> - **`model-runners/ltx-video/`** wraps LTX-Video 2.3 (Lightricks, Apache 2.0, March 2026). Two manifests: `ltx-2-3-distilled` (8B distilled, 16GB VRAM, ~20-40s per 5s clip) and `ltx-2-3-dev` (22B base, 24GB+ VRAM). Text-to-video, image-to-video, AND **synchronized audio+video** in one forward pass. See [`model-runners/ltx-video/README.md`](../model-runners/ltx-video/README.md).
> - **`model-runners/wan-video/`** wraps Wan 2.2 (Alibaba, Apache 2.0). Three manifests: `wan-2-2-ti2v-5b` (5B combined, 16GB VRAM), `wan-2-2-t2v-a14b` (MoE A14B, 24GB+ VRAM), `wan-2-2-i2v-a14b` (MoE A14B, image-to-video). Higher quality than LTX at the cost of 3-5× longer inference; no native audio. See [`model-runners/wan-video/README.md`](../model-runners/wan-video/README.md).
>
> The two runners share `/v1/video/generate` — operators run both side-by-side, route by model name. LTX for draft iteration with audio, Wan for hero-quality finals.

### **Text-to-Video**

**1. LTX-Video 2.3 (22B params, 8B distilled)** ⭐ **FLAGSHIP — SHIPS AS A RUNNER**
- License: Apache 2.0 — fully commercial-unrestricted
- Hardware: distilled fits on 16GB VRAM (RTX 4070 Ti, A10); dev needs 24GB+ (RTX 4090, A100)
- Speed: ~20-40s for 5s clip at 768×512 (distilled, 8 steps); ~60-180s for 1216×704 (dev, 30 steps)
- Max Length: 20 seconds at 24fps (~481 frames)
- Resolution: 1216×704 native, any dimensions divisible by 32
- FPS: 24 / 30 / 48
- Quality: Production-grade for most use cases; competitive with closed APIs at 1080p
- Features: Text-to-video, image-to-video, **synchronized audio+video in a single forward pass**
- Audio: ambient sound and foley quality (not music or voice — use stable-audio-3 or kokoro-tts for those)
- Use: Marketing video drafts, agent video responses, product demos, illustrated explainers, social media
- **SAFEBUX: 45/5-second clip (distilled), 80/5-second clip (dev)**

**2. Wan 2.2 (MoE A14B — 27B total, 14B active)** ⭐ **HIGH-QUALITY ALTERNATIVE — SHIPS AS A RUNNER**
- License: Apache 2.0 — fully commercial-unrestricted
- Hardware: 5B variant fits on 16GB VRAM; A14B needs 24GB+ (RTX 4090 with offload, A100, H100)
- Speed: ~60-300s per 5s clip depending on variant and hardware
- Max Length: ~5 seconds (81 frames at 16fps) for A14B; ~7.5 seconds (121 frames at 16fps) for 5B
- Resolution: 1280×720 native (also supports 480p), divisible by 16
- Architecture: Mixture-of-Experts diffusion — separate high-noise and low-noise experts
- Quality: Higher ceiling than LTX-Video; sharper textures, cleaner motion, better prompt adherence
- Features: T2V + I2V (separate A14B variants), or combined in the 5B variant
- Audio: None (chain stable-audio-3 for background music, or use ltx-video for synchronized audio)
- Use: Hero content, final renders, product visualization, brand-confidential imagery requiring quality
- **SAFEBUX: 35/5-second clip (5B), 55/5-second clip (A14B)**

**3. HunyuanVideo (13B params)**
- License: Tencent HunyuanVideo Community License (open but restricted commercial use — check carefully)
- Hardware: 4× H100 80GB (FP8) or 8× A100 80GB (FP16)
- Speed: ~10 min for 5-second clip at 720p
- Resolution: 720p (1280×720)
- Quality: Best facial detail among open models; cinematic
- Use: High-end marketing where Tencent license terms are acceptable
- Status: Documented; would require a separate `hunyuan-video/` runner directory (different library, different loader) — post-1.0
- **SAFEBUX: 80/5-second clip**

**5. CogVideoX-5B**
- License: Apache 2.0
- Hardware: 1× A100 40GB
- Speed: ~5 min for 6-second clip at 480p
- Max Length: 6 seconds
- Resolution: 720×480
- Quality: Efficient, solid Diffusers support
- Features: Quantization to 8GB VRAM, good for testing
- Use: Prototyping, small-scale production
- **SAFEBUX: 40/6-second clip**

**6. SkyReels V1** (Skywork AI)
- License: Apache 2.0
- Hardware: 4× H100 80GB
- Quality: **Cinematic-grade** — trained on high-end film/TV clips
- Features: Realistic humans, facial expressions, professional camera movement
- Use: Storytelling, filmmaking, high-end marketing
- **SAFEBUX: 95/5-second clip**

**7. Open-Sora 2.0**
- License: Apache 2.0
- Hardware: 4× A100 80GB
- Max Length: 10 seconds
- Resolution: 1080p
- Quality: Research-grade, strong academic backing
- Use: Research, long-form experiments
- **SAFEBUX: 75/10-second clip**

### **Image-to-Video**

All text-to-video models above also support image-to-video (I2V) mode:
- **HunyuanVideo:** Best motion quality
- **LTX-Video:** Fastest I2V
- **CogVideoX:** Best I2V quality

---

## 🗿 3D Protocol (`/v1/3d/generate`) — PRODUCTION

> **Shipped runner: `model-runners/triposr/`** — wraps TripoSR (Stability AI + Tripo AI, MIT). Single image in, textured 3D mesh out in ~1 second on a consumer GPU. One manifest. Output as GLB / OBJ / PLY. Vertex colors only — for PBR textures, Hunyuan3D 2.1 would be a separate runner directory (Tencent Community License caveat) — post-1.0. See [`model-runners/triposr/README.md`](../model-runners/triposr/README.md).

### **Text-to-3D**

> TripoSR is image-only. For text-to-3D, the right pattern is to chain ComfyUI (text → image) and then TripoSR (image → mesh). See the TripoSR runner README for the composition example. Direct text-to-3D models below are documented for reference but don't ship as wrapped runners in 1.0.

**1. Shap-E** (OpenAI)
- License: MIT
- Hardware: 1× A100 40GB
- Speed: ~30 seconds per model
- Output: NeRF + Mesh (OBJ, GLB, STL)
- Quality: Good for simple objects
- Use: Concept visualization, rapid prototyping
- **SAFEBUX: 10/model**

**2. Point-E** (OpenAI)
- License: MIT
- Hardware: 1× A100 40GB
- Speed: ~15 seconds per model
- Output: Point cloud → Mesh
- Quality: 600× faster than diffusion-based methods
- Use: Quick 3D previews, game assets
- **SAFEBUX: 8/model**

### **Image-to-3D**

**3. TripoSR** ⭐ **FLAGSHIP**
- License: MIT
- Hardware: 1× A100 40GB
- Speed: **<0.5 seconds** on A100
- Output: Textured mesh (OBJ, GLB, FBX, STL)
- Quality: High-quality single-image reconstruction
- Architecture: Large Reconstruction Model (LRM)
- Features: Auto-inpainting for hidden surfaces, high-quality textures
- Use: Product visualization, AR/VR, e-commerce 3D previews
- **SAFEBUX: 12/model**

**4. TripoSF** (SparseFlex)
- License: MIT
- Hardware: 1× H100 80GB
- Quality: Higher resolution, arbitrary topology
- Output: High-res meshes
- Use: Professional 3D modeling, film/game production
- **SAFEBUX: 18/model**

**5. InstantMesh**
- License: Apache 2.0
- Hardware: 1× A100 40GB
- Speed: 3-5 seconds
- Quality: Fast multi-view reconstruction
- Use: Real-time 3D capture, AR applications
- **SAFEBUX: 10/model**

**6. Trellis** (Microsoft)
- License: MIT
- Hardware: 1× A100 80GB
- Quality: High-fidelity with PBR materials
- Features: Physically-Based Rendering (PBR) material generation
- Use: Game-ready assets, professional rendering
- **SAFEBUX: 15/model**

---

## 📄 Documents Protocol (`/v1/extract`, `/v1/extract/batch`) — NEW

Document parsing into LLM-ready Markdown / JSON. Handles PDFs (text-native and scanned), Word, PowerPoint, Excel, and images. Math becomes LaTeX, tables become structured cells, multi-column layouts read in human order, 109 languages.

### **Tier 1: All-around Default**

**MinerU 2.5** (opendatalab/MinerU)
- License: Apache 2.0 (with upstream MinerU clause on pre-trained weights — read before commercial use)
- Hardware: 1× T4 / consumer GPU (8 GB) for the `pipeline` backend; 1× A10 / 24 GB GPU for the `vlm` backend; CPU-only works at ~8-10x slower throughput
- Speed (pipeline backend, single consumer GPU): ~0.5-1 second per page
- Speed (CPU only): ~6-10 seconds per page on 8-core x86_64
- Input: PDF, DOCX, PPTX, XLSX, PNG, JPG, TIFF
- Output: Markdown, JSON (with blocks: title / text / formula / table / image), HTML for tables specifically
- Use: Document Q&A, contract search, invoice ingestion, research synthesis, compliance review
- Two backends:
  - `pipeline` (default) — modular: layout detection → OCR → formula recognition → table parsing. Faster and lighter. Right default for everyday extraction.
  - `vlm` — single end-to-end vision-language model. Higher fidelity on hard documents (mixed scripts, dense formulas, unusual layouts). Use as a fallback queue.
- SAFEBUX: 0.05-0.15/page

### Comparison

| Tool | Cost (2026) | Tables | Formulas | Scanned | Privacy |
|---|---|---|---|---|---|
| Adobe Acrobat Pro | $239.88/yr | ⚠️ Loses merged cells | ❌ | ⚠️ Partial | ❌ Cloud |
| ABBYY FineReader Corporate | $165/yr | ✅ | ❌ | ✅ | ⚠️ Mixed |
| Mistral OCR | $2/1,000 pages | ✅ | ✅ | ✅ | ❌ Cloud |
| **MinerU on Safebox** | **$0 / your GPU power** | ✅ | ✅ LaTeX | ✅ | ✅ Local |

### Runner

[`../model-runners/mineru/`](../model-runners/mineru/) — FastAPI service on Unix socket, HMAC auth, audit-trail with source + output SHA-256, idempotent across re-runs.

---

## 🔒 Privacy & Safety Models

### **Content Filtering**

**OpenAI Privacy Filter** (deployed in existing architecture)
- License: MIT
- Hardware: 1× T4 GPU
- Speed: <50ms latency
- Use: Detect PII, profanity, NSFW content before/after LLM
- SAFEBUX: 0.05/request

---

## 💰 SAFEBUX Pricing Summary

### **Per-Request Costs**

| Protocol | Model | Typical Use | SAFEBUX Cost |
|----------|-------|-------------|--------------|
| **LLM** | DeepSeek-R1-70B | Chat (2K tokens) | 0.8 |
| **LLM** | LLaMA 3.1 8B | Chat (2K tokens) | 0.3 |
| **Image** | SDXL | 1024×1024 image | 2.0 |
| **Image** | Flux.1 Dev | 1024×1024 image | 3.5 |
| **Speech** | VibeVoice-1.5B | 60-min podcast | 15.0 |
| **Transcription** | VibeVoice-ASR | 60-min meeting | 0.8 |
| **Transcription** | Whisper v3 | 60-min dictation | 0.3 |
| **Video** | HunyuanVideo | 5-sec 720p clip | 80.0 |
| **Video** | LTX-Video | 5-sec 720p clip | 45.0 |
| **3D** | TripoSR | Image-to-3D model | 12.0 |

### **Cache Savings**

**With prefix caching enabled (default):**
- **LLM:** 70-90% reduction on repeated prompts
- **Speech:** 80-95% reduction on repeated scripts
- **Image/Video/3D:** 100% reduction on identical parameters

**Example:** Second generation of same 60-minute podcast:
- Without cache: 15 SAFEBUX
- With cache hit: 1.5 SAFEBUX (90% reduction)

---

## 📊 Hardware Requirements Summary

### **Minimum Viable Safebox**

**Starter ($15K hardware):**
- 1× NVIDIA A100 80GB
- Models: LLaMA 3.1 8B, SDXL, Whisper v3, BGE embeddings
- Capacity: 50-100 users
- Protocols: LLM (chat), Image (basic), Transcription (single-speaker)

**Production ($50K hardware):**
- 2× NVIDIA A100 80GB
- Models: + DeepSeek-R1-70B, VibeVoice-ASR, TripoSR
- Capacity: 500+ users
- Protocols: LLM (full), Image, Speech (limited), Transcription (multi-speaker), 3D

**Enterprise ($200K hardware):**
- 8× NVIDIA H100 80GB
- Models: All models including video generation
- Capacity: 10,000+ users
- Protocols: ALL (LLM, Image, Speech, Transcription, Video, 3D)

---

## 🚀 Recommended Deployment Tiers

### **Tier 1: Text & Audio ($50K)**
- **Hardware:** 2× A100 80GB
- **Models:** DeepSeek-R1-70B, LLaMA 3.1 8B, SDXL, VibeVoice-ASR, Whisper v3
- **Protocols:** LLM, Image (basic), Transcription
- **Use Cases:** Most businesses, HIPAA compliance, general AI

### **Tier 2: + Speech Synthesis ($80K)**
- **Hardware:** 1× H100 80GB + 1× A100 80GB
- **Models:** + VibeVoice-1.5B
- **Protocols:** + Speech (TTS)
- **Use Cases:** Content creation, training materials, audiobooks

### **Tier 3: + 3D Generation ($120K)**
- **Hardware:** 2× H100 80GB + 2× A100 80GB
- **Models:** + TripoSR, Shap-E
- **Protocols:** + 3D
- **Use Cases:** E-commerce, AR/VR, product visualization

### **Tier 4: Full Suite with Video ($200K)**
- **Hardware:** 8× H100 80GB
- **Models:** ALL models
- **Protocols:** ALL protocols
- **Use Cases:** Media production, advertising, enterprise

---

## 🎯 Model Selection Guide

**By Use Case:**

| Use Case | Recommended Models |
|----------|-------------------|
| **Medical Records** | VibeVoice-ASR-7B (transcription) + Privacy Filter |
| **Legal Depositions** | VibeVoice-ASR-7B (60-min diarization) |
| **Podcast Production** | VibeVoice-1.5B (multi-speaker TTS) |
| **Marketing Videos** | HunyuanVideo or SkyReels V1 (cinematic) |
| **E-Commerce 3D** | TripoSR (image-to-3D, <0.5 sec) |
| **Customer Support Chat** | LLaMA 3.1 8B (fast, efficient) |
| **Code Generation** | GLM 5.2 (frontier-grade coding, MIT) or Qwen 2.5 Coder 32B (smaller hardware) |
| **Product Images** | SDXL or Flux.1 Dev |
| **Audiobooks** | VibeVoice-1.5B (90-min single-pass) |
| **Meeting Transcription** | VibeVoice-ASR-7B (multi-speaker) |
| **Quick Dictation** | Whisper Large v3 (50× real-time) |
| **Game Asset Creation** | Shap-E (text-to-3D), LTX-Video (fast iteration) |

---

## ✅ All Models Summary

**Total Models Available: 35+**

- **LLM:** 9 models (671B to 8B params)
- **Image:** 5 models (SDXL, Flux variants, ControlNet)
- **Speech:** 3 models (TTS, 90-min multi-speaker)
- **Transcription:** 2 models (ASR, 60-min diarization)
- **Video:** 7 models (T2V, I2V, cinematic to fast)
- **3D:** 6 models (T2-3D, I2-3D, professional)
- **Safety:** 1 model (Privacy Filter)

**All models:**
- Open-source or permissive licenses
- Run entirely on-premise
- Full HIPAA/GDPR/SOC2/PCI compliance
- Safebox wire protocol compatible

**Production-ready for deployment!** 🚀
