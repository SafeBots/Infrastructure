# EMBEDDINGS-PROTOCOL.md — `/embed` over per-container sockets

> Wire spec for the embeddings endpoint family exposed by the System component. Reachable from per-container Unix sockets only. Same HMAC envelope, same identity model, same governance approach as `/system` and `/test`.

---

## TL;DR

The System component forks a subprocess (`embeddingsWorker.js`) at startup that holds embedding models in memory and runs inference via `@huggingface/transformers`. From inside any managed container that has `'embed'` in its `allowedActions`, Safebox Node POSTs to `/embed` over the bind-mounted `/run/safebox/system.sock` and gets back a list of vectors. Models must already be installed via `/models/install` — the worker has no network access for model fetching and `allowRemoteModels = false` enforces that at the library level.

## Why a subprocess

The System component holds the master HMAC key in memory; that key derives every per-container HMAC key. Anything that can read the System component's process memory can impersonate any container. ONNX Runtime is a multi-megabyte native binary doing JIT codegen on tensor operations. The probability of an exploitable bug in there over a multi-year horizon is nonzero. Keeping inference out of the System component's address space turns "ONNX bug becomes master key compromise" into "ONNX bug becomes embedding worker crash, supervised respawn." The IPC overhead is ~1ms per request, against 50-200ms inference. The tradeoff is clear.

A secondary benefit: the worker gets its own memory accounting. The default systemd memory ceiling for the System component is 4 GiB (raised from 512 MiB to accommodate the worker as a child process). If a runaway model load were to happen in-process, it would compete with the request-handler heap. In a subprocess, the failure is isolated and the parent can detect it via the `exit` event, log it, and respawn.

## Endpoints

All four reachable from per-container sockets only. Control socket returns `WRONG_SOCKET 403`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/embed` | Synchronous embedding |
| `POST` | `/embed/unload` | Force-evict a model from the worker's cache |
| `GET`  | `/embed/models` | List currently loaded models |
| `GET`  | `/embed/health` | Worker pid, memory, budget |

## Authentication, identity, governance

No different from any other per-container call:

- HMAC-SHA-256 over the canonical envelope, verified against the per-container key
- The socket the connection arrived on determines the calling identity (kernel-enforced)
- Request body's `managedContainer` field (if present) must match the socket identity
- `'embed'` must be in `managedContainers.json`'s `allowedActions` for that container

A container without `'embed'` in `allowedActions` gets `FORBIDDEN_ACTION` regardless of what model it requests. Default for a new container is no embedding access; the action has to be explicitly granted at `/containers/create` time, which goes through Safebox's M-of-N governance.

## `POST /embed`

Request:

```json
{
  "managedContainer": "safebox-app-foo",   // optional; filled in from socket identity
  "model":     "<64-char hex manifestHash>",
  "task":      "feature-extraction",        // optional, default "feature-extraction"
  "inputs":    ["text 1", "text 2", "..."], // 1-64 strings, each ≤8192 chars
  "pooling":   "mean",                       // "mean" | "cls" | "none"; default "mean"
  "normalize": true                          // default true; L2-normalize the output
}
```

The `model` field is the manifest hash from `/models/install` — the directory name under `/srv/safebox/models/`. The worker calls `pipeline(task, model)` against transformers.js, which resolves the model id relative to its configured `localModelPath = '/srv/safebox/models/'`. Models that aren't on disk yield `MODEL_NOT_INSTALLED 404`; the worker never downloads anything from the network.

Successful response (HTTP 200):

```json
{
  "status": "ok",
  "data": {
    "model":      "<hash>",
    "task":       "feature-extraction",
    "pooling":    "mean",
    "normalize":  true,
    "dim":        384,
    "count":      2,
    "embeddings": [
      [0.0234, -0.0118, ..., 0.0457],   // 384 floats for first input
      [0.0331,  0.0091, ..., 0.0098]    // 384 floats for second input
    ],
    "durationMs": 87
  }
}
```

When `pooling: "none"`, each input's embedding is an array-of-arrays (per-token vectors) instead of a single vector, and `dim` reflects the per-token dim.

## `POST /embed/unload`

Request:

```json
{
  "managedContainer": "safebox-app-foo",
  "model":            "<hash>"
}
```

Response:

```json
{ "status": "ok", "data": { "unloaded": true, "freedBytes": 22483456 } }
```

If the model wasn't loaded, returns `{ "unloaded": false, "reason": "not_loaded" }` with `status: "ok"`. Use this when you've finished a batch of work with a particular model and want to release its memory immediately instead of waiting for LRU eviction. The default LRU policy already does the right thing under memory pressure; explicit unload is for cases where Safebox knows better than the cache (e.g., "we just finished re-indexing, free the multilingual embedder").

## `GET /embed/models`

Response:

```json
{
  "status": "ok",
  "data": {
    "models": [
      { "model": "abc...", "task": "feature-extraction", "sizeBytes": 22483456, "lastUsedMs": 1738291200000 },
      { "model": "def...", "task": "feature-extraction", "sizeBytes": 134217728, "lastUsedMs": 1738291245000 }
    ],
    "totalBytes":         156701184,
    "budgetBytes":        2147483648,
    "transformersReady":  true,
    "transformersError":  null
  }
}
```

The model `sizeBytes` is the on-disk size used as a proxy for resident memory — for ONNX models this is close (the weights ARE the resident memory, plus a small fixed runtime overhead).

## `GET /embed/health`

Response:

```json
{
  "status": "ok",
  "data": {
    "running":           true,
    "pid":               1234,
    "uptimeSeconds":     3672,
    "loadedCount":       2,
    "totalBytes":        156701184,
    "budgetBytes":       2147483648,
    "rss":               198432768,
    "transformersReady": true
  }
}
```

If the worker subprocess isn't running (initial fork failed, crashed and respawn backoff hasn't fired yet), returns `{ "running": false }` with `status: "ok"`.

## LRU cache policy

Models stay in worker memory after first use. Each load takes 200ms-5s depending on model size and disk speed; subsequent calls hit the cached pipeline and run inference directly.

When loading a new model would push `totalBytes + neededBytes` above `EMBEDDINGS_MEMORY_BUDGET_MB` (default 2048 MiB), the worker evicts the least-recently-used model. Eviction continues until there's room or until only the model being loaded would remain.

A model whose size exceeds the budget on its own returns `MODEL_EXCEEDS_BUDGET 507` and is not loaded. Adjust the budget via the systemd unit override or environment variable.

## Worker lifecycle

The worker is forked at System component startup, eagerly. If transformers.js fails to initialize (broken install, missing native binary), the worker still starts and answers `/embed/health` and `/embed/models` with `transformersReady: false` and an error message — but `/embed` requests fail.

On unexpected exit (crash, OOM kill, segfault from ONNX Runtime), the parent waits 2 seconds and forks a new worker. In-flight `/embed` requests at the moment of exit return `EMBEDDINGS_WORKER_RESTART 503`. New requests during the backoff window also fail; once the new worker is up, requests succeed normally. Worker exits are audit-logged via the existing System component audit pipeline (`journalctl -t safebox-system`).

On `SIGTERM` (server shutdown), the worker is killed and respawn is suppressed.

## Bootstrap & supply chain

`@huggingface/transformers` is installed at AMI build time via `install-system.sh`:

```bash
npm ci --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip
```

The `--onnxruntime-node-install-cuda=skip` flag is required because `onnxruntime-node`'s post-install otherwise tries to download CUDA binaries from `github.com/microsoft/onnxruntime/releases/...`, which (a) fails in restricted-egress environments and (b) we don't want anyway since AMIs without GPUs shouldn't have CUDA artifacts taking up space. CPU inference works fine — that's what we want for embeddings.

The `package-lock.json` is checked in. Auditors read it to see exactly which versions of which packages are installed. `npm ci` (not `npm install`) is used so the lockfile is the source of truth — any drift between `package.json` and `package-lock.json` causes the install to fail loudly.

Upgrading `@huggingface/transformers` is the same M-of-N path as upgrading any other npm dependency: a PR that bumps the version in `package.json` and regenerates `package-lock.json` via `npm install --package-lock-only`, reviewed by M-of-N signers, then the new AMI is built. There's no runtime npm install for System component dependencies — those changes flow through the AMI build process exclusively.

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `BAD_REQUEST` | 400 | Schema problem (bad hash, empty inputs, oversized inputs, unknown pooling/task) |
| `FORBIDDEN_ACTION` | 403 | `'embed'` not in container's `allowedActions` |
| `WRONG_SOCKET` | 403 | Request body's `managedContainer` doesn't match socket identity |
| `MODEL_NOT_INSTALLED` | 404 | No directory at `/srv/safebox/models/<hash>/` |
| `NOT_FOUND` | 404 | Unknown `/embed/*` sub-path |
| `EMBEDDINGS_WORKER_RESTART` | 503 | Worker died mid-request; respawn in progress |
| `EMBEDDINGS_WORKER_UNAVAILABLE` | 503 | IPC channel broken; usually paired with a respawn |
| `EMBEDDINGS_TIMEOUT` | 504 | Worker didn't respond within `EMBEDDINGS_REQUEST_TIMEOUT_MS` (default 120s) |
| `MODEL_EXCEEDS_BUDGET` | 507 | Single model larger than configured budget |
| `TASK_MISMATCH` | 500 | Model already loaded for a different task (load it as task X, then asked for task Y) |
| `MODEL_LOAD_FAILED` | 500 | transformers.js failed to load the model (corrupt files, unsupported architecture) |
| `INTERNAL_ERROR` | 500 | Anything else |

## Configuration knobs (via systemd unit `Environment=` or override)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SAFEBOX_MODELS_ROOT` | `/srv/safebox/models` | Where the worker looks for installed models |
| `EMBEDDINGS_MEMORY_BUDGET_MB` | `2048` | LRU eviction threshold (total resident across all loaded models) |
| `EMBEDDINGS_THREADS` | `4` | ONNX Runtime intra-op thread count (capped at CPU count) |
| `EMBEDDINGS_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout for IPC round trip |

## Worked example: from container to embedding

```js
// Inside container safebox-app-foo, which has 'embed' in its allowedActions.
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');

const KEY = fs.readFileSync('/etc/safebox/system.hmac');  // bind-mounted from host
const SOCK = '/run/safebox/system.sock';                  // bind-mounted from host

function sign(method, path, bodyStr) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bh = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
    const sig = crypto.createHmac('sha256', KEY)
        .update(`${ts}\n${nonce}\n${method}\n${path}\n${bh}`).digest('hex');
    return {
        'authorization':       'SafeboxHMAC v1',
        'x-safebox-timestamp': ts,
        'x-safebox-nonce':     nonce,
        'x-safebox-signature': sig,
    };
}

async function embed(modelHash, texts) {
    const body = JSON.stringify({ model: modelHash, inputs: texts });
    return new Promise((resolve, reject) => {
        const headers = Object.assign(sign('POST', '/embed', body), {
            'content-type':   'application/json',
            'content-length': Buffer.byteLength(body),
        });
        const req = http.request({
            socketPath: SOCK, method: 'POST', path: '/embed', headers,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                const parsed = JSON.parse(buf);
                if (parsed.status === 'error') {
                    return reject(Object.assign(new Error(parsed.message), { code: parsed.code }));
                }
                resolve(parsed.data);
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    const result = await embed('abc123...', [
        'The quick brown fox jumps over the lazy dog.',
        'Embeddings let you compare meanings, not just words.',
    ]);
    console.log(result.dim);              // e.g. 384
    console.log(result.embeddings[0][0]); // first dim of first text
})();
```

## Threat model: what doesn't this protect against

A few things to be honest about:

- **Side-channel inference of input content.** The worker logs request metadata (model hash, input count, duration) to the audit pipeline. It does NOT log input text. But ONNX Runtime's timing might leak information about input content to any process that can observe CPU/cache behavior on the same host. If your threat model includes co-tenant timing attacks, embeddings aren't safe to call from sensitive contexts.

- **Model poisoning via the supply chain.** If M-of-N approves an installation of a model that was crafted to produce embeddings designed to look correct but actually leak information (e.g., embed a specific token sequence that hashes to a known value, allowing an attacker to identify documents), the worker has no way to detect that. Trust in the manifest hash is trust in the M-of-N reviewers' judgment about which models to install.

- **Compromised container reading another container's plaintext via embeddings.** A container can only call `/embed` on its own socket, so it can only embed its own data — there's no cross-container read path. But two containers using the same model produce embeddings in the same vector space; if one container can observe another container's inputs by some side channel and produces matching embeddings, it can correlate. This is true of any shared embedding model and isn't specific to this architecture.

- **Worker memory contains plaintext during inference.** While a `/embed` call is running, the input strings are in the worker's heap. A process with `/proc/<pid>/mem` access (root, or `safebox-infra` with `ptrace`) can read them. The systemd unit hardening (`PrivateTmp`, `ProtectKernelTunables`, no capabilities) makes this hard but not impossible. If embedding inputs are highly sensitive, consider running the workload in an actual Nitro Enclave where the host can't read worker memory at all.

- **Worker runs as same user as the System component (`safebox-infra`).** The forked worker inherits the parent's UID, which means filesystem-wise the worker CAN read `/etc/safebox/system.hmac` (the master HMAC key) — it's mode 0640 owned by `safebox-infra-readers`. The worker code doesn't try to read it, but a hypothetical ONNX Runtime RCE that achieves arbitrary file read inside the worker process could exfiltrate the master, derive every per-container key, and impersonate any container to the System component. A stronger isolation would run the worker as a dedicated unprivileged user (e.g., `safebox-embed`) with no read access to `/etc/safebox/`. That requires either a second systemd unit invoking the worker, or the parent having `CAP_SETUID` to drop privileges before fork — both are noticeably more complex than the current setup. The current design accepts this risk because (a) the model files are downloaded via the M-of-N-gated `/models/install` path so malicious bytes shouldn't reach ONNX in the first place, and (b) we're at v1 — the dedicated-user split is a known-good v2 hardening.
