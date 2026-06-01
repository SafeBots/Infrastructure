# How to Call Infrastructure Model Runners v1.0

**For Safebox Team: Complete integration guide**

---

## 🎯 What Infrastructure Provides

We've implemented the **Local Service Container v1.0 spec** with Unix domain sockets. Here's what you can call:

### **Available Runners**

| Runner | Socket Path | Task | Model |
|--------|------------|------|-------|
| **safebox-model-llm** | `/run/safebox/services/model-llm-1.sock` | Chat, completion | LLaMA 3.1, Mistral |
| **safebox-model-vision** | `/run/safebox/services/model-vision-1.sock` | Image generation | Stable Diffusion XL |
| **safebox-model-audio** | `/run/safebox/services/model-audio-1.sock` | Transcription | Whisper Large v3 |

---

## 📞 How Safebox Calls Runners

### **Architecture: Shared Unix Socket Volume**

```
┌─────────────────────────────────────────────┐
│     Safebox App Container (Node.js/PHP)    │
│                                             │
│  /run/safebox/services/                    │
│  ├── model-llm-1.sock      ←─────┐         │
│  ├── model-vision-1.sock   ←─────┼─┐       │
│  └── model-audio-1.sock    ←─────┼─┼─┐     │
└─────────────────────────────────┬─┴─┴─┴─────┘
                                  │ │ │
                    Shared volume │ │ │
                    safebox-sockets │ │
                                  │ │ │
┌─────────────────────────────────┴─┴─┴─────┐
│  Model Runner Containers                  │
│                                            │
│  safebox-model-llm creates:               │
│  /run/safebox/services/model-llm-1.sock   │
│                                            │
│  safebox-model-vision creates:            │
│  /run/safebox/services/model-vision-1.sock│
│                                            │
│  safebox-model-audio creates:             │
│  /run/safebox/services/model-audio-1.sock │
└────────────────────────────────────────────┘
```

**Key point:** All containers mount the same volume at `/run/safebox/services`. Runners create sockets, Safebox connects to them.

---

## 🔧 Implementation in Safebox

### **1. Discovery: Read Transport from Capabilities**

**When registry updater polls runners:**

```javascript
// In Safebox registry updater (runs every 5s)

async function updateRunnerRegistry() {
    const runners = [
        { serviceId: 'model-llm-1', socketPath: '/run/safebox/services/model-llm-1.sock' },
        { serviceId: 'model-vision-1', socketPath: '/run/safebox/services/model-vision-1.sock' },
        { serviceId: 'model-audio-1', socketPath: '/run/safebox/services/model-audio-1.sock' }
    ];
    
    const registry = [];
    
    for (const runner of runners) {
        try {
            // Call capabilities endpoint via Unix socket
            const response = await fetch('http://localhost/v1/capabilities', {
                socketPath: runner.socketPath  // Node.js fetch with socketPath
            });
            
            const caps = await response.json();
            
            // Store in registry
            registry.push({
                id: caps.runnerId,
                serviceId: caps.serviceId,
                transport: caps.transport,  // { socket: { path: "..." }, tcp: { ... } }
                models: caps.models,
                resources: caps.resources,
                queue: caps.queue,
                health: caps.health
            });
        } catch (error) {
            console.error(`Failed to poll ${runner.serviceId}:`, error);
            // Mark as unhealthy but keep in registry
            registry.push({
                serviceId: runner.serviceId,
                health: 'unreachable',
                transport: { socket: { path: runner.socketPath } }
            });
        }
    }
    
    // Update Safebox/inference/runners stream
    await Q.Streams.fetch('Safebox', 'Safebox/inference/runners')
        .save({ content: JSON.stringify(registry) });
}

// Run every 5 seconds
setInterval(updateRunnerRegistry, 5000);
```

**Capabilities response you'll get:**

```json
{
  "version": "1.0",
  "runnerId": "safebox-model-llm-1",
  "serviceId": "model-llm-1",
  "transport": {
    "socket": {
      "path": "/run/safebox/services/model-llm-1.sock",
      "permissions": "0660",
      "group": "safebox-services"
    }
  },
  "models": {
    "loaded": ["meta-llama/Llama-3.1-8B-Instruct"],
    "loading": [],
    "available": []
  },
  "resources": {
    "gpuMemoryFreeMB": 23920,
    "kvCacheSizeMB": 12000
  },
  "queue": {
    "depth": 3,
    "maxDepth": 16
  },
  "health": "healthy"
}
```

### **2. Routing: Protocol.Inference Calls Runner**

**In `Protocol.Inference.execute()`:**

```javascript
// In platform/plugins/Q/handlers/Q/Protocol.js

Protocol.Inference = {
    async execute(params) {
        const { model, type, request, options = {} } = params;
        
        // 1. Find runner with this model loaded
        const runner = await this.findRunner(model, type);
        
        if (!runner) {
            return await this.handleModelNotLoaded(model, type, request, options);
        }
        
        // 2. Check capacity (optional pre-flight)
        if (runner.queue.depth >= runner.queue.maxDepth) {
            return await this.handleRunnerSaturated(model, runner, request, options);
        }
        
        // 3. Call runner via Unix socket
        const endpoint = this.getEndpoint(type); // '/v1/chat/completions'
        const socketPath = runner.transport.socket.path;
        
        const response = await fetch(`http://localhost${endpoint}`, {
            socketPath,  // THIS IS THE KEY - Unix socket instead of TCP
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Cache-Mode': options.cacheMode || 'prefix',
                'X-Cache-Tag': options.cacheTag || '',
                'X-Tenant-ID': options.tenantId || 'default',
                'X-Priority': options.priority || 'normal'
            },
            body: JSON.stringify(request)
        });
        
        const result = await response.json();
        
        // 4. Extract telemetry from response headers
        const telemetry = {
            cacheHit: response.headers.get('X-Cache-Hit') === 'true',
            tokensReused: parseInt(response.headers.get('X-Cache-Tokens-Reused') || '0'),
            queueWaitMs: parseInt(response.headers.get('X-Queue-Wait-Ms') || '0'),
            gpuTimeMs: parseInt(response.headers.get('X-GPU-Time-Ms') || '0')
        };
        
        // 5. Log telemetry
        await this.logTelemetry(model, runner, telemetry, options.tenantId);
        
        return { result, telemetry, runner: runner.id };
    },
    
    async findRunner(model, type) {
        // Read from Safebox/inference/runners stream
        const registry = await Q.Streams.fetch('Safebox', 'Safebox/inference/runners');
        const runners = JSON.parse(registry.content);
        
        // Find runner with this model loaded
        for (const runner of runners) {
            if (runner.models.loaded.includes(model) && runner.health === 'healthy') {
                return runner;
            }
        }
        
        return null;
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

## 💬 Example: Chat with Local Model

```javascript
// User asks a question
const result = await Protocol.Inference.execute({
    model: 'meta-llama/Llama-3.1-8B-Instruct',
    type: 'chat',
    request: {
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Explain quantum computing in simple terms' }
        ],
        max_tokens: 2048,
        temperature: 0.7
    },
    options: {
        cacheMode: 'prefix',  // Use KV cache
        cacheTag: 'session-abc123',
        tenantId: 'community-x',
        priority: 'normal'
    }
});

// What you get back:
console.log('Answer:', result.result.choices[0].message.content);
console.log('Cache hit:', result.telemetry.cacheHit);  // true
console.log('Tokens reused:', result.telemetry.tokensReused);  // 45
console.log('Queue wait:', result.telemetry.queueWaitMs, 'ms');  // 150
console.log('GPU time:', result.telemetry.gpuTimeMs, 'ms');  // 450
```

**What happens under the hood:**

1. `Protocol.Inference.findRunner()` reads registry → finds `model-llm-1` has this model loaded
2. Builds request with headers: `X-Cache-Mode: prefix`, `X-Tenant-ID: community-x`
3. Calls `fetch('http://localhost/v1/chat/completions', { socketPath: '/run/safebox/services/model-llm-1.sock', ... })`
4. Runner processes request, checks KV cache, returns response
5. Response includes headers: `X-Cache-Hit: true`, `X-Cache-Tokens-Reused: 45`
6. Protocol.Inference logs telemetry to `Safebox/inference/request` stream
7. Returns result + telemetry to caller

---

## 🖼️ Example: Generate Image

```javascript
const result = await Protocol.Inference.execute({
    model: 'stable-diffusion-xl-base-1.0',
    type: 'image',
    request: {
        prompt: 'A serene mountain landscape at sunset',
        steps: 20,
        cfg: 7.0,
        width: 1024,
        height: 1024
    },
    options: {
        tenantId: 'community-y',
        priority: 'high'
    }
});

console.log('Image URL:', result.result.images[0].url);
```

**Socket path:** `/run/safebox/services/model-vision-1.sock`

---

## 🎤 Example: Transcribe Audio

```javascript
const result = await Protocol.Inference.execute({
    model: 'whisper-large-v3',
    type: 'transcription',
    request: {
        file: audioBuffer,  // Base64 or file path
        language: 'en'
    },
    options: {
        tenantId: 'community-x'
    }
});

console.log('Transcript:', result.result.text);
console.log('Language:', result.result.language);
```

**Socket path:** `/run/safebox/services/model-audio-1.sock`

---

## 🔄 Fallback Behavior

### **When Runner Not Available**

```javascript
async handleModelNotLoaded(model, type, request, options) {
    // Check if model approved for auto-loading
    const modelRegistry = await Q.Streams.fetch('Safebox', 'Safebox/inference/models');
    const models = JSON.parse(modelRegistry.content);
    const modelSpec = models[model];
    
    if (modelSpec.loadPolicy === 'fallback-cloud') {
        // Fall back to cloud model
        const cloudModel = {
            'meta-llama/Llama-3.1-8B-Instruct': 'gpt-4o-mini',
            'stable-diffusion-xl-base-1.0': 'dall-e-3'
        }[model] || 'gpt-4o-mini';
        
        if (type === 'chat') {
            return await Protocol.LLM.OpenAI({
                model: cloudModel,
                messages: request.messages,
                ...request
            });
        }
    }
    
    throw new Error(`Model ${model} not loaded and no fallback configured`);
}
```

### **When Runner Saturated (503)**

```javascript
async handleRunnerSaturated(model, runner, request, options) {
    if (options.fallbackToCloud) {
        // Fallback to cloud
        return await this.fallbackToCloud(model, type, request);
    }
    
    if (options.queueWait) {
        // Wait and retry
        await new Promise(resolve => setTimeout(resolve, 5000));
        return await this.execute({ model, type, request, options });
    }
    
    // Fail fast
    throw new Error(`Runner ${runner.id} saturated (queue ${runner.queue.depth}/${runner.queue.maxDepth})`);
}
```

---

## 🔐 Security: How It Works

### **Unix Socket Permissions**

**Infrastructure sets this up automatically:**

```bash
# In runner container, setup_unix_socket() does:
chmod 0660 /run/safebox/services/model-llm-1.sock
chown safebox-services:safebox-services /run/safebox/services/model-llm-1.sock

# Result:
-rw-rw---- 1 safebox-services safebox-services model-llm-1.sock
```

**Your container must run as a user in `safebox-services` group:**

```yaml
safebox-app-safebox:
  user: "1000:1000"  # UID 1000, member of safebox-services (GID 1000)
  volumes:
    - safebox-sockets:/run/safebox/services
```

**Access control:**
- Only `safebox-services` group can read/write
- Other containers can't access the sockets
- No network exposure possible (it's a filesystem object)

---

## 📊 Registry Stream Schema

### **Safebox/inference/runners**

**Updated every 5 seconds by registry updater:**

```json
[
  {
    "id": "safebox-model-llm-1",
    "serviceId": "model-llm-1",
    "transport": {
      "socket": {
        "path": "/run/safebox/services/model-llm-1.sock",
        "permissions": "0660",
        "group": "safebox-services"
      }
    },
    "models": {
      "loaded": ["meta-llama/Llama-3.1-8B-Instruct"],
      "loading": [],
      "available": []
    },
    "resources": {
      "gpuMemoryFreeMB": 23920,
      "kvCacheSizeMB": 12000,
      "gpuUtilization": 0.47
    },
    "queue": {
      "depth": 3,
      "maxDepth": 16,
      "avgWaitMs": 150
    },
    "health": "healthy",
    "lastUpdated": 1745880000
  },
  {
    "id": "safebox-model-vision-1",
    "serviceId": "model-vision-1",
    "transport": {
      "socket": {
        "path": "/run/safebox/services/model-vision-1.sock"
      }
    },
    "models": {
      "loaded": ["stable-diffusion-xl-base-1.0"]
    },
    "health": "healthy",
    "lastUpdated": 1745880000
  }
]
```

### **Safebox/inference/models**

**Governed by M-of-N, updated rarely:**

```json
{
  "meta-llama/Llama-3.1-8B-Instruct": {
    "type": "chat",
    "gpuMemoryMB": 16000,
    "loadPolicy": "on-demand",
    "fallbackCloud": "gpt-4o-mini",
    "approvedBy": ["admin1", "admin2"],
    "approvedAt": 1745880000
  },
  "stable-diffusion-xl-base-1.0": {
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

## ✅ Implementation Checklist

**For Safebox team:**

### Core Implementation

- [ ] Create `Protocol.Inference` in `Protocol.js` (~300 lines)
- [ ] Implement `findRunner()` - reads registry stream
- [ ] Implement `execute()` - calls runner via Unix socket
- [ ] Add `socketPath` parameter to fetch calls
- [ ] Implement `handleModelNotLoaded()` - auto-load or fallback
- [ ] Implement `handleRunnerSaturated()` - 503 handling
- [ ] Implement `logTelemetry()` - creates audit streams

### Registry Management

- [ ] Create `Safebox/inference/runners` stream
- [ ] Create `Safebox/inference/models` stream
- [ ] Create registry updater script (runs every 5s)
- [ ] Deploy updater as systemd service or cron

### Testing

- [ ] Test chat with local LLaMA model
- [ ] Test image generation with SDXL
- [ ] Test audio transcription with Whisper
- [ ] Test cache hit telemetry
- [ ] Test fallback to cloud when runner saturated
- [ ] Test model auto-loading (if enabled)

**Estimated effort:** 2-3 days (~400 lines total + tests)

---

## 🎉 Summary

**What you call:**

| Endpoint | Socket Path | Purpose |
|----------|------------|---------|
| `GET /v1/capabilities` | `/run/safebox/services/<service-id>.sock` | Discovery |
| `GET /v1/capacity` | Same | Quick capacity check |
| `POST /v1/chat/completions` | Same | Chat/completion |
| `POST /v1/images/generations` | Same | Image generation |
| `POST /v1/audio/transcriptions` | Same | Audio transcription |

**How you call it:**

```javascript
const response = await fetch('http://localhost/v1/chat/completions', {
    socketPath: '/run/safebox/services/model-llm-1.sock',  // Unix socket
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Cache-Mode': 'prefix',
        'X-Tenant-ID': 'community-x'
    },
    body: JSON.stringify({ messages: [...] })
});
```

**What you get back:**

- Response body: `{ choices: [{ message: { content: "..." } }] }`
- Response headers: `X-Cache-Hit: true`, `X-Cache-Tokens-Reused: 45`, `X-Queue-Wait-Ms: 150`

**Security:**
- ✅ Unix sockets = filesystem objects (can't be network-exposed)
- ✅ Permissions: `0660`, `safebox-services` group only
- ✅ Your container runs as member of this group

**Fully compatible with your existing Protocol.LLM/AI architecture** - just route local models through Protocol.Inference instead of Protocol.LLM.OpenAI!

🚀 **Ready to integrate!**
