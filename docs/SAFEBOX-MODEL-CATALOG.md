# Safebox Model Catalog — Complete Protocol Coverage

**Comprehensive list of open-source models for all Safebox protocols**

**Last Updated:** April 2026

---

## 📊 Protocol Overview

| Protocol | Endpoint | Purpose | SAFEBUX Cost |
|----------|----------|---------|--------------|
| **LLM** | `/v1/chat`, `/v1/complete`, `/v1/embed` | Text generation, reasoning | Medium |
| **Image** | `/v1/image/generate` | Text-to-image, image editing | Medium-High |
| **Speech** | `/v1/speech` | Text-to-speech synthesis | High |
| **Transcription** | `/v1/transcribe` | Audio-to-text, diarization | Medium |
| **Video** | `/v1/video/generate` | Text-to-video, image-to-video | **Very High** |
| **3D** | `/v1/3d/generate` | Text-to-3D, image-to-3D | High |

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

**4. GLM-5.1 (Z.ai)**
- License: MIT
- Hardware: 2× H100 80GB
- Speed: ~60 tok/sec
- Benchmark: SWE-Bench Pro 58.4% (beats GPT-5.4!)
- Use: Production agent work, software engineering
- SAFEBUX: 1.2/request

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

## 🎬 Video Protocol (`/v1/video/generate`) — NEW

### **Text-to-Video**

**1. HunyuanVideo (13B params)** ⭐ **FLAGSHIP**
- License: Tencent HunyuanVideo Community License (open but restricted commercial use)
- Hardware: 4× H100 80GB (FP8) or 8× A100 80GB (FP16)
- Speed: ~10 min for 5-second clip at 720p
- Max Length: 5 seconds
- Resolution: 720p (1280×720)
- FPS: 24-30
- Quality: Cinematic, beats Runway Gen-3 on benchmarks
- Features: Text-to-video, image-to-video, strong motion, xDiT parallelism
- Use: Marketing videos, product demos, short films
- **SAFEBUX: 80/5-second clip**

**2. Mochi 1 (10B params)**
- License: Apache 2.0
- Hardware: 2× H100 80GB
- Speed: ~8 min for 5.4-second clip at 480p
- Max Length: 5.4 seconds (162 frames at 30 FPS)
- Resolution: 480p (640×480)
- Quality: Photorealistic, strong prompt-following
- Architecture: Asymmetric Diffusion Transformer + AsymmVAE
- Use: Creative experiments, high-fidelity short clips
- **SAFEBUX: 65/5-second clip**

**3. LTX-Video (13B params)**
- License: Apache 2.0
- Hardware: 1× A100 40GB (runs on 12GB VRAM with offload)
- Speed: ~2 min for 5-second clip at 720p (real-time capable)
- Max Length: 5 seconds
- Resolution: 1216×704 at 30 FPS
- Quality: Good, optimized for speed
- Features: Image-to-video, upscalers, ComfyUI workflows
- Use: Rapid iteration, batch generation, real-time previews
- **SAFEBUX: 45/5-second clip**

**4. Wan 2.2 (Alibaba)**
- License: Tongyi Wanxiang Community License
- Hardware: 1× H100 80GB (14B variant) or 1× A100 40GB (1.3B variant)
- Speed: 30% faster than Wan 2.1 at 720p
- Max Length: 5 seconds
- Resolution: 720p
- Architecture: Mixture-of-Experts (MoE) — separate experts for high/low noise
- Quality: Sharp detail, good prompt adherence
- Use: General-purpose T2V, accessible on consumer GPUs (1.3B variant)
- **SAFEBUX: 55/5-second clip (14B), 35/5-second clip (1.3B)**

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

## 🗿 3D Protocol (`/v1/3d/generate`) — NEW

### **Text-to-3D**

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
| **Code Generation** | Qwen 2.5 Coder 32B or GLM-5.1 |
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
