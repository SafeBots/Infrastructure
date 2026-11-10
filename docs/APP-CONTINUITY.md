# App Continuity Contract

This document defines the contract between the Safebox Infrastructure base (Layer 0) and applications running inside managed containers (Layer 1). It specifies what survives a succession event, what the base guarantees, what apps are responsible for, and how the two layers interact during normal operation and during transfers of authority.

## 1. Purpose and audience

This contract is for developers building applications that run inside Safebox-managed containers. If your app uses a per-container HMAC key to authenticate against the System component, mounts ZFS datasets for persistent storage, or needs to maintain identity across infrastructure upgrades, this document describes the guarantees you can rely on and the responsibilities you must handle yourself.

The contract covers the boundary between:

- **Layer 0 (Infrastructure base):** A Node.js system component running on the host. Manages containers, attestation, HMAC authentication, model supply chain, OCP governance, and succession. Key modules: `server.js`, `auth.js`, `secret.js`, `ocpVerify.js`, `governanceKeys.js`, `instanceIdentity.js`, `transparency.js`, `succession.js`.
- **Layer 1 (Application):** PHP (Qbix Streams) and Node.js (Safebox plugin) running inside containers. PHP handles user management, governance voting, M-of-N flow, and audit trails. The Node.js orchestrator handles tool execution, model calls, and credential resolution.

## 2. What the base guarantees across succession

A succession event transfers the master secret from one infrastructure instance to another. Three paths exist (online predecessor, pre-positioned failover, Shamir governance recovery), but from the app's perspective the outcome is the same: a new base instance holds the same master secret and mounts the same storage. The following invariants hold after any successful succession.

### 2.1 ZFS volumes survive

ZFS datasets are stored on durable block storage (EBS volumes on AWS) that is independent of the compute instance. The successor mounts the same datasets. Your data on encrypted ZFS is exactly as you left it --- files, databases, cached models, everything written to your assigned datasets.

The base records volume mounts in `/var/lib/safebox/volumes/volume-registry.json`. This registry is itself stored on a ZFS dataset that survives succession, so your volume assignments are preserved without manual re-registration.

### 2.2 Per-container HMAC keys are re-derived identically

Per-container keys are derived deterministically from the master secret via HKDF:

```js
'use strict';

const crypto = require('crypto');

// Derivation as implemented in secret.js
function derivePerContainerKey(masterSecret, containerName, keyEpoch) {
    var INFO = Buffer.from(
        'safebox-container-' + containerName + '-' + keyEpoch + '-v2',
        'utf8'
    );
    var SALT = Buffer.alloc(32);
    return Buffer.from(crypto.hkdfSync('sha256', masterSecret, SALT, INFO, 32));
}
```

Because the master secret is transferred intact during succession and the `keyEpoch` is stored in `managed-containers.json` (which lives on a surviving ZFS dataset), the new base derives exactly the same per-container key. Your container's HMAC authentication continues to work without any key rotation or reconfiguration.

### 2.3 Attestation chain is published

Every succession event is appended to the transparency log at `/var/lib/safebox/transparency/transparency.json`. The log records the predecessor's public key, the successor's public key, the succession claim, and the timestamp. The log is append-only; entries are never removed.

Apps can read the succession chain via `GET /transparency/succession` (no authentication required --- the transparency log is public by design). This lets your app verify that the base it is talking to has a legitimate chain of custody back to a known root.

### 2.4 Container configurations are preserved

The file `/var/lib/safebox/managed-containers.json` records every declared container with its `containerName`, `imagePattern`, `allowedActions`, `keyEpoch`, `runUser`, `zfsVolumes`, and `defaultCommands`. This file lives on a ZFS dataset. After succession, the new base reads the same config and opens the same per-container sockets.

### 2.5 Volume mounts are preserved

The volume registry at `/var/lib/safebox/volumes/volume-registry.json` maps volume names to ZFS datasets with their manifest hashes and blessing claims. The new base loads this registry on startup. Your app's volumes are mounted at the same paths.

## 3. What apps must do themselves

The base provides storage continuity and authentication continuity. Everything above that is the app's responsibility.

### 3.1 Generate and manage your own keypair

Your app should generate its own asymmetric keypair (P-256 recommended, to match the base's curve) and store the private key on your encrypted ZFS dataset. This keypair is your app's identity --- it is not managed, rotated, or escrowed by the base.

The base gives you a ZFS dataset and an HMAC key. The HMAC key authenticates your container to the System component. Your keypair authenticates your app to the outside world (peers, other services, users). These are separate concerns.

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');

// Generate once, store on your encrypted ZFS dataset
const KEY_PATH = '/data/app/identity.key';  // your ZFS mount

function loadOrCreateKeypair() {
    try {
        const pem = fs.readFileSync(KEY_PATH, 'utf8');
        const privateKey = crypto.createPrivateKey(pem);
        const publicKey = crypto.createPublicKey(privateKey);
        return { privateKey, publicKey };
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        fs.writeFileSync(KEY_PATH, pair.privateKey.export({
            type: 'pkcs8', format: 'pem'
        }), { mode: 0o600 });
        return pair;
    }
}
```

### 3.2 Sign attestation claims binding your identity to the base

To prove to a peer that your app is running on a legitimate Safebox instance, you need to produce a claim that ties your app's public key to the base's attestation chain. The pattern is:

1. Read the base's attestation chain via `GET /transparency/succession`.
2. Construct a claim that says "app key X is running on base instance Y, which has succession chain Z."
3. Sign the claim with your app's private key.
4. The peer verifies your signature, then walks the succession chain to a trusted root.

The base does not produce this binding for you. It publishes its own attestation chain; you build the bridge from your identity to that chain.

### 3.3 Define what "continuity" means for your domain

The base guarantees that your ZFS bytes and your HMAC key survive succession. What "continuity" means for your app is your decision:

- **Database state:** If you run MySQL/PostgreSQL on ZFS, your data survives. But you need to handle crash recovery (WAL replay, etc.) because the predecessor may not have shut down cleanly.
- **Sessions:** In-memory sessions are lost. If session continuity matters, persist sessions to your ZFS dataset or to the database.
- **Cached models:** Model files on ZFS survive. GPU-loaded model state does not. Your app must reload models after succession.
- **Queued work:** Anything in a message queue backed by ZFS survives. Anything in an in-memory queue is lost.

### 3.4 Handle reconnection after succession

During a succession event, there is a brief period (typically seconds for Path A online transfer, potentially minutes for Path C Shamir recovery) where the base is unavailable. Your app's connection to the System component socket will drop.

Your app must:

1. Detect the socket disconnection (ECONNREFUSED or ECONNRESET on `/run/safebox/system.sock`).
2. Retry with backoff. The socket path does not change; the new base opens the same listener.
3. Re-authenticate. The HMAC key has not changed, so your existing key works. But if you cached any per-request nonces or timestamps, those caches should be discarded.
4. Verify the succession chain if your threat model requires it. Read `GET /transparency/succession` and check that the chain extends the one you saw before the interruption.

### 3.5 Peer verification

When a peer wants to verify that your app is legitimate, the verification chain is:

1. Peer receives your app's signed claim (section 3.2).
2. Peer verifies your app's signature using your public key.
3. Peer reads the base's transparency log and verifies the succession chain back to a trusted root (a known genesis public key or a governance-signed attestation).
4. Peer confirms that the claim binds your app key to an entry in that chain.

This is a two-layer check: app key + base attestation chain = trusted identity. The base does not do this verification for you; it provides the raw chain data.

## 4. What the base does NOT do

### 4.1 Manage app identities

The base does not generate, store, rotate, or revoke your app's keypair. It does not know your app's public key. If you lose your private key (e.g., you delete your ZFS dataset), the base cannot recover it.

### 4.2 Coordinate app-level state migration

If your app needs to migrate state during a succession (e.g., drain connections, flush caches, checkpoint a database), that is your responsibility. The base does not send a "succession is about to happen" signal to containers before initiating the transfer. From your app's perspective, the socket simply goes away and comes back.

### 4.3 Guarantee that your app is the "same" app

The base guarantees that the ZFS dataset mounted into your container contains the same bytes, and that the HMAC key is the same. It does not guarantee that the container image is the same, that the app code has not changed, or that the app is in a consistent state. If someone replaces your container image between succession events, the base does not detect or prevent that (the `imagePattern` regex constraint in managed-containers.json is the only guard, and it validates the image name, not its content hash).

### 4.4 Manage app-level secrets beyond the per-container HMAC

The per-container HMAC key authenticates your container to the System component. Any other secrets your app needs --- API keys, database passwords, TLS certificates, encryption keys --- must be managed by your app. Store them on your encrypted ZFS dataset.

## 5. Succession timeline from the app's perspective

Here is what happens during a Path A (online predecessor) succession, which is the most common case. Paths B and C differ in how the master secret reaches the new instance, but the app-visible behavior is the same from step 4 onward.

| Step | What happens | App impact |
|------|-------------|------------|
| 1 | Governance approves succession. An OCP succession claim is created and signed by the required threshold of governance keys. | None. Your app is unaware. |
| 2 | The successor instance boots, generates an ephemeral P-256 keypair, and presents its attestation document to the predecessor. | None. |
| 3 | The predecessor ECIES-encrypts the master secret to the successor's public key and transmits it along with the succession claim and the predecessor chain. | None. |
| 4 | The predecessor shuts down its socket listeners. | **Your socket connection drops.** You see ECONNREFUSED or ECONNRESET. |
| 5 | The successor decrypts the master secret, reads `managed-containers.json` from the ZFS dataset, derives per-container HMAC keys, and opens socket listeners. | **The socket at `/run/safebox/system.sock` becomes available again.** |
| 6 | The successor appends a succession entry to `/var/lib/safebox/transparency/transparency.json`. | You can read the updated chain. |
| 7 | Your app reconnects and authenticates with the same HMAC key. | **Normal operation resumes.** |

The gap between steps 4 and 5 is the downtime window. For Path A, this is typically under 10 seconds. For Path C (Shamir recovery), it can be minutes to hours depending on how quickly governance signers provide their shares.

## 6. Container lifecycle events

### 6.1 Create

Triggered by `POST /containers/create` on the control socket. The base:

1. Validates the container declaration (name, image pattern, allowed actions, ZFS volumes).
2. Generates a random 32-hex-character key epoch.
3. Writes the declaration to `managed-containers.json`.
4. Derives the per-container HMAC key via `derivePerContainerKey(masterSecret, containerName, keyEpoch)`.
5. Writes the key to `/run/safebox/keys/<name>/system.hmac` on tmpfs (directory 0750, file 0440, owner `safebox-infra`, group = the host gid the container's app user maps to). The key is never written into the tenant's workspace.
6. Opens a Unix domain socket at `/run/safebox/containers/<name>.sock` (mode 0660).
7. Returns the socket path and key path for bind-mounting into the container.

The caller (typically the orchestrator that runs `docker create`) bind-mounts the socket at `/run/safebox/system.sock`, the workspace directory at `/workspace`, and the key directory read-only at `/run/safebox/keys`, so the key is visible inside the container at `/run/safebox/keys/system.hmac`.

### 6.2 Destroy

Triggered by `POST /containers/destroy` on the control socket. The base:

1. Kills any running test workspaces owned by the container.
2. Removes the declaration from `managed-containers.json`.
3. Closes and unlinks the container's socket.
4. Deletes the container's HMAC key file.

After destroy, the key epoch is forgotten. Re-creating a container with the same name generates a new epoch, which produces a cryptographically unrelated HMAC key.

### 6.3 Succession

From the container's perspective:

1. Socket goes away (ECONNREFUSED).
2. Socket comes back (same path, same HMAC key).
3. Transparency log has a new entry.

No container-level action is required beyond reconnecting.

### 6.4 Failover (Path B)

Identical to succession from the app's perspective. The escrow blob is pre-positioned, so the successor can start faster, but the container sees the same socket-drop-and-reconnect pattern.

## 7. HMAC key lifecycle

### 7.1 Derivation

Per-container keys are derived from the master secret using HKDF-SHA256:

- **IKM (input keying material):** The 32-byte master secret.
- **Salt:** 32 zero bytes.
- **Info:** `safebox-container-<containerName>-<keyEpoch>-v2` (UTF-8 encoded).
- **Output length:** 32 bytes.

The `keyEpoch` is a random hex string (16-128 characters) generated at `/containers/create` time and stored in `managed-containers.json`.

### 7.2 When keys change

Per-container HMAC keys change **only** when a container is destroyed and re-created. The following events do **not** change the key:

- **Succession** (any path): The master secret is transferred intact. Same master + same epoch = same derived key.
- **SIGHUP reload:** The base re-reads config and reconciles sockets, but does not change existing keys.
- **Base process restart:** The master secret is re-derived from the sealed seed at `/run/safebox/hmac-seed`, which lives for the life of the boot. Same master + same epoch = same derived key.

The following events **do** change the key:

- **Container destroy + re-create:** The old epoch is deleted; a new random epoch is generated. The new key is cryptographically independent of the old one.
- **Master secret rotation:** The seed is generated once per instance and sealed to its TPM; it cannot be rotated in place. A new instance (image rotation or succession to a fresh box) has a new seed, so all per-container keys change unless the master is transferred through the succession path.

### 7.3 Key file locations

| File | Scope | Owner | Mode |
|------|-------|-------|------|
| `/run/safebox/hmac-seed` | Sealed seed the master is derived from (host, tmpfs) | safebox-infra | 0400 |
| `/run/safebox/keys/<name>/system.hmac` | Per-container key (host tmpfs, never in the workspace) | safebox-infra | 0440 |
| `/run/safebox/keys/system.hmac` (inside container) | The same file, seen through a read-only bind mount | safebox-infra | 0440 |

The master itself is never written to disk; it exists only in the system component's memory. Nothing under `/etc` holds a key.

## 8. Health check contract

### 8.1 What the base expects from apps

The base does not directly health-check application containers. The socket-level health flow is:

- The base exposes `GET /healthz` on every socket (per-container and control). This lets the app verify that the base is alive, not the other way around.
- Docker-level health checks (HEALTHCHECK in your Dockerfile) are the app's responsibility.
- If the base needs to know whether a container is healthy, it inspects the Docker container state via the Docker API. It does not call into the container.

### 8.2 What the app should do

Your app should:

1. **Check the base on startup.** Hit `GET /healthz` on `/run/safebox/system.sock` (the bind-mounted socket) before declaring yourself ready. If the base is not up yet, retry with backoff.
2. **Monitor the socket.** If requests to the system socket start failing, you are either mid-succession or the base has crashed. Either way, retry with backoff. Do not treat a transient socket failure as fatal.
3. **Implement your own health endpoint.** Expose a health check at a well-known path (e.g., `/healthz` or `/status`) on your app's HTTP port for Docker, load balancers, and monitoring systems to hit.

### 8.3 Test keepalive

If your app uses the base's test workspace feature (`POST /test`), each test workspace has a keepalive deadline. The app must `POST /test/<id>/keepalive` at least every 2 minutes to keep the workspace alive. If the keepalive lapses, the base tears down the test's Docker container and ZFS clone.

## 9. Security boundaries

### 9.1 Trusted Computing Base (TCB)

The following components are in the TCB --- a compromise of any of them compromises the entire system:

- **Hardware root of trust:** Nitro TPM, SEV-SNP, or TDX. Provides the PCR measurements that bind the master secret to the physical instance.
- **Host kernel and bootstrap:** PCR0 and PCR1. Changes when the AMI is rebuilt or the kernel is updated.
- **The System component (Layer 0):** Holds the master secret in RAM. Derives all per-container keys. Runs as `safebox-infra` user on the host.
- **ZFS encryption:** Dataset encryption keys are derived from the master secret or managed by ZFS natively. Compromise of the host filesystem without the encryption key does not expose data.

### 9.2 Not in the TCB

The following are **not** in the TCB:

- **Application code (Layer 1):** A compromised app container can leak its own per-container HMAC key and its own ZFS data, but cannot access other containers' keys or the master secret.
- **Docker daemon:** Mediates container lifecycle but does not hold cryptographic material. A compromised Docker daemon can stop/start containers and read bind-mounted key files, so the host must restrict Docker socket access.
- **Transparency log:** Public and read-only from the app's perspective. Tampering with the log does not compromise keys, but does compromise auditability.

### 9.3 Per-container isolation

Each container gets:

- Its own Unix domain socket (kernel-enforced identity via filesystem topology).
- Its own HMAC key (cryptographically independent of every other container's key).
- Its own ZFS datasets (mount namespace isolation).
- Its own allowed-actions whitelist (enforced by the System component before executing any operation).

A container cannot impersonate another container because it does not have access to the other container's socket or key. The system socket path inside every container is `/run/safebox/system.sock`, but each container's bind-mount points to a different host-side socket.

## 10. Testing succession

### 10.1 What to test

Before deploying to production, verify that your app survives a succession event:

1. **Socket reconnection.** Does your app detect the socket drop and reconnect?
2. **HMAC continuity.** Does authentication work after reconnection without any key refresh?
3. **Data integrity.** Is your ZFS-backed data intact and consistent after succession?
4. **State recovery.** Does your app recover from the equivalent of a hard restart? (In-memory state is gone; disk state is intact.)
5. **Transparency chain verification.** If your app verifies the succession chain, does it accept the new entry?

### 10.2 How to test locally

Use the dev-mode random secret (Path 3 in `secret.js`) for local testing. The test procedure:

```bash
# 1. Start the System component (generates a random master secret in dev mode)
node server.js

# 2. Create a container and start your app
curl --unix-socket /run/safebox/control.sock \
  -X POST http://localhost/containers/create \
  -H 'Content-Type: application/json' \
  -d '{"containerName":"myapp","imagePattern":"myapp:.*","allowedActions":["status","npm"]}'

# 3. Verify your app can authenticate and operate normally

# 4. Simulate succession: stop the System component
kill $(pidof node)  # or send SIGTERM

# 5. Copy the master secret to simulate transfer (in dev mode, just keep the file)
# the test seed file from step 1 is still there (SAFEBOX_SYSTEM_SECRET under NODE_ENV=test)

# 6. Restart the System component (it reads the existing master secret from disk)
node server.js

# 7. Verify your app reconnects and authenticates
# 8. Verify your ZFS data is intact
# 9. Check /transparency for the succession entry (not present in this
#    simplified test; in production, succession.js appends the entry)
```

### 10.3 Integration test pattern

For automated integration testing, write a test that:

```js
'use strict';

const http = require('http');
const crypto = require('crypto');
const { sign } = require('./auth');

async function testSuccessionSurvival(socketPath, hmacKey) {
    // 1. Make a request before succession
    const preHeaders = sign(hmacKey, 'GET', '/healthz', '');
    const preSurvival = await request(socketPath, 'GET', '/healthz', '', preHeaders);
    console.assert(preSurvival.status === 'ok', 'pre-succession healthz failed');

    // 2. Simulate succession gap (stop and restart the base)
    //    In a real test, this would be orchestrated externally.
    //    Here we just verify reconnection logic.

    // 3. Wait for the socket to come back
    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const postHeaders = sign(hmacKey, 'GET', '/healthz', '');
            const postSurvival = await request(socketPath, 'GET', '/healthz', '', postHeaders);
            if (postSurvival.status === 'ok') {
                connected = true;
                break;
            }
        } catch (e) {
            // ECONNREFUSED is expected during the gap
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    console.assert(connected, 'failed to reconnect after succession');
    console.log('succession survival test passed');
}

function request(socketPath, method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath, method, path,
            headers: { ...headers, 'content-type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        req.end(body);
    });
}
```

### 10.4 Checklist

Before going to production, verify each of these:

- [ ] App reconnects to `/run/safebox/system.sock` after a connection drop, with exponential backoff.
- [ ] App does not cache the HMAC key in a way that prevents re-reading from `/run/safebox/keys/system.hmac` on restart.
- [ ] App stores its own private key on an encrypted ZFS dataset, not in the container image or in environment variables.
- [ ] App handles database crash recovery (WAL replay, journal recovery) on startup.
- [ ] App does not assume in-memory state survives across restarts.
- [ ] App can read and validate the transparency log succession chain.
- [ ] App's Docker health check does not depend on the System component being available (the base may be mid-succession).

## Appendix A: Authentication protocol reference

The HMAC authentication protocol (`SafeboxHMAC v1`) signs a canonical envelope:

```
<timestamp>\n<nonce>\n<method>\n<path>\n<body-sha256-hex>
```

- **Timestamp:** Unix epoch seconds. Requests with more than 300 seconds of clock skew are rejected.
- **Nonce:** 32 lowercase hex characters (16 random bytes). Each nonce is accepted once; replays within a 10-minute window are rejected.
- **Method:** HTTP method (GET, POST, etc.).
- **Path:** Full request URL including query string.
- **Body hash:** SHA-256 hex digest of the request body (empty string if no body).

The signature is HMAC-SHA256 of the canonical string, using the per-container key. It is sent in the `x-safebox-signature` header. The timestamp and nonce are sent in `x-safebox-timestamp` and `x-safebox-nonce`.

## Appendix B: File and path reference

| Path | Survives succession | Description |
|------|:-------------------:|-------------|
| `/run/safebox/hmac-seed` | No (per-instance, sealed to its TPM; the master transfers via succession) | Seed the host master is derived from |
| `/var/lib/safebox/managed-containers.json` | Yes (ZFS) | Container declarations and key epochs |
| `/var/lib/safebox/volumes/volume-registry.json` | Yes (ZFS) | Volume-to-dataset mappings |
| `/var/lib/safebox/transparency/transparency.json` | Yes (ZFS) | Append-only succession chain, key rotations, volume blessings |
| `/run/safebox/keys/<name>/system.hmac` | Yes (re-derived) | Per-container HMAC key files |
| `/run/safebox/containers/<name>.sock` | No (recreated) | Per-container Unix domain sockets |
| `/run/safebox/control.sock` | No (recreated) | Control socket (host-only) |
| `/var/lib/safebox/succession/failover-escrow.bin` | Varies | Path B escrow blob; may or may not be on ZFS |
