# Model Supply Chain Protocol

**Wire spec for `/models/*` endpoints in the Safebox Infrastructure System component.**

The system component exposes endpoints for installing, listing, verifying, and removing AI model weights on the Safebox AMI. All operations are host-scope (`managedContainer: "_host"`) and are expected to be gated by Safebox M-of-N governance the same way `dnf` is.

---

## Trust model

A model on a Safebox is identified by the **SHA-256 of its canonical manifest JSON**. The manifest itself declares:

- The model's identity (`name`, `version`, `license`, `runnerType`)
- The list of weight files, with per-file SHA-256 and total size
- One or more HTTPS download sources per file (Hugging Face, S3, mirrors)

The system component never trusts a download. After fetching each file it verifies the SHA-256 against the manifest before moving the file into the active models directory. If any file fails to verify or download, the entire install rolls back — nothing is left in the active directory.

What Safebox M-of-N actually signs is the **manifest hash**. To pull a new model version, Safebox publishes a new manifest with new file hashes, computes its canonical hash, and gets M-of-N approval for that hash. The system component request carries `{manifestHash, manifest}` and rejects the install with `MANIFEST_HASH_MISMATCH` if `sha256(canonicalize(manifest)) !== manifestHash`. That makes the manifest itself the unit of governance.

Installed models live at `/srv/safebox/models/<manifestHash>/`. The directory name **is** the manifest hash, so an auditor can verify a given install matches a known-good manifest by hashing the `manifest.json` inside the directory.

---

## Canonical JSON

Both Safebox and the system component compute the manifest hash from the same canonical encoding (RFC 8785-compatible subset):

- Object keys sorted ascending by code unit
- No whitespace
- Strings JSON-stringified (escape rules per ECMA-262)
- Integers in shortest form (no leading zeros, no `1e0`-style)
- Arrays preserve declaration order
- `true`, `false`, `null` as bare tokens
- Floats are NOT supported — sizes must be integers

The system component's implementation is in `aws/scripts/components/system/opsModels.js` (function `canonicalize`). It's small enough to read in one sitting (~30 lines) and locked to the test vectors in `test/testModelsCanonical.js`. If your side computes a different hash for the same manifest, an install will fail-loud with `MANIFEST_HASH_MISMATCH` — that's the drift signal.

---

## Manifest schema

```json
{
  "name":           "stable-audio-3-medium",
  "version":        "1.0.0",
  "license":        "Stability-Community-License",
  "runnerType":     "stable-audio-3",
  "totalSizeBytes": 5800000000,
  "files": [
    {
      "path":      "model.safetensors",
      "sizeBytes": 5800000000,
      "sha256":    "abc...",
      "sources": [
        "https://huggingface.co/stabilityai/stable-audio-3-medium/resolve/main/model.safetensors",
        "https://safebots-models.s3.amazonaws.com/stable-audio-3-medium/model.safetensors"
      ]
    }
  ],
  "metadata": {
    "author": "Stability AI",
    "paper":  "https://arxiv.org/abs/2605.17991"
  }
}
```

**Constraints:**
- `name` — 1-128 chars, `[a-zA-Z0-9._-]`
- `version` — 1-64 chars
- `license` — 1-256 chars
- `runnerType` — 1-64 chars, `[a-z0-9-]` (identifies which runner container consumes this model)
- `totalSizeBytes` — positive integer, MUST equal `sum(files[].sizeBytes)`
- `files` — 1-256 entries
- `files[].path` — 1-256 chars, no `..`, no leading `/`, no `\`
- `files[].sizeBytes` — positive integer, ≤ 200 GB
- `files[].sha256` — exactly 64 lowercase hex chars
- `files[].sources` — 1-16 HTTPS URLs
- `metadata` — any JSON-serializable extra fields (passed through)

---

## Endpoints

All endpoints are `POST` and require `managedContainer: "_host"` in the body. The HMAC authentication on the outer request is the same as for all other System component calls.

### POST /models/install

Install a model: download each file, verify SHA-256, atomically move into the active models directory.

**Request:**
```json
{
  "managedContainer": "_host",
  "manifestHash":     "<64 hex chars, sha256 of canonical manifest>",
  "manifest":         { /* full manifest object */ }
}
```

**Response (success):**
```json
{
  "status": "ok",
  "data": {
    "manifestHash": "abc...",
    "name":         "stable-audio-3-medium",
    "version":      "1.0.0",
    "license":      "Stability-Community-License",
    "runnerType":   "stable-audio-3",
    "installedAt":  "2026-05-20T10:00:00.000Z",
    "files": [
      { "path": "model.safetensors", "sha256": "abc...", "sourceUsed": "https://..." }
    ]
  }
}
```

**Response (already installed and verifies):**
```json
{
  "status": "ok",
  "data": {
    "manifestHash":     "abc...",
    "alreadyInstalled": true
  }
}
```

**Error codes:**
- `FORBIDDEN_ACTION` (403) — `managedContainer` was not `_host`
- `BAD_REQUEST` (400) — manifest validation failed (see schema)
- `MANIFEST_HASH_MISMATCH` (400) — `sha256(canonicalize(manifest)) !== manifestHash`
- `DOWNLOAD_FAILED` (502) — all configured sources for some file failed (or returned wrong bytes)
- `INSTALL_FAILED` (500) — unexpected error during install; staging directory is cleaned up

Idempotent: if a model with the same `manifestHash` is already installed and passes verification, returns `alreadyInstalled: true` without re-downloading. If the on-disk install is corrupt, it's removed and reinstalled fresh.

### POST /models/list

List installed models.

**Request:**
```json
{
  "managedContainer": "_host"
}
```

**Response:**
```json
{
  "status": "ok",
  "data": {
    "models": [
      {
        "manifestHash":   "abc...",
        "name":           "stable-audio-3-medium",
        "version":        "1.0.0",
        "license":        "Stability-Community-License",
        "runnerType":     "stable-audio-3",
        "totalSizeBytes": 5800000000
      }
    ]
  }
}
```

### POST /models/{manifestHash}/verify

Re-verify the SHA-256 of every file on disk for an installed model. Use this periodically to detect bit rot or tampering.

**Request:**
```json
{
  "managedContainer": "_host"
}
```

**Response (success):**
```json
{
  "status": "ok",
  "data": {
    "manifestHash": "abc...",
    "verifiedAt":   "2026-05-20T10:00:00.000Z",
    "files": [
      { "path": "model.safetensors", "sha256": "abc..." }
    ]
  }
}
```

**Response (verification failed):**
```json
{
  "status": "error",
  "code":   "VERIFICATION_FAILED",
  "data": {
    "ok":     false,
    "reason": "model.safetensors SHA-256 mismatch: expected abc..., got def..."
  }
}
```

### POST /models/{manifestHash}/remove

Atomically delete an installed model. The directory is first renamed into a `.trash` slot, then deleted, so callers never see a partially-removed install.

**Request:**
```json
{
  "managedContainer": "_host"
}
```

**Response:**
```json
{
  "status": "ok",
  "data": {
    "manifestHash": "abc...",
    "removed":      true
  }
}
```

---

## Filesystem layout

After install, the model lives at:

```
/srv/safebox/models/
└── <manifestHash>/
    ├── manifest.json     (canonical bytes, same content used to compute the hash)
    └── <files as declared in manifest, with their relative paths>
```

Runners (the Python containers that actually serve inference) mount `/srv/safebox/models/<manifestHash>/` read-only and load the weights from there. The runners themselves are unprivileged — they don't have write access to the models directory; only the system component (via `safebox-infra` user) does.

---

## How Safebox should use this

The flow is:

1. **Author or update a model manifest.** Safebox composes a manifest with the SHA-256 of every weight file and the canonical sources to fetch from.
2. **Compute the canonical hash.** Use the same canonicalization function as the system component. The system component has `canonicalize()` in `opsModels.js`; mirror it on the Safebox side.
3. **Get M-of-N approval for the hash.** The hash is what governance signs. Different version → different manifest → different hash → new approval.
4. **POST to /models/install.** With a valid HMAC and `managedContainer: "_host"`. The system component validates, downloads, verifies, installs.
5. **Periodically verify.** Run `POST /models/{hash}/verify` as part of audit sweeps.
6. **To upgrade a model:** install the new manifest. The old version remains installed until you call `/models/{oldHash}/remove`. This makes upgrades atomic from the runner's perspective — it can switch over once the new model is ready, then the old one is removed.

---

## What this does NOT cover

- **Running inference.** That's the runner containers' job (`model-runners/<runnerType>/`). The system component only handles the supply chain.
- **Model serving endpoints.** A separate API spec covers `/v1/audio/generate`, `/v1/chat/completions`, etc. See `MODEL-RUNNER-API-SPEC.md`.
- **Model discovery.** Safebox is expected to know which models it wants; the system component is a delivery mechanism, not a registry.

---

## Audit

Every model install/verify/remove emits a structured audit entry to `journalctl -t safebox-system`. The entry includes the manifest hash, runner type, name, version, and the timing.

For an external auditor verifying a Safebox AMI:

```bash
# Every model on the box, by manifest hash
ls /srv/safebox/models/

# For any model, verify the directory contents match the manifest
for d in /srv/safebox/models/*/; do
    hash=$(basename "$d")
    echo "Verifying $hash..."
    # The directory name IS the manifest hash; computing it from the manifest
    # file should match.
    # (Real verification uses /models/<hash>/verify endpoint, but the same
    # computation can be done by hand.)
done
```

The auditor can then cross-check the manifest hashes against the M-of-N signatures Safebox holds, confirming every model on the box was approved by governance.
