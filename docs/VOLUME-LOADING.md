# Generalized Volume Loader

## Motivation: From Models to Any Volume

`opsModels.js` handles the model supply chain: manifest-hash verification, multi-source HTTPS download with redirect following, per-file SHA-256 verification, and atomic staging (`.staging/` directory with random suffix, then rename to final path). It works well, but it is hardcoded to models.

The system manages more than models. An app needs to be loaded. A config bundle needs to be deployed. A plugin needs to be mounted. A runner binary needs to be installed. Each of these is the same operation at the base layer: download a set of files described by a manifest, verify every file against its declared hash, stage atomically, mount read-only into a container. The only differences are the volume type (which determines mount point), the governance threshold (some types require higher quorum), and the metadata (a model has a `runnerType` and `license`; an app has a `framework` and `entrypoint`).

`opsVolumes.js` generalizes `opsModels.js` into a volume loader that handles any volume type. `opsModels.js` is kept as a thin backward-compatible wrapper that delegates to `opsVolumes` for the actual work.

## Volume Types

| Type | Mount Path | Description |
|---|---|---|
| `model` | `/srv/safebox/models/<hash>` | AI model weights (GGUF, safetensors, ONNX). Consumed by runner containers. |
| `app` | `/srv/safebox/apps/<hash>` | Application code (Qbix app, U language app). The container's main workload. |
| `config` | `/srv/safebox/config/<hash>` | Configuration bundles (nginx configs, environment files, policy documents). |
| `plugin` | `/srv/safebox/plugins/<hash>` | Qbix plugins or extension modules loaded by an app container. |
| `runner` | `/srv/safebox/runners/<hash>` | Runner binaries (vLLM, SGLab, U language interpreter). The engine that executes a model or app. |

The loader does not care about the type beyond using it to determine the mount path. A model volume and an app volume go through the same download-verify-stage-mount pipeline. Type-specific logic (how to start a runner, how to configure an app) lives in the container, not the base.

## Manifest Format

A volume manifest is a JSON object describing the files in the volume, their hashes, and metadata:

```json
{
  "name": "qwen-3.6-27b",
  "version": "1.0.0",
  "type": "model",
  "license": "Apache-2.0",
  "totalSizeBytes": 27000000000,
  "metadata": {
    "runnerType": "vllm",
    "quantization": "awq-4bit",
    "contextLength": 131072
  },
  "files": [
    {
      "path": "model-00001-of-00006.safetensors",
      "sizeBytes": 4500000000,
      "sha256": "a1b2c3d4e5f6...",
      "sources": [
        "https://huggingface.co/Qwen/Qwen3.6-27B-AWQ/resolve/main/model-00001-of-00006.safetensors",
        "https://safebots-volumes.s3.amazonaws.com/qwen-3.6-27b/model-00001-of-00006.safetensors"
      ]
    }
  ]
}
```

The manifest hash -- `SHA-256(canonicalize(manifest))` using RFC 8785 canonicalization -- is the volume's identity. This is the same canonicalization used in `opsModels._canonicalize()` and in `ocpVerify.canonicalize()`. The hash is what governance signers approve. The directory name on disk IS the manifest hash, so an auditor can verify any installed volume by hashing the manifest file and comparing it to the directory name.

### Field Validation

`opsVolumes.js` validates the manifest with the same rigor as `opsModels.validateManifest()`:

- `name`: short identifier, `[a-zA-Z0-9._-]{1,128}`
- `version`: string, max 64 chars
- `type`: one of the recognized volume types
- `files[].path`: relative POSIX path, no `..` or `.` segments, no leading slash, no backslashes, no shell metacharacters. The regex `^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$` enforces this, with an additional explicit check for `.` and `..` segments.
- `files[].sha256`: 64 lowercase hex characters
- `files[].sources`: 1-16 HTTPS URLs (or `safecloud:` URIs for future Safecloud support)
- `files[].sizeBytes`: positive integer, max 200 GB per file
- `totalSizeBytes`: must equal the sum of all `files[].sizeBytes`

## M-of-N Blessing Flow

A volume cannot be installed unless its manifest hash has been blessed by governance. The blessing is an OCP claim signed by M-of-N governance signers, verified at the base layer by `ocpVerify.verifyThreshold()`.

### The Flow

1. **Review.** Governance signers review the volume contents. For a model, this means inspecting the weights' provenance, license, and safety properties. For an app, this means auditing the code.

2. **Sign.** Each approving signer signs an OCP claim over the manifest hash:
   ```json
   {
     "ocp": 1,
     "stm": {
       "type": "volumeBlessing",
       "manifestHash": "sha256:a1b2c3...",
       "volumeType": "model",
       "volumeName": "qwen-3.6-27b"
     }
   }
   ```
   OCP supports sequential signing -- signers do not all need to be online simultaneously. Each signer adds their key and signature to the claim's `key[]` and `sig[]` arrays.

3. **Submit.** The Safebox plugin sends the install request to the base:
   ```
   POST /volumes/install
   {
     "manifest": { ... },
     "ocpClaim": { "ocp": 1, "stm": {...}, "key": [...], "sig": [...] },
     "sources": { "model-00001-of-00006.safetensors": ["https://..."] }
   }
   ```

4. **Base verifies.** The base performs three checks:
   - The OCP claim is valid: M-of-N threshold met, all signatures verify against trusted governance keys (`ocpVerify.verifyThreshold()`).
   - The claim's `stm.manifestHash` matches `SHA-256(canonicalize(manifest))`.
   - The claim has not expired (`nbf <= now <= exp`).

5. **Download and verify.** For each file in the manifest, the base downloads from the declared sources (HTTPS with redirect following, same as `opsModels.downloadWithFallback()`), computes SHA-256 of the downloaded bytes, and compares against the manifest's declared hash. A mismatch aborts the entire install and deletes all partial downloads.

6. **Atomic staging.** Downloaded files go into a staging directory: `/srv/safebox/volumes/.staging/<hash>.<pid>.<random>`. The random suffix (from `crypto.randomBytes(6).toString('hex')`) prevents two concurrent installs of the same volume from trampling each other. When all files are verified, the staging directory is atomically renamed to the final path. If the final path already exists (a concurrent install won the race), the second install's staging directory is cleaned up.

7. **Mount.** The volume directory is bind-mounted read-only (`:ro`) into the target container. The container sees the files at a path determined by the volume type (e.g., `/srv/safebox/models/<hash>/` for a model).

### Idempotency

If a volume with the same manifest hash is already installed, the base re-verifies the on-disk files against the manifest. If verification passes, it returns `alreadyInstalled: true` without re-downloading. If verification fails (corrupt install), the base removes the corrupt directory and reinstalls.

## Download: HTTPS with Fallback

The download logic is generalized from `opsModels.downloadWithFallback()`:

- **Multiple sources per file.** Each file in the manifest declares 1-16 source URLs. The loader tries them in order. If one fails (HTTP error, timeout, size mismatch, hash mismatch), it moves to the next.
- **Redirect following.** Up to 5 redirects per source. HuggingFace and S3 commonly redirect. After 5 redirects from a single source, skip to the next source.
- **Per-file SHA-256.** Every downloaded file is hashed during download (streaming -- the hash is updated with each chunk). After the download completes, the final hash is compared to the manifest. No file is moved to staging until its hash is verified.
- **Size cap.** If `bytesReceived` exceeds the manifest's declared `sizeBytes` for that file, the download is aborted and the next source is tried.
- **Wall-clock timeout.** 1 hour per file (`DOWNLOAD_TIMEOUT_MS`). Prevents a slow source from blocking the install indefinitely.
- **Atomic file placement.** Each file is downloaded to `<destPath>.partial`, then renamed to `<destPath>` only after hash verification. A crash during download leaves only `.partial` files, which are cleaned up on the next install attempt.

## Safecloud Source Type (Stub)

Sources in the manifest can use the `safecloud:` URI scheme:

```json
{
  "path": "model.safetensors",
  "sha256": "a1b2c3...",
  "sources": [
    "safecloud:QmRootCID123.../model.safetensors",
    "https://fallback.s3.amazonaws.com/model.safetensors"
  ]
}
```

The `safecloud:` source type is a stub for Phase 4. When implemented, it will:

1. Parse the Safecloud CID (content identifier, which is the SHA-256 of the chunk or Merkle root).
2. Request chunks from Drops (Safecloud's distributed storage nodes) via Jets.
3. Reassemble chunks, verify each against its CID.
4. Verify the reassembled file against the manifest's per-file SHA-256.

Until Phase 4, `safecloud:` sources are skipped and the loader falls through to HTTPS sources. The multi-source fallback mechanism handles this transparently.

## Volume Registry

The base maintains a registry of installed volumes at `/var/lib/safebox/volumes/volume-registry.json`:

```json
{
  "volumes": {
    "sha256:a1b2c3d4e5f6...": {
      "type": "model",
      "name": "qwen-3.6-27b",
      "version": "1.0.0",
      "mountPath": "/srv/safebox/models/a1b2c3d4e5f6...",
      "installedAt": "2026-04-23T14:30:00.000Z",
      "blessingClaim": {
        "ocp": 1,
        "stm": { "type": "volumeBlessing", "manifestHash": "sha256:a1b2c3..." },
        "key": ["..."],
        "sig": ["..."]
      },
      "files": 42,
      "totalBytes": 27000000000
    }
  }
}
```

The registry is written atomically (write to temp, rename) after each install or removal. It serves two purposes:

1. **Audit trail.** The `blessingClaim` field stores the complete OCP claim that authorized the install. An auditor can verify that the claim is valid, that it was signed by the right governance keys, and that the manifest hash matches the directory name.

2. **Quick lookup.** The Safebox plugin can query `GET /volumes/list` to see what's installed without scanning the filesystem. The registry also records the mount path, so the plugin knows where to find the volume inside a container.

## Read-Only Mount into Containers

After installation and verification, volumes are bind-mounted into containers with the `:ro` (read-only) flag. This prevents the container from modifying the volume's contents -- a container cannot tamper with its own model weights, runner binaries, or app code after they've been verified.

The bind-mount is set up at container creation time (`opsContainers.handleCreate()`) using the volume's mount path from the registry. If a volume is installed after the container is already running, the container must be recreated to pick up the new mount (or the base can use `docker exec` to create a mount namespace, but this is not implemented -- a restart is simpler and more auditable).
