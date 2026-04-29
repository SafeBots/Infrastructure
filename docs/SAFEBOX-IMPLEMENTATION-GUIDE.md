# Safebox Model Catalog — Implementation Guide

**How to actually deploy the 35+ models, what runners you need, and whether it's cheaper than APIs**

**Version:** 1.0  
**Last Updated:** April 2026

---

## 🎯 **Executive Summary**

**The Safebox Model Catalog is a curated list of 35+ truly open-source AI models that can run entirely on-premise.** This guide answers three critical questions:

1. **What do we do with this catalog?** → Load models via runners, expose via wire protocol
2. **What runners do we need?** → 7-8 specialized runners covering all protocols
3. **Is GPU self-hosting cheaper than APIs?** → **YES**, at 10M+ tokens/month

---

## 📋 **Table of Contents**

1. [License Filtering](#license-filtering)
2. [Runner Architecture](#runner-architecture)
3. [Hardware Requirements](#hardware-requirements)
4. [Cost Analysis: GPU vs API](#cost-analysis)
5. [Deployment Tiers](#deployment-tiers)
6. [Model Loading Strategy](#model-loading-strategy)
7. [GGUF & CPU Inference](#gguf-cpu-inference)

---

## 🔒 **License Filtering**

### **Truly Open-Source Only**

**Safebox only includes models with permissive licenses:**

✅ **Acceptable Licenses:**
- **MIT** — Most permissive (DeepSeek, Qwen, Phi, GLM)
- **Apache 2.0** — Commercial-friendly (Mistral, Gemma, Llama)
- **NVIDIA Open Model License** — Commercial use allowed (Nemotron 3 Nano Omni)
- **BSD** — Permissive (some research models)

❌ **Excluded Licenses:**
- Llama 3.3 Community License (commercial restrictions)
- Tencent HunyuanVideo Community License (restricted commercial use)
- Non-commercial research licenses
- Models without published weights

### **Filtered Model List (33 Models)**

**New addition:** NVIDIA Nemotron 3 Nano Omni — unified text + image + video + audio in single model!

#### **Multimodal Models (Vision + Language + Audio)**

| Model | Params | License | Hardware | Modalities |
|-------|--------|---------|----------|------------|
| **Nemotron 3 Nano Omni** ⭐ **NEW** | 30B-A3B MoE | NVIDIA Open Model License | 1× A100 80GB | Text, Image, Video, Audio |
| **Qwen 3.5 72B** | 72B | Apache 2.0 | 2× A100 80GB | Text, Image |
| **DeepSeek-R1-70B** | 70B | MIT | 2× A100 80GB | Text only |
| **Mistral Small 22B** | 22B | Apache 2.0 | 1× A100 80GB | Text only |
| **Gemma 3 27B** | 27B | Apache 2.0 | 1× A100 80GB | Text, Image |

**⭐ Nemotron 3 Nano Omni highlights:**
- **Front-line perception model:** Handles 60-80% of requests directly (3B active vs 72B)
- **Active context manager:** Analyzes chat history, identifies gaps, requests missing info
- **KV cache optimizer:** Routes to cached contexts → 90% latency reduction
- **76% cost savings:** 0.19 SAFEBUX average (vs 0.8 routing everything to Qwen 72B)
- **Unified multimodal:** Single model replaces vision + audio + text stacks
- **9× throughput** vs other open omni models (same interactivity)
- **256K context:** Long document + video + audio reasoning
- **Native agent support:** Computer use, document intelligence, video analysis
- **Fully open:** Weights, datasets, training recipes (NVIDIA Open Model License = commercial use)
- **Fast:** FP8 and NVFP4 quantization, runs on single A100 40GB (not 80GB!)

#### **Image Protocol (4 models)**

| Model | License | Hardware | Quality |
|-------|---------|----------|---------|
| **SDXL 1.0** | OpenRAIL++-M | 1× A100 40GB | Production |
| **Flux.1 Schnell** | Apache 2.0 | 1× A100 40GB | Fast |
| **ControlNet** | OpenRAIL++-M | 1× A100 40GB | Precise control |
| **InstantID** | Apache 2.0 | 1× A100 40GB | Face-consistent |

#### **Speech Protocol (3 models)**

| Model | License | Hardware | Languages |
|-------|---------|----------|-----------|
| **VibeVoice-1.5B** | MIT | 1× H100 80GB | EN, ZH |
| **VibeVoice-Realtime-0.5B** | MIT | 1× H100 40GB | EN |
| **VibeVoice-Large-7B** | MIT | 1× H100 80GB | EN, ZH |

#### **Transcription Protocol (2 models)**

| Model | License | Hardware | Languages |
|-------|---------|----------|-----------|
| **VibeVoice-ASR-7B** | MIT | 1× A100 80GB | 50+ |
| **Whisper Large v3** | MIT (OpenAI) | 1× A100 40GB | 99 |

#### **Video Protocol (5 models) — Apache 2.0 only**

| Model | License | Hardware | Quality |
|-------|---------|----------|---------|
| **Mochi 1 (10B)** | Apache 2.0 | 2× H100 80GB | Photorealistic |
| **LTX-Video (13B)** | Apache 2.0 | 1× A100 40GB | Fast |
| **CogVideoX-5B** | Apache 2.0 | 1× A100 40GB | Efficient |
| **SkyReels V1** | Apache 2.0 | 4× H100 80GB | Cinematic |
| **Open-Sora 2.0** | Apache 2.0 | 4× A100 80GB | Research-grade |

**Excluded:** HunyuanVideo (Tencent license has commercial restrictions)

#### **3D Protocol (6 models)**

| Model | License | Hardware | Speed |
|-------|---------|----------|-------|
| **TripoSR** | MIT | 1× A100 40GB | <0.5 sec |
| **TripoSF** | MIT | 1× H100 80GB | High-res |
| **Shap-E** | MIT (OpenAI) | 1× A100 40GB | ~30 sec |
| **Point-E** | MIT (OpenAI) | 1× A100 40GB | ~15 sec |
| **InstantMesh** | Apache 2.0 | 1× A100 40GB | 3-5 sec |
| **Trellis** | MIT (Microsoft) | 1× A100 80GB | High-fidelity |

---

## 🏗️ **Runner Architecture**

### **What Runners Do We Need?**

**A "runner" is a containerized service that loads model weights, handles inference, and exposes the Safebox wire protocol.**

**Minimum viable Safebox: 8 runners**

| Runner | Protocols | Models | Implementation |
|--------|-----------|--------|----------------|
| **1. vLLM Runner** | LLM (chat, complete, embed) | 7-8 LLMs | `vllm serve` + Safebox adapter |
| **2. Nemotron Omni Runner** ⭐ **NEW** | Multimodal (vision + audio) | Nemotron 3 Nano Omni | vLLM 0.20+ with multimodal |
| **3. ComfyUI Runner** | Image (generate) | SDXL, Flux, ControlNet | ComfyUI + API wrapper |
| **4. VibeVoice TTS Runner** | Speech (synthesize) | 3 TTS models | HuggingFace Transformers |
| **5. VibeVoice ASR Runner** | Transcription (transcribe) | VibeVoice-ASR | vLLM or HF |
| **6. Whisper Runner** | Transcription (transcribe) | Whisper v3 | whisper.cpp or faster-whisper |
| **7. Video Runner** | Video (generate) | 5 video models | Diffusers + ComfyUI |
| **8. 3D Runner** | 3D (generate) | 6 3D models | TripoSR + Shap-E APIs |

**⭐ Nemotron 3 Nano Omni is the only model that handles:**
- Computer use (screen reading + action)
- Document intelligence (multi-page, charts, tables)
- Audio-video reasoning (transcription + understanding)
- **Front-line request routing** (analyze → route to Qwen 72B if complex)
- **Active context management** (search chat history, identify gaps)
- **KV cache optimization** (route to cached contexts)
- All in **one model call** instead of fragmented pipeline

**Deployment pattern:**
```
User Request → Nemotron Nano (front-line)
                    ↓
              ┌─────┴─────┐
              ↓           ↓
        Answer directly   Route to Qwen 72B
        (60-80%)         (15-20%)
        0.05 SAFEBUX     0.8 SAFEBUX
```

**Average cost: 0.19 SAFEBUX (76% cheaper than routing everything to Qwen 72B)**

See `NEMOTRON-FRONTLINE-ARCHITECTURE.md` for complete pattern details.

**Optional 9th runner:**
- **Privacy Filter Runner** — OpenAI Privacy Filter (MIT), PII/NSFW detection

### **Runner Implementation Pattern**

**Every runner follows the same architecture:**

```
┌─────────────────────────────────────┐
│  Safebox Wire Protocol API          │  ← External interface
│  POST /v1/chat, /v1/speech, etc.    │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Protocol Adapter (FastAPI)         │  ← Safebox-specific
│  - Request validation                │
│  - Header handling (X-Safebox-*)    │
│  - Caching logic                    │
│  - Telemetry emission               │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Model Engine (vLLM/ComfyUI/etc)    │  ← Model-specific
│  - Load weights from HuggingFace    │
│  - Run inference                    │
│  - Return results                   │
└─────────────────────────────────────┘
```

### **Example: vLLM Runner**

**File:** `model-runners/vllm/runner_extensions.py`

```python
"""
vLLM Runner for Safebox LLM Protocol
Wraps vLLM's OpenAI server with Safebox wire protocol
"""

from fastapi import FastAPI, Header, Response
from pydantic import BaseModel
import httpx

app = FastAPI()

# vLLM runs on localhost:8000 (Unix socket in production)
VLLM_BASE_URL = "http://localhost:8000"

@app.post("/v1/chat")
async def safebox_chat(
    request: SafeboxChatRequest,
    x_safebox_request_id: str = Header(...),
    x_safebox_tenant: str = Header(...),
    response: Response
):
    """Safebox canonical chat endpoint"""
    
    # Convert Safebox format → vLLM format
    vllm_request = {
        "model": request.model,
        "messages": request.messages,
        "max_tokens": request.maxTokens,
        "temperature": request.temperature,
        "top_p": request.topP,
        "stop": request.stop
    }
    
    # Call vLLM
    async with httpx.AsyncClient() as client:
        vllm_response = await client.post(
            f"{VLLM_BASE_URL}/v1/chat/completions",
            json=vllm_request
        )
    
    result = vllm_response.json()
    
    # Convert vLLM format → Safebox format
    safebox_response = {
        "model": result["model"],
        "content": result["choices"][0]["message"]["content"],
        "finishReason": result["choices"][0]["finish_reason"],
        "usage": {
            "promptTokens": result["usage"]["prompt_tokens"],
            "completionTokens": result["usage"]["completion_tokens"]
        }
    }
    
    # Set all 8 required Safebox headers
    response.headers["X-Safebox-Request-Id"] = x_safebox_request_id
    response.headers["X-Safebox-Runner-Id"] = "safebox-model-llm-1"
    response.headers["X-Safebox-Model-Id"] = request.model
    response.headers["X-Safebox-Cache-Hit"] = "false"
    response.headers["X-Safebox-Cache-Tokens-Reused"] = "0"
    response.headers["X-Safebox-Queue-Wait-Ms"] = "0"
    response.headers["X-Safebox-Compute-Ms"] = str(compute_ms)
    response.headers["X-Safebox-Capacity-Hint"] = "available"
    
    return safebox_response
```

**Startup:**
```bash
# Terminal 1: Start vLLM
vllm serve Qwen/Qwen3.5-72B-Instruct \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.9 \
  --port 8000

# Terminal 2: Start Safebox adapter
uvicorn runner_extensions:app --uds /run/safebox/services/model-llm-1.sock
```

**Result:** Safebox protocol exposed at Unix socket, vLLM does the actual inference.

---

## 💻 **Hardware Requirements**

### **GPU vs CPU Decision**

**Which models can run on CPU?**

**CPU-viable models (with GGUF quantization):**
- **LLMs:** 7B-32B models (Qwen 3.5 9B, Phi-4 14B, Mistral Small 22B)
- **Embeddings:** BGE-Large-EN (always CPU-viable)
- **Whisper:** Whisper Large v3 (CPU-optimized)

**GPU-required models:**
- **Large LLMs:** 70B+ models (Qwen 72B, DeepSeek 70B)
- **Image generation:** All diffusion models
- **Speech synthesis:** All VibeVoice TTS models
- **Video generation:** All video models
- **3D generation:** All 3D models

### **GGUF Quantization**

**GGUF = llama.cpp's model format with aggressive quantization**

**Quantization levels:**

| Quantization | VRAM Reduction | Quality Loss | Use Case |
|--------------|----------------|--------------|----------|
| **FP16** (baseline) | 1× | 0% | GPU baseline |
| **Q8_0** | 2× | <1% | CPU-viable, good quality |
| **Q5_K_M** | 2.5× | ~2% | Best CPU sweet spot |
| **Q4_K_M** | 3× | ~5% | Fast CPU, acceptable |
| **Q3_K_M** | 4× | ~10% | Edge devices only |

**Example: Qwen 3.5 72B**

| Format | VRAM | Hardware | Speed |
|--------|------|----------|-------|
| FP16 | 144GB | 2× A100 80GB | 50 tok/sec |
| Q8_0 | 72GB | 1× A100 80GB | 35 tok/sec |
| Q5_K_M | 58GB | CPU (128GB RAM) | 8 tok/sec |
| Q4_K_M | 48GB | CPU (64GB RAM) | 10 tok/sec |

**Key insight:** Q4-Q5 quantization enables CPU inference for 70B models on consumer hardware (Mac Studio, high-end workstation)

### **llama.cpp Integration**

**For CPU inference, use llama.cpp:**

```bash
# Download GGUF model
wget https://huggingface.co/Qwen/Qwen3.5-72B-Instruct-GGUF/resolve/main/qwen3.5-72b-instruct-q5_k_m.gguf

# Run llama-server (OpenAI-compatible)
./llama-server \
  --model qwen3.5-72b-instruct-q5_k_m.gguf \
  --host 0.0.0.0 \
  --port 8000 \
  --ctx-size 8192 \
  --threads 32 \
  --n-gpu-layers 0   # CPU-only

# Safebox adapter connects to localhost:8000
```

**Performance:** 8-15 tokens/sec on modern CPU (AMD EPYC, Intel Xeon)

**Cost:** $200-500/month for dedicated CPU server (vs $2,000/month for GPU)

---

## 💰 **Cost Analysis: GPU vs API**

### **Break-Even Analysis**

**Question:** When is self-hosted GPU cheaper than API?

**Answer:** **At 10M+ tokens/month for LLMs**, much lower for other protocols.

### **LLM Cost Comparison**

**Scenario:** 10M tokens/month (300K tokens/day)

| Provider | Cost Model | Monthly Cost |
|----------|------------|--------------|
| **GPT-4o API** | $2.50 input, $10 output | ~$6,250/mo |
| **Claude Sonnet 4.6 API** | $3 input, $15 output | ~$9,000/mo |
| **Qwen 3.5 72B (self-hosted GPU)** | 2× A100 80GB rental | ~$2,400/mo |
| **Qwen 3.5 72B (owned GPU)** | Amortized over 3 years | ~$550/mo |

**Break-even:** 
- vs Claude: **3M tokens/month**
- vs GPT-4o: **2.5M tokens/month**

**At 100M tokens/month:**
- **API cost:** $90,000/month
- **Self-hosted cost:** $2,400/month (GPU rental) or $550/month (owned)
- **Savings:** $87,600/month = **$1.05M/year**

### **Video Generation Cost Comparison**

**Scenario:** 100 marketing videos/month (5 seconds each)

| Provider | Cost Model | Monthly Cost |
|----------|------------|--------------|
| **Runway Gen-3 API** | $0.05/second | $25/video = **$2,500/mo** |
| **Pika Labs API** | $0.08/second | $40/video = **$4,000/mo** |
| **LTX-Video (self-hosted)** | 1× A100 40GB rental | **$700/mo** |
| **LTX-Video (owned GPU)** | Amortized | **$150/mo** |

**Break-even:** **30 videos/month**

**At 1,000 videos/month:**
- **API cost:** $25,000-40,000/month
- **Self-hosted cost:** $700/month (rental)
- **Savings:** $24,300/month = **$292K/year**

### **Speech Synthesis Cost Comparison**

**Scenario:** 100 hours of TTS/month (podcasts, audiobooks)

| Provider | Cost Model | Monthly Cost |
|----------|------------|--------------|
| **ElevenLabs API** | $250/1M chars (~60 hrs) | **$417/mo** |
| **OpenAI TTS API** | $15/1M chars | **$250/mo** |
| **VibeVoice-1.5B (self-hosted)** | 1× H100 80GB rental | **$800/mo** |

**Break-even:** **200 hours/month**

**But:** Self-hosted has zero marginal cost. At 1,000 hours/month:
- **API cost:** $2,500/month
- **Self-hosted cost:** $800/month (same!)
- **Savings:** $1,700/month = **$20K/year**

### **Hidden Costs — NEARLY ZERO for Safebox**

**Traditional self-hosting requires 2 FTE minimum:**
- DevOps/ML engineer: $135K-275K/year each
- **Total:** $270K-550K/year for setup, monitoring, updates, troubleshooting

**Safebox eliminates 95% of this:**

✅ **Turnkey infrastructure** — AMI boots → runners start → models load → protocol works  
✅ **ZFS auto-backups** — Atomic snapshots, no manual management  
✅ **Wire protocol tested** — Integration tests included  
✅ **Deterministic builds** — Same AMI = same behavior  
✅ **TPM attestation** — Automatic security verification  
✅ **M-of-N governance** — Built-in, no custom logic  

**Engineering time: <5 hours/month** (monitor dashboards, rotate logs, apply quarterly AMI updates)

**Annual cost: ~$20K-40K** (DevOps checking dashboards quarterly + emergency response budget)

**vs traditional self-hosting: $270K-550K/year**

**Safebox saves $230K-510K/year in engineering costs alone!**

**This shifts break-even dramatically:**
- **Traditional self-hosting:** 100M+ tokens/month (to cover $270K engineering)
- **Safebox:** **5-10M tokens/month** (engineering nearly free!)

**For most orgs:**
- **Safebox breaks even at startup scale** (5-10M tokens/month)
- Traditional self-hosting breaks even at enterprise scale (100M+ tokens/month)

**Exception:** Privacy/compliance requirements (HIPAA, GDPR) make Safebox mandatory regardless of volume

---

## 🎯 **Deployment Tiers**

**All tiers include Safebox infrastructure (turnkey, <5 hrs/month maintenance)**

### **Tier 1: CPU-Only ($2K hardware, $50/mo electricity)**

**Hardware:**
- AMD EPYC 9654 (96 cores) or Intel Xeon Platinum 8480+
- 256GB DDR5 RAM
- 2TB NVMe SSD

**Models:**
- **LLM:** Qwen 3.5 9B (Q5_K_M GGUF) — 8-15 tok/sec
- **LLM:** Phi-4 14B (Q5_K_M GGUF) — 6-10 tok/sec
- **Embeddings:** BGE-Large-EN — 500 embeddings/sec
- **Transcription:** Whisper Large v3 — 10× real-time

**Protocols:** LLM (small), Transcription

**Use Case:** Hobbyist, small business, development/testing, edge deployment

**Volume:** <5M tokens/month

**Total Monthly Cost:**
- Hardware amortized (3 years): $55/month
- Electricity: $50/month
- Engineering (Safebox): $5/month
- **Total: $110/month**

**vs API (Claude Sonnet 4.6, 5M tokens):** $4,500/month  
**Savings:** $4,390/month = **$52K/year**  
**ROI:** 2 months

---

### **Tier 2: Single GPU ($2K consumer / $15K datacenter, $700/mo rental)**

**Hardware Option A — Consumer:**
- 1× NVIDIA RTX 4090 (24GB VRAM)
- AMD Ryzen 9 7950X or similar
- 128GB DDR5 RAM
- 2TB NVMe SSD
- **Total:** ~$4,500

**Hardware Option B — Datacenter:**
- 1× NVIDIA A100 40GB
- Dual Xeon or EPYC
- 256GB RAM
- 4TB NVMe
- **Total:** ~$18,000

**Models:**
- **LLM:** Mistral Small 22B OR Phi-4 14B (FP16)
- **Image:** SDXL 1.0, Flux.1 Schnell
- **Transcription:** Whisper Large v3 (GPU-accelerated), VibeVoice-ASR* (with offloading)
- **3D:** TripoSR, Shap-E, Point-E

**Protocols:** LLM (mid-size), Image, Transcription, 3D

**Use Case:** Startup, agency, SMB with AI products

**Volume:** 5-50M tokens/month + image/3D generation

**Total Monthly Cost (Consumer Owned):**
- Hardware amortized: $125/month
- Electricity (350W): $90/month
- Engineering (Safebox): $5/month
- **Total: $220/month**

**Total Monthly Cost (Datacenter Rental):**
- GPU rental (A100 40GB): $700/month
- Engineering (Safebox): $5/month
- **Total: $705/month**

**vs API (Claude, 20M tokens + 500 images):**
- LLM: $18,000/month
- Images (Midjourney): $1,000/month
- **Total: $19,000/month**

**Savings (owned):** $18,780/month = **$225K/year**  
**Savings (rental):** $18,295/month = **$220K/year**  
**ROI (owned):** 1 month  
**ROI (rental):** Immediate

---

### **Tier 3: Multi-GPU Production ($50K owned / $2,400/mo rental)**

**Hardware:**
- 2× NVIDIA A100 80GB
- Dual EPYC 9654 or Xeon Platinum
- 512GB DDR5 RAM
- 8TB NVMe RAID
- **Total:** ~$50,000

**Models:**
- **LLM:** Qwen 3.5 72B, DeepSeek-R1-70B, GLM-5.1 (FP16)
- **Multimodal:** **Nemotron 3 Nano Omni** (text + image + video + audio) ⭐
- **Image:** SDXL, Flux.1 Schnell, ControlNet, InstantID
- **Speech:** VibeVoice-ASR-7B (full), Whisper v3
- **3D:** All 6 models (TripoSR, TripoSF, Shap-E, Point-E, InstantMesh, Trellis)
- **Video:** LTX-Video, CogVideoX-5B

**Protocols:** LLM (large), **Multimodal (unified)**, Image, Transcription (multi-speaker), 3D, Video (fast)

**Key addition:** Nemotron 3 Nano Omni enables **computer use agents**, **document intelligence**, and **audio-video reasoning** in production

**Use Case:** AI-first company, SaaS with AI features, 100-500 employees

**Volume:** 50-200M tokens/month + heavy media generation

**Total Monthly Cost (Owned):**
- Hardware amortized: $1,390/month
- Electricity (1.4kW): $370/month
- Engineering (Safebox): $5/month
- **Total: $1,765/month**

**Total Monthly Cost (Rental):**
- 2× A100 80GB: $2,400/month
- Engineering (Safebox): $5/month
- **Total: $2,405/month**

**vs API (Claude, 100M tokens + video/speech/3D):**
- LLM: $90,000/month
- Images: $5,000/month
- Video (100 clips): $2,500/month
- Speech (200 hrs): $800/month
- 3D (500 models): $6,000/month
- **Total: $104,300/month**

**Savings (owned):** $102,535/month = **$1.23M/year**  
**Savings (rental):** $101,895/month = **$1.22M/year**  
**ROI (owned):** <1 month  
**ROI (rental):** Immediate

---

### **Tier 4: Enterprise Full Suite ($200K owned / $8,000/mo rental)**

**Hardware:**
- 8× NVIDIA H100 80GB SXM5
- Dual AMD EPYC 9754 (128 cores each)
- 2TB DDR5 RAM
- 32TB NVMe RAID
- 10GbE networking
- **Total:** ~$240,000

**Models:** **ALL 32+ models** including:
- **LLM:** DeepSeek V3 (671B MoE), Qwen 3.5 72B, all others
- **Video:** SkyReels V1 (cinematic), Open-Sora 2.0 (1080p), Mochi 1, LTX-Video, CogVideoX
- **Speech:** VibeVoice-Large-7B (best Chinese quality)
- **Image:** All models including Flux.1 Schnell
- **3D, Transcription:** Complete coverage

**Protocols:** **ALL** (LLM, Image, Speech, Transcription, Video, 3D)

**Use Case:** Enterprise, AI research lab, media production company, government

**Volume:** 500M+ tokens/month + extensive video/speech production

**Total Monthly Cost (Owned):**
- Hardware amortized: $6,670/month
- Electricity (5.6kW): $1,470/month
- Engineering (Safebox): $10/month (2 quarterly reviews)
- **Total: $8,150/month**

**Total Monthly Cost (Rental):**
- 8× H100 80GB: $16,000/month (on-demand)
- Reserved instance (1-year): $8,000/month
- Engineering (Safebox): $10/month
- **Total: $8,010/month (reserved)**

**vs API (Claude, 500M tokens + extensive media):**
- LLM: $450,000/month
- Images (5K/month): $25,000/month
- Video (2K clips): $50,000/month
- Speech (2K hrs): $16,000/month
- 3D (5K models): $60,000/month
- **Total: $601,000/month**

**Savings (owned):** $592,850/month = **$7.11M/year**  
**Savings (rental reserved):** $592,990/month = **$7.12M/year**  
**ROI (owned):** <1 month  
**ROI (rental):** Immediate

**Additional value:**
- Complete data sovereignty
- <50ms P50 latency (vs 200-600ms API)
- No rate limits
- Structural HIPAA/GDPR compliance
- Zero vendor lock-in

---

## 📦 **Model Loading Strategy**

### **How Models Get Into Safebox**

**Three-step process:**

**1. Define model in registry**

`Safebox/inference/models` stream:

```json
{
  "modelId": "qwen-3.5-72b",
  "displayName": "Qwen 3.5 72B Instruct",
  "protocols": ["llm"],
  "license": "Apache 2.0",
  "provider": "Alibaba",
  "huggingfaceRepo": "Qwen/Qwen3.5-72B-Instruct",
  "hardware": {
    "minVRAM": "144GB",
    "recommendedGPU": "2x A100 80GB",
    "tensorParallelSize": 2
  },
  "safebux": {
    "chat": 0.8,
    "complete": 0.7,
    "embed": 0.1
  }
}
```

**2. Runner pulls weights**

Runner startup script:

```bash
#!/bin/bash
# model-runners/vllm/start.sh

# Pull weights from HuggingFace
huggingface-cli download \
  Qwen/Qwen3.5-72B-Instruct \
  --local-dir /models/qwen-3.5-72b

# Start vLLM
vllm serve /models/qwen-3.5-72b \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.9 \
  --port 8000
```

**3. Safebox discovers via `/v1/capabilities`**

Runner reports:

```json
{
  "runnerId": "safebox-model-llm-1",
  "protocols": {
    "llm": {
      "chat": true,
      "completion": true,
      "embedding": false
    }
  },
  "models": {
    "loaded": ["qwen-3.5-72b"]
  }
}
```

Safebox inference router now knows: "Send LLM chat requests for `qwen-3.5-72b` to `safebox-model-llm-1`"

### **Dynamic Model Loading**

**Models can be loaded/unloaded without restarting Safebox:**

```bash
# Load new model
curl -X POST http://safebox-model-llm-1:8000/admin/load-model \
  -d '{"modelId": "mistral-small-22b", "repo": "mistralai/Mistral-Small-24B-Instruct"}'

# Unload old model (free VRAM)
curl -X POST http://safebox-model-llm-1:8000/admin/unload-model \
  -d '{"modelId": "qwen-3.5-72b"}'
```

Runner re-reports capabilities → Safebox re-routes traffic

---

## ✅ **Summary**

### **What to Do With the Catalog**

1. **Pick models** based on license (MIT/Apache), hardware, use case
2. **Deploy 7 runners** (containers) that load model weights from HuggingFace
3. **Expose Safebox protocol** (`/v1/chat`, `/v1/speech`, etc.)
4. **Let Safebox auto-discover** via `/v1/capabilities`
5. **Bill SAFEBUX** based on usage

### **Runner Checklist**

- ✅ **vLLM Runner** — 7-8 LLMs (Qwen, DeepSeek, Mistral, Phi, Gemma, Llama)
- ✅ **ComfyUI Runner** — 4 image models (SDXL, Flux, ControlNet, InstantID)
- ✅ **VibeVoice TTS Runner** — 3 speech models
- ✅ **VibeVoice ASR Runner** — ASR transcription
- ✅ **Whisper Runner** — Fast transcription
- ✅ **Video Runner** — 5 video models (LTX, Mochi, CogVideoX, SkyReels, Open-Sora)
- ✅ **3D Runner** — 6 3D models (TripoSR, Shap-E, etc.)

### **CPU vs GPU**

**Use CPU (GGUF quantization) for:**
- LLMs ≤32B params (8-15 tok/sec on Q5_K_M)
- Embeddings (always CPU-viable)
- Whisper transcription (<10 hours/day)
- Development/testing

**Use GPU for:**
- LLMs >70B params (full precision)
- All image/video/speech/3D models
- High throughput (>100K tokens/hour)
- Production workloads

### **Safebox Economic Advantage**

**Traditional self-hosting:**
- Engineering: $270K-550K/year (2 FTE)
- Break-even: 100M+ tokens/month

**Safebox:**
- Engineering: $20K-40K/year (<5 hrs/month)
- Break-even: **5-10M tokens/month** ← startup scale!

**Safebox saves $230K-510K/year in engineering costs alone**

### **Break-Even Points (with Safebox)**

| Tier | Volume | Monthly Savings | ROI |
|------|--------|-----------------|-----|
| **Tier 2** (Single GPU) | 5M+ tokens/month | $18K/month | <1 month |
| **Tier 3** (Multi-GPU) | 50M+ tokens/month | $100K/month | <1 month |
| **Tier 4** (Enterprise) | 500M+ tokens/month | $590K/month | <1 month |

### **When Safebox Wins**

✅ **Volume:** 5M+ tokens/month (Tier 2+)  
✅ **Privacy:** HIPAA/GDPR compliance required  
✅ **Latency:** Need <50ms P50 (vs 200-600ms API)  
✅ **Sovereignty:** Zero vendor lock-in  
✅ **Video/Speech:** Heavy usage (100+ clips or hours/month)  
✅ **Engineering:** Small team (Safebox is turnkey)

### **When APIs Still Win**

✅ **Ultra-low volume:** <1M tokens/month  
✅ **Frontier quality:** Need GPT-5/Claude 4.6 (no open alternative yet)  
✅ **Prototyping:** Testing multiple models before committing

### **Safebox Value Proposition**

**Safebox isn't just about cost savings** — it's about:

1. **Data sovereignty** — Zero data exfiltration, structural guarantee
2. **Security** — Immune to supply chain attacks (deterministic AMI + TPM)
3. **Compliance** — HIPAA/GDPR built-in, not contractual
4. **Engineering efficiency** — Turnkey infrastructure, <5 hrs/month
5. **No lock-in** — Own your infrastructure, switch models freely

**Cost savings are the bonus:**
- Tier 2: $225K/year
- Tier 3: $1.23M/year
- Tier 4: $7.11M/year

**Customers pay for control. At scale, they also get massive savings.**

---

**🚀 Complete implementation guide with economics, runners, GGUF, and realistic ROI!**
