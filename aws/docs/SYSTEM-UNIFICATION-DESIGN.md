# System Component Unification — Design

> **Purpose**: explain what the System component does today, what's still asymmetric, and what changes are needed so one auditable Node module orchestrates everything: host packages via dnf, per-app packages inside containers, global model downloads, and configuration.
>
> **Status**: implemented. The unification described here landed in commit `8043f09`. A subsequent commit replaced the loopback TCP transport with per-container Unix domain sockets — see [`Safebox.md`](Safebox.md) for the current transport model. The routing, ACL, and ops design described in this document is still accurate; only the transport endpoint changed.

---

## What "the System component" is today

One Node.js process on the host. Runs as the unprivileged `safebox-infra` user. Listens on per-container Unix domain sockets — one per managed container plus one control socket. Accepts HMAC-signed JSON over HTTP from Safebox. Routes each request to one of four handlers:

```
                                  ┌─────────────────┐
   Safebox plugin ──HMAC HTTP──→  │   server.js     │
   (signed envelope)              │  (auth + audit) │
                                  └────────┬────────┘
                                           │
                  ┌──────────────┬─────────┴────────┬──────────────────┐
                  ▼              ▼                  ▼                  ▼
         ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
         │  opsSystem.js  │ │   opsTest.js   │ │  opsModels.js  │ │opsContainers.js│
         │  POST /system  │ │   POST /test   │ │  POST /models  │ │POST /containers│
         └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
```

Auth is HMAC-SHA-256 over a canonical envelope (`timestamp\nnonce\nmethod\npath\nbody-sha256-hex`). The shared key is derived from AWS Nitro attestation PCRs via HKDF, so the same key is reproducible on the same host but unforgeable elsewhere. Every request emits one journal entry via `systemd-cat -t safebox-system`. Privileged operations elevate via `sudo` against a tight allowlist in `/etc/sudoers.d/safebox-system`. The whole runtime is ~3,500 lines of Node with zero npm dependencies.

That part is solid. The asymmetry is in what each handler actually does.

## What each handler does today

### `opsSystem.js` — runs ON THE HOST

When Safebox sends `{tool: "npm", action: "install", managedContainer: "safebox-app-foo", workspaceRoot: "/srv/encrypted/apps/foo", packages: ["lodash@4.17.21"]}`, the System component executes:

```
execFile("/usr/local/bin/npm", ["install", "--save-exact", "--ignore-scripts", "--", "lodash@4.17.21"], { cwd: "/srv/encrypted/apps/foo" })
```

The `managedContainer` is consulted only as a permission check ("is npm in this container's allowedActions?") and a workspace-path restriction. The actual `npm` binary that runs is the host's npm. The cache it writes is the host's npm cache. The Node version it sees is the host's Node version. Apps share npm caches, can't have different Node versions, and an npm postinstall script that bypasses `--ignore-scripts` (there have been CVEs for this) gets host-level access.

Same story for `pip`, `cargo`, `gem`, `composer`, `git`, `migrate`.

### `opsTest.js` — runs IN A FRESH CONTAINER

Creates a ZFS clone of the app's data volume, spins up a docker container (read-only rootfs, `--network=none`, runs as `nobody`), runs the test command inside it, returns ring-buffered stdout. Aggressive 60s teardown unless pinged. Clean isolation, exactly right.

### `opsModels.js` — downloads to HOST, will be mounted into model-runner CONTAINERS

Fetches model files from the manifest's declared HTTPS sources, verifies each file's SHA-256 against the manifest, materializes the model at `/srv/safebox/models/<manifestHash>/`. The directory name IS the manifest hash. Model-runner containers then bind-mount that directory read-only. Weights are stored on the host because they're large (multi-GB) and shared between containers; inference runs in containers because the ML stack is Python.

This is the right pattern.

## The asymmetry

```
                          Where does the actual work happen?
                          ──────────────────────────────────
   Host packages (dnf):   host         ✓ correct — system-wide
   Test environments:     container    ✓ correct — isolation
   Model weights:         host (data)  ✓ correct — shared cache
   Model inference:       container    ✓ correct — Python isolation
   App packages (npm,     HOST         ✗ should be IN CONTAINER
     pip, cargo, gem,
     composer, git):

```

Per-app package management is the odd one out. Every other category is in the right place. `opsSystem.js` was written assuming a flat host with apps sharing a runtime. The model we actually want — one container per app, isolated runtimes, version-pinned per-container — was never wired in.

## What changing this means architecturally

### Container routing

`opsSystem.js` needs a routing decision before executing:

```
                  is tool=dnf?
                  ┌─────yes─────→ run on host as root via sudo (host-scope tool)
                  │
   incoming req  ─┤
                  │
                  └─────no──────→ is managedContainer === '_host'?
                                  ├─yes── (currently only dnf — refuse non-dnf host tools)
                                  └─no─── docker exec <containerName> <tool> <action> <args>
```

Concrete: when `{tool: "npm", managedContainer: "safebox-app-foo"}` arrives, the System component runs:

```
sudo docker exec --user safebox-app safebox-app-foo \
    npm install --save-exact --ignore-scripts -- lodash@4.17.21
```

instead of running host npm. The npm running is the one in the container image. The cache is the container's cache. The Node version is whatever that container ships.

### Per-container declaration

`managed-containers.json` already keys on container name. The container name IS the docker container's name. Today the declaration says `imagePattern`, `allowedActions`, `zfsVolumes`. We add one explicit field:

```json
"safebox-app-foo": {
  "imagePattern": "^qbix/app:.*$",
  "containerName": "safebox-app-foo",
  "runUser": "safebox-app",
  "allowedActions": ["npm", "git", "composer", "test", "zfs-snapshot", "zfs-rollback"],
  "execContext": "container",
  "zfsVolumes": { ... }
}
```

`containerName` is what `docker exec` targets. `runUser` is the user inside the container that the tool runs as. `execContext: "container"` is the default and explicit; the only other value is `"host"`, reserved for `_host` and possibly for `migrate` (which runs against a MariaDB volume the app container mounts, but the schema migration is run from the host's `mysql` client).

### Sudoers expansion (carefully)

The sudoers file currently allows specific argv shapes for `dnf`, `zfs`, `docker rm`, `docker exec` (for tests). It needs to grow one new shape:

```
safebox-infra ALL=(root) NOPASSWD: /usr/bin/docker exec --user [a-z][a-z0-9-]* safebox-app-* npm *
safebox-infra ALL=(root) NOPASSWD: /usr/bin/docker exec --user [a-z][a-z0-9-]* safebox-app-* pip *
... one line per (tool, container-prefix) pair ...
```

We do NOT want `sudo docker exec * * *` because that's a root shell on any container. The constraint is: container name matches a known prefix (`safebox-app-*`, `safebox-mariadb-*`, etc.), user is a specific allowed user, command is one of the known tools. The exact argv after the tool name is validated in Node before sudo is invoked, same as today.

### Version pinning via manifest hashes

Today `{"packages": ["lodash@4.17.21"]}` carries the version as a string. That's fine for npm semver, but Safebox M-of-N is signing a request envelope, not a manifest. The actual lockfile content (sub-dependencies, integrity hashes) isn't part of what's signed.

The right pattern, copied from `opsModels.js`: install requests can carry a `lockfileHash`. The System component pulls the lockfile out of the container (`docker exec ... cat package-lock.json`), hashes it, and compares against `lockfileHash`. If they differ, the install is rejected with `LOCKFILE_HASH_MISMATCH`. This way what Safebox M-of-N approves is the entire dependency tree, not just the top-level version.

The lockfile-hash check is opt-in — for fast iteration, omit it. For production deploys, Safebox includes it and gets bit-exact reproducibility.

## The vision: one auditable orchestrator

```
                   ┌──────────────────────────────────────────────────────┐
                   │  System component (Node, runs as safebox-infra)      │
                   │  ─────────────────────────────────────────────────   │
                   │                                                       │
                   │  HMAC verify ── managed-containers.json allowlist    │
                   │       │                                               │
                   │       ▼                                               │
                   │  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
                   │  │ ops-sys  │  │  opsTest│  │opsModels│            │
                   │  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
                   │       │             │              │                  │
                   │  ┌────┴─────────────┴──────────────┴────┐            │
                   │  │      execFile dispatcher              │            │
                   │  └────┬───────────────────┬───────────┬──┘            │
                   │       │ sudo dnf          │ docker    │ HTTPS         │
                   │       │ sudo zfs          │ exec      │ + sha256      │
                   └───────┼───────────────────┼───────────┼───────────────┘
                           ▼                   ▼           ▼
                       host RPMs        per-app           /srv/safebox/
                       OS packages      container         models/<hash>/
                       runners/         (npm, pip,        (verified weights)
                       dnf config       cargo, etc.
                       global           inside)
```

Every tool. One Node codepath. Auditor reads `server.js` → one of `ops-{system,test,models}.js` → `sudo` allowlist → done. Same shape for every operation. Same HMAC envelope. Same audit entry shape.

What the auditor does NOT have to read: Python in the model runners, the npm binary itself, dnf's internals, docker's daemon. Those are opaque to audit; we verify their *inputs* (cryptographically-pinned versions, manifest-hash-verified weights) and trust their behavior on the validated inputs.

## What changes per file

### `opsSystem.js` (~318 lines today → ~450 lines)

Add the routing layer. Currently `handle()` calls `run(bin, argv, cwd, timeout)` which directly execs the host tool. Change to:

```js
async function handle(req) {
    validateRequest(req);
    const builder = TOOL_BUILDERS[req.tool];
    const built = builder(req, req.packages || []);
    const [tool, args] = built;

    const entry = config.get(req.managedContainer);
    const execContext = entry.execContext || 'container';

    let bin, argv, cwd;
    if (req.managedContainer === '_host') {
        // Host-scope: sudo + the host tool directly. Currently only dnf reaches here.
        [bin, argv] = built;
        cwd = '/tmp';
    } else if (execContext === 'container') {
        // Per-app: docker exec into the container, with --user constraint.
        bin = '/usr/bin/sudo';
        argv = [
            '/usr/bin/docker', 'exec',
            '--user', entry.runUser || 'safebox-app',
            '--workdir', req.containerWorkdir || '/app',
            entry.containerName || req.managedContainer,
            tool, ...args
        ];
        cwd = '/tmp';
    } else {
        throw new BadRequest(`unknown execContext: ${execContext}`);
    }

    // Optional lockfile-hash verification (for production deploys)
    if (req.lockfileHash) {
        await verifyLockfileHash(entry, req);  // docker exec ... cat <file> | sha256
    }

    const result = await run(bin, argv, cwd, timeoutMs);
    // ... same response shaping ...
}
```

Lockfile verification adds ~50 lines. The existing per-tool validators (`validatePackages`, the regex tables) don't change — those validate the request *before* we know whether it's container-bound or not.

### `managed-containers.json` (schema change)

Add `containerName`, `runUser`, `execContext` fields. Backward compatibility: `containerName` defaults to the key itself, `runUser` defaults to `safebox-app`, `execContext` defaults to `container` (so `_host` is the only special case that needs to explicitly opt out).

### `sudoers/safebox-system` (expansion)

Today the file allows specific argv shapes for `sudo dnf`, `sudo zfs`, `sudo docker rm` (test teardown), `sudo docker exec` (test setup). We add one entry per (tool, container-prefix) pair. ~20 lines of rules, all reviewable in one sitting. Each rule constrains:

- The container name to a known prefix
- The user to a specific allowed identifier
- The tool to a known set

The Node side does pre-validation; sudoers is the constitutional limit.

### `opsTest.js` — no changes

Already runs in containers. Already uses the docker exec pattern. The new container-routing in `opsSystem.js` is essentially adopting the test pattern for all per-app tools, which means we're making two codepaths converge rather than diverge.

### `opsModels.js` — no changes

Already does what we want: download to host, verify, materialize at `/srv/safebox/models/<hash>/`. Model-runner containers mount that read-only. Already restricted to `managedContainer: '_host'` because model installs affect every tenant.

### `secret.js`, `nsmClient.js`, `cborDecode.js`, `auth.js`, `config.js`, `server.js` — no changes

The cryptographic layer is stable. The routing change is local to one file.

## How an auditor walks the change

After the change, the audit story is:

1. **Read `server.js`** (~250 lines). HTTP listener, HMAC verification, audit hook, route dispatch. Confirms: every request authenticates, every request audits.

2. **Read `auth.js`** (~105 lines). HMAC envelope canonicalization, nonce LRU, clock skew window. Confirms: HMAC is correct, replay is blocked.

3. **Read `secret.js`** (~210 lines) and `nsmClient.js` (~330 lines). Where does the HMAC key come from? PCRs via HKDF. Confirms: key is bound to (image, kernel, host); copying the disk produces a different key.

4. **Read `opsSystem.js`** (~450 lines after change). Per-app tools: docker exec with constrained args. Host tool (dnf): sudo with constrained args. Confirms: every privilege escalation goes through one of two narrow channels.

5. **Read `/etc/sudoers.d/safebox-system`** (~70 lines after change). The constitutional limit. Even if Node has a bug, the worst case is bounded by what sudoers allows.

6. **Read `opsTest.js`** (~370 lines) and `opsModels.js` (~500 lines). Test envs: ZFS clone + ephemeral container + ring buffer + aggressive teardown. Models: HTTPS fetch + per-file SHA-256 + atomic materialize. Confirms: tests can't escape, models can't be substituted.

7. **Read `managed-containers.json`**. What does each container declare it can do? What's its runtime user? Confirms: the declared blast radius for each container.

That's the entire surface. ~2,000 lines of Node, ~70 lines of sudoers, one JSON config. No Python in the audit path. No shell in the audit path beyond `install-base.sh` and `install-system.sh`. One language, one wire protocol, one place to look.

## What this enables

### Per-app version pinning

Each app's container image carries its own runtime. `safebox-app-foo` runs Node 22; `safebox-app-bar` runs Node 24. They never share a binary, never share a cache, never share a postinstall hook. Image hashes are pinned in the same `managed-containers.json`.

### Global package management without cross-tenant blast

`dnf install <something>` only affects the AMI itself — the host's PHP version, the host's Docker version, the runners. Apps are isolated; their internal `npm` install does not require an AMI rebuild. AMI changes go through the `_host` channel, which Safebox M-of-N gates with a different (stricter) policy than per-app changes.

### Unified model orchestration

`POST /models/install` is the same shape as `POST /system { tool: 'npm', ... }` — the only difference is that models are `_host`-scope. The model's manifest hash is what Safebox signs; the System component verifies the hash, downloads, materializes. Model-runner containers mount the verified weights. Same signing pattern, same hash discipline, same audit entry shape.

### One language

Auditor learns Node. Auditor reads ~2,000 lines. Done. No Python, no Go, no Rust toolchain to verify, no second wire protocol.

## Implementation plan

In order:

1. **Add `containerName`, `runUser`, `execContext` to `managed-containers.json`** with sensible defaults. Update `config.js` to expose them. Pure schema; no behavior change because defaults preserve current behavior.

2. **Add container-routing to `opsSystem.js`** — when `execContext === 'container'`, build `docker exec ...` argv instead of direct argv. Keep the current path as the `_host` branch. Add tests that exercise both branches.

3. **Expand `sudoers/safebox-system`** with `docker exec --user <user> <container-pattern> <tool>` lines, one per (tool, allowed-container-pattern) pair. Each line is auditable independently.

4. **Add `lockfileHash` verification** to `opsSystem.js`. Optional field on the request; when present, the System component reads the lockfile out of the container after install and verifies the hash. Reject with `LOCKFILE_HASH_MISMATCH` on mismatch. ~50 lines.

5. **Update `aws/docs/SYSTEM-PROTOCOL.md`** to document the per-app vs `_host` execution model, the new `containerName`/`runUser`/`execContext` schema fields, and the `lockfileHash` field.

6. **Update `aws/docs/AUDIT.md`** Phase 3 with explicit checks: sudoers `docker exec` lines match the expected pattern, container declarations are consistent, no `execContext: host` declarations exist outside `_host`.

7. **Add smoke tests** that exercise the routing decision — `tool: npm + managedContainer: safebox-app-foo` produces a `docker exec` invocation, `tool: dnf + managedContainer: _host` produces a `sudo dnf` invocation, mismatches are rejected.

8. **No changes to the cryptographic layer** — `auth.js`, `secret.js`, `nsmClient.js`, `cborDecode.js` stay byte-identical with Safebox's copies. The wire protocol (HMAC envelope) is unchanged. Adding `containerWorkdir`, `lockfileHash` to request bodies is additive — old request shapes still work.

Total estimate: ~3-4 days of focused work, including doc updates and tests. The cryptographic layer doesn't move; the change is contained to one Node file and one sudoers file.

## What this is NOT

- **Not a full container orchestrator.** The System component doesn't decide which app container to spawn; that's deployment/Safebox concern. The System component executes commands inside containers Safebox has already declared as managed.
- **Not a replacement for docker compose or Kubernetes.** Long-running app containers are still started/stopped by other means (systemd unit, compose file, whatever the deployment chose). The System component exec's into already-running containers.
- **Not a way to add new app containers at runtime via the API.** Adding a new managed container requires editing `managed-containers.json` and `SIGHUP`'ing the System component. That's a deliberate restriction — adding a container changes the trust surface and should go through code review on the config file.

The System component remains a *constrained* orchestrator: it does what's already declared in `managed-containers.json` and constrained by `sudoers/safebox-system`. The change here just makes it route correctly for per-app vs host scope.
