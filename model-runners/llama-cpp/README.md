# llama.cpp Runner

**For edge and laptop-class Safebox deployments. Explicit KV-cache slot
management. CPU + GPU offload via CUDA, Metal, Vulkan, or ROCm. GGUF
quantization formats.**

This runner wraps the upstream [`llama-server`][llama-server] binary
shipped with [llama.cpp][llama-cpp] and exposes the same Safebox
canonical endpoints (`/v1/chat`, `/v1/complete`, `/v1/embed`) plus the
lifecycle endpoints (`/v1/models/load`, `/v1/models/unload`,
`/v1/cache/flush`) that `docker/system-protocol-api.js` calls into.

[llama-server]: https://github.com/ggerganov/llama.cpp/tree/master/tools/server
[llama-cpp]:    https://github.com/ggerganov/llama.cpp

## When to use this runner instead of vllm/

| | `llama-cpp/` | `vllm/` |
|---|---|---|
| **Hardware** | CPU + optional GPU offload (CUDA, Metal, Vulkan, ROCm) | NVIDIA GPU required |
| **Quant formats** | GGUF (4/5/6/8-bit, K-quants, IQ-quants) | safetensors (FP16/BF16/INT8) |
| **Memory** | A 12B model in Q4_K_M fits in ~7 GB; Q5_K_M in ~9 GB; Q8_0 in ~13 GB | A 12B model in FP16 needs ~24 GB |
| **KV cache** | Explicit slot management. Save/restore slots by ID. Persistable. | PagedAttention. Internal; no per-slot pinning. |
| **Best for** | Laptops, single-GPU consumer hardware, edge deployments, the Gemma 4 12B / 16 GB unified-memory story | A100/H100-class server-grade GPU production |
| **Concurrency model** | `--parallel N` and `--slots N`: one slot per concurrent conversation | Continuous batching across all requests |
| **Throughput vs latency** | Lower throughput, lower per-request latency at low concurrency | Higher throughput, batching adds latency |

Both runners speak the same Safebox wire protocol. Pick the one that
matches your hardware tier.

## KV cache: the slot model

llama.cpp's distinguishing feature for agentic workloads is its
explicit slot system. You configure a slot count at startup
(`--parallel N`, `--slots N`), and each slot can hold one
conversation's KV cache. The Safebots LLM wrapper
(`platform/plugins/Safebots/classes/Safebots/LLM.js`) was designed
around exactly this: allocate a slot, pin it to a bot's stable prefix
(system prompt + tool definitions), then send only the per-turn delta
on subsequent requests. The slot is held warm; the next call reuses
its KV cache wholesale.

This runner exposes the following endpoints for slot management on
top of the standard inference paths. They map onto llama-server's own
slot endpoints with Safebox conventions (X-Safebox-Request-Id, etc).

| Endpoint | Maps to llama-server | Purpose |
|---|---|---|
| `GET /v1/cache/slots` | `GET /slots` | List active slots and their states |
| `POST /v1/cache/slots/allocate` | (synthesized) | Reserve a slot for a stable prefix |
| `POST /v1/cache/slots/save` | `POST /slots/{id}?action=save` | Persist a slot's KV state to disk |
| `POST /v1/cache/slots/restore` | `POST /slots/{id}?action=restore` | Reload a saved slot from disk |
| `POST /v1/cache/slots/release` | (synthesized) | Free a slot |
| `POST /v1/cache/flush` | (synthesized) | Drop all slots' KV state |

Saved slot state lives at
`/var/lib/safebox-llama-cpp/slots/<runnerId>/<slotId>.bin` and
survives `llama-server` restarts. Useful when a long-lived agent
needs to outlive a container's lifetime.

## Build variants

The Dockerfile builds llama.cpp from source against the toolchain it
finds, controlled by the `LLAMA_BUILD` build arg:

| `LLAMA_BUILD` | Backend | Image base | Use for |
|---|---|---|---|
| `cpu` (default) | OpenBLAS | `python:3.12-slim` | CPU-only deployment, broad compatibility |
| `cuda` | CUDA 12.4 | `nvidia/cuda:12.4.1-devel-ubuntu22.04` | NVIDIA GPUs |
| `metal` | Metal | `python:3.12-slim` (Apple Silicon host needed) | macOS / Apple Silicon |
| `vulkan` | Vulkan | `python:3.12-slim` + Vulkan SDK | AMD / Intel / heterogeneous GPUs |
| `rocm` | ROCm 6.x | `rocm/dev-ubuntu-22.04:6.0` | AMD Instinct |

The same `runner.py` adapter works against every variant. Build with:

```bash
docker build \
  --build-arg LLAMA_BUILD=cuda \
  -t safebox/llama-cpp:cuda \
  model-runners/llama-cpp/
```

## Model installation

Like every Safebox runner, this one **does not fetch its own
weights**. The `opsModels.js` install path (see
`aws/scripts/components/system/opsModels.js`) downloads GGUF files
from the manifest's `sources` list, verifies SHA-256 against the
manifest, and stores the result at
`/srv/safebox/models/<manifestHash>/`. This runner mounts that
directory read-only and points `llama-server --model` at the GGUF
file inside.

Sample manifest fragment for Gemma 4 12B Q4_K_M:

```json
{
  "name":           "gemma-4-12b-it-Q4_K_M",
  "version":        "1.0.0",
  "license":        "Apache-2.0",
  "runnerType":     "llama-cpp",
  "totalSizeBytes": 7242800000,
  "files": [
    {
      "path":      "model.gguf",
      "sizeBytes": 7242800000,
      "sha256":    "TODO-fill-from-huggingface",
      "sources":   [
        "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf",
        "https://safebots-models.s3.amazonaws.com/gemma-4-12b-it/Q4_K_M/model.gguf"
      ]
    }
  ],
  "metadata": {
    "quantization": "Q4_K_M",
    "contextLength": 262144,
    "recommendedSlots": 4
  }
}
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `RUNNER_ID` | `safebox-model-llm-llamacpp-1` | Runner identifier in audit logs |
| `SERVICE_ID` | `model-llm-llamacpp-1` | Service identifier for the unix socket path |
| `LLAMA_MODEL_PATH` | `/srv/safebox/models/<hash>/model.gguf` | GGUF file to load (set by system component on start) |
| `LLAMA_N_GPU_LAYERS` | `999` | Layers to offload to GPU. `999` = all; `0` = pure CPU |
| `LLAMA_CTX_SIZE` | `8192` | Per-slot context window |
| `LLAMA_PARALLEL` | `4` | Number of concurrent slots |
| `LLAMA_THREADS` | `<num cores>` | CPU threads when running on CPU layers |
| `LLAMA_FLASH_ATTN` | `1` | Use FlashAttention if the backend supports it |
| `SAFEBOX_SOCKET_PATH` | `/run/safebox/services/${SERVICE_ID}.sock` | Where the system component reaches this runner |

## Status

Skeleton. The lifecycle endpoints conform to the
`docker/system-protocol-api.js` contract. The inference adapter
methods (`/v1/chat`, `/v1/complete`, `/v1/embed`) forward to
`llama-server`'s OpenAI-compatible API. Slot management endpoints
proxy to llama-server's `/slots`. Production hardening — slot
allocation policy, per-slot tenant scoping, observability metrics,
graceful slot eviction under memory pressure — is the next phase of
work.
