# U Language Models API — Implementation Spec

**For the U runtime team: everything needed to implement against the Safebox model runner interface, including the two-tier KV cache tree.**

This document is the contract between the U binary and the Safebox Infrastructure runner adapter (`model-runners/u-omni/runner.py`). The adapter handles HMAC auth, the HTTP surface, and KV tree bookkeeping. The U binary handles inference and KV cache operations.

---

## 1. Transport

The U binary listens on a **Unix domain socket** at a configurable path (default `/run/safebox/u-omni.sock`). The adapter talks to this socket using HTTP/1.1 over UDS.

Socket permissions: `0660`, group `safebox-services`.

All communication is JSON over HTTP. Requests have `Content-Type: application/json`. Responses are JSON with appropriate status codes.

---

## 2. Two-Tier KV Cache Architecture

The central design idea: KV caches are stored in a tree across two copy-on-write tiers, so conversations persist across restarts, share common prefixes efficiently, and resume without re-running prefill.

### RAM tier — fork(), ~0.1 ms

The hot path for active inference. Model weights live in shared memory (mmap, read-only). Each request fork()s the process; the child gets a CoW copy of the KV cache, runs inference, responds, and exits. The child's KV evaporates on exit unless explicitly saved.

Multiple checkpoints coexist in the parent process and share common prefix pages via the OS page table's CoW semantics. 100 conversations branching from the same system prompt share that prefix in physical memory.

### ZFS tier — snapshot/clone, ~1 ms

The persistence and sharing tier. A ZFS snapshot captures KV state durably — it survives process restarts, reboots, and hardware migration. ZFS clones share all blocks with the source snapshot and diverge on write, giving the same tree-shaped CoW semantics as fork() but on disk.

ZFS is not an overflow tier. It exists because:

1. **Conversations survive restarts.** A user's 32K-token conversation is a ~28 MB KV snapshot on ZFS. On next boot, the U binary mmap()s it back and resumes decoding immediately — no re-prefill.

2. **System prompts are pre-computed once.** A 4K-token system prompt costs ~3.5 MB of KV state (DeepSeek MLA). Compute it once, snapshot it to ZFS, and every future request starts from that checkpoint via fork(). The prefill cost of the system prompt is paid exactly once, ever.

3. **Trees are shared across users.** A community Safebox serving 100 users with the same system prompt stores the prefix once on ZFS. Each user's conversation is a clone that shares the prefix blocks and stores only the delta.

4. **Branches enable speculative workflows.** Fork a conversation at a decision point, run two completions in parallel, keep the better one. The fork costs ~0.1 ms in RAM and near-zero storage on ZFS until the branches diverge.

### Why this is fast: thaw vs. re-prefill

Resuming a conversation means either re-running prefill on the entire history (expensive) or loading the pre-computed KV cache from ZFS (cheap). Here are the actual numbers:

**Re-prefill (no KV persistence) — CPU inference path:**

| Model | Prefill speed | 32K re-prefill | 128K re-prefill |
|-------|--------------|----------------|-----------------|
| DeepSeek V4.1 Flash (MLA) | ~2,000 tok/s | ~16 s | ~64 s |
| Qwen3.8-Flash-Next | ~4,000 tok/s | ~8 s | ~32 s |
| Small 8B | ~5,000 tok/s | ~6.4 s | ~26 s |

**ZFS thaw (mmap the snapshot):**

| Model | KV bytes/tok | 32K KV size | NVMe @ 5 GB/s | ZFS ARC hit |
|-------|-------------|-------------|---------------|-------------|
| DeepSeek V4.1 Flash (MLA) | ~890 | ~28 MB | ~6 ms | < 1 ms |
| Qwen3.8-Flash-Next | ~640 | ~20 MB | ~4 ms | < 1 ms |
| Small 8B | ~512 | ~16 MB | ~3 ms | < 1 ms |

The difference is three to four orders of magnitude. A 32K DeepSeek conversation resumes in 6 ms from cold NVMe, under 1 ms if ZFS's ARC already has the blocks cached. After mmap, the fork() to start the next decode pass is ~0.1 ms. First token back to the user in under 10 ms total.

At 128K context the gap is even wider: ~22 ms vs over a minute of re-prefill.

### Why it's compact in memory and on disk

Three layers of sharing compound:

1. **MLA compression at the model level.** DeepSeek's Multi-Latent Attention compresses KV representations to ~890 bytes/token — roughly 3× smaller than standard GQA at comparable model size (~2,560 bytes/token for LLaMA 70B). The KV cache is born small.

2. **CoW sharing at the tree level.** N branches from a shared K-token prefix cost `(K × bytes/token) + N × (delta × bytes/token)`, not `N × (K + delta) × bytes/token`. In RAM this is fork()'s page-table sharing; on ZFS it's block-level sharing via clones. A system prompt prefix is stored once regardless of how many conversations branch from it.

3. **ZFS compression on disk.** KV cache data has structure and compresses well under lz4 or zstd. Expect 2–3× further compression, so a 28 MB snapshot might be 10–14 MB of actual storage.

The result: thousands of conversation trees on a single NVMe drive, each instantly resumable, sharing common prefixes both in physical memory and on disk.

### The tiers compose in sequence

```
Boot:
  1. mmap model weights from ZFS (read-only, all processes share)
  2. mmap system-prompt KV from ZFS snapshot → checkpoint "system-prompt"
     (pre-computed last boot, or on first request if missing)
  3. Report healthy on /v1/healthz

Per-request (hot path, no KV headers):
  1. fork() from parent → child gets CoW copy of weights + system-prompt KV
  2. Child runs prefill on the new tokens only (user message)
  3. Child decodes, returns response
  4. Child exits — KV evaporates

Per-request (with KV checkpoint):
  1. Adapter sends X-Safebox-KV-Checkpoint header
  2. U binary loads that checkpoint (mmap from ZFS if not in RAM)
  3. fork() → child starts from the loaded KV state
  4. Child runs inference on new tokens only — no re-prefill of history
  5. If X-Safebox-KV-Save: child saves extended KV before exiting
  6. Adapter snapshots to ZFS if tier=zfs or auto-promote threshold exceeded

Shutdown:
  1. Adapter saves any unsaved RAM checkpoints worth keeping to ZFS
  2. U binary exits, RAM freed
  3. ZFS snapshots are already durable
  4. On next boot, ZFS checkpoints are restored via mmap
```

---

## 3. Standard Inference Endpoints

These are the endpoints the adapter proxies from the Safebox system component. The U binary must implement them.

### POST /v1/chat

Chat completion with optional multimodal inputs.

**Request:**
```json
{
  "model": "u-omni-multimodal",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Describe this image."}
  ],
  "maxTokens": 2048,
  "temperature": 0.7,
  "topP": null,
  "stop": null,
  "stream": false,
  "images": [{"base64": "..."}],
  "audio": {"base64": "..."}
}
```

All fields are camelCase per the Safebox wire protocol. `images` and `audio` are optional multimodal inputs — omit for text-only.

**Response:**
```json
{
  "model": "u-omni-multimodal",
  "content": "The image shows...",
  "role": "assistant",
  "finishReason": "stop",
  "usage": {
    "promptTokens": 42,
    "completionTokens": 128,
    "totalTokens": 170
  }
}
```

**KV cache headers forwarded by the adapter:**

| Header | Meaning |
|--------|---------|
| `X-Safebox-KV-Checkpoint` | Start inference from this checkpoint's KV state |
| `X-Safebox-KV-Save` | Save resulting KV state with this name |
| `X-Safebox-KV-Tier` | `ram`, `zfs`, or `auto` |

When `X-Safebox-KV-Checkpoint` is present, the U binary should load that checkpoint's KV state and run inference starting from it — skipping prefill for all tokens already in the checkpoint. The response's `usage.promptTokens` should reflect only the new tokens processed, not the cached ones.

When `X-Safebox-KV-Save` is present, include these extra fields in the response:
```json
{
  "kvCheckpointId": "kv-a1b2c3d4e5f6",
  "kvTier": "ram",
  "kvTokenCount": 170,
  "kvSizeBytes": 151300
}
```

### POST /v1/complete

Text completion (non-chat).

**Request:**
```json
{
  "model": "u-omni-multimodal",
  "prompt": "Once upon a time",
  "maxTokens": 2048,
  "temperature": 0.7,
  "topP": null,
  "stop": null,
  "stream": false
}
```

**Response:**
```json
{
  "model": "u-omni-multimodal",
  "content": " in a land far away...",
  "finishReason": "stop",
  "usage": {
    "promptTokens": 5,
    "completionTokens": 64,
    "totalTokens": 69
  }
}
```

---

## 4. KV Cache Internal Endpoints

These endpoints are called by the adapter to manage KV state inside the U binary. They are **not** exposed to the system component — the adapter wraps them in the public `/v1/kv/*` API.

All paths are prefixed `/v1/internal/kv/` to distinguish them from the public API.

### POST /v1/internal/kv/save

Save the current KV cache state under a checkpoint ID.

**Request:**
```json
{
  "checkpointId": "kv-a1b2c3d4e5f6",
  "tier": "ram",
  "name": "system-prompt-cache"
}
```

**Response:**
```json
{
  "ok": true,
  "checkpointId": "kv-a1b2c3d4e5f6",
  "tokenCount": 1024,
  "sizeBytes": 911360
}
```

`tier` is informational here — the U binary always saves to RAM. The adapter handles ZFS snapshots separately when `tier` is `"zfs"`.

**Implementation notes for U:**
- Allocate a named slot in the session pool for this checkpoint ID
- The KV data stays in the process's address space (RAM)
- Multiple checkpoints can coexist — they share common prefix pages via CoW
- Return the actual byte count (token count × bytes-per-token for the loaded model)

### POST /v1/internal/kv/load

Restore a previously saved KV state as the active state for the next inference.

**Request:**
```json
{
  "checkpointId": "kv-a1b2c3d4e5f6"
}
```

**Response:**
```json
{
  "ok": true,
  "tokenCount": 1024
}
```

**Implementation:**
- Set the active KV cache pointer to this checkpoint's data
- If the checkpoint was evicted from RAM (only ZFS copy remains), the adapter will have restored it to a file first — the U binary mmap()s it back into the process address space
- After mmap, the KV state is usable immediately — no deserialization or conversion needed. The on-disk format must match the in-memory layout exactly (the same struct, the same byte order) so that mmap is a zero-copy restore.

### POST /v1/internal/kv/fork

Create a new checkpoint by forking from an existing one (RAM CoW).

**Request:**
```json
{
  "sourceId": "kv-a1b2c3d4e5f6",
  "newId": "kv-b2c3d4e5f6a1"
}
```

**Response:**
```json
{
  "ok": true,
  "tokenCount": 1024,
  "sizeBytes": 911360
}
```

**Implementation:**
- This is the core CoW operation
- `fork()` the process (or equivalent: duplicate the KV page table with CoW semantics)
- The new checkpoint shares all pages with the source until either is modified
- Marginal cost: ~0.1 ms for the fork, near-zero memory until divergence
- Both source and new checkpoint remain independently usable
- This is what makes branching conversations essentially free — forking a 32K-token conversation allocates no new memory until the branches diverge

### POST /v1/internal/kv/graft

Graft source's token extension onto target's prefix.

**Request:**
```json
{
  "sourceId": "kv-source",
  "targetId": "kv-target",
  "newId": "kv-grafted"
}
```

**Response:**
```json
{
  "ok": true,
  "tokenCount": 2048,
  "sizeBytes": 1822720,
  "tier": "ram"
}
```

**Implementation:**
- Target has tokens [0..T] representing a cached prefix (e.g. system prompt)
- Source has tokens [0..S] representing a full conversation
- Find the divergence point D where source and target share prefix tokens
- Create new checkpoint with target's KV[0..T] + source's KV[D..S]
- This avoids recomputing KV for the shared prefix
- Maps to U's `kv_graft(source, target)` function
- Use case: a system prompt is updated (new target), and you want to re-root existing conversations onto it without re-running their entire prefill. Only the system prompt delta needs recomputation.

### POST /v1/internal/kv/delete

Free a checkpoint's RAM allocation.

**Request:**
```json
{
  "checkpointId": "kv-a1b2c3d4e5f6"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Implementation:**
- Release the named slot from the session pool
- CoW pages that are still referenced by other checkpoints are not freed (standard CoW behavior)
- Only pages unique to this checkpoint are actually reclaimed

---

## 5. KV Cache On-Disk Format

For ZFS thaw to work as a zero-copy mmap, the on-disk KV format must match the in-memory layout exactly. This section specifies that format.

### Requirements

1. **Byte-identical to in-memory layout.** The file is a direct dump of the KV cache pages as they exist in the process address space. No serialization, no headers, no compression — the file IS the memory. mmap() makes it usable immediately.

2. **Page-aligned.** KV data should be allocated in page-aligned chunks (4 KB pages on Linux) so that fork() CoW and mmap work at page granularity. A token's KV data should not straddle a page boundary unnecessarily.

3. **Fixed stride per token.** Each token's KV representation occupies exactly `kv_bytes_per_token` bytes, laid out contiguously. The total file size is `token_count × kv_bytes_per_token`.

4. **Metadata stored separately.** The checkpoint's metadata (token count, model ID, creation time) is tracked by the adapter in its KV tree data structure, not embedded in the KV file. The file contains only the raw KV data.

### Reference sizes

| Model | KV bytes/token | 4K tokens | 32K tokens | 128K tokens |
|-------|---------------|-----------|------------|-------------|
| DeepSeek V4.1 Flash (MLA) | ~890 | ~3.5 MB | ~28 MB | ~110 MB |
| LLaMA 3.3 70B (GQA) | ~2,560 | ~10 MB | ~80 MB | ~320 MB |
| Qwen3.8-Flash-Next | ~640 | ~2.5 MB | ~20 MB | ~80 MB |
| Small models (8B) | ~512 | ~2 MB | ~16 MB | ~64 MB |

MLA (Multi-Latent Attention) models like DeepSeek compress KV representations at the model level, so their per-token cost is much lower than model size would suggest.

### Tree storage cost

N branches from a shared K-token prefix cost roughly `(K × bytes/token) + N × (delta_tokens × bytes/token)`, not `N × (K + delta) × bytes/token`. This holds in both tiers:
- **RAM:** fork()'s CoW page tables share the prefix pages. Only pages modified by a branch are copied.
- **ZFS:** clone's block pointers share the prefix blocks. Only blocks modified by a branch are allocated.

With ZFS compression (lz4 or zstd), on-disk cost is further reduced by 2–3×.

---

## 6. Health & Capabilities

### GET /v1/healthz

**Response:**
```json
{
  "status": "ok",
  "model": "u-omni-multimodal",
  "modalities": ["text", "vision", "audio"],
  "kvCheckpoints": 5,
  "kvRamUsedBytes": 4556800,
  "uptimeSeconds": 3600
}
```

---

## 7. HMAC Authentication

The adapter handles HMAC verification before proxying to the U binary — the U binary does **not** need to implement HMAC. However, the canonical form is documented here for cross-repo parity testing.

**Strong canonical form** (matches `auth.js` and the Safebox LocalRunner):

```
canonical = "{timestamp}\n{nonce}\n{method}\n{path}\n{sha256(body).hex()}"
signature = HMAC-SHA256(secret, canonical)
```

**Headers on every request:**
- `X-Safebox-Signature` — hex-encoded HMAC
- `X-Safebox-Timestamp` — Unix epoch seconds
- `X-Safebox-Nonce` — unique per request

**Verification rules:**
1. All three headers must be present
2. Timestamp within 300s of server time
3. Nonce not seen before (tracked in an LRU cache, 50K entries, half-evict at capacity)
4. Signature matches the canonical form above
5. Verify **before** recording the nonce (so a failed verification doesn't consume the nonce)
6. Timing-safe comparison for the signature

---

## 8. Response Headers

Every response from the adapter includes these headers. The U binary does not need to set them — the adapter adds them based on the inference result.

| Header | Example | Source |
|--------|---------|--------|
| `X-Safebox-Request-Id` | `req_abc123` | Echoed from request |
| `X-Safebox-Runner-Id` | `safebox-u-omni-1` | Config |
| `X-Safebox-Model-Id` | `u-omni-multimodal` | Request body |
| `X-Safebox-Compute-Ms` | `142` | Measured by adapter |
| `X-Safebox-Capacity-Hint` | `available` | Adapter judgment |
| `X-Safebox-Cache-Hit` | `true` | Whether KV checkpoint was used |
| `X-Safebox-Cache-Tokens-Reused` | `1024` | Tokens from cached KV |
| `X-Safebox-KV-Checkpoint-Id` | `kv-a1b2c3` | If KV was saved |
| `X-Safebox-KV-Tier` | `ram` | Tier of saved KV |

---

## 9. Error Handling

The U binary should return standard HTTP status codes:

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (malformed JSON, invalid parameters) |
| 404 | Checkpoint not found (for KV operations) |
| 500 | Internal error (inference failure, OOM) |
| 503 | Model not loaded / not ready |

Error responses:
```json
{
  "ok": false,
  "error": "Human-readable error message",
  "code": "CHECKPOINT_NOT_FOUND"
}
```

Error codes for KV operations:
- `CHECKPOINT_NOT_FOUND` — requested checkpoint ID doesn't exist in RAM
- `KV_OOM` — not enough RAM for the requested operation
- `FORK_FAILED` — fork() failed (usually resource limits)
- `GRAFT_INCOMPATIBLE` — source and target have no shared prefix

---

## 10. Cross-Reference

- **Runner adapter source:** `model-runners/u-omni/runner.py`
- **Shared HMAC auth:** `model-runners/safebox_auth.py`
- **System component auth:** `aws/scripts/components/system/auth.js`
- **Wire protocol spec:** `docs/MODEL-RUNNER-API-SPEC.md`
- **Model catalog:** `docs/MODEL-CATALOG.md`
- **U ML stack docs:** U repo — `AI.md`, `Library.md`, `Python.md`, `Dataframe.md`
