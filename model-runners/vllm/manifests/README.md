# Model Manifests

A manifest is a single JSON file that fully describes how the vLLM Safebox runner should load and serve one model. The file lives at `manifests/<canonical-name>.json` here (development) and at `/etc/safebox/runners/vllm/manifests/<canonical-name>.json` at runtime.

The canonical name is the value of `MODEL_NAME` that clients pass to `/v1/chat`, `/v1/complete`, `/v1/embed`. By convention it's lowercase with hyphens — `llama-3.3-70b-instruct`, `qwen-3-32b`, `mistral-small-3`, and so on.

## Schema

```json
{
  "name":            "<canonical safebox name>",
  "vllmModel":       "<HuggingFace repo id OR local path>",
  "manifestHash":    "<sha256 of this manifest — populated by the install protocol>",
  "version":         "<semver>",
  "vendor":          "<who trained it>",
  "license":         "<SPDX identifier or short tag>",
  "homepage":        "<url>",

  "weights": [
    { "file": "<filename>", "size": <bytes>, "sha256": "<hex>" }
  ],

  "vllm": {
    "tensorParallelSize":   <int, default 1>,
    "maxModelLen":          <int, default 8192>,
    "dtype":                "auto | float16 | bfloat16 | float32",
    "quantization":         "<empty | awq | gptq | fp8 | ...>",
    "gpuMemoryUtilization": <float 0..1, default 0.9>,
    "trustRemoteCode":      <bool, default false>,
    "enforceEager":         <bool, default false>,
    "extraFlags":           ["--foo", "bar"]
  },

  "capabilities": {
    "chat":       true,
    "complete":   true,
    "embed":      false,
    "toolUse":    false,
    "vision":     false
  },

  "resources": {
    "minGpuMemoryGb":    <int>,
    "recommendedGpu":    "<short string>",
    "approximateLoadSec": <int>
  },

  "notes": "<free text — known good configurations, caveats>"
}
```

## Field semantics

**`name`** — the Safebox canonical name. This is what clients send and what the runner advertises in `/v1/capabilities`. Pick something short and stable; don't include version-y suffixes unless they distinguish loadable variants (e.g. `-int4`, `-awq`).

**`vllmModel`** — what gets passed to `vllm serve` as the model identifier. Two acceptable forms:

- A HuggingFace repo id: `meta-llama/Llama-3.3-70B-Instruct`. vLLM downloads on first run (slow) or uses the local HF cache. Useful for development; in production you'd typically pre-stage weights.
- A local path: `/srv/safebox/models/<manifestHash>/`. Required for production deployment under the Safebox model-install protocol — the system component downloads, verifies, and stages weights under the hash-named directory; vLLM loads from there with no network access at runtime.

The runner uses whichever the manifest provides. If `manifestHash` is set AND a directory at `/srv/safebox/models/<manifestHash>/` exists, the runner prefers the local path automatically.

**`weights`** — the canonical list of weight files with sizes and SHA-256 hashes. The Safebox system component uses this to download and verify before mounting into the runner container. M-of-N signers sign the manifest as a whole (after `manifestHash` is computed by hashing the canonical JSON form excluding the `manifestHash` field itself).

**`vllm.*`** — passed through to `vllm serve` on the launch command line. The most important fields:

- `tensorParallelSize` — number of GPUs to shard the model across. 1 for models that fit on one GPU; 2-8 for larger.
- `maxModelLen` — context window in tokens. Higher = more memory used per request. Set it to match the application's expected use, not the model's theoretical maximum, to avoid wasting GPU memory.
- `dtype` — `auto` (recommended) lets vLLM pick. `bfloat16` is the right choice for most modern Hopper/Ada GPUs; `float16` for older.
- `quantization` — leave empty for full-precision weights. Use `awq` / `gptq` for pre-quantized weights, `fp8` on H100/H200 for runtime quantization. The runner trusts the manifest here — if you say `fp8` but the weights aren't fp8, vLLM will error at load time.
- `gpuMemoryUtilization` — fraction of GPU memory vLLM is allowed to claim. 0.9 is fine on dedicated GPUs; lower it if other processes share the GPU.
- `trustRemoteCode` — set to `true` for models that ship custom Python in the HF repo (DeepSeek, GLM, some Chinese-vendor models). Reads as a security flag because it executes arbitrary code from the repo at load time; Safebox's hash-verification on weights doesn't extend to remote code, so think carefully before enabling.

**`capabilities`** — declares what endpoints this runner accepts. The wrapper enforces these — `/v1/embed` returns 400 if `capabilities.embed` is false, even if vLLM itself supports it. This is for protocol cleanliness: clients learn from `/v1/capabilities` what they can call, and the runner stays honest.

**`resources`** — informational only; not used by the wrapper or vLLM. Operator-facing hints for placement decisions.

## Adding a new model

1. Pick a canonical name. Lowercase, hyphens, no `_`. Examples: `llama-3.3-70b-instruct`, `qwen-3-32b`, `gemma-3-12b-it`.

2. Copy an existing manifest that ships in the same family (`llama-3.3-70b-instruct.json` for dense Llama-likes, `qwen-3-32b.json` for Qwen, `deepseek-v3.json` for MoE models needing `trustRemoteCode`).

3. Update:
   - `name` to the canonical name
   - `vllmModel` to the HF repo id
   - `weights` array — list every file in the repo with size and SHA-256. The Safebox install tooling can populate this; for development you can leave it empty and let vLLM download from HF cache.
   - `vllm.maxModelLen`, `vllm.tensorParallelSize`, `vllm.dtype` to fit the deployment GPU
   - `capabilities.*` based on what the model is trained for

4. Test in development:
   ```
   docker run -d --name vllm-test --gpus all \
       -e MODEL_NAME=<canonical-name> \
       -v safebox-sockets:/run/safebox/services \
       safebox/vllm:latest

   curl -X POST --unix-socket /var/lib/docker/volumes/safebox-sockets/_data/llm-1.sock \
       http://localhost/v1/capabilities | jq .
   ```

5. When ready for production, run the manifest through the Safebox manifest-signing tooling so M-of-N quorum approves the install. The signed manifest gets the `manifestHash` populated and lands at `/etc/safebox/runners/vllm/manifests/`.

## What's in this directory today

Five starter manifests covering the LLM roster:

| File | Model | TP size | Max context | Recommended GPU |
|---|---|---|---|---|
| `llama-3.3-70b-instruct.json` | Meta Llama 3.3 70B Instruct | 2 | 128K | 2× A100 80GB |
| `qwen-3-32b.json` | Qwen3 32B | 1 | 32K | 1× A100 80GB |
| `mistral-small-3.json` | Mistral Small Instruct 2409 (22B) | 1 | 32K | 1× A100 40GB |
| `gemma-3-12b-it.json` | Google Gemma 3 12B Instruction-tuned | 1 | 8K | 1× T4 16GB or laptop |
| `deepseek-v3.json` | DeepSeek V3 | 8 | 128K | 8× H100 80GB |

GLM 5.2 and the other Z.ai / Moonshot / MiniMax models are documented in `docs/MODEL-CATALOG.md` but don't have manifests here yet because their vLLM-specific launch args change with each release. Adding a manifest is the next step once a deployment target picks a specific quantization and TP size.

For each manifest below, the `weights` arrays and `manifestHash` fields are populated by the install tooling, not by hand. The committed versions in this directory leave them empty — the Safebox system component fills them in when an operator signs a specific install.
