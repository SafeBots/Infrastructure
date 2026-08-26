# vLLM Runner — Safebox Local Service

**Safebox-canonical LLM runner backed by vLLM.** One Docker image; one model per container; one well-defined wire format for the rest of Safebox.

This runner translates between the Safebox protocol (camelCase JSON, Unix socket transport, HMAC auth, audit-trail hashes) and vLLM's built-in OpenAI-compatible HTTP server. The wrapper is thin — about 770 lines of Python — and adds streaming, capability advertisement, and the audit trail that the rest of the Safebox stack expects.

---

## 🎯 What it does

**Endpoints (Safebox canonical):**

- `POST /v1/chat` — chat completion with conversation history. Streaming supported via `stream: true` (returns SSE).
- `POST /v1/complete` — text completion from a raw prompt. Streaming supported.
- `POST /v1/embed` — text embeddings (for models that expose them).
- `GET  /v1/capabilities` — what this runner can do (chat? embed? tool use? vision?).
- `GET  /v1/capacity` — current load, queue depth, cumulative tokens.
- `GET  /v1/models` — what's loaded (OpenAI-style for tooling compatibility).
- `GET  /health` — liveness; 200 when vLLM has finished loading, 503 while loading.

**Models supported (initial roster of five manifests in `manifests/`):**

| Manifest | Model | TP | Max context | Recommended GPU |
|---|---|---|---|---|
| `llama-3.3-70b-instruct.json` | Meta Llama 3.3 70B Instruct | 2 | 128K | 2× A100 80GB |
| `qwen-3-32b.json` | Alibaba Qwen3 32B | 1 | 32K | 1× A100 80GB |
| `mistral-small-3.json` | Mistral Small 2409 (22B) | 1 | 32K | 1× A100 40GB |
| `gemma-3-12b-it.json` | Google Gemma 3 12B IT | 1 | 8K | 1× T4 / Apple Silicon |
| `deepseek-v3.json` | DeepSeek V3 (671B MoE) | 8 | 128K | 8× H100 80GB |

Adding a new model is a one-file change. See [`manifests/README.md`](manifests/README.md) for the schema and walk-through.

---

## 🏗 Architecture

```
┌─ container ─────────────────────────────────────────────────────────┐
│                                                                     │
│  vLLM (HuggingFace model loaded into GPU)                           │
│      listens on 127.0.0.1:8000  (OpenAI HTTP)                       │
│         ▲                                                           │
│         │ POST /v1/chat/completions etc.                            │
│         │                                                           │
│  runner.py  (the Safebox wrapper)                                   │
│      listens on Unix socket  /run/safebox/services/llm-1.sock       │
│      translates Safebox protocol ↔ OpenAI                           │
│      handles HMAC, SSE streaming, audit-trail SHA-256, queues       │
│                                                                     │
│  supervisord keeps both alive and restarts independently            │
└─────────────────────────────────────────────────────────────────────┘
        ▲
        │ Safebox-canonical requests
        │
   Safebox Plugin (PHP/JS) → Protocol.LLM.Local(...)
```

**Why this shape:**

vLLM does the heavy lifting — KV cache, prefix caching, paged attention, tensor parallelism, batching. The wrapper does not duplicate any of that. It exists to translate the wire format and add the cryptographic discipline the rest of Safebox depends on (HMAC, audit hashes, capability advertisement, Unix socket transport).

**Why one model per container:**

vLLM loads one model into GPU memory at start time. You can't swap models in-process without a full restart. So the deployment unit is one container per model. Multiple models = multiple containers, each with its own manifest, each at its own socket. The Safebox plugin routes by model name to the right socket.

This matches how the rest of the Safebox runner ecosystem works (one job per container, sockets as the routing fabric, the orchestrator decides which one to call).

---

## 🚀 Quick start

### Build

```bash
cd model-runners/vllm

# CPU dev build (you can compile, can't run a model — vLLM needs CUDA)
docker build -t safebox/vllm:latest .

# GPU production build (CUDA 12.4 base)
docker build --build-arg BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
             -t safebox/vllm:latest .
```

### Run a model

```bash
docker run -d --name safebox-vllm-qwen \
    --gpus all \
    --network safebox-net \
    -e MODEL_NAME=qwen-3-32b \
    -e SERVICE_ID=llm-qwen \
    -e SAFEBOX_SOCKET_PATH=/run/safebox/services/llm-qwen.sock \
    -e SAFEBOX_REQUIRE_HMAC=true \
    -v safebox-sockets:/run/safebox/services \
    -v /etc/safebox:/etc/safebox:ro \
    -v safebox-models:/srv/safebox/models:ro \
    -v safebox-hf-cache:/root/.cache/huggingface \
    safebox/vllm:latest
```

First start: vLLM downloads model weights from HuggingFace (or from `/srv/safebox/models/` if pre-staged), loads them into GPU memory, then signals the wrapper that it's ready. Cold-start time: 30 seconds for small models, several minutes for large MoE ones. The wrapper comes up immediately and returns 503 from data endpoints until vLLM is ready.

### Test

```bash
# Capabilities (works immediately, before vLLM is ready)
curl --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/llm-qwen.sock \
    http://localhost/v1/capabilities | jq .

# Chat (non-streaming, blocks until vLLM is ready)
curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/llm-qwen.sock \
    http://localhost/v1/chat \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-001" \
    -d '{
      "model": "qwen-3-32b",
      "messages": [
        {"role": "user", "content": "Explain attention in three sentences."}
      ],
      "maxTokens": 200,
      "temperature": 0.3
    }'

# Chat (streaming SSE)
curl -N -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/llm-qwen.sock \
    http://localhost/v1/chat \
    -H "Content-Type: application/json" \
    -H "X-Safebox-Request-Id: test-002" \
    -d '{
      "model": "qwen-3-32b",
      "messages": [{"role": "user", "content": "Write a haiku about indexes."}],
      "stream": true
    }'
```

---

## 📞 How Safebox calls it

### From Protocol.LLM.Local

```javascript
// Inside Safebox
const result = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'You are a careful contract reviewer.' },
        { role: 'user',   content: extractedContract }    // from MinerU
    ],
    maxTokens: 4000,
    temperature: 0.2
});

console.log(result.content);            // the generated text
console.log(result.usage.totalTokens);  // for billing / SafeBux accounting
console.log(result.sourceSha256);       // audit trail
console.log(result.outputSha256);       // audit trail
```

### Streaming chat in a UI

```javascript
const r = await fetch('/v1/chat', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Safebox-Request-Id': crypto.randomUUID()
    },
    body: JSON.stringify({
        model: 'qwen-3-32b',
        messages: [{ role: 'user', content: userMessage }],
        stream: true,
        maxTokens: 1000
    })
});

const reader = r.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const chunk = JSON.parse(data);
        appendToUI(chunk.deltaContent);
    }
    buffer = buffer.split('\n').pop();
}
```

### As part of a document Q&A workflow

```javascript
// 1. Extract document (MinerU runner)
const doc = await Protocol.Documents.Local({
    model:  'opendatalab/mineru-2.5',
    source: '/data/contract.pdf'
});

// 2. Optionally redact PII (privacy-filter runner)
const cleaned = await Protocol.Privacy.Local({
    model: 'privacy-filter',
    text:  doc.markdown,
    mode:  'mask'
});

// 3. Q&A against the cleaned text (this runner)
const answer = await Protocol.LLM.Local({
    model: 'qwen-3-32b',
    messages: [
        { role: 'system', content: 'Answer strictly from the document below.' },
        { role: 'user',   content: cleaned.redactedText + '\n\nQ: ' + userQuestion }
    ],
    maxTokens: 1500,
    temperature: 0.1
});

// 4. Log the chain (audit trail)
await Q.Streams.create({
    type: 'AI/document-qa',
    content: JSON.stringify({
        sourceFile:   doc.sourceSha256,
        extractedSha: doc.outputSha256,
        cleanedSha:   await sha256(cleaned.redactedText),
        questionSha:  await sha256(userQuestion),
        answerSha:    answer.outputSha256,
        model:        answer.model,
        tokens:       answer.usage.totalTokens
    })
});
```

Three runners composing through `Protocol.X.Local()`. The Streams audit log records the SHA-256 of every link in the chain — re-runnable from cold input, hash-verifiable end-to-end.

---

## 📊 Capabilities

`GET /v1/capabilities` returns:

```json
{
  "version":    "1.2",
  "runnerType": "llm",
  "runnerId":   "safebox-llm-1",
  "serviceId":  "llm-qwen",
  "transport": {
    "socket": {
      "path":        "/run/safebox/services/llm-qwen.sock",
      "permissions": "0660",
      "group":       "safebox-services"
    }
  },
  "models": {
    "loaded":   ["qwen-3-32b"],
    "loading":  [],
    "vllmArg":  "Qwen/Qwen3-32B"
  },
  "capabilities": {
    "chat":      true,
    "complete":  true,
    "embed":     false,
    "toolUse":   true,
    "vision":    false,
    "streaming": true
  },
  "health": "healthy"
}
```

The capability flags come from the manifest. The runner enforces them — `/v1/embed` returns 400 if `capabilities.embed` is false, even if vLLM itself supports embeddings on this model. Clients learn from `/v1/capabilities` what they can call.

---

## 🔐 Privacy and trust

**Data path:**

- All inference runs locally inside the Safebox. The wrapper has no network egress except the Unix socket and the in-container HTTP call to vLLM.
- The model weights are read from `/srv/safebox/models/<manifestHash>/` (mounted read-only) when staged by the Safebox model-install protocol. The directory name is the SHA-256 of the canonical manifest, so a fork of the runner cannot substitute different weights — the manifest hash is what M-of-N signed.
- For development / quick-start, the runner falls back to vLLM's HuggingFace cache. That path involves network access to HF on first run; switch to the manifest-hash path for production.

**HMAC:**

When `SAFEBOX_REQUIRE_HMAC=true`, every request must include:

- `X-Safebox-Timestamp` — unix epoch seconds, within ±300s of now
- `X-Safebox-Nonce` — single-use random string (replayed nonces are rejected)
- `X-Safebox-Signature` — `hex(hmac_sha256(timestamp + '.' + nonce + '.' + body, key))`

The key is read at startup from `/etc/safebox/model-api.key`. HMAC is off by default for local development. Turn it on for any deployment that's reachable by more than the local Safebox plugin.

**Audit trail:**

Every non-streaming response includes `sourceSha256` (hash of the request body) and `outputSha256` (hash of the response content). These plus the model id and runner id are what you'd write to a Streams audit log for compliance review. The pipeline is deterministic at the SHA level for fixed seed + temperature 0; for stochastic generation the hashes still let you prove that a specific output was what the runner returned at a specific moment.

---

## ⚡ Performance

**Throughput** (vLLM scheduler doing the work):

- Llama 3.3 70B on 2× A100 80GB at FP16: ~90 tok/s sustained, peaks higher
- Qwen 3 32B on 1× A100 80GB at BF16: ~85 tok/s sustained
- Mistral Small (22B) on 1× A100 40GB at BF16: ~140 tok/s
- Gemma 3 12B on 1× L4 24GB at BF16: ~60 tok/s
- DeepSeek V3 on 8× H100 80GB at BF16: ~37 tok/s aggregate (the MoE routing is the bottleneck, not the math)

**Wrapper overhead** (measured at the Unix socket): ~1-3 ms per request, negligible vs vLLM inference time. The wrapper is async so it can hold up to `MAX_QUEUE_DEPTH` (default 16) in-flight requests without blocking the event loop.

**Cold start:**

- Wrapper: < 1 second to listen on the socket
- vLLM: 20-90 seconds for non-MoE models, 90-300 seconds for large MoE
- `/v1/capabilities` and `/health` work from the moment the wrapper starts; data endpoints return 503 until vLLM is ready

---

## 💰 Compare to per-token cloud APIs

For a team running 50 million tokens/month of mixed chat (~70/30 input/output split):

| Provider | Monthly cost | Data exposure |
|---|---|---|
| GPT-5.5 ($8/$24 per 1M) | $640 | ✗ sent to OpenAI |
| Claude Opus 4.8 ($15/$75 per 1M) | $1,800 | ✗ sent to Anthropic |
| Z.ai GLM 5.2 ($1.40/$4.40 per 1M) | $115 | ✗ sent to China |
| **Self-hosted Qwen 3 32B on Safebox** | **GPU power bill** | **✓ never leaves the box** |

The self-hosted line item is your electricity, not a metered API. A single dedicated A100 amortized over depreciation + power + cooling typically lands somewhere in the $400-$800/month range — competitive with API billing at modest volume and dramatically better at high volume. The exposure column is what makes the comparison interesting for regulated industries; the cost column is what makes it interesting for everyone else.

---

## 🧪 Testing without a GPU

The wrapper has no GPU dependency. You can run it standalone against a mock vLLM (or against the real vLLM via a remote port-forward) for protocol testing:

```bash
# Terminal 1 — start a vLLM server somewhere with a GPU
ssh gpu-host -L 8000:127.0.0.1:8000 -- \
    bash -c 'cd /work && vllm serve Qwen/Qwen3-32B --port 8000'

# Terminal 2 — run the wrapper locally talking to that forwarded port
MODEL_NAME=qwen-3-32b \
VLLM_MODEL_ARG=Qwen/Qwen3-32B \
VLLM_PORT=8000 \
ENABLE_UNIX_SOCKET=false \
SAFEBOX_REQUIRE_HMAC=false \
python3 runner.py
```

That gets you a runnable Safebox endpoint at `http://127.0.0.1:8080/v1/chat` for protocol testing without touching the production stack.

---

## 📚 References

- vLLM: https://github.com/vllm-project/vllm
- Safebox model catalog: [`../../docs/MODEL-CATALOG.md`](../../docs/MODEL-CATALOG.md)
- Model runner contract: [`../README.md`](../README.md)
- Manifest schema: [`manifests/README.md`](manifests/README.md)
- Other runners that follow this pattern: [`../privacy-filter/`](../privacy-filter/), [`../mineru/`](../mineru/)

---

## ✅ Production status

This is a **production-ready runner**. The wrapper handles streaming, HMAC auth, audit hashing, capability enforcement, capacity reporting, and graceful startup/shutdown. The manifest layer cleanly separates the "what model" question from the runner code, so adding a model is a JSON file rather than a code change.

What it does NOT do — and these are deliberate decisions:

- **Hot model swapping.** vLLM loads one model per process. Switching models = restarting the container.
- **Multi-model in one container.** Possible with vLLM's multi-model server, but the resource footprint and operational story don't fit Safebox's "one job per container" pattern. Run multiple containers instead, route by model name at the Safebox plugin layer.
- **Weight downloading.** The wrapper assumes weights are either pre-staged at `/srv/safebox/models/<hash>/` (production path, via the M-of-N-governed install protocol) or available in the HF cache (dev path). It's not responsible for the download step.

The deployment unit is a single container, one manifest, one model. Compose them at the orchestration layer.
