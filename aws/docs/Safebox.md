# Safebox.md — How Safebox Talks to the System Component

> Audience: the Safebox plugin team and anyone wiring Safebox Node into a Safebox AMI. Wire field reference lives in [`SYSTEM-PROTOCOL.md`](SYSTEM-PROTOCOL.md) and [`MODELS-PROTOCOL.md`](MODELS-PROTOCOL.md); this document covers the transport, identity model, governance mapping, and worked examples.

---

## The model in one paragraph

The Safebox AMI runs one Node.js process called the **System component** as the unprivileged `safebox-infra` user. It listens on Unix domain sockets — one per managed container plus one control socket for host-scope operations. There is no TCP port. The socket file a connection arrives on determines the calling identity, and the System component verifies an HMAC signature using the key derived for that socket. Each per-container socket file and its corresponding key file are designed to be bind-mounted into exactly one Docker container, so the kernel — through the filesystem topology — enforces which container can claim which identity. Compromise of one container's filesystem yields one container's key, not any other's.

## Three layered defenses

Every cross-container call passes through three independent checks:

1. **Kernel layer — bind-mount topology.** A container can only connect to `/run/safebox/system.sock` inside its own filesystem. That path bind-mounts from a host-side socket file that ONLY that container can see. A different container has no path through which to reach foo's socket — there isn't one in its mount namespace.

2. **Crypto layer — per-container HMAC.** Each container has its own 32-byte HMAC key, derived deterministically from the AMI's master attestation secret via HKDF with a per-container info string. Foo's key and bar's key are cryptographically independent: leaking one tells you nothing about the other.

3. **Application layer — identity reconciliation.** The System component knows which socket received the call. If the request body claims to act on a different container, it's rejected with `WRONG_SOCKET`. Foo's socket cannot speak for bar even with a forged or stolen HMAC.

Each defense covers a different attack surface. The crypto layer protects against tampering and replay even from a container with legitimate access to its own socket. The kernel layer protects against any process not running inside the right container. The application layer is a sanity check that catches programming errors and provides defense in depth.

## Three execution scopes

```
                       Host-scope (_host)              Per-app (per container)
                       ─────────────────                ──────────────────────
   Transport:          /run/safebox/control.sock        /run/safebox/containers/
                       (control socket — HOST ONLY)     <name>.sock (bind-mounted
                                                        into THAT container only)
   HMAC key:           master                           per-container, HKDF-derived
   Operations:         dnf, /models/*, /containers/*    npm, pip, composer, cargo,
                                                        gem, git, test
   Where work runs:    Directly on the AMI as root      Inside the app's container
                       (sudo dnf, HTTPS fetch)          (sudo docker exec)
   Blast radius:       Every tenant on the box          One container
   Governance:         M-of-N, host quorum              M-of-N, per-app policy
                                                        (lower threshold acceptable)
```

## Filesystem layout

```
HOST:
  /run/safebox/
    control.sock                          ← host-only; controls _host scope
    containers/
      safebox-app-foo.sock                ← bind-mount target
      safebox-app-bar.sock                ← bind-mount target
      ...                                 (one per managed container)

  /etc/safebox/
    managed-containers.json               ← per-container ACLs
    system.hmac                           ← master key (mode 0640)
    containers/
      safebox-app-foo.hmac                ← per-container key, mode 0640
      safebox-app-bar.hmac                ← per-container key, mode 0640
      ...                                 (one per managed container)

INSIDE EACH CONTAINER (via bind mounts):
  /run/safebox/system.sock                ← from host's /run/safebox/containers/<name>.sock
  /etc/safebox/system.hmac                ← from host's /etc/safebox/containers/<name>.hmac
                                            (read-only)
```

When Safebox creates a new container via `/containers/create`, the System component:

1. Adds the container to `managed-containers.json`
2. Derives a fresh per-container HMAC key from the master via HKDF
3. Writes it to `/etc/safebox/containers/<name>.hmac` (mode 0640, owner `safebox-infra`)
4. Opens a new HTTP listener on `/run/safebox/containers/<name>.sock`
5. Returns the socket path, key path, and bind-mount hints in the response

The orchestrator (whichever component starts `docker run`) bind-mounts both into the container at the standard paths. The Safebox Node process inside the container reads its key from `/etc/safebox/system.hmac` and connects to `/run/safebox/system.sock` — the same conventional paths every container uses.

## Authentication

Every request carries an HMAC-SHA-256 signature. The envelope and headers are identical to what the prior TCP protocol used; only the transport changed.

Headers:

```
Authorization:        SafeboxHMAC v1
X-Safebox-Timestamp:  <unix-seconds>
X-Safebox-Nonce:      <16-byte hex random>
X-Safebox-Signature:  <hex sha256-hmac of envelope>
```

Envelope (bytes signed):

```
<timestamp>\n<nonce>\n<method>\n<path>\n<sha256-hex of body>
```

The System component:
- Reads the HMAC key for the socket the connection arrived on
- Rejects timestamps outside a 5-minute skew window
- Tracks the last 10 minutes of nonces and rejects replays
- Verifies the signature against the envelope

## managed-containers.json — the source of truth

```json
{
  "_host": {
    "imagePattern": "",
    "execContext": "host",
    "allowedActions": ["dnf"]
  },

  "safebox-app-safebox": {
    "imagePattern": "^qbix/app:.*$",
    "containerName": "safebox-app-safebox",
    "runUser": "safebox-app",
    "execContext": "container",
    "allowedActions": [
      "start", "stop", "status", "restart",
      "npm", "pip", "composer", "git",
      "zfs-snapshot", "zfs-rollback", "test"
    ],
    "zfsVolumes": {
      "platform": "zpool/app-safebox-platform",
      "app":      "zpool/app-safebox-data"
    }
  }
}
```

Field reference:

- `imagePattern` — regex applied to the `container` field of `/test` requests
- `execContext` — `"host"` (for `_host` only) or `"container"` (default). Per-container sockets are only created for containers with `execContext: "container"`.
- `containerName` — what `docker exec` targets. Defaults to the key.
- `runUser` — user inside the container that tools run as. Defaults to `safebox-app`.
- `allowedActions` — tool names for `/system`, literal `"test"` for `/test`, action names like `model-load`. Anything not in this list returns `FORBIDDEN_ACTION`.
- `zfsVolumes` — labeled ZFS dataset paths Safebox can snapshot/rollback.

## Connecting from Safebox Node

Inside any managed container, Safebox Node uses the standard paths:

```js
const SOCKET   = '/run/safebox/system.sock';   // bind-mounted from host
const KEY_PATH = '/etc/safebox/system.hmac';   // bind-mounted from host
```

Then HTTP-over-Unix-socket:

```js
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');

let cachedKey = null;
function loadKey() {
    if (cachedKey) return cachedKey;
    cachedKey = fs.readFileSync(KEY_PATH);
    if (cachedKey.length !== 32) throw new Error('expected 32-byte HMAC key');
    return cachedKey;
}

function sign(method, path, bodyStr) {
    const key = loadKey();
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bh = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
    const sig = crypto.createHmac('sha256', key)
        .update(`${ts}\n${nonce}\n${method}\n${path}\n${bh}`).digest('hex');
    return {
        'authorization':        'SafeboxHMAC v1',
        'x-safebox-timestamp':  ts,
        'x-safebox-nonce':      nonce,
        'x-safebox-signature':  sig,
    };
}

async function callSystem(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = sign(method, path, bodyStr);
    if (bodyStr) {
        headers['content-type']   = 'application/json';
        headers['content-length'] = Buffer.byteLength(bodyStr);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: SOCKET,        // ← the only line that's different from TCP
            method, path, headers,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(buf);
                    if (parsed.status === 'error') {
                        const e = new Error(parsed.message || 'system error');
                        e.code = parsed.code;
                        e.status = res.statusCode;
                        return reject(e);
                    }
                    resolve(parsed);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

module.exports = { callSystem };
```

Safebox Node never needs to know its own container name. The socket identity already says — the System component fills in `managedContainer` automatically. You can include it explicitly for clarity; if you do, it must match the socket identity or you'll get `WRONG_SOCKET`.

## Per-app operations: worked example

### Install dependencies

```js
await callSystem('POST', '/system', {
    tool:              'npm',
    action:            'install',
    containerWorkdir:  '/app',          // optional, defaults to /app
    packages:          ['lodash@4.17.21', 'express@4.18.0'],
    lockfileHash:      'abc123...',      // optional 64-char hex sha256
    timeoutSeconds:    600,              // optional, default 1800
});
```

Response on success:

```json
{
  "status": "ok",
  "data": {
    "tool": "npm",
    "action": "install",
    "stdout": "...",
    "stderr": "",
    "returncode": 0,
    "durationMs": 12345,
    "lockfileVerified": true
  }
}
```

If `lockfileHash` is provided and the post-install `package-lock.json` doesn't match, you get `LOCKFILE_HASH_MISMATCH`. The install DID happen — `npm install` wrote files. The mismatch means the resolved dependency tree drifted from what M-of-N approved. Safebox decides whether to roll back (via `zfs-rollback`) or accept the drift.

### Per-tool quick reference

| Tool       | Lockfile path           | Use case                       |
|------------|-------------------------|--------------------------------|
| `npm`      | `package-lock.json`     | Node packages in app container |
| `pip`      | `requirements.lock`     | Python packages (pip-tools)    |
| `composer` | `composer.lock`         | PHP packages (Qbix platform)   |
| `cargo`    | `Cargo.lock`            | Rust packages                  |
| `gem`      | (no lockfile mapping)   | Ruby gems                      |
| `git`      | (n/a)                   | clone/checkout/commit          |

Standard actions: `install`, `update`, `remove`, `list`, `outdated`. `git` has its own shape (`clone` needs `url`, `checkout` needs `ref`, `commit` needs `message`).

## Host-scope operations: from the control socket

The control socket is `/run/safebox/control.sock` on the host. It's NOT bind-mounted into any container. Only host processes (typically the System component itself or its orchestration helpers) can reach it.

### `dnf`: system package management

```js
// From a host-side orchestration process
await callOnControl('POST', '/system', {
    managedContainer: '_host',
    tool: 'dnf',
    action: 'install',
    packages: ['python3.12', 'docker-ce-26.1.4'],
});
```

Actions: `install`, `remove`, `upgrade`, `list`, `check-update`.

### Models: supply chain

```js
const manifest = {
    name:           'stable-audio-3-small',
    version:        '1.0.0',
    license:        'Stability-Community-License',
    runnerType:     'stable-audio-3',
    totalSizeBytes: 1837465600,
    files: [{
        path:      'model.safetensors',
        sizeBytes: 1837465600,
        sha256:    'abc123...',
        sources:   [
            'https://huggingface.co/stabilityai/stable-audio-3-small/resolve/main/model.safetensors',
            'https://safebots-models.s3.amazonaws.com/stable-audio-3-small/model.safetensors',
        ],
    }],
};
const manifestHash = sha256Hex(canonicalizeJson(manifest));

await callOnControl('POST', '/models/install', {
    managedContainer: '_host',
    manifestHash,
    manifest,
});
```

The System component:
1. Verifies `sha256(canonicalize(manifest)) === manifestHash`
2. Downloads each file from `sources` (trying each URL in order)
3. Verifies each file's SHA-256 against the manifest
4. Atomically renames the staging dir to `/srv/safebox/models/<manifestHash>/`

Already-installed models return `ALREADY_INSTALLED` without re-downloading.

### Container lifecycle

Adding a new managed app:

```js
const r = await callOnControl('POST', '/containers/create', {
    containerName: 'safebox-app-newapp',
    imagePattern:  '^qbix/app:.*$',
    runUser:       'safebox-app',
    allowedActions: ['start', 'stop', 'status', 'restart',
                     'npm', 'pip', 'composer', 'git',
                     'zfs-snapshot', 'zfs-rollback', 'test'],
    zfsVolumes: { app: 'zpool/app-newapp-data' },
});

// r.data:
// {
//   containerName: 'safebox-app-newapp',
//   socketPath:    '/run/safebox/containers/safebox-app-newapp.sock',
//   keyPath:       '/etc/safebox/containers/safebox-app-newapp.hmac',
//   bindMounts: {
//     socket: '/run/safebox/containers/safebox-app-newapp.sock:/run/safebox/system.sock',
//     key:    '/etc/safebox/containers/safebox-app-newapp.hmac:/etc/safebox/system.hmac:ro',
//   }
// }

// Then `docker run` with both bind mounts:
//   docker run -d --name safebox-app-newapp \
//     -v /run/safebox/containers/safebox-app-newapp.sock:/run/safebox/system.sock \
//     -v /etc/safebox/containers/safebox-app-newapp.hmac:/etc/safebox/system.hmac:ro \
//     qbix/app:1.0.0
```

Removing one:

```js
await callOnControl('POST', '/containers/destroy', {
    containerName: 'safebox-app-newapp',
});
```

The System component:
1. Removes the entry from `managed-containers.json`
2. Closes the listener for that socket
3. Removes the socket file from `/run/safebox/containers/`
4. Removes the key file from `/etc/safebox/containers/`

It does NOT stop the Docker container — that's the orchestrator's responsibility. After destroy, the container's Safebox Node will find its bind-mounted socket file gone, and any attempt to call `callSystem()` will fail with `ECONNREFUSED`.

### Listing

```js
const r = await callOnControl('GET', '/containers');
// r.data.containers = [
//   { containerName, imagePattern, runUser, allowedActions, listening, socketPath },
//   ...
// ]
```

## Embeddings

The System component forks a subprocess (`embeddingsWorker.js`) at startup that holds embedding models in memory and runs `@huggingface/transformers` inference. Containers with `'embed'` in their `allowedActions` can POST to `/embed` over their bind-mounted socket. The worker loads models from `/srv/safebox/models/<manifestHash>/` — the same directories `/models/install` populates — and `allowRemoteModels = false` enforces at the library level that nothing reaches out to HuggingFace Hub.

```js
await callSystem('POST', '/embed', {
    model:   'abc123...',          // manifestHash from /models/install
    inputs:  ['hello', 'world'],   // 1-64 strings
    pooling: 'mean',                // default mean
    normalize: true,                // default true
});
// → { dim: 384, count: 2, embeddings: [[...], [...]], durationMs: 87 }
```

The worker uses an LRU cache: models stay resident after first use, with a 2 GiB default budget. Beyond the budget, the least-recently-used model is evicted to make room for a new load. Explicit `POST /embed/unload {model}` is available when Safebox knows it's done with a model.

Inference runs in a forked subprocess, not the System component's main event loop, so an ONNX Runtime crash or a slow embed call doesn't affect `/system`, `/test`, or `/containers/*`. The master HMAC key never enters the worker's address space. On worker death, the parent respawns after a 2-second backoff; in-flight requests get `EMBEDDINGS_WORKER_RESTART`.

Full spec: [`EMBEDDINGS-PROTOCOL.md`](EMBEDDINGS-PROTOCOL.md).

## Suggested governance mapping

```
Safebox/system/npm-install/<app>     → M-of-N for that app's signers (lower threshold)
Safebox/system/git-clone/<app>       → same
Safebox/system/composer-update/<app> → same
Safebox/host/dnf-install             → host quorum (Safebots ops + auditors)
Safebox/host/dnf-upgrade             → host quorum (stricter)
Safebox/host/model-install           → host quorum
Safebox/host/container-create        → highest quorum — expands trust surface
Safebox/host/container-destroy       → host quorum
```

## Error codes

| Code                       | Meaning                                                            |
|----------------------------|--------------------------------------------------------------------|
| `BAD_REQUEST`              | Schema problem                                                     |
| `FORBIDDEN_ACTION`         | Action not in `allowedActions`, or dnf from non-`_host`            |
| `WRONG_SOCKET`             | Request body's `managedContainer` doesn't match calling socket     |
| `WORKSPACE_NOT_FOUND`      | Host workspace path doesn't resolve (migrate tool only)            |
| `IMAGE_NOT_ALLOWED`        | `/test` container doesn't match `imagePattern`                     |
| `TEST_NOT_FOUND`           | Unknown testId                                                     |
| `ALREADY_EXISTS`           | `/containers/create` for a name already declared                   |
| `NOT_FOUND`                | `/containers/destroy` for a name not declared                      |
| `TIMEOUT`                  | Tool exceeded `timeoutSeconds`                                     |
| `<TOOL>_OP_FAILED`         | Tool ran but returned non-zero (e.g., `NPM_OP_FAILED`)             |
| `LOCKFILE_HASH_MISMATCH`   | Post-install lockfile didn't match `lockfileHash`                  |
| `LOCKFILE_READ_FAILED`     | Couldn't read lockfile from container                              |
| `NO_LOCKFILE_DEFINED`      | Tool has no lockfile mapping (e.g., gem)                           |
| `MANIFEST_HASH_MISMATCH`   | `/models/install` payload's manifest doesn't hash to declared      |
| `FILE_HASH_MISMATCH`       | Downloaded model file's SHA-256 didn't match manifest              |
| `ALREADY_INSTALLED`        | `/models/install` with a manifestHash already present              |
| `MODEL_IN_USE`             | `/models/remove` while a runner is using the model                 |
| `MODEL_NOT_INSTALLED`      | `/embed` references a hash that's not under `/srv/safebox/models/` |
| `MODEL_EXCEEDS_BUDGET`     | `/embed` model larger than `EMBEDDINGS_MEMORY_BUDGET_MB`           |
| `EMBEDDINGS_WORKER_RESTART`| Worker subprocess died mid-`/embed`; respawn in progress (HTTP 503)|
| `EMBEDDINGS_TIMEOUT`       | `/embed` worker didn't respond within timeout (HTTP 504)           |
| `UNAUTHORIZED`             | HMAC signature didn't match, or replay nonce / clock skew          |
| `INTERNAL_ERROR`           | System component bug                                               |

## Migration from the prior TCP protocol

If you've been integrating against an earlier TCP-based version:

- **Transport changed.** The System component no longer listens on `127.0.0.1:7780`. Replace `host: '127.0.0.1', port: 7780` with `socketPath: '/run/safebox/system.sock'` in HTTP requests from inside a container, or `socketPath: '/run/safebox/control.sock'` from host-side orchestration code.
- **Keys are now per-container.** Each container reads from `/etc/safebox/system.hmac` (bind-mounted from the host's `/etc/safebox/containers/<name>.hmac`). Host-side orchestration code reads from `/etc/safebox/system.hmac` (the master).
- **New error: `WRONG_SOCKET`.** Returned when a request body's `managedContainer` doesn't match the socket identity. Inside a container, you usually don't need to set `managedContainer` at all — the System component fills it in.
- **New endpoints: `/containers/create`, `/containers/destroy`, `GET /containers`.** Reachable only from the control socket. The lifecycle for managing apps.
- **`/test` is only reachable from per-container sockets** (tests run in clones of THAT container's data).
- **`/models/*` is only reachable from the control socket** (models are host-scope).
- **HMAC envelope, header names, error codes, the canonical signing string, and the HKDF info string `safebox-gateway-hmac-v1` are unchanged.** Bring your existing HMAC code over verbatim; only the transport opening changes.
