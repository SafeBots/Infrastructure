# System Protocol — v1.0

> Wire spec for `Safebox.Protocol.System` and `Safebox.Protocol.Test`. This is what Safebox Node calls when a workflow step needs to run a privileged operation on the Linux host.

> **Transport update**: in v1.0, the System component listens on per-container Unix domain sockets rather than the loopback TCP port shown in older diagrams below. See [`Safebox.md`](Safebox.md) for the current transport model. The wire format (HMAC envelope, headers, signing string, JSON schemas, error codes) is unchanged — only the connection setup differs.

---

## TL;DR

One Node process on the host (the **System component**) listens on Unix domain sockets — one per managed container at `/run/safebox/containers/<name>.sock` (bind-mounted into that container at `/run/safebox/system.sock`) plus one control socket at `/run/safebox/control.sock` for host-scope operations. Safebox Node sends HMAC-signed JSON over HTTP, the System component executes the underlying tool (npm, dnf, git, docker, etc.) with the right privileges, and returns the result. Long-running test environments use a keepalive pattern: aggressive teardown after 60s of silence unless Safebox keeps pinging.

There is no daemon to install separately. The System component IS the Infrastructure-side API. There is no shell-script invocation contract for Safebox to honor. Everything goes through HTTP-over-Unix-socket.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Container: safebox-app-foo                                             │
│                                                                        │
│  Safebox Node (PHP plugin invokes; orchestrator handles workflows)     │
│    │                                                                   │
│    │  HTTP POST / GET, HMAC-signed body or query                       │
│    ▼                                                                   │
│  /run/safebox/system.sock (bind-mounted from host)                     │
└────────────────────────────────────────────────────────────────────────┘
                              │ (per-container Unix socket — no TCP)
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Infrastructure System component (Node, runs as `safebox-infra` user)   │
│                                                                        │
│   - Identify caller from arrival socket (kernel-enforced)              │
│   - HMAC verify against per-container key (timing-safe)                │
│   - Schema validate                                                    │
│   - Reconcile request.managedContainer vs socket identity              │
│   - Check (managedContainer, action) against managed-containers.json   │
│   - execFile(/usr/bin/<tool>, [argv]) — or sudo for privileged ops     │
│   - For /test: hold the watchdog timer, ring-buffer the yields         │
│   - Audit-log every request to journal (tag: safebox-system)           │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  /usr/bin/{npm,pip,cargo,gem,composer,git}
                  /usr/bin/sudo /usr/bin/dnf
                  /usr/bin/sudo /usr/sbin/zfs
                  /usr/bin/sudo /usr/bin/docker
```

---

## Authentication

Every request carries an HMAC-SHA-256 signature over a canonical envelope. The shared secret is provisioned at deployment time and lives in `/etc/safebox/system.hmac` (mode `0640`, group `safebox-infra-readers`, readable by both the System component and the Safebox Node user).

### Signing

The signed payload is the canonical envelope:

```
<timestamp>\n<nonce>\n<method>\n<path>\n<body-sha256-hex>
```

- `timestamp` — unix seconds when the request was created
- `nonce` — 16-byte random string, hex-encoded (32 chars). Used for replay protection
- `method` — `GET`, `POST`, `DELETE`
- `path` — request path including query string, e.g. `/test/abc123/yields?since=42`
- `body-sha256-hex` — `sha256` of the request body, hex-encoded; for `GET` and other bodyless requests, the hex of `sha256("")` which is `e3b0c44...855`

The signature goes in the request headers:

```
Authorization: SafeboxHMAC v1
X-Safebox-Timestamp: 1747850000
X-Safebox-Nonce: 5f3a8c1b9d2e7f0a4b6c8d1e3f5a7b9c
X-Safebox-Signature: <hex>
```

### Verification rules (System component side, for reference)

1. Reject if `|now - timestamp| > 300` seconds (5-minute clock skew window)
2. Reject if nonce already seen in the last 10 minutes (in-memory LRU, ~10k entries)
3. Reconstruct the canonical envelope; recompute HMAC with `timingSafeEqual`
4. If mismatch, reject with `401`. No "wrong signature" hint — just `{"error":"unauthorized"}`

### Node example (Safebox side)

```js
const crypto = require('crypto');

function signRequest(method, path, body, secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
    const canonical = `${ts}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
    const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    return {
        'Authorization': 'SafeboxHMAC v1',
        'X-Safebox-Timestamp': ts,
        'X-Safebox-Nonce': nonce,
        'X-Safebox-Signature': sig
    };
}
```

---

## Common envelope

### Request body (POST)

Every POST has an `op` field at top level and operation-specific fields beside it:

```json
{
    "op": "<operation-name>",
    "managedContainer": "safebox-app-safebox",
    "allowlistVersion": "1747850000:abc123",
    "tenantHint": "community-XYZ",
    "...op-specific fields..."
}
```

- `managedContainer` — required. Must be a key in `managed-containers.json`. The System component looks up that container's `allowedActions` and rejects if the op is not in the list.
- `allowlistVersion` — optional, opaque audit field. Echoed into journal for forensic correlation.
- `tenantHint` — optional, opaque audit field. Echoed into journal.

### Response (success)

```json
{
    "status": "ok",
    "data": { /* operation-specific */ }
}
```

### Response (failure)

```json
{
    "status": "error",
    "code": "<MACHINE_READABLE_CODE>",
    "message": "<human-readable explanation>"
}
```

HTTP status codes:
- `200` — operation completed (check `status` field for ok/error)
- `400` — request schema invalid
- `401` — HMAC failure
- `403` — `managedContainer` not allowed to do the requested action
- `404` — for test endpoints, no env with that id
- `409` — replay (nonce already seen)
- `500` — system internal error

---

## /system — synchronous tool invocation

Used for package management (npm/pip/cargo/gem/composer/dnf), version control (git), database migrations (`migrate`), and ZFS operations (`zfs-snapshot`, `zfs-rollback`).

**Synchronous**: the HTTP connection blocks until the tool finishes, up to a per-op timeout (default 1800s for package managers, 60–600s for ZFS). Safebox should set an HTTP client timeout matching this.

### Per-app vs host actions

Actions split by scope:

- **Per-app actions** (npm, pip, cargo, gem, composer, git, migrate, zfs-snapshot, zfs-rollback, test) operate on one container's filesystem or one container's ZFS volumes. They require a `workspaceRoot` that resolves under `/srv/encrypted/apps/<container>/` or one of the container's declared `zfsVolumes`. Any real `managedContainer` may declare these in its `allowedActions`.

- **Host actions** (dnf) operate on the AMI itself — PHP, nginx, the kernel, docker. They have no `workspaceRoot`. **The only managedContainer allowed to invoke a host action is `_host`**, a pseudo-container declared at the top of `managed-containers.json`. A request like `{"managedContainer": "safebox-app-safebox", "tool": "dnf"}` is rejected with `FORBIDDEN_ACTION` even if `dnf` somehow ends up in that app's `allowedActions` — the scope check happens before the allowlist check.

The separation exists because `dnf upgrade` updates PHP for every app on the box at once. That's a different blast radius than `safebox-app-X` updating its own lodash, and probably needs different M-of-N governance on the Safebox side. Splitting them at the wire makes the governance gate explicit.

Future host-wide actions (pool-level zfs, reboot, time sync) will follow the same pattern: declared on `_host`, refused on real containers.

### `POST /system`

```json
{
    "op": "system",
    "managedContainer": "safebox-app-safebox",
    "tool": "npm",
    "action": "update",
    "workspaceRoot": "/srv/encrypted/apps/safebox-app/data",
    "packages": ["lodash@4.17.21", "express@4.19.2"],
    "timeoutSeconds": 600,
    "allowlistVersion": "1747850000:abc123",
    "tenantHint": "community-XYZ"
}
```

- `tool` — one of `npm`, `pip`, `cargo`, `gem`, `composer`, `dnf`, `git`, `migrate`, `zfs-snapshot`, `zfs-rollback`
- `action` — tool-specific (see below)
- `workspaceRoot` — required for tools that operate on a workspace (everything except `dnf`, `zfs-*`). Must resolve under `/srv/encrypted/apps/` or be a `zfsVolumes` path declared in `managed-containers.json` for this container
- `packages` — required for mutating package-manager actions
- `timeoutSeconds` — optional, default 1800, max 3600

### Per-tool action vocabulary

| Tool       | Actions                                                            | Notes                                                            |
|------------|--------------------------------------------------------------------|------------------------------------------------------------------|
| `npm`      | `install` `update` `remove` `list` `outdated`                      | Always with `--ignore-scripts --save-exact`                      |
| `pip`      | `install` `update` `remove` `list` `outdated`                      | `--upgrade` for update                                           |
| `cargo`    | `install` `update` `remove` `list` `outdated`                      | Crate workspaces                                                 |
| `gem`      | `install` `update` `remove` `list` `outdated`                      |                                                                  |
| `composer` | `install` `update` `remove` `list` `outdated`                      | Always with `--no-scripts --no-interaction`                      |
| `dnf`      | `install` `update` `remove` `list` `check-update`                  | No `workspaceRoot`; system-wide. Exit code 100 mapped to success |
| `git`      | `status` `diff` `log` `branch` `checkout` `add` `commit` `clone` `pull` | `clone` uses `workspaceParent`+`url`; `checkout` needs `ref`     |
| `migrate`  | `run` `rollback` `status`                                          | Invokes `<workspaceRoot>/migrate.sh <action> [<target>]`         |
| `zfs-snapshot` | (no action)                                                    | Fields: `dataset`, `snapshotName`                                |
| `zfs-rollback` | (no action)                                                    | Fields: `snapshot`, `force?`                                     |

### Response

```json
{
    "status": "ok",
    "data": {
        "tool": "npm",
        "action": "update",
        "stdout": "<bounded to 64 KiB>",
        "stderr": "<bounded to 16 KiB>",
        "returncode": 0,
        "durationMs": 8412
    }
}
```

### Failure codes

- `BAD_REQUEST` — schema / field validation failed
- `FORBIDDEN_ACTION` — `managedContainer.allowedActions` does not include `tool`
- `WORKSPACE_NOT_FOUND` — `workspaceRoot` does not resolve, or escapes allowed prefix
- `<TOOL>_OP_FAILED` — underlying tool returned non-zero (e.g. `NPM_OP_FAILED`, `GIT_OP_FAILED`)
- `TIMEOUT` — exceeded `timeoutSeconds`
- `INTERNAL_ERROR` — system component bug

### Field validation regexes

Pre-validate on the Safebox side to return clean errors before signing:

```
package name   ^[a-zA-Z0-9_./@][a-zA-Z0-9_./@~^=<>!-]*$, len ≤ 256
               (leading char NOT '-' — defeats --registry=evil injection)
git ref        ^[a-zA-Z0-9._/][a-zA-Z0-9._/-]*$
git URL        ^(https|ssh)://… len ≤ 2048, no control chars
dataset        ^safebox-pool/[a-zA-Z0-9_./-]+$, len ≤ 256
snapshot ref   ^safebox-pool/[a-zA-Z0-9_./-]+@[a-zA-Z0-9_.-]+$, len ≤ 320
snapshotName   ^[a-zA-Z0-9_.-]{1,64}$
migrate target ^[a-zA-Z0-9._-]{1,256}$
```

---

## /test — long-running test environments

Used by Safebox's Test capability. The flow:

1. `POST /test` to create a test environment. Returns a `testId` immediately. The system component sets up a ZFS clone and starts a container in the background.
2. Send `POST /test/<testId>/keepalive` every 30 seconds while the workflow step is active.
3. Optionally poll `GET /test/<testId>/yields?since=<offset>` to read streaming stdout/stderr from the test container.
4. When the workflow step finishes, either:
   - Let keepalives stop. After 60s of silence the system component tears down the env automatically (clone destroyed, container killed, exit code captured).
   - Explicitly call `POST /test/<testId>/stop` for an immediate teardown with the same cleanup.
5. After teardown, `GET /test/<testId>` returns the final status, exit code, and the rest of the stdout/stderr buffer until garbage collection.

The default behavior is **aggressive teardown**. A workflow that crashes mid-step does not leak a container.

### `POST /test`

```json
{
    "op": "test",
    "managedContainer": "safebox-app-safebox",
    "container": "qbix/test-runner:python-3.11-v2",
    "sourceClone": "safebox-pool/encrypted/apps/safebox-app/data",
    "envVars": {
        "TEST_TIMEOUT": "300",
        "VERBOSE": "1"
    },
    "command": ["python", "-m", "pytest", "-q"],
    "keepaliveSeconds": 60,
    "maxLifetimeSeconds": 1800,
    "allowlistVersion": "1747850000:abc123",
    "tenantHint": "community-XYZ"
}
```

- `container` — must match the `imagePattern` regex on the `managedContainer`'s entry in `managed-containers.json`
- `sourceClone` — optional. If provided, the test env starts from a ZFS snapshot of this dataset (CoW). If omitted, an empty clone is created
- `envVars` — optional, ≤ 64 entries. Keys must match `^[A-Z][A-Z0-9_]{0,63}$`, values ≤ 8192 chars and no control characters
- `command` — optional. If provided, replaces the container's default `CMD`. Array of strings, ≤ 64 elements, each ≤ 4096 chars
- `keepaliveSeconds` — optional, default 60. Range 30–600. The system component tears down the env if no keepalive arrives within this many seconds
- `maxLifetimeSeconds` — optional, default 1800, max 3600. Absolute upper bound regardless of keepalives

**Response (synchronous, returns within ~1 second after the ZFS clone is set up):**

```json
{
    "status": "ok",
    "data": {
        "testId": "tst_5f3a8c1b9d2e7f0a",
        "createdAt": 1747850000,
        "keepaliveDeadline": 1747850060,
        "maxLifetimeDeadline": 1747851800
    }
}
```

If image is not in the allowlist for this `managedContainer`:
```json
{"status":"error","code":"IMAGE_NOT_ALLOWED","message":"container 'X' does not match imagePattern for managedContainer 'Y'"}
```

Other failure codes: `BAD_REQUEST`, `ZFS_SNAPSHOT_FAILED`, `ZFS_CLONE_FAILED`, `DOCKER_START_FAILED`.

### `POST /test/<testId>/keepalive`

Empty body or `{}`. Resets the keepalive deadline to `now + keepaliveSeconds`.

```json
{
    "status": "ok",
    "data": {
        "testId": "tst_5f3a8c1b9d2e7f0a",
        "keepaliveDeadline": 1747850090,
        "containerRunning": true
    }
}
```

If the test has already been torn down (timeout, explicit stop, or container exited): `404 TEST_NOT_FOUND`.

### `GET /test/<testId>/yields?since=<offset>`

Returns new stdout/stderr lines from the test container since `offset`. Bounded ring buffer of the last 4 MiB of output per test. Safebox can call this whenever — it does not affect the keepalive timer.

```
GET /test/tst_5f3a8c1b9d2e7f0a/yields?since=0
```

```json
{
    "status": "ok",
    "data": {
        "yields": [
            {"stream": "stdout", "offset": 0,   "text": "Running tests...\n"},
            {"stream": "stdout", "offset": 18,  "text": "test_foo PASSED\n"},
            {"stream": "stderr", "offset": 34,  "text": "warning: deprecated\n"}
        ],
        "nextOffset": 54,
        "truncated": false,
        "containerRunning": true
    }
}
```

`offset` is a cumulative byte position in the merged stdout+stderr stream, suitable for the next `since` parameter. `truncated: true` if the ring buffer dropped earlier output (Safebox polled too slowly); the offset is still consistent, just the gap is unrecoverable.

### `POST /test/<testId>/stop`

Empty body. Synchronous: blocks until the container is killed and the ZFS clone is destroyed (≤ 30 seconds).

```json
{
    "status": "ok",
    "data": {
        "testId": "tst_5f3a8c1b9d2e7f0a",
        "exitCode": 0,
        "stoppedAt": 1747850120,
        "reason": "explicit_stop"
    }
}
```

### `GET /test/<testId>`

Returns the current status without affecting keepalive.

```json
{
    "status": "ok",
    "data": {
        "testId": "tst_5f3a8c1b9d2e7f0a",
        "createdAt": 1747850000,
        "containerRunning": false,
        "exitCode": 0,
        "stoppedAt": 1747850120,
        "reason": "container_exited",
        "totalYieldBytes": 5400,
        "keepaliveDeadline": null,
        "maxLifetimeDeadline": 1747851800
    }
}
```

`reason` is one of: `container_exited`, `keepalive_timeout`, `max_lifetime`, `explicit_stop`, `container_oom`, `docker_died`.

Tests are retained for 10 minutes after they end, then garbage-collected. After GC, the endpoint returns `404 TEST_NOT_FOUND`.

---

## /models — model supply chain

Endpoints for installing, listing, verifying, and removing AI model weights. All restricted to `managedContainer: "_host"` — same blast radius as `dnf`, same governance gate on the Safebox side.

The full spec lives in [`MODELS-PROTOCOL.md`](MODELS-PROTOCOL.md). The short version:

- `POST /models/install` — pull weights from one or more HTTPS sources, verify each file's SHA-256 against the manifest, install atomically. Idempotent.
- `POST /models/list` — return installed manifest hashes, names, versions, sizes.
- `POST /models/{manifestHash}/verify` — re-hash every file on disk to detect bit rot or tampering.
- `POST /models/{manifestHash}/remove` — atomic delete.

Models are identified by the SHA-256 of their canonical (RFC 8785) manifest JSON. The hash is what Safebox M-of-N actually signs — a different model version produces a different hash and needs new approval. The system component rejects any install where `sha256(canonicalize(manifest)) !== manifestHash` before touching any download.

Installed models live at `/srv/safebox/models/<manifestHash>/`. The directory name is the manifest hash, so an auditor can re-derive provenance by hashing the bundled `manifest.json`.

---

## managed-containers.json — the allowlist

The system component reads `/etc/safebox/managed-containers.json` at startup and on `SIGHUP`. This file is the single source of truth for what each container can do. Already exists in the Infrastructure repo at `config/managed-containers.json`.

```json
{
    "safebox-app-safebox": {
        "imagePattern": "^qbix/app:.*$",
        "allowedActions": [
            "git", "composer", "npm", "pip", "cargo", "gem",
            "zfs-rollback", "zfs-snapshot", "test", "migrate"
        ],
        "zfsVolumes": {
            "platform": "zpool/app-safebox-platform",
            "app": "zpool/app-safebox-data"
        }
    },
    "safebox-app-intercoin": { ... }
}
```

- `allowedActions` — names map to `tool` values for `/system` and to literal `"test"` for `/test`. The system component rejects any request whose `tool` (or `op=test` for test) isn't listed
- `imagePattern` — only checked for `/test` requests. The `container` field of the request must match this regex
- `zfsVolumes` — alternate workspace roots besides `/srv/encrypted/apps/<container>`

**Update flow**: Operations team edits the file, runs `systemctl reload safebox-system` (SIGHUP). No request loss; in-flight ops finish under the old config, new ops use the new config.

---

## Streaming yields semantics (matches Safebox.yield in tools)

The `/test/<id>/yields` endpoint mirrors the semantics of `Safebox.yield` inside Safebox sandboxed tools: fire-and-forget streaming of intermediate values, accumulated in a ring buffer, polled by the orchestrator. Safebox can wire test yields into the same plumbing as in-sandbox `Safebox.yield` calls:

```js
// In Safebox Node, after creating a test:
async function pollYields(testId) {
    let offset = 0;
    while (test.containerRunning) {
        const r = await system.get(`/test/${testId}/yields?since=${offset}`);
        for (const y of r.data.yields) {
            await orchestrator.handleYield(testId, y);  // same as Safebox.yield
        }
        offset = r.data.nextOffset;
        if (!r.data.containerRunning) break;
        await sleep(500);  // adjust to taste
    }
}
```

Yields are included in the test's execution record but are NOT signed by the system component — they're stdout from arbitrary container code. Safebox treats them as data to display, not as authorities.

---

## Audit trail

The system component emits structured journal entries via `systemd-cat -t safebox-system`:

```json
{"event":"request","method":"POST","path":"/system","managedContainer":"safebox-app-safebox","tool":"npm","action":"update","allowlistVersion":"…","tenantHint":"…","durationMs":8412,"status":200}
{"event":"test_created","testId":"tst_…","managedContainer":"…","container":"…","keepaliveSeconds":60}
{"event":"test_torn_down","testId":"tst_…","reason":"keepalive_timeout","exitCode":-1}
{"event":"auth_fail","reason":"timestamp_skew|nonce_reuse|signature_mismatch","remoteAddr":"127.0.0.1"}
```

Forensic recovery:
```bash
journalctl -t safebox-system | jq 'select(.tenantHint == "<…>")'
```

---

## Test environments — full example

```js
// Safebox Node side (inside a container; both paths are bind-mounted from host)

const secret = fs.readFileSync('/etc/safebox/system.hmac');

async function callSystem(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = signRequest(method, path, bodyStr, secret);
    if (body) headers['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
        const req = require('http').request({
            socketPath: '/run/safebox/system.sock',
            method, path, headers,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function runTest(spec) {
    // 1. Create
    const created = await callSystem('POST', '/test', {
        op: 'test',
        managedContainer: 'safebox-app-safebox',
        container: 'qbix/test-runner:python-3.11-v2',
        sourceClone: 'safebox-pool/encrypted/apps/safebox-app/data',
        envVars: { TEST_TIMEOUT: '300' },
        command: ['python', '-m', 'pytest', '-q'],
        keepaliveSeconds: 60
    });
    if (created.status !== 'ok') throw new Error(created.message);
    const testId = created.data.testId;

    // 2. Start keepalive loop
    const keepaliveTimer = setInterval(async () => {
        try { await callSystem('POST', `/test/${testId}/keepalive`, {}); }
        catch (e) { /* test already dead */ clearInterval(keepaliveTimer); }
    }, 30_000);  // every 30s, well under the 60s timeout

    // 3. Stream yields and watch for completion
    let offset = 0;
    try {
        while (true) {
            const r = await callSystem('GET', `/test/${testId}/yields?since=${offset}`, null);
            if (r.status !== 'ok') break;
            for (const y of r.data.yields) {
                orchestrator.handleYield(testId, y);
            }
            offset = r.data.nextOffset;
            if (!r.data.containerRunning) break;
            await sleep(500);
        }
    } finally {
        clearInterval(keepaliveTimer);
    }

    // 4. Get final status
    const final = await callSystem('GET', `/test/${testId}`, null);
    return final.data;
}
```

---

## What Safebox needs to implement

1. **A small client module** (`Safebox.Protocol.System.js`) that handles HMAC signing, retries, and the keepalive loop. ~150 lines of Node. The example above is most of it.
2. **`Safebox.Protocol.System`** — wraps `/system` calls. Maps the existing `Protocol.System` actions (npm, git, dnf, etc.) to `tool` + `action` + `packages` in the JSON envelope.
3. **`Safebox.Protocol.Test`** — wraps `/test*` calls, keepalive loop, yields polling. Hooks into the orchestrator's existing `Safebox.yield` plumbing so test stdout streams the same way as sandboxed-tool yields.
4. **Config**: store the HMAC secret at `/etc/safebox/system.hmac` (group `safebox-infra-readers`, mode `0640`) at deployment time. Both Safebox Node and the System component read from there.

---

## What changes vs the prior protocol

If you've already built against the earlier shell-script-via-systemctl protocol:

- **Drop everything** about `/run/safebox/jobs/<jobid>.json`, `systemctl --no-block start safebox-op@<subsystem>:<jobid>.service`, polling for result files, polkit. None of that exists anymore.
- The System component is reachable via per-container Unix domain sockets. From inside a container: `socketPath: '/run/safebox/system.sock'`. From host-side orchestration: `socketPath: '/run/safebox/control.sock'`. Speak HMAC-signed JSON to either.
- `jobid` is gone. The System component generates internal IDs for tests; for `/system` calls there's no ID at all — the request blocks until it's done.
- `allowlistVersion` and `tenantHint` still round-trip into the journal. Same as before.
- Field-validation regexes are unchanged. The System component enforces them server-side, but pre-validating on the Safebox side is still recommended for clean error messages.

---

## Out of scope for 1.0

- Per-request governance signatures (Ed25519). Trust boundary is "Safebox Node holds the HMAC; if Safebox Node is compromised, the System component will execute what it asks." M-of-N governance still happens inside Safebox before the call is made.
- TCP listener outside loopback. The System component never binds to a public interface; multi-host Safebox needs a different transport.
- Subscription/webhook notifications for test termination. Safebox polls `GET /test/<id>` if it cares.
- Inference workload protocol. The Inference component is a separate post-1.0 service that may or may not also live behind this System component.
