# Model Runner API Specification

**For Infrastructure Team: What to implement in model runner containers**

---

## 🎯 Overview

This spec defines the API that model runner containers (vLLM, TGI, ComfyUI, Whisper) must expose to enable:
- Dynamic model loading/unloading
- KV cache control and telemetry
- Per-tenant queueing and rate limiting
- Capacity-aware request routing
- Governance integration

**Key principle:** The OpenAI-compatible `/v1/chat/completions` endpoint is necessary but NOT sufficient for production. We need additional endpoints and headers for lifecycle, observability, and resource management.

---

## 📋 Required Endpoints

### 1. Capability Descriptor

**Endpoint:** `GET /v1/capabilities`

**Purpose:** Let Protocol.Inference discover what this runner can do and current resource state.

**Response:**

```json
{
  "runnerType": "vllm-0.6.0",
  "runnerId": "safebox-model-llm-1",
  "models": {
    "loaded": [
      {
        "id": "meta-llama/Llama-3.1-70B-Instruct",
        "quantization": "awq-4bit",
        "contextLength": 32768,
        "loadedAt": 1745880000,
        "gpuMemoryMB": 24000
      }
    ],
    "loading": [
      {
        "id": "mistralai/Mistral-7B-Instruct-v0.3",
        "progress": 0.45,
        "eta": 180
      }
    ],
    "available": [
      "meta-llama/Llama-3.1-8B-Instruct",
      "deepseek-ai/deepseek-r1-distill-llama-70b"
    ]
  },
  "resources": {
    "gpuIds": [0],
    "gpuMemoryTotalMB": 81920,
    "gpuMemoryUsedMB": 58000,
    "gpuMemoryFreeMB": 23920,
    "gpuUtilization": 0.67,
    "kvCacheSizeMB": 12000,
    "kvCacheUtilization": 0.45
  },
  "queue": {
    "depth": 3,
    "maxDepth": 16,
    "avgWaitMs": 150,
    "p95WaitMs": 450
  },
  "capabilities": {
    "streaming": true,
    "prefixCaching": true,
    "multiTenant": true,
    "visionInput": false,
    "audioInput": false,
    "functionCalling": true
  },
  "health": "healthy"
}
```

**Cache:** 5 second TTL. Protocol.Inference polls this every 5s to update registry.

**Implementation notes:**
- vLLM: Extend with custom endpoint that reads `AsyncLLMEngine` state
- TGI: Similar - read engine state via `/metrics` + custom logic
- Return 503 if runner is starting up or shutting down

---

### 2. Model Loading

**Endpoint:** `POST /v1/models/load`

**Purpose:** Load a model into GPU memory (governed operation).

**Request:**

```json
{
  "modelId": "meta-llama/Llama-3.1-70B-Instruct",
  "quantization": "awq-4bit",
  "maxContextLength": 32768,
  "gpuMemoryBudgetMB": 40000,
  "evictModel": "meta-llama/Llama-3.1-8B-Instruct",
  "verifiedOpToken": "eyJ..."
}
```

**Parameters:**
- `modelId` - HuggingFace model ID or local path
- `quantization` - Optional: `awq-4bit`, `gptq-4bit`, `fp16`, `bf16`
- `maxContextLength` - Max sequence length
- `gpuMemoryBudgetMB` - How much GPU memory this model can use
- `evictModel` - Optional: Unload this model first to free memory
- `verifiedOpToken` - Signed by Safebox governance (M-of-N verified)

**Response (202 Accepted):**

```json
{
  "taskId": "load-abc123",
  "status": "loading",
  "progress": 0.0,
  "eta": 300
}
```

**Poll status:** `GET /v1/models/load/{taskId}`

**Response when complete (200 OK):**

```json
{
  "taskId": "load-abc123",
  "status": "completed",
  "modelId": "meta-llama/Llama-3.1-70B-Instruct",
  "gpuMemoryUsedMB": 38500,
  "loadTimeMs": 287000
}
```

**Implementation notes:**
- Verify `verifiedOpToken` signature (HMAC with shared key)
- If `evictModel` specified, unload it first
- Download model if not cached locally (HuggingFace hub)
- Load into vLLM engine
- Return 202 immediately, actual loading is async
- Store task in Redis/memory for status polling

---

### 3. Model Unloading

**Endpoint:** `POST /v1/models/unload`

**Purpose:** Free GPU memory by unloading a model.

**Request:**

```json
{
  "modelId": "meta-llama/Llama-3.1-8B-Instruct",
  "verifiedOpToken": "eyJ..."
}
```

**Response (200 OK):**

```json
{
  "modelId": "meta-llama/Llama-3.1-8B-Instruct",
  "gpuMemoryFreedMB": 8200,
  "kvCacheFlushed": true
}
```

**Implementation notes:**
- Verify `verifiedOpToken`
- Flush KV cache for this model
- Unload model from vLLM engine
- Return freed memory amount

---

### 4. Cache Management

**Endpoint:** `POST /v1/cache/flush`

**Purpose:** Clear KV cache (by tenant, by model, or全部).

**Request:**

```json
{
  "scope": "tenant",
  "tenantId": "community-x",
  "modelId": null,
  "verifiedOpToken": "eyJ..."
}
```

**Scope options:**
- `all` - Flush entire KV cache
- `model` - Flush cache for specific model
- `tenant` - Flush cache for specific tenant
- `tag` - Flush cache by custom tag

**Response (200 OK):**

```json
{
  "flushed": true,
  "entriesRemoved": 1234,
  "memoryFreedMB": 3500
}
```

---

### 5. Health Check

**Endpoint:** `GET /health`

**Purpose:** Simple alive check for container orchestration.

**Response (200 OK):**

```json
{
  "status": "healthy",
  "uptime": 86400,
  "modelsLoaded": 2,
  "queueDepth": 3
}
```

**Response (503 Service Unavailable) if:**
- GPU OOM
- All models failed to load
- Queue saturated beyond threshold

---

## 🔧 Request Headers (Inference Endpoints)

### Cache Control Headers

**On `/v1/chat/completions`, `/v1/completions` requests:**

**Request headers:**

```http
X-Cache-Mode: prefix
X-Cache-Tag: session-abc123
X-Tenant-ID: community-x
X-Priority: high
```

**Header definitions:**

| Header | Values | Purpose |
|--------|--------|---------|
| `X-Cache-Mode` | `prefix`, `none`, `auto` | Control prefix caching |
| `X-Cache-Tag` | String (max 64 chars) | Scope cache entries |
| `X-Tenant-ID` | String | Per-tenant queueing/rate-limiting |
| `X-Priority` | `high`, `normal`, `low` | Queue priority |

**Response headers:**

```http
X-Cache-Hit: true
X-Cache-Tokens-Reused: 1234
X-Queue-Wait-Ms: 150
X-GPU-Time-Ms: 450
```

**Header definitions:**

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Cache-Hit` | `true`, `false` | Whether prefix cache helped |
| `X-Cache-Tokens-Reused` | Integer | How many tokens served from cache |
| `X-Queue-Wait-Ms` | Integer | Time spent in queue |
| `X-GPU-Time-Ms` | Integer | Actual GPU inference time |

**Implementation notes:**
- vLLM with `--enable-prefix-caching` supports this natively
- Track cache hits in metrics
- Return headers even if caching disabled (false values)

---

## 🚦 Backpressure and Rate Limiting

### Queue Saturation

**When queue depth exceeds threshold:**

**Response (503 Service Unavailable):**

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5

{
  "error": {
    "code": "queue_full",
    "message": "Queue depth 16/16, retry in 5 seconds",
    "queueDepth": 16,
    "avgWaitMs": 2000
  }
}
```

**Implementation:**
- Return 503 when queue depth >= maxDepth
- Set `Retry-After` header (seconds)
- Protocol.Inference sees 503, can fallback to cloud model

### Per-Tenant Rate Limiting

**Configured via environment variables:**

```bash
TENANT_RATE_LIMIT_community-x=100req/min
TENANT_RATE_LIMIT_community-y=500req/min
TENANT_RATE_LIMIT_default=50req/min
```

**When exceeded:**

**Response (429 Too Many Requests):**

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30

{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Tenant community-x exceeded 100 req/min",
    "limit": 100,
    "remaining": 0,
    "resetAt": 1745880060
  }
}
```

**Implementation:**
- Use Redis or in-memory sliding window
- Key: `rate_limit:{tenantId}:{minute}`
- Increment on each request
- Check against limit before queueing

---

## 📊 Metrics Endpoint

**Endpoint:** `GET /metrics`

**Purpose:** Prometheus-compatible metrics for monitoring.

**Response (text/plain):**

```
# HELP vllm_requests_total Total requests processed
# TYPE vllm_requests_total counter
vllm_requests_total{model="llama-3.1-70b",tenant="community-x",status="success"} 12345

# HELP vllm_cache_hit_rate Cache hit rate
# TYPE vllm_cache_hit_rate gauge
vllm_cache_hit_rate{model="llama-3.1-70b"} 0.67

# HELP vllm_queue_depth Current queue depth
# TYPE vllm_queue_depth gauge
vllm_queue_depth 3

# HELP vllm_gpu_memory_used GPU memory used in bytes
# TYPE vllm_gpu_memory_used gauge
vllm_gpu_memory_used{gpu="0"} 60000000000

# HELP vllm_inference_duration_seconds Inference duration
# TYPE vllm_inference_duration_seconds histogram
vllm_inference_duration_seconds_bucket{model="llama-3.1-70b",le="0.5"} 100
vllm_inference_duration_seconds_bucket{model="llama-3.1-70b",le="1.0"} 500
vllm_inference_duration_seconds_sum{model="llama-3.1-70b"} 450.0
vllm_inference_duration_seconds_count{model="llama-3.1-70b"} 1000
```

**Standard vLLM metrics + additions:**
- Cache hit rate per model
- Per-tenant request counters
- Queue wait time histogram
- GPU memory breakdown (model weights vs KV cache)

---

## 🔐 Authentication

### verifiedOpToken Format

**Lifecycle operations (load/unload/flush) require governance:**

```json
{
  "opToken": {
    "operation": "model-load",
    "modelId": "meta-llama/Llama-3.1-70B-Instruct",
    "issuedAt": 1745880000,
    "signers": ["admin1", "admin2", "admin3"],
    "nonce": "abc123..."
  },
  "signature": "..."
}
```

**Verification:**
1. Parse JWT/JSON
2. Verify signature with shared HMAC key
3. Check nonce not seen before (replay protection)
4. Check timestamp within 5 minutes
5. Check signers match M-of-N governance requirement

**Shared key location:** `/etc/safebox/model-api.key`

**Inference requests do NOT require opToken** - only lifecycle ops.

---

## 🐳 Docker Environment Variables

**Required:**

```bash
# GPU allocation
CUDA_VISIBLE_DEVICES=0

# Model storage
HF_HOME=/models/cache
MODEL_BASE_PATH=/models

# vLLM config
VLLM_ENABLE_PREFIX_CACHING=true
VLLM_MAX_MODEL_LEN=32768
VLLM_GPU_MEMORY_UTILIZATION=0.9

# Multi-tenant
ENABLE_MULTI_TENANT=true
DEFAULT_RATE_LIMIT=100req/min

# Governance
VERIFIED_OP_TOKEN_KEY_PATH=/etc/safebox/model-api.key
```

**Optional:**

```bash
# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Metrics
ENABLE_METRICS=true
METRICS_PORT=9090

# Queue
MAX_QUEUE_DEPTH=16
QUEUE_TIMEOUT_MS=30000
```

---

## 📝 Implementation Checklist

**For Infrastructure team:**

### vLLM Runner — **SHIPPED**

- [x] vLLM-backed FastAPI runner under `model-runners/vllm/` (774 lines)
- [x] Safebox-canonical endpoints: `/v1/chat`, `/v1/complete`, `/v1/embed`, `/v1/capabilities`, `/v1/capacity`, `/v1/models`, `/health`
- [x] HMAC verification with timestamp + nonce + 5-min replay window
- [x] Audit-trail SHA-256 hashes (sourceSha256 over canonical request, outputSha256 over response)
- [x] Per-tenant priority queue and rate limiting
- [x] Backpressure (503 when queue full)
- [x] Five LLM manifests (Llama 3.3 70B, Qwen 3 32B, Mistral Small 3, Gemma 3 12B IT, DeepSeek V3)
- [x] 41 unit tests passing

### Document Extraction Runner — **SHIPPED** (`model-runners/mineru/`)

- [x] FastAPI wrapper over MinerU 2.5 (463 lines)
- [x] Endpoints: `/v1/extract`, `/v1/extract/batch`, plus the standard introspection set
- [x] Pipeline and VLM backends both supported
- [x] PDF, DOCX, PPTX, XLSX, image inputs → Markdown/JSON outputs
- [x] HMAC + audit hashes

### Privacy Filter Runner — **SHIPPED** (`model-runners/privacy-filter/`)

- [x] PII redaction over `/v1/redact`
- [x] Plumbs into the same HMAC + audit-hash convention

### ComfyUI Runner (Image) — **SHIPPED** (`model-runners/comfyui/`)

- [x] FastAPI wrapper over ComfyUI (676 lines)
- [x] Endpoint: `/v1/image/generate` plus introspection set
- [x] Workflow templates for SDXL and FLUX families
- [x] Three manifests: SDXL Base 1.0, FLUX.1-schnell (Apache 2.0), FLUX.1-dev (Non-Commercial — flagged in manifest)
- [x] 53 unit tests passing
- [x] supervisord-managed two-process container (ComfyUI engine + Safebox wrapper)

### Whisper Runner (Transcription) — **SHIPPED** (`model-runners/whisper/`)

- [x] FastAPI wrapper over Faster-Whisper (648 lines)
- [x] Endpoints: `/v1/transcribe`, `/v1/transcribe/batch`
- [x] Streaming SSE for long-form audio
- [x] Five manifests covering large-v3-turbo (default), large-v3 (translation), medium, small, distil-large-v3
- [x] 33 unit tests passing

### Kokoro TTS Runner (Speech) — **SHIPPED** (`model-runners/kokoro-tts/`)

- [x] FastAPI wrapper over Kokoro 82M (598 lines, Apache 2.0)
- [x] Endpoints: `/v1/speech`, `/v1/voices`
- [x] Streaming SSE for long-form text
- [x] WAV / MP3 / OGG output via ffmpeg
- [x] Two manifests: kokoro-82m (English, ~28 voices) and kokoro-82m-multilingual (Japanese/Mandarin/French/Hindi/Italian/Portuguese)
- [x] 41 unit tests passing

### Stable Audio Runner (Audio Generation) — **SHIPPED** (`model-runners/stable-audio-3/`)

- [x] FastAPI wrapper over stable-audio-tools (544 lines, Apache 2.0)
- [x] Endpoint: `/v1/audio/generate` (text-to-music, SFX, ambient)
- [x] WAV / MP3 / OGG output
- [x] Two manifests: stable-audio-open-small (341M, 8 steps, 11s clips) and stable-audio-open-1.0 (1.21B, 100 steps DPM++ 3M-SDE, 47s clips)
- [x] 35 unit tests passing
- [ ] Audio-to-audio (inpainting, style transfer) — post-1.0

### LTX-Video Runner (Video Generation) — **SHIPPED** (`model-runners/ltx-video/`)

- [x] FastAPI wrapper over LTX-Video 2.3 (710 lines, Apache 2.0, Lightricks)
- [x] Endpoint: `POST /v1/video/generate`
  - Body: `{ model, prompt, negativePrompt?, inputImage?, width?, height?, numFrames?, fps?, steps?, guidance?, seed?, enableAudio?, audioPrompt?, modalityScale?, outputMode? }`
  - Dimensions clamped to multiples of 32; frame counts clamped to form 8k+1
  - inputImage accepts file path or `data:` URL base64
  - outputMode: `path` (default, returns `video.path`) or `base64` (returns `video.base64`)
- [x] Response shape:
  ```json
  {
    "model": "ltx-2-3-distilled",
    "prompt": "...",
    "video": {
      "format": "mp4", "codec": "h264",
      "width": 768, "height": 512,
      "numFrames": 121, "fps": 24,
      "durationSec": 5.042, "sizeBytes": 1284311,
      "hasAudio": true,
      "audio": { "codec": "aac", "bitrateKbps": 192, "sampleRate": 44100, "channels": 2, "prompt": "..." },
      "path": "/data/output/safebox-video-...mp4"
    },
    "sourceSha256": "...", "outputSha256": "...",
    "usage": { "steps": 8, "elapsedMs": 28400, "realTimeFactor": 0.178, "seed": 42, "audioEnabled": true, "modalityScale": 3.0 }
  }
  ```
- [x] MP4 output via ffmpeg (h264 + yuv420p, AAC audio when present)
- [x] Text-to-video AND image-to-video
- [x] **Synchronized audio+video in a single forward pass via LTX-2.3's dual-stream architecture**; ambient/foley quality (for music use stable-audio-3, for voice use kokoro-tts); `modalityScale` (default 3.0) controls audio-visual sync tightness; separate `audioPrompt` accepted; CAP_AUDIO defaults to true
- [x] Two manifests: ltx-2-3-distilled (8B, 16GB VRAM) and ltx-2-3-dev (22B, 24GB+ VRAM, model_cpu_offload)
- [x] MAX_QUEUE_DEPTH=1 (video gen is slow; serialize requests)
- [x] 49 unit tests passing
- [ ] Video-to-video (style transfer, editing) — post-1.0
- [ ] Frame-level progress events via SSE — post-1.0

### Wan-Video Runner (Video Generation, MoE) — **SHIPPED** (`model-runners/wan-video/`)

- [x] FastAPI wrapper over Wan 2.2 (616 lines, Apache 2.0, Alibaba Tongyi Wanxiang)
- [x] Sister runner to ltx-video — same `/v1/video/generate` protocol, different model, complementary quality/speed profile
- [x] Endpoint: `POST /v1/video/generate`
  - Body: `{ model, prompt, negativePrompt?, inputImage?, width?, height?, numFrames?, fps?, steps?, guidance?, guidanceLowNoise?, flowShift?, seed?, outputMode? }`
  - Dimensions clamped to multiples of 16 (Wan's VAE downsample factor)
  - `guidance` controls the high-noise expert; `guidanceLowNoise` controls the low-noise expert (MoE A14B variants only — ignored for 5B)
  - `flowShift` parameter for the UniPC scheduler (5.0 for 720p, 3.0 for 480p)
- [x] Response shape:
  ```json
  {
    "model": "wan-2-2-ti2v-5b",
    "video": {
      "format": "mp4", "codec": "h264",
      "width": 1280, "height": 704,
      "numFrames": 121, "fps": 24,
      "durationSec": 5.042, "sizeBytes": 2143891,
      "hasAudio": false,
      "path": "/data/output/safebox-wan-video-...mp4"
    },
    "sourceSha256": "...", "outputSha256": "...",
    "usage": { "steps": 50, "elapsedMs": 82400, "realTimeFactor": 0.061, "seed": 42,
               "guidance": 5.0, "guidanceLowNoise": 3.0, "flowShift": 5.0 }
  }
  ```
- [x] Three manifests: wan-2-2-ti2v-5b (5B combined T+I2V, 16GB VRAM), wan-2-2-t2v-a14b (MoE A14B, 24GB+ VRAM), wan-2-2-i2v-a14b (MoE A14B image-to-video, 24GB+ VRAM)
- [x] WanPipeline + AutoencoderKLWan + UniPCMultistepScheduler with `flow_shift` from request
- [x] enable_model_cpu_offload() on by default for A14B variants (ENABLE_CPU_OFFLOAD env)
- [x] No native audio (use ltx-video for synchronized audio, or chain stable-audio-3 for background music)
- [x] MAX_QUEUE_DEPTH=1 (video gen is slow)
- [x] 38 unit tests passing
- [ ] Video editing (Wan VACE) — post-1.0, separate runner
- [ ] Speech-to-video (Wan 2.2-S2V) — post-1.0, separate runner

### TripoSR Runner (3D Generation) — **SHIPPED** (`model-runners/triposr/`)

- [x] FastAPI wrapper over TripoSR (479 lines, MIT, Stability AI + Tripo AI)
- [x] Endpoint: `POST /v1/3d/generate`
  - Body: `{ model, inputImage, foregroundRatio?, meshResolution?, removeBackground?, format?, outputMode? }`
  - inputImage accepts file path or `data:` URL base64
  - format: `glb` (default), `obj`, or `ply`
  - removeBackground: true (default) runs rembg first
- [x] Response shape:
  ```json
  {
    "model": "triposr",
    "mesh": {
      "format": "glb", "vertices": 24832, "faces": 49664,
      "sizeBytes": 1284113, "hasVertexColors": true,
      "path": "/data/output/safebox-mesh-...glb"
    },
    "sourceSha256": "...", "outputSha256": "...",
    "usage": { "meshResolution": 256, "foregroundRatio": 0.85, "removedBackground": true, "elapsedMs": 842 }
  }
  ```
- [x] Vertex colors baked into mesh (PBR textures would require Hunyuan3D 2.1 — separate runner, post-1.0)
- [x] One manifest: triposr (stabilityai/TripoSR)
- [x] 36 unit tests passing
- [ ] Text-to-3D — chain ComfyUI (text→image) → TripoSR (image→mesh); no direct text-to-3D runner

---

## 🔄 Integration with Infrastructure API

**system-protocol-api.js needs new action:**

```javascript
case 'model-load':
    return await executeModelLoad(dockerContainer, stm);

async function executeModelLoad(container, stm) {
    const { modelId, quantization, maxContextLength, evictModel, verifiedOpToken } = stm;
    
    // Call runner's /v1/models/load endpoint
    const response = await fetch('http://safebox-model-llm:8080/v1/models/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            modelId,
            quantization,
            maxContextLength,
            evictModel,
            verifiedOpToken
        })
    });
    
    const result = await response.json();
    
    if (response.status === 202) {
        // Poll for completion
        const taskId = result.taskId;
        return await pollModelLoadTask(container, taskId);
    }
    
    return result;
}

async function pollModelLoadTask(container, taskId) {
    const maxAttempts = 60; // 5 minutes
    
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s
        
        const response = await fetch(`http://safebox-model-llm:8080/v1/models/load/${taskId}`);
        const status = await response.json();
        
        if (status.status === 'completed') {
            return {
                modelId: status.modelId,
                verified: true,
                gpuMemoryUsedMB: status.gpuMemoryUsedMB
            };
        }
        
        if (status.status === 'failed') {
            throw new Error(`Model load failed: ${status.error}`);
        }
    }
    
    throw new Error('Model load timeout');
}
```

---

## 📊 Summary

**What Infrastructure provides:**

| Component | What | How |
|-----------|------|-----|
| **Capability endpoint** | Runner state discovery | `GET /v1/capabilities` |
| **Model lifecycle** | Load/unload models | `POST /v1/models/load`, `POST /v1/models/unload` |
| **Cache control** | KV cache management | Headers + `POST /v1/cache/flush` |
| **Multi-tenancy** | Per-tenant queues | `X-Tenant-ID` header + rate limiting |
| **Backpressure** | Queue saturation | 503 with `Retry-After` |
| **Observability** | Metrics and health | `GET /metrics`, `GET /health` |
| **Governance** | Verify operations | `verifiedOpToken` validation |

**What Safebox consumes:**

All of the above via `Protocol.Inference` (new) and `Protocol.System` (extended).

🎉 **Complete model runner API for production inference!**
