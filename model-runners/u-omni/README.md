# U-Omni Runner

**Native multimodal inference via the U runtime, with tree-structured KV cache management.**

## Architecture

```
Safebox System Component          This Runner (FastAPI)            U Binary
──────────────────────           ────────────────────            ─────────
POST /v1/chat           ───►     HMAC verify                    
                                 proxy to U binary        ───►  fork() → CoW KV
                                                                inference in child
                                                          ◄───  response
                                 KV tree bookkeeping      
                          ◄───   response + headers

POST /v1/kv/save        ───►     tier decision
                                 if zfs: zfs snapshot
                                 tell U binary to save    ───►  kv_save()
                          ◄───   checkpoint metadata

POST /v1/kv/fork        ───►     if ram: tell U binary    ───►  fork() → CoW
                                 if zfs: zfs clone
                          ◄───   new checkpoint in tree
```

## Two-Tier KV Cache

The U runtime manages KV caches across two copy-on-write tiers:

**RAM (fork, ~0.1ms):** The hot path for active inference. Model weights live in shared memory (mmap, read-only). Each request fork()s the process; the child gets a CoW copy of the KV cache, runs inference, responds, and exits. The child's KV cache evaporates on exit unless explicitly saved.

**ZFS (snapshot/clone, ~1ms):** The cold path for persistence. Save a KV cache when it's worth keeping — a processed document, a system prompt, a conversation you want to resume tomorrow. ZFS snapshots are instant and clones share all blocks with the original.

They compose in sequence:

1. Boot → mmap weights from ZFS (read-only, all processes share)
2. Load system prompt KV from ZFS (pre-computed last boot)
3. Request → fork() → child gets CoW of weights + system KV
4. Child runs inference, extends KV in RAM
5. If worth keeping → save KV to ZFS before exit
6. ZFS snapshot → branching point for future requests

## KV Cache Tree

Multiple forks from the same parent share all original pages (RAM) or blocks (ZFS). A tree of 100 branches from a shared system prompt costs roughly `(system_prompt_KV + 100 × delta_KV)`, not `100 × full_KV`.

```
            [system-prompt]          ← pre-computed at boot, on ZFS
               /       \
      [user-A-turn-1] [user-B-turn-1]   ← forked in RAM, ~0ms marginal cost
         /     \           \
  [A-turn-2] [A-alt]   [B-turn-2]       ← further branches
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/kv/save` | POST | Save current KV state as a named checkpoint |
| `/v1/kv/load` | POST | Restore a checkpoint for the next inference call |
| `/v1/kv/fork` | POST | Fork from a checkpoint (RAM CoW or ZFS clone) |
| `/v1/kv/graft` | POST | Graft source's extension onto target's prefix |
| `/v1/kv/promote` | POST | Move a RAM checkpoint to ZFS (persist to disk) |
| `/v1/kv/evict` | POST | Free RAM copy, keep only ZFS backing |
| `/v1/kv/checkpoint/{id}` | DELETE | Delete a checkpoint (cascade=true for subtree) |
| `/v1/kv/checkpoints` | GET | List checkpoints (filter by parentId, tier) |
| `/v1/kv/tree` | GET | Full tree as nested JSON |
| `/v1/kv/stats` | GET | Memory/storage usage for both tiers |

### Per-Request KV Control (Headers)

Standard `/v1/chat` requests can opt into KV management via headers:

- `X-Safebox-KV-Checkpoint: <id>` — start inference from this cached state
- `X-Safebox-KV-Save: <name>` — save the resulting KV after inference
- `X-Safebox-KV-Tier: ram|zfs|auto` — which tier to save to

Without these headers, requests use the default hot path: fork, infer, exit.

## Hardware Requirements

Depends on the model loaded into the U binary. The runner adapter itself is lightweight (Python + FastAPI, ~50MB RAM). The U binary and model weights are the real resource consumers.

For DeepSeek V4.1 Flash with 128K context:
- ~890 bytes/token KV cache (MLA compression)
- ~110MB KV state at full context
- 4× H100 80GB minimum for weights

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `RUNNER_ID` | `safebox-u-omni-1` | Runner identifier |
| `SERVICE_ID` | `u-omni-1` | Service identifier |
| `U_BINARY_PATH` | `/usr/local/bin/u-omni` | Path to U runtime binary |
| `U_SOCKET_PATH` | `/run/safebox/u-omni.sock` | U binary's Unix socket |
| `KV_RAM_LIMIT_MB` | `8192` | Max RAM for KV cache tree |
| `KV_ZFS_DATASET` | `safebox-pool/data/kv-cache` | ZFS dataset for persistent KV |
| `KV_AUTO_PROMOTE_MB` | `512` | Auto-promote to ZFS above this size |
| `SAFEBOX_REQUIRE_HMAC` | `false` | Require HMAC auth (true in production) |

## Runner Contract

This runner follows the standard Safebox runner contract:

- Exposes HTTP on `127.0.0.1:7790` (or Unix socket)
- `/v1/healthz` for system component probing
- `/v1/capabilities` for feature discovery
- `/v1/capacity` for load balancing
- HMAC auth via shared `safebox_auth.py` (strong canonical form)
- All responses include `X-Safebox-*` telemetry headers
