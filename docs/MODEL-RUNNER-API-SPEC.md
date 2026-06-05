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

### vLLM Runner

- [ ] Extend vLLM with custom endpoints:
  - [ ] `GET /v1/capabilities`
  - [ ] `POST /v1/models/load`
  - [ ] `POST /v1/models/unload`
  - [ ] `POST /v1/cache/flush`
  - [ ] `GET /health`
- [ ] Add request/response headers:
  - [ ] Parse `X-Cache-Mode`, `X-Cache-Tag`, `X-Tenant-ID`, `X-Priority`
  - [ ] Return `X-Cache-Hit`, `X-Cache-Tokens-Reused`, `X-Queue-Wait-Ms`
- [ ] Implement per-tenant queue with priority
- [ ] Implement per-tenant rate limiting
- [ ] Add backpressure (503 when queue full)
- [ ] Verify `verifiedOpToken` on lifecycle ops
- [ ] Extend metrics with cache hit rate, per-tenant counters
- [ ] Add nonce tracking for replay protection

### ComfyUI Runner (Vision)

- [ ] Wrap ComfyUI with FastAPI/Flask API server
- [ ] Implement same endpoints (simpler - no KV cache)
- [ ] Model loading: Download checkpoint to `/opt/comfyui/models/checkpoints/`
- [ ] Queue management for concurrent generation requests
- [ ] Return queue depth in `/v1/capabilities`

### Whisper Runner (Audio)

- [ ] Wrap faster-whisper with FastAPI
- [ ] Implement same endpoints
- [ ] Model loading: Load whisper model size (tiny/base/small/medium/large)
- [ ] No caching needed (audio is one-shot)
- [ ] Return transcription metrics

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
