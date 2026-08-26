# Protocol.Inference Implementation Guide

**For Safebox Team: How to implement local model inference with governance**

---

## 🎯 Overview

`Protocol.Inference` is the new Protocol layer that routes inference requests to local model runners while respecting:
- Model availability (which runner has which model loaded)
- Resource capacity (GPU memory, queue depth)
- KV cache state (hit/miss telemetry)
- Per-tenant limits (rate limiting, priority queuing)
- Governance (M-of-N approval for model loading)

**Key architecture:**
- **High-frequency path:** `Protocol.Inference` → model runner (no governance, just routing)
- **Low-frequency path:** `Protocol.System` → model lifecycle (M-of-N governed)

---

## 📂 File Structure

```
platform/plugins/Q/handlers/Q/
├── Protocol.js                    # Add Protocol.Inference here
├── inference.js                   # New: inference logic
└── ai/
    ├── chat.js                    # Update to use Protocol.Inference
    ├── image.js                   # Update to use Protocol.Inference
    └── transcribe.js              # Update to use Protocol.Inference

platform/plugins/Safebox/classes/Safebox/
├── Inference/
│   ├── RunnerRegistry.php         # Registry stream reader
│   ├── ModelRegistry.php          # Model metadata
│   └── Router.php                 # Request routing logic
└── System/
    └── Governance.php             # Extend with model-load action
```

---

## 🔧 Protocol.Inference API

### Core Function

```javascript
// In platform/plugins/Q/handlers/Q/Protocol.js

Protocol.Inference = {
    /**
     * Send inference request to appropriate model runner
     * 
     * @param {object} params
     * @param {string} params.model - Logical model name (e.g., "llama-3.1-70b")
     * @param {string} params.type - "chat", "completion", "image", "transcription"
     * @param {object} params.request - Model-specific request (messages, prompt, etc.)
     * @param {object} params.options - Cache mode, priority, tenant
     * @returns {Promise<object>} Response with result + telemetry
     */
    async execute(params) {
        const { model, type, request, options = {} } = params;
        
        // 1. Find runner with this model loaded
        const runner = await this.findRunner(model, type);
        
        if (!runner) {
            // Model not loaded - check if should auto-load or fallback
            return await this.handleModelNotLoaded(model, type, request, options);
        }
        
        // 2. Check runner capacity
        if (runner.queueDepth >= runner.maxQueueDepth) {
            // Runner saturated - fallback to cloud or queue
            return await this.handleRunnerSaturated(model, runner, request, options);
        }
        
        // 3. Build request with cache/tenant headers
        const runnerRequest = this.buildRunnerRequest(request, options);
        
        // 4. Send to runner
        const response = await fetch(`http://${runner.host}:${runner.port}${this.getEndpoint(type)}`, {
            method: 'POST',
            headers: runnerRequest.headers,
            body: JSON.stringify(runnerRequest.body)
        });
        
        // 5. Parse response + telemetry
        const result = await response.json();
        const telemetry = this.extractTelemetry(response.headers);
        
        // 6. Log telemetry
        await this.logTelemetry(model, runner, telemetry, options.tenantId);
        
        return {
            result,
            telemetry,
            runner: runner.id
        };
    },
    
    async findRunner(model, type) {
        // Read from Safebox/inference/runners stream
        const registry = await Q.Streams.fetch('Safebox', 'Safebox/inference/runners');
        const runners = JSON.parse(registry.content);
        
        // Find runner with this model loaded
        for (const runner of runners) {
            if (runner.models.loaded.includes(model) && runner.capabilities[type]) {
                return runner;
            }
        }
        
        return null;
    },
    
    async handleModelNotLoaded(model, type, request, options) {
        // Check if model is approved for loading
        const modelRegistry = await Q.Streams.fetch('Safebox', 'Safebox/inference/models');
        const models = JSON.parse(modelRegistry.content);
        const modelSpec = models[model];
        
        if (!modelSpec) {
            throw new Error(`Model ${model} not found in registry`);
        }
        
        // Check governance policy
        if (modelSpec.loadPolicy === 'on-demand') {
            // Auto-load if runner has capacity
            return await this.autoLoadModel(model, modelSpec, request, options);
        } else if (modelSpec.loadPolicy === 'manual') {
            // Requires explicit M-of-N approval
            throw new Error(`Model ${model} requires manual loading via governance`);
        } else if (modelSpec.loadPolicy === 'fallback-cloud') {
            // Fall back to cloud model
            return await this.fallbackToCloud(model, type, request, options);
        }
    },
    
    async autoLoadModel(model, modelSpec, request, options) {
        // Find runner with free capacity
        const registry = await Q.Streams.fetch('Safebox', 'Safebox/inference/runners');
        const runners = JSON.parse(registry.content);
        
        const runner = runners.find(r => 
            r.resources.gpuMemoryFreeMB >= modelSpec.gpuMemoryMB &&
            r.capabilities[modelSpec.type]
        );
        
        if (!runner) {
            throw new Error(`No runner has capacity for ${model} (needs ${modelSpec.gpuMemoryMB}MB)`);
        }
        
        // Load model via Protocol.System
        const loadResult = await Protocol.System.execute({
            ocp: 1,
            stm: {
                action: 'model-load',
                container: runner.containerId,
                modelId: modelSpec.modelId,
                quantization: modelSpec.quantization,
                maxContextLength: modelSpec.maxContextLength
            },
            jti: crypto.randomBytes(16).toString('hex'),
            // Auto-load uses system credentials, not M-of-N
            key: ['system'],
            sig: [await this.signSystemOp()]
        });
        
        if (!loadResult.verified) {
            throw new Error(`Model load failed: ${loadResult.error}`);
        }
        
        // Now retry the inference request
        return await this.execute({ model, type: modelSpec.type, request, options });
    },
    
    async handleRunnerSaturated(model, runner, request, options) {
        // Runner queue full - check fallback policy
        if (options.fallbackToCloud) {
            return await this.fallbackToCloud(model, request.type, request, options);
        }
        
        // Queue and wait
        if (options.queueWait) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
            return await this.execute({ model, type: request.type, request, options });
        }
        
        // Fail fast
        throw new Error(`Runner for ${model} saturated (queue ${runner.queueDepth}/${runner.maxQueueDepth})`);
    },
    
    async fallbackToCloud(model, type, request, options) {
        // Map local model to cloud equivalent
        const cloudMapping = {
            'llama-3.1-70b': 'gpt-4o-mini',
            'llama-3.1-8b': 'gpt-4o-mini',
            'mistral-7b': 'gpt-4o-mini',
            'sdxl': 'dall-e-3'
        };
        
        const cloudModel = cloudMapping[model] || 'gpt-4o-mini';
        
        // Delegate to existing Protocol.LLM.OpenAI or Protocol.AI.Image
        if (type === 'chat' || type === 'completion') {
            return await Protocol.LLM.OpenAI({
                model: cloudModel,
                messages: request.messages,
                ...request
            });
        } else if (type === 'image') {
            return await Protocol.AI.Image({
                model: cloudModel,
                prompt: request.prompt,
                ...request
            });
        }
    },
    
    buildRunnerRequest(request, options) {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Cache control
        if (options.cacheMode) {
            headers['X-Cache-Mode'] = options.cacheMode; // 'prefix', 'none'
        }
        if (options.cacheTag) {
            headers['X-Cache-Tag'] = options.cacheTag;
        }
        
        // Multi-tenancy
        if (options.tenantId) {
            headers['X-Tenant-ID'] = options.tenantId;
        }
        if (options.priority) {
            headers['X-Priority'] = options.priority; // 'high', 'normal', 'low'
        }
        
        return {
            headers,
            body: request
        };
    },
    
    extractTelemetry(headers) {
        return {
            cacheHit: headers.get('X-Cache-Hit') === 'true',
            tokensReused: parseInt(headers.get('X-Cache-Tokens-Reused') || '0'),
            queueWaitMs: parseInt(headers.get('X-Queue-Wait-Ms') || '0'),
            gpuTimeMs: parseInt(headers.get('X-GPU-Time-Ms') || '0')
        };
    },
    
    async logTelemetry(model, runner, telemetry, tenantId) {
        // Create Safebox/inference/request stream
        await Q.Streams.create({
            type: 'Safebox/inference/request',
            content: JSON.stringify({
                model,
                runner: runner.id,
                tenantId,
                cacheHit: telemetry.cacheHit,
                tokensReused: telemetry.tokensReused,
                queueWaitMs: telemetry.queueWaitMs,
                gpuTimeMs: telemetry.gpuTimeMs,
                timestamp: Date.now()
            })
        });
        
        // Update cache hit rate metric
        await this.updateCacheMetrics(model, telemetry.cacheHit);
    },
    
    async updateCacheMetrics(model, hit) {
        // Read/update Safebox/inference/metrics stream
        const metrics = await Q.Streams.fetch('Safebox', 'Safebox/inference/metrics');
        const data = JSON.parse(metrics.content);
        
        if (!data[model]) {
            data[model] = { hits: 0, misses: 0 };
        }
        
        if (hit) {
            data[model].hits++;
        } else {
            data[model].misses++;
        }
        
        await metrics.save({ content: JSON.stringify(data) });
    },
    
    getEndpoint(type) {
        const endpoints = {
            'chat': '/v1/chat/completions',
            'completion': '/v1/completions',
            'image': '/v1/images/generations',
            'transcription': '/v1/audio/transcriptions'
        };
        return endpoints[type];
    }
};
```

---

## 📊 Registry Streams

### Safebox/inference/runners

**Stream type:** `Safebox/registry`  
**Publisher:** `Safebox`  
**Updated by:** Registry updater process (polls runner `/v1/capabilities` every 5s)

**Content:**

```json
[
  {
    "id": "safebox-model-llm-1",
    "containerId": "safebox-model-llm",
    "host": "safebox-model-llm",
    "port": 8080,
    "runnerType": "vllm-0.6.0",
    "models": {
      "loaded": [
        "meta-llama/Llama-3.1-70B-Instruct",
        "mistralai/Mistral-7B-Instruct-v0.3"
      ],
      "loading": [],
      "available": [
        "meta-llama/Llama-3.1-8B-Instruct"
      ]
    },
    "resources": {
      "gpuIds": [0],
      "gpuMemoryFreeMB": 23920,
      "kvCacheSizeMB": 12000
    },
    "queue": {
      "depth": 3,
      "maxQueueDepth": 16,
      "avgWaitMs": 150
    },
    "capabilities": {
      "chat": true,
      "completion": true,
      "image": false,
      "transcription": false,
      "streaming": true,
      "prefixCaching": true
    },
    "health": "healthy",
    "lastUpdated": 1745880000
  },
  {
    "id": "safebox-model-vision-1",
    "containerId": "safebox-model-vision",
    "host": "safebox-model-vision",
    "port": 8081,
    "runnerType": "comfyui-0.2.0",
    "models": {
      "loaded": ["stabilityai/stable-diffusion-xl-base-1.0"],
      "loading": [],
      "available": []
    },
    "capabilities": {
      "image": true,
      "chat": false
    },
    "health": "healthy",
    "lastUpdated": 1745880000
  }
]
```

---

### Safebox/inference/models

**Stream type:** `Safebox/registry`  
**Publisher:** `Safebox`  
**Updated by:** Governance (M-of-N approved)

**Content:**

```json
{
  "llama-3.1-70b": {
    "modelId": "meta-llama/Llama-3.1-70B-Instruct",
    "type": "chat",
    "quantization": "awq-4bit",
    "maxContextLength": 32768,
    "gpuMemoryMB": 38000,
    "loadPolicy": "on-demand",
    "fallbackCloud": "gpt-4o-mini",
    "approvedBy": ["admin1", "admin2", "admin3"],
    "approvedAt": 1745880000
  },
  "llama-3.1-8b": {
    "modelId": "meta-llama/Llama-3.1-8B-Instruct",
    "type": "chat",
    "quantization": "fp16",
    "maxContextLength": 32768,
    "gpuMemoryMB": 16000,
    "loadPolicy": "on-demand",
    "fallbackCloud": "gpt-4o-mini",
    "approvedBy": ["admin1", "admin2"],
    "approvedAt": 1745880000
  },
  "sdxl": {
    "modelId": "stabilityai/stable-diffusion-xl-base-1.0",
    "type": "image",
    "gpuMemoryMB": 12000,
    "loadPolicy": "manual",
    "fallbackCloud": "dall-e-3",
    "approvedBy": ["admin1", "admin2", "admin3"],
    "approvedAt": 1745880000
  }
}
```

---

## 🔄 Registry Updater

**Background process that keeps runner registry current:**

```javascript
// In platform/plugins/Safebox/scripts/update-runner-registry.js

async function updateRunnerRegistry() {
    const registry = [];
    
    // Read configured runners from environment or config
    const runners = [
        { id: 'safebox-model-llm-1', host: 'safebox-model-llm', port: 8080 },
        { id: 'safebox-model-vision-1', host: 'safebox-model-vision', port: 8081 },
        { id: 'safebox-model-audio-1', host: 'safebox-model-audio', port: 8082 }
    ];
    
    for (const runner of runners) {
        try {
            // Poll runner's /v1/capabilities
            const response = await fetch(`http://${runner.host}:${runner.port}/v1/capabilities`);
            const capabilities = await response.json();
            
            registry.push({
                id: runner.id,
                containerId: capabilities.runnerId,
                host: runner.host,
                port: runner.port,
                runnerType: capabilities.runnerType,
                models: capabilities.models,
                resources: capabilities.resources,
                queue: capabilities.queue,
                capabilities: capabilities.capabilities,
                health: capabilities.health,
                lastUpdated: Date.now()
            });
        } catch (error) {
            console.error(`Failed to update runner ${runner.id}:`, error);
            // Mark as unhealthy but keep in registry
            registry.push({
                id: runner.id,
                host: runner.host,
                port: runner.port,
                health: 'unreachable',
                lastUpdated: Date.now()
            });
        }
    }
    
    // Update Safebox/inference/runners stream
    const stream = await Q.Streams.fetch('Safebox', 'Safebox/inference/runners');
    await stream.save({ content: JSON.stringify(registry) });
}

// Run every 5 seconds
setInterval(updateRunnerRegistry, 5000);
```

**Deploy as:**
- Node.js process managed by systemd
- Or cron job (less responsive)
- Or part of existing Safebox Node.js daemon

---

## 🎨 Usage Examples

### Example 1: Chat with Local Model

```javascript
// In app handler
const result = await Protocol.Inference.execute({
    model: 'llama-3.1-70b',
    type: 'chat',
    request: {
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Explain quantum computing' }
        ],
        max_tokens: 2048,
        temperature: 0.7
    },
    options: {
        cacheMode: 'prefix',  // Use prefix caching
        cacheTag: 'session-abc123',  // Scope to session
        tenantId: 'community-x',
        priority: 'normal',
        fallbackToCloud: true  // Fall back to OpenAI if local saturated
    }
});

console.log('Answer:', result.result.choices[0].message.content);
console.log('Cache hit:', result.telemetry.cacheHit);
console.log('Tokens reused:', result.telemetry.tokensReused);
console.log('Queue wait:', result.telemetry.queueWaitMs, 'ms');
```

### Example 2: Generate Image

```javascript
const result = await Protocol.Inference.execute({
    model: 'sdxl',
    type: 'image',
    request: {
        prompt: 'A beautiful sunset over mountains',
        steps: 20,
        cfg: 7.0,
        width: 1024,
        height: 1024
    },
    options: {
        tenantId: 'community-y',
        priority: 'high',
        queueWait: true  // Wait if runner busy
    }
});

console.log('Image URL:', result.result.images[0].url);
console.log('Queue wait:', result.telemetry.queueWaitMs, 'ms');
```

### Example 3: Transcribe Audio

```javascript
const result = await Protocol.Inference.execute({
    model: 'whisper-large-v3',
    type: 'transcription',
    request: {
        file: audioBuffer,
        language: 'en'
    },
    options: {
        tenantId: 'community-x'
    }
});

console.log('Transcript:', result.result.text);
console.log('Language:', result.result.language);
```

---

## 🔧 Integration with Existing Protocols

### Update Protocol.LLM

```javascript
// In Protocol.LLM.OpenAI
Protocol.LLM.OpenAI = async function(params) {
    // Check if should use local model
    const useLocal = params.useLocal || Q.Config.get('Q/ai/useLocal', false);
    
    if (useLocal) {
        // Map OpenAI model to local model
        const modelMapping = {
            'gpt-4o': 'llama-3.1-70b',
            'gpt-4o-mini': 'llama-3.1-8b',
            'gpt-4': 'llama-3.1-70b'
        };
        
        const localModel = modelMapping[params.model] || 'llama-3.1-8b';
        
        return await Protocol.Inference.execute({
            model: localModel,
            type: 'chat',
            request: {
                messages: params.messages,
                max_tokens: params.maxTokens,
                temperature: params.temperature
            },
            options: {
                cacheMode: 'prefix',
                tenantId: params.tenantId,
                fallbackToCloud: true  // Fall back to OpenAI if local fails
            }
        });
    }
    
    // Original cloud implementation
    return await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            max_tokens: params.maxTokens,
            temperature: params.temperature
        })
    });
};
```

---

## 🔐 Governance for Model Loading

### Extend Protocol.System

```javascript
// In Protocol.System
Protocol.System.execute = async function(claim) {
    const { action } = claim.stm;
    
    // New model lifecycle actions
    if (action === 'model-load') {
        return await this.handleModelLoad(claim);
    } else if (action === 'model-unload') {
        return await this.handleModelUnload(claim);
    } else if (action === 'cache-flush') {
        return await this.handleCacheFlush(claim);
    }
    
    // Existing actions (git, npm, etc.)
    // ...
};

Protocol.System.handleModelLoad = async function(claim) {
    // 1. Verify M-of-N signatures
    const verification = await this.verifySignatures(claim);
    if (!verification.valid) {
        throw new Error('Insufficient signatures');
    }
    
    // 2. Sign operation with Safebox key
    const verifiedOpToken = await this.signOpToken(claim);
    
    // 3. Call Infrastructure API
    const { container, modelId, quantization, maxContextLength, evictModel } = claim.stm;
    
    const result = await this.callInfrastructure({
        action: 'model-load',
        container,
        modelId,
        quantization,
        maxContextLength,
        evictModel,
        verifiedOpToken
    });
    
    // 4. Log to audit
    await this.logAudit(claim, result);
    
    return result;
};
```

---

## ✅ Implementation Checklist

**For Safebox team:**

### Core Infrastructure

- [ ] Create `Protocol.Inference` in `Protocol.js`
- [ ] Implement `findRunner()` - reads runner registry stream
- [ ] Implement `buildRunnerRequest()` - adds cache/tenant headers
- [ ] Implement `extractTelemetry()` - parses response headers
- [ ] Implement `logTelemetry()` - creates audit streams
- [ ] Implement `handleModelNotLoaded()` - auto-load or fallback logic
- [ ] Implement `handleRunnerSaturated()` - backpressure handling
- [ ] Implement `fallbackToCloud()` - cloud model mapping

### Registry Streams

- [ ] Create `Safebox/inference/runners` stream (type: `Safebox/registry`)
- [ ] Create `Safebox/inference/models` stream (type: `Safebox/registry`)
- [ ] Create `Safebox/inference/metrics` stream (cache hit rates)
- [ ] Create registry updater script: `scripts/update-runner-registry.js`
- [ ] Deploy updater as systemd service (runs every 5s)

### Governance Integration

- [ ] Extend `Protocol.System` with `model-load` action
- [ ] Extend `Protocol.System` with `model-unload` action
- [ ] Extend `Protocol.System` with `cache-flush` action
- [ ] Add `verifiedOpToken` signing in `Protocol.System`
- [ ] Add audit logging for model lifecycle actions

### Protocol Updates

- [ ] Update `Protocol.LLM.OpenAI` to support local models
- [ ] Add config flag: `Q/ai/useLocal` (default: false)
- [ ] Add model mapping (OpenAI model → local model)
- [ ] Test fallback behavior (local saturated → cloud)

### Testing

- [ ] Test model loading via governance (M-of-N)
- [ ] Test inference routing (finds correct runner)
- [ ] Test cache hit telemetry
- [ ] Test backpressure (503 from runner → fallback)
- [ ] Test per-tenant rate limiting
- [ ] Test registry updater (polls runners every 5s)

---

## 📊 Summary

**What Safebox implements:**

| Component | Lines of Code | Purpose |
|-----------|---------------|---------|
| `Protocol.Inference` | ~300 | Request routing, capacity checking, telemetry |
| Registry updater | ~100 | Poll runner capabilities, update stream |
| `Protocol.System` extensions | ~50 | Model lifecycle governance |
| Stream schemas | ~0 | JSON data structures |
| Tests | ~200 | Integration tests |

**Total:** ~650 lines of Node.js + tests

**What you get:**
- Local model inference with automatic routing
- KV cache telemetry (hit rate, tokens reused)
- Per-tenant queueing and rate limiting
- Governed model loading (M-of-N)
- Automatic fallback to cloud when saturated
- Complete audit trail

🎉 **Production-ready local inference with governance!**
