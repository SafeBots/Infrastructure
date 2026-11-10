# U GPU Compute and State Caching — Implementation Spec

**For the U runtime team: GGML integration, GPU inference, MoE expert offloading, quantization, and diffusion state caching.**

This document extends `ulanguage-models-api.md` (which covers the Unix socket API, KV cache tree, and fork/CoW architecture). That spec describes *what* the adapter expects from the U binary. This spec describes *how* the U binary should implement GPU-accelerated inference for large models — the ones that don't fit in CPU RAM alone — and how diffusion model state caching works within the same tiered architecture.

---

## 1. Architecture Decision: GGML as Tensor Library, Not Server

U uses GGML (the C tensor library from the llama.cpp project) as its GPU compute backend. This is a deliberate scoping decision.

### What U uses from GGML

- **Tensor operations**: matmul, attention (flash attention and standard), softmax, RoPE, layer norm, SiLU, GELU
- **Quantized compute kernels**: Q4_K_M, Q5_K_M, Q6_K, Q8_0, FP8 (E4M3/E5M2) dequant-on-the-fly in CUDA/ROCm kernels
- **MoE routing**: top-k expert selection, gating softmax, expert gather/scatter
- **CUDA/ROCm/Metal backends**: GPU kernel dispatch, memory management on device, multi-GPU tensor parallelism
- **GGUF weight loader**: parse GGUF container format, load quantized weight tensors into GPU VRAM or system RAM

### What U does NOT use from llama.cpp

- **llama.cpp's HTTP server** (`llama-server`). U has its own Unix socket server and adapter.
- **llama.cpp's KV cache manager**. U manages KV caches itself via fork/CoW in RAM and ZFS snapshots on disk.
- **llama.cpp's slot system**. Slots are llama.cpp's mechanism for concurrent KV management within a single process using index arithmetic. U solves this at the OS level. See §2 below.
- **llama.cpp's sampling logic**. U implements its own sampling (temperature, top-p, top-k, repetition penalty, grammar-constrained sampling).
- **llama.cpp's tokenizer**. U has its own tokenizer implementation.

### Why this boundary

llama.cpp is a full inference server. Its KV cache management, slot system, and sampling are tightly coupled to its single-process, multi-slot architecture. U's architecture is fundamentally different: fork-based CoW gives each request its own address space, making llama.cpp's internal bookkeeping redundant and in some cases conflicting.

GGML, by contrast, is a clean tensor computation library. Its API accepts tensor data pointers and dimensions, runs the math on the GPU, and writes results to output tensors. It doesn't care who allocated the memory or how the KV cache is structured at a higher level. This is exactly the boundary U needs.

---

## 2. Why Not Slots

This section exists because the llama.cpp slot system is the obvious first question when integrating GGML. The answer is: U's fork/CoW replaces slots with something better for our architecture.

### What llama.cpp slots do

In llama.cpp, a "slot" is a logical KV cache partition within a single process. The server allocates a contiguous KV buffer for N slots, each with its own token range within the shared buffer. When a new request arrives, it's assigned a free slot. The server manages slot lifecycle (allocation, deallocation, defragmentation) using index arithmetic within the shared buffer.

Slots solve the problem of serving multiple concurrent conversations without fork(). They work well for llama.cpp's use case: a single GPU server handling many requests, where fork() is either unavailable or would duplicate GPU state.

### What U does instead

U uses `fork()`. Each incoming request forks the parent process. The child gets a copy-on-write view of the entire address space, including the KV cache. The child runs inference, responds, and exits. Pages modified by the child are copied on write; unmodified pages (the vast majority — shared prefix, model weights) remain shared.

### Why fork/CoW is better for U

| Concern | llama.cpp slots | U fork/CoW |
|---------|----------------|------------|
| Isolation | Shared address space; a crash in one slot can corrupt others | Each child is a separate process; a crash affects only that request |
| Memory sharing | Manual — slot manager tracks which KV ranges are shared | Automatic — OS page tables share all unmodified pages |
| Concurrency | Bounded by pre-allocated slot count | Bounded only by available RAM (CoW pages are cheap) |
| Branching | Not natively supported — requires copying KV data | Native — fork() IS a branch; costs ~0.1 ms and zero memory until divergence |
| Context persistence | KV data lives in process RAM; lost on restart | ZFS snapshots persist KV across restarts; mmap restores in milliseconds |
| Defragmentation | Needed — slots fragment the contiguous buffer over time | Not needed — each child has its own address space |
| GPU memory | One set of weights in VRAM, shared across slots | One set of weights in VRAM, shared across fork'd children (CUDA contexts are inherited by fork on Linux) |

### The correspondence

Every slot concept has a U equivalent:

| llama.cpp concept | U equivalent |
|-------------------|-------------|
| Slot allocation | `fork()` — child inherits parent's KV state |
| Slot deallocation | Child process `exit()` — OS reclaims all private pages |
| KV cache resize | Not needed — each child's KV grows independently in its own address space |
| Slot defragmentation | Not needed — no shared contiguous buffer to fragment |
| KV cache save/load | ZFS snapshot/mmap — see `ulanguage-models-api.md` §4 |
| Multi-slot batching | Multiple fork'd children run concurrently; GPU batches can be assembled from multiple children's pending operations |

### GPU memory and fork()

On Linux, CUDA contexts survive fork(). The child process inherits the parent's CUDA context and can access the same GPU memory (model weights in VRAM are shared read-only). Each child allocates its own GPU working memory for intermediate tensors during inference.

For multi-GPU setups, the parent process initializes all GPU contexts at startup. Children inherit all of them.

**Caveat**: CUDA documentation officially discourages fork() after `cuInit()`. In practice, read-only access to the parent's GPU memory works on Linux with the NVIDIA driver, and this is the same pattern used by vLLM's process-based parallelism. If future driver versions break this, the fallback is to re-attach to the GPU context in the child via CUDA IPC (`cudaIpcGetMemHandle` / `cudaIpcOpenMemHandle`), which adds ~1 ms of setup per fork. The KV cache architecture (fork/CoW in RAM, mmap from ZFS) is unaffected because KV caches live in system RAM, not VRAM.

---

## 3. GGUF Weight Loading

U loads model weights from GGUF files. GGUF is the standard container format for quantized LLM weights in the GGML ecosystem.

### File layout

A GGUF file contains:
- **Header**: magic number, version, tensor count, metadata KV pairs
- **Metadata**: model architecture, tokenizer data, quantization scheme, context length, etc.
- **Tensor data**: weight tensors stored contiguously, each with name, shape, dtype, and offset

### Loading strategy

1. **Parse the GGUF header and metadata.** Extract model architecture, layer count, head count, embedding dimension, quantization type.
2. **Map tensor data.** For each weight tensor, compute its byte range in the file.
3. **Place tensors by tier:**
   - **GPU VRAM**: shared attention layers (Q, K, V projections for all layers), shared FFN layers (for dense models), shared MoE layers (gate, up, down projections for the always-active experts), embedding table, output head.
   - **System RAM**: warm MoE expert weights (for expert offloading — see §5).
   - **ZFS / NVMe**: all expert weights compressed (the full checkpoint). ZFS ARC caches recently accessed blocks automatically.
4. **Memory-map the file.** The GGUF file lives on ZFS. `mmap()` it with `MAP_PRIVATE | MAP_POPULATE` for weights that go to RAM. For GPU weights, read into a pinned host buffer and `cudaMemcpy` to VRAM. Alternatively, use `cudaHostRegister` on the mmap'd region and transfer via DMA.

### Supported quantization formats

| Format | Bits/weight | Use case | GPU kernel |
|--------|-------------|----------|------------|
| Q4_K_M | 4.5 | Primary quantization — fits large models in limited VRAM | GGML CUDA kernel with grouped dequant |
| Q5_K_M | 5.5 | Better quality, slightly more VRAM | GGML CUDA kernel |
| Q6_K | 6.5 | High quality, 30% more VRAM than Q4 | GGML CUDA kernel |
| Q8_0 | 8.0 | Near-lossless, 2× VRAM of Q4 | GGML CUDA kernel |
| FP8 (E4M3) | 8.0 | H100-native, hardware-accelerated | cuBLAS FP8 gemm |
| FP16 | 16.0 | Full precision, for small models or fine-tuning | cuBLAS FP16 gemm |
| BF16 | 16.0 | Full precision, A100/H100/MI300X native | cuBLAS BF16 gemm |

**Recommendation**: Q4_K_M as default quantization for deployment. FP8 when running on H100s with enough VRAM. FP16/BF16 only for models that fit entirely in VRAM at full precision.

---

## 4. KV Cache Buffer Allocation

This is the critical integration point between U's fork/CoW architecture and GGML's attention kernels.

### The problem

GGML's attention kernels expect K and V tensors as contiguous memory with known strides. U's fork/CoW architecture requires KV data to be in page-aligned system RAM (not VRAM) so that `fork()` produces CoW copies at page granularity.

### The solution

U allocates KV buffers itself. It passes pointers to these buffers into GGML's attention kernels as raw tensor data.

```
┌─────────────────────────────────────────────────────┐
│ U process (parent)                                  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ KV buffer (page-aligned, mmap'd from ZFS)    │   │
│  │ Token 0: [K_layer0..K_layerN | V_layer0..N]  │   │
│  │ Token 1: [K_layer0..K_layerN | V_layer0..N]  │   │
│  │   ...                                        │   │
│  │ Token T: [K_layer0..K_layerN | V_layer0..N]  │   │
│  └──────────────────────────────────────────────┘   │
│       │                                             │
│       │ pointers + strides                          │
│       ▼                                             │
│  ┌──────────────────────────────────────────────┐   │
│  │ GGML attention kernel (on GPU)               │   │
│  │ Reads K,V from host RAM via PCIe             │   │
│  │ Computes attention on GPU                    │   │
│  │ Writes output to GPU buffer                  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
         │
    fork()  ← CoW copy of KV buffer, ~0.1 ms
         │
┌─────────────────────────────────────────────────────┐
│ U process (child)                                   │
│  KV buffer: same physical pages until child writes  │
│  Child appends new tokens → only new pages copied   │
└─────────────────────────────────────────────────────┘
```

### Buffer layout

Each token's KV representation is stored contiguously at a fixed stride of `kv_bytes_per_token`. The buffer is allocated with `mmap(MAP_ANONYMOUS | MAP_PRIVATE)` and aligned to the system page size (4 KB on Linux).

For MLA models (DeepSeek), each token stores the compressed latent vector rather than separate K and V heads. The stride is determined by the model's MLA configuration:

```
DeepSeek V4.1 Flash:
  MLA latent dim = 512
  Per-token storage = 512 × (FP16 = 2 bytes) × (some overhead) ≈ 890 bytes
  Stride: 896 bytes (rounded to 64-byte alignment for SIMD)
  Page alignment: token 0 at offset 0, tokens pack within pages,
                  new pages allocated every ~4.5 tokens
```

For standard GQA models (LLaMA, Qwen without MLA), each token stores separate K and V vectors per layer per KV head:

```
LLaMA 3.3 70B:
  80 layers × 8 GQA heads × 128 head_dim × 2 (K+V) × 2 bytes (FP16) = 2,560 bytes/token
  Stride: 2,560 bytes (already 64-byte aligned)
```

### Passing KV to GGML

When U builds a GGML compute graph for a forward pass, it wraps the KV buffer regions as GGML tensors:

```c
// Pseudocode — actual U implementation will be in the U language
struct ggml_tensor * k_layer_i = ggml_new_tensor_2d(ctx,
    GGML_TYPE_F16,
    head_dim,                    // 128
    n_tokens_in_kv               // current sequence length
);
k_layer_i->data = kv_buffer + (layer_i * layer_stride);  // point into U's buffer

// Same for V
struct ggml_tensor * v_layer_i = ggml_new_tensor_2d(ctx, ...);
v_layer_i->data = kv_buffer + (layer_i * layer_stride) + k_size;

// GGML attention reads from these pointers
struct ggml_tensor * attn_out = ggml_flash_attn_ext(ctx, q, k_layer_i, v_layer_i, mask, scale, ...);
```

GGML doesn't know or care that the backing memory is mmap'd from ZFS or shared via CoW — it just reads from the pointer.

### GPU KV placement for large-context GPU inference

For GPU-only inference (where context fits in VRAM alongside weights), KV caches can optionally live in VRAM instead of system RAM. In this mode:
- KV buffers are allocated with `cudaMalloc` instead of `mmap`
- fork/CoW does NOT apply to VRAM — GPU memory is not part of the process's virtual address space in the same way
- Persistence uses explicit `cudaMemcpy` from VRAM to a host buffer, then ZFS snapshot of that buffer
- This mode is for pure GPU inference where latency matters more than memory efficiency
- The choice is per-model-instance, set at load time: `kv_placement: "host"` (default, enables fork/CoW) or `kv_placement: "device"` (GPU VRAM, explicit save/load)

---

## 5. MoE Expert Offloading (DeepSeek Architecture)

DeepSeek V4.1 Flash has 552 billion parameters arranged as a Mixture-of-Experts model: a small number of "shared" experts that process every token, plus a large pool of "routed" experts from which only a few are activated per token. The challenge: the full model is 552B parameters, but each token only touches ~37B of active parameters.

### Three-tier expert placement

```
Tier 0: GPU VRAM (hot)
  ├── Shared attention layers (all layers, always active)
  ├── Shared experts (always active, ~8 per layer)
  ├── Top-N most frequently activated routed experts
  └── Embedding + output head

Tier 1: System RAM / ZFS ARC (warm)
  ├── Medium-frequency routed experts
  └── Loaded into VRAM on demand per token batch

Tier 2: ZFS / NVMe (cold)
  ├── All expert weights (complete checkpoint, compressed)
  └── Promoted to RAM/VRAM by ZFS ARC on access
```

### How expert routing works

1. **Router evaluation (GPU, every token):** The MoE gate (a small linear layer) runs on GPU for every token and produces a probability distribution over all experts. The top-K experts (K=6 for DeepSeek, typically) are selected.

2. **Expert availability check:** Before dispatching to the selected experts, check whether each expert's weights are in VRAM (Tier 0). If yes, run immediately. If not, check system RAM (Tier 1).

3. **Expert loading (if needed):** If an expert is in Tier 1 (RAM), `cudaMemcpyAsync` it to a pre-allocated VRAM staging buffer. If in Tier 2 (disk), ZFS ARC usually has it cached in RAM already; if not, the ZFS read brings it in. PCIe transfer of one expert takes ~0.5–2 ms depending on expert size and PCIe generation.

4. **Expert computation:** All selected experts run on GPU. Outputs are combined by the router's gating weights.

5. **Expert eviction:** VRAM staging buffer uses LRU eviction. Experts evicted from VRAM stay in system RAM (Tier 1); they're evicted from RAM only under memory pressure, at which point ZFS ARC's own eviction policy applies.

### ZFS ARC as the warm cache

ZFS's Adaptive Replacement Cache (ARC) is a read cache that sits in system RAM. It automatically learns the access pattern of expert weights and keeps hot blocks cached. This gives us a self-tuning warm tier with no custom code:

- When an expert is read from ZFS, its blocks enter ARC
- Frequently accessed experts stay in ARC even under memory pressure
- ARC's ghost lists (recently evicted metadata) let it distinguish scan (one-off access) from frequency (repeated access), so a burst of cold expert loads doesn't evict hot ones
- ARC size is tunable: for inference machines, set `zfs_arc_max` to leave enough RAM for KV caches and the OS, and give the rest to ARC

### VRAM budget

The VRAM budget determines how many experts stay hot in Tier 0. Here are the reference numbers for DeepSeek V4.1 Flash at Q4_K_M quantization:

| Component | Size at Q4_K_M | Notes |
|-----------|---------------|-------|
| Shared attention (all layers) | ~20 GB | Always in VRAM |
| Shared experts (all layers) | ~8 GB | Always in VRAM |
| Embedding + output head | ~4 GB | Always in VRAM |
| Per routed expert | ~100–200 MB | 256 total routed experts |
| **Fixed VRAM cost** | **~32 GB** | Before any routed experts |

On 4× H100 (320 GB total VRAM with tensor parallelism):
- Fixed components: ~32 GB
- Remaining for routed experts: ~288 GB
- Experts cached in VRAM: ~1,400–2,800 of 256 → **all experts fit in VRAM at Q4_K_M**

On 1× H100 (80 GB):
- Fixed components: ~32 GB
- Remaining for routed experts: ~48 GB
- Experts cached: ~240–480 → most experts fit, with LRU rotation for the cold tail

On 4× A100 (320 GB, older generation):
- Same budget as 4× H100 but without FP8 hardware; Q4_K_M is the best quantization option

On 1× A100 (80 GB or 40 GB):
- 80 GB: similar to 1× H100 minus FP8
- 40 GB: only ~8 GB for routed experts → heavy Tier 1 rotation, expect ~1–2 ms per-token overhead for cold experts

### Expert paging implementation

U needs to implement an expert pager. Pseudocode:

```
struct ExpertPager:
    vram_cache: LRU<expert_id, CudaBuffer>     // Tier 0
    host_cache: LRU<expert_id, HostBuffer>      // Tier 1 (mmap'd from ZFS)
    vram_staging: CudaBuffer[]                  // pre-allocated transfer buffers
    
    fn ensure_in_vram(expert_id) -> CudaBuffer:
        if expert_id in vram_cache:
            return vram_cache.get(expert_id)     // Tier 0 hit
        
        if expert_id in host_cache:
            buf = vram_staging.acquire()
            cudaMemcpyAsync(buf, host_cache[expert_id], ...)
            vram_cache.put(expert_id, buf)       // promote Tier 1 → Tier 0
            return buf
        
        // Tier 2: read from ZFS (ARC may serve from RAM)
        host_buf = mmap(zfs_expert_path(expert_id))
        host_cache.put(expert_id, host_buf)      // enter Tier 1
        buf = vram_staging.acquire()
        cudaMemcpyAsync(buf, host_buf, ...)
        vram_cache.put(expert_id, buf)           // enter Tier 0
        return buf
```

### Prefetch optimization

The router output for layer L is known before layer L's expert computation begins. Use this to prefetch:

1. After computing the router output for layer L, immediately issue `cudaMemcpyAsync` for any selected experts not in VRAM.
2. While waiting for the transfer, compute other parts of layer L that don't depend on the routed experts (the shared expert computation runs in parallel).
3. By the time the routed expert computation is needed, the transfer is complete (PCIe 5.0 at 64 GB/s transfers a 200 MB expert in ~3 ms; a 2-layer lookahead covers this).

---

## 6. Quantization

### Format selection at load time

U selects the quantization format based on the GGUF file's metadata and the available hardware:

```
fn select_quant(gguf_meta, gpu_info):
    if gguf_meta.quant == FP8 and gpu_info.has_fp8 (H100/H200):
        → use cuBLAS FP8 GEMM, hardware-accelerated
    elif gguf_meta.quant in [Q4_K_M, Q5_K_M, Q6_K, Q8_0]:
        → use GGML's quantized CUDA kernels (dequant-on-the-fly)
    elif gguf_meta.quant in [FP16, BF16]:
        → use cuBLAS FP16/BF16 GEMM
    else:
        → error: unsupported quantization
```

### Quantization trade-offs

| Model | FP16 size | Q4_K_M size | Quality loss | GPU requirement (FP16) | GPU requirement (Q4_K_M) |
|-------|-----------|-------------|-------------|----------------------|--------------------------|
| DeepSeek V4.1 Flash (552B MoE, 37B active) | ~1.1 TB | ~320 GB | ~1–2% on benchmarks | 16× H100 | 4× H100 |
| LLaMA 3.3 70B | ~140 GB | ~40 GB | ~1% | 2× H100 | 1× H100 (80 GB) |
| Qwen3.8-Flash-Next (MoE) | ~60 GB (est.) | ~18 GB | ~1% | 1× H100 | 1× A100 40 GB |
| Small 8B | ~16 GB | ~4.5 GB | <0.5% | 1× A100 40 GB | Any GPU with 8+ GB |

### Mixed quantization

For MoE models, different components can use different quantization levels:
- **Shared layers** (always active, quality-critical): Q6_K or Q8_0
- **Routed experts** (activated sparsely): Q4_K_M (lower quality acceptable because each expert contributes only a fraction of the output)
- **Embedding + output head**: FP16 (small relative to total model, quality-sensitive)

This is called "importance-aware quantization" and reduces the average quality loss while keeping the overall model compact.

---

## 7. GGML Compute Graph Construction

For each forward pass, U builds a GGML compute graph that describes the sequence of tensor operations. The graph is then executed on the GPU.

### Graph construction flow

```
1. U receives a batch of tokens to process (new tokens after the KV checkpoint)

2. For each transformer layer:
   a. Build attention subgraph:
      - Q projection: ggml_mul_mat(weight_q, input)
      - K projection: ggml_mul_mat(weight_k, input) → append to U's KV buffer
      - V projection: ggml_mul_mat(weight_v, input) → append to U's KV buffer
      - RoPE: ggml_rope(Q, K, position_ids)
      - Attention: ggml_flash_attn_ext(Q, K_all, V_all, mask)
      - Output projection: ggml_mul_mat(weight_o, attn_out)
   
   b. Build MoE subgraph (if MoE layer):
      - Gate: ggml_mul_mat(gate_weight, input) → expert scores
      - Top-K selection: select K experts per token
      - Expert pager: ensure selected experts in VRAM (§5)
      - Per-expert FFN: ggml_mul_mat for each active expert
      - Weighted combine: sum expert outputs × gate weights
   
   b'. Build FFN subgraph (if dense layer):
      - Up project: ggml_mul_mat(weight_up, input)
      - Gate project: ggml_mul_mat(weight_gate, input)
      - Activation: ggml_silu(gate_out) * up_out
      - Down project: ggml_mul_mat(weight_down, activated)
   
   c. Residual + LayerNorm: ggml_add, ggml_rms_norm

3. Final: ggml_mul_mat(output_head, last_hidden_state) → logits

4. Execute: ggml_graph_compute(graph, n_threads)
```

### Multi-GPU tensor parallelism

For models split across multiple GPUs, U splits the compute graph:

- **Tensor parallelism (TP)**: Each GPU holds a shard of each weight matrix. Matrix multiplications are split across GPUs, with an all-reduce after each TP operation. GGML supports this via `ggml_backend_sched` with multiple CUDA backends.
- **Expert parallelism (EP)**: For MoE, different experts can live on different GPUs. The router broadcasts token representations to all GPUs; each GPU computes its assigned experts; results are gathered back. This maps naturally to the expert pager: each GPU has its own Tier 0 (VRAM) cache of experts.

TP degree is set at model load time. For DeepSeek 552B at Q4_K_M on 4× H100:
- TP=4: each GPU holds 1/4 of each shared weight matrix
- EP: experts distributed across 4 GPUs, ~64 experts per GPU in VRAM
- All-reduce via NVLink (900 GB/s on H100 NVLink): adds ~0.1 ms per layer

---

## 8. Diffusion Model State Caching

Diffusion models (Wan 2.1 for video, Stable Diffusion / Flux for images) have their own cacheable intermediate states. The same tiered fork/CoW/ZFS architecture applies, but the data shapes are different.

### Cacheable diffusion state

| State | Typical size | Cache lifetime | Sharing pattern |
|-------|-------------|---------------|-----------------|
| Text encoder embeddings (CLIP/T5) | 2–8 MB | Until prompt changes | Shared across all images with the same prompt |
| VAE encoder output (latent) | 0.5–4 MB per image | Until source image changes | Shared across variations of the same input |
| Partial denoise states | 10–50 MB per step | Session-scoped | Shared across branches from the same generation |
| ControlNet features | 5–20 MB per control image | Until control image changes | Shared across all generations with the same control |
| IP-Adapter embeddings | 1–4 MB per reference image | Until reference changes | Shared across all generations referencing the same image |

### How diffusion caching maps to U's tiers

**Text encoder embeddings**: The most reusable state. A user making 20 image variations with the same prompt should compute the CLIP/T5 embedding once. Store in the KV tree under a content-addressed key (SHA-256 of the prompt text). Fork/CoW means each variation shares the embedding without copying.

**VAE latents**: When doing image-to-image (I2V, V2V), the source image's VAE-encoded latent representation is computed once and reused. Same content-addressing: SHA-256 of the source image. For video (Wan 2.1), the first frame's latent is shared across all frame generation steps.

**Partial denoise states**: Diffusion models generate images by iteratively denoising a latent from pure noise. At any step T in the process, the partially denoised state can be checkpointed. This enables:
- **Branching**: Start a generation, checkpoint at step 15 (of 30), then branch into multiple variations that share the first 15 steps of denoising. Like conversation branching for LLMs.
- **Resume**: Pause a generation, persist the partial state to ZFS, resume later without re-running the earlier steps.
- **Step refinement**: Generate with 30 steps, save the step-20 checkpoint, try continuing with different guidance scales.

**ControlNet features**: ControlNet preprocesses a control image (edge map, depth map, pose) into a set of feature tensors that are injected into the diffusion UNet at each step. These features are constant across the entire generation and are prime cache candidates.

### Diffusion state in the KV tree

Diffusion states use the same checkpoint API as LLM KV caches (`/v1/internal/kv/save`, `/v1/internal/kv/load`, `/v1/internal/kv/fork`). The adapter distinguishes them by checkpoint ID prefix:

| Prefix | Type | Content |
|--------|------|---------|
| `kv-` | LLM KV cache | Token-level K/V tensors |
| `de-` | Diffusion encoder | Text encoder / CLIP / T5 embeddings |
| `dl-` | Diffusion latent | VAE-encoded source latent |
| `dd-` | Diffusion denoise | Partial denoise state at step N |
| `dc-` | Diffusion control | ControlNet features |
| `di-` | Diffusion IP | IP-Adapter embeddings |

The U binary doesn't need to distinguish these — they're all opaque byte buffers at the KV layer. The adapter and the model runner (`model-runners/wan-video/runner.py`, `model-runners/flux-image/runner.py`) use the prefixes for lifecycle management (e.g., evict `dd-` before `de-` under memory pressure, because denoise states are session-scoped while encoder embeddings are globally shareable).

### Diffusion GPU memory layout

Diffusion models have a different GPU memory profile than LLMs:

```
Wan 2.1 (14B parameter video model):

  GPU VRAM allocation:
  ├── UNet / DiT weights (Q8_0): ~14 GB
  ├── Text encoder (T5-XXL, FP16): ~11 GB
  ├── VAE decoder (FP16): ~0.5 GB
  ├── ControlNet (if used, FP16): ~5 GB
  ├── Working memory (per-step tensors): ~4–8 GB
  └── Total: ~35–40 GB → fits on 1× H100

  System RAM / ZFS:
  ├── Cached text embeddings (LRU): configurable
  ├── Cached VAE latents (LRU): configurable
  ├── Partial denoise checkpoints: on demand
  └── ControlNet features: per control image
```

Unlike LLM inference where KV caches grow per-token, diffusion working memory is fixed per generation step. The cacheable state (embeddings, latents, partial denoise) lives in system RAM / ZFS and is loaded to GPU only when needed.

---

## 9. What the U Team Needs to Build

This section is the concrete work list. Items are roughly in dependency order.

### Phase 1: GGML integration (CPU-only inference already works; this adds GPU)

1. **GGUF loader**: Parse GGUF header and metadata. Map weight tensors to GGML tensor objects. Support Q4_K_M, Q5_K_M, Q6_K, Q8_0, FP16, BF16 dtypes. Load weights into GPU VRAM via `cudaMemcpy` or `cudaHostRegister` + DMA.

2. **GGML graph builder**: Translate U's model definition into a GGML compute graph. Build attention subgraphs that read K/V from U's page-aligned host buffers. Build FFN subgraphs using weights loaded from GGUF.

3. **KV buffer allocator**: Allocate KV cache buffers with `mmap(MAP_ANONYMOUS | MAP_PRIVATE)`, page-aligned, with the correct stride per model. Wrap these buffers as GGML tensors for the attention kernel. This is the integration point between U's fork/CoW layer and GGML's compute layer.

4. **GPU context management**: Initialize CUDA/ROCm context at startup. Ensure fork()'d children inherit the context. Test VRAM access from child processes. Implement CUDA IPC fallback if direct inheritance fails.

### Phase 2: Large model support

5. **Expert pager**: Implement the three-tier expert LRU (§5). Track which experts are in VRAM, RAM, and on disk. Handle async transfers with `cudaMemcpyAsync`. Implement prefetch based on router output lookahead.

6. **Multi-GPU tensor parallelism**: Split weight matrices across GPUs for TP. Implement all-reduce for TP (NVLink path). Implement expert parallelism for MoE across GPUs. Use `ggml_backend_sched` for multi-backend scheduling.

7. **Mixed quantization loader**: Support different quantization levels for different model components (§6). Parse GGUF files with mixed quant types. Route each tensor to the appropriate GGML kernel.

8. **FP8 support**: For H100s, use cuBLAS FP8 GEMM instead of GGML's quantized kernels. Detect FP8 hardware support at init. Convert FP8 GGUF weights to the cuBLAS expected format.

### Phase 3: Diffusion state caching

9. **Diffusion state save/load**: Extend the KV checkpoint endpoints to handle diffusion state (same byte-buffer interface, different sizes and shapes). Implement content-addressed caching for text embeddings and VAE latents. Implement step-indexed caching for partial denoise states.

10. **Diffusion GPU integration**: Load diffusion model weights (UNet/DiT, text encoder, VAE, ControlNet) via GGUF or safetensors. Build GGML compute graphs for the diffusion forward pass. Manage per-step GPU working memory.

### Phase 4: Optimization

11. **Continuous batching**: Collect pending tokens from multiple fork'd children and batch them into a single GPU kernel call. This is where U's fork-based concurrency meets GPU efficiency — each child submits its tokens to a shared batch queue; the parent assembles the batch and dispatches to GPU.

12. **Speculative decoding**: Use a smaller "draft" model to propose N tokens ahead, then verify with the full model in a single forward pass. Integrates with fork/CoW: fork at the current state, run the draft model in the child, verify in the parent.

13. **KV cache quantization**: Quantize KV caches themselves (not just weights) for longer contexts. KV at Q8 or Q4 reduces per-token storage from ~890 bytes (FP16 MLA) to ~445 or ~222 bytes, enabling 2–4× longer contexts in the same memory. Quality impact is model-dependent; needs benchmarking.

---

## 10. Instance Type Reference (GPU Tiers)

### AWS

| Config | Instance | GPUs | VRAM | Interconnect | Monthly Cost |
|--------|----------|------|------|-------------|-------------|
| 1× A10G | g5.xlarge | 1× A10G | 24 GB | — | ~$750 |
| 1× A100 | p4d.24xlarge (1/8) | 1× A100 | 80 GB | — | ~$3,000 |
| 4× A100 | p4d.24xlarge | 4× A100 | 320 GB | NVLink | ~$24,000 |
| 8× A100 | p4d.24xlarge | 8× A100 | 640 GB | NVLink | ~$24,000 |
| 8× H100 | p5.48xlarge | 8× H100 | 640 GB | NVLink | ~$65,000 |

### GCP

| Config | Instance | GPUs | VRAM | Interconnect | Monthly Cost |
|--------|----------|------|------|-------------|-------------|
| 1× L4 | g2-standard-4 | 1× L4 | 24 GB | — | ~$500 |
| 1× A100 | a2-highgpu-1g | 1× A100 | 80 GB | — | ~$2,900 |
| 4× A100 | a2-megagpu-16g (4/16) | 4× A100 | 320 GB | NVLink | ~$11,600 |
| 8× H100 | a3-highgpu-8g | 8× H100 | 640 GB | NVLink | ~$60,000 |

### Azure

| Config | Instance | GPUs | VRAM | Interconnect | Monthly Cost |
|--------|----------|------|------|-------------|-------------|
| 1× A100 | Standard_NC24ads_A100_v4 | 1× A100 | 80 GB | — | ~$3,200 |
| 4× A100 | Standard_ND96asr_v4 (4/8) | 4× A100 | 320 GB | NVLink | ~$13,000 |
| 8× H100 | Standard_ND96isr_H100_v5 | 8× H100 | 640 GB | NVLink | ~$72,000 |

### OCI

| Config | Instance | GPUs | VRAM | Interconnect | Monthly Cost |
|--------|----------|------|------|-------------|-------------|
| 1× A10 | GPU.A10.1 | 1× A10 | 24 GB | — | ~$600 |
| 4× A100 | BM.GPU.A100-v2.8 (4/8) | 4× A100 | 320 GB | NVLink | ~$16,000 |
| 8× H100 | BM.GPU.H100.8 | 8× H100 | 640 GB | NVLink | ~$55,000 |

### Model → instance mapping

| Model | Quantization | Min GPU config | Recommended GPU config |
|-------|-------------|---------------|----------------------|
| DeepSeek V4.1 Flash (552B MoE) | Q4_K_M | 4× H100 (320 GB) | 4× H100 |
| DeepSeek V4.1 Flash | FP8 | 8× H100 (640 GB) | 8× H100 |
| LLaMA 3.3 70B | Q4_K_M | 1× H100 (80 GB) | 1× H100 |
| LLaMA 3.3 70B | FP16 | 2× H100 (160 GB) | 2× H100 |
| Qwen3.8-Flash-Next (MoE) | Q4_K_M | 1× A100 40 GB | 1× A100 80 GB |
| Small 8B models | Q4_K_M | Any GPU 8+ GB | 1× A10G / L4 |
| Wan 2.1 14B (video) | Q8_0 | 1× A100 40 GB | 1× H100 |
| Flux.1 (image) | FP16 | 1× A100 40 GB | 1× A100 80 GB |

---

## 11. Cross-Reference

- **U API spec**: `docs/ulanguage-models-api.md` — Unix socket API, KV cache tree, fork/CoW architecture
- **Model catalog**: `docs/MODEL-CATALOG.md` — supported models and hardware requirements
- **Runner adapters**: `model-runners/u-omni/runner.py`, `model-runners/wan-video/runner.py`
- **AWS GPU instances**: `aws/README.md` — XL (GPU) configuration
- **GCP GPU instances**: `gcp/README.md` — XL (GPU) configuration
- **Azure GPU instances**: `azure/README.md` — XL (GPU) configuration
- **OCI GPU instances**: `oci/README.md` — XL (GPU) configuration
- **GGML source**: https://github.com/ggerganov/llama.cpp/tree/master/ggml
- **GGUF spec**: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
- **DeepSeek MoE paper**: https://arxiv.org/abs/2401.06066
- **Multi-Latent Attention**: DeepSeek-V2 technical report §2.1
