# safebox-models — Operator CLI

The operator-facing command-line interface for managing models on a Safebox. Wraps the System component's `/models/install`, `/models/list`, `/models/<hash>/verify`, and `/models/<hash>/remove` endpoints with HMAC signing handled automatically. Also provides a local-only mode that does filesystem operations directly — useful for development and single-operator deployments.

This is the "dnf-like" experience layer for Safebox models. One command per action, sensible defaults, helpful errors, idempotent.

---

## Install

The CLI itself has no dependencies beyond Node.js 18 or newer (uses only built-in modules: `crypto`, `http`, `fs`, `path`). Drop the directory anywhere on `$PATH`:

```bash
# Anywhere on PATH
ln -s /opt/safebox-infrastructure/cli/safebox-models/safebox-models \
      /usr/local/bin/safebox-models

# Or run directly
/opt/safebox-infrastructure/cli/safebox-models/safebox-models --help
```

---

## At a glance

```bash
# What's available?
safebox-models catalog

# What's already installed?
safebox-models list

# Show details about a specific model
safebox-models show qwen-3-32b

# Install (production)
safebox-models install whisper-large-v3-turbo

# Install (local mode — no System component, no HMAC required)
safebox-models install sdxl-base-1.0 --local --yes

# Verify SHA-256 of installed weights
safebox-models verify whisper-large-v3-turbo

# Uninstall
safebox-models remove whisper-large-v3-turbo

# Diagnose setup
safebox-models doctor
```

---

## How it talks to Safebox

```
operator's shell                           Safebox host (one machine)
─────────────────                          ─────────────────────────────
$ safebox-models install qwen-3-32b
                ↓
   reads runner manifest from
   /opt/safebox-infrastructure/
   model-runners/vllm/manifests/qwen-3-32b.json
                ↓
   reads install manifest
   (sibling .install.json file or --install-manifest)
                ↓
   computes manifest hash
                ↓
   HMAC-signs the request                  ┌──────────────────────────────┐
                ↓                          │ System component             │
   POST /models/install  ─────────────────▶│ 127.0.0.1:7780               │
                                            │  verifies HMAC               │
                                            │  validates manifest          │
                                            │  re-hashes manifest          │
                                            │  downloads weight files      │
                                            │  verifies each SHA-256       │
                                            │  atomic rename into          │
                                            │  /srv/safebox/models/<hash>/ │
   ◄────────────────────────────────────── │ returns status               │
   stages runner manifest into             └──────────────────────────────┘
   /etc/safebox/runners/vllm/manifests/
                ↓
   prints next steps
```

In `--local` mode, every step on the right is skipped. The CLI just stages the runner manifest into `/etc/safebox/runners/<runner>/manifests/<name>.json` and assumes the operator has staged weights themselves (e.g. via `huggingface-cli download`).

---

## Catalog vs Install manifests

The catalog you see with `safebox-models catalog` shows two kinds of manifests:

**Runner manifests** (always present) — at `model-runners/<runner>/manifests/<name>.json`. These describe how the model-runner should launch the model: vLLM args, ComfyUI workflow family, Whisper compute type, etc. The CLI uses these to populate the runner's config when staging.

**Install manifests** (the `●` marker) — at `model-runners/<runner>/manifests/<name>.install.json`. These describe what the System component should download: every weight file's path, size, SHA-256, and source URL(s). The CLI sends these to the System component for production installs.

The catalog distinguishes them visually:

```
  vllm:
    ● qwen-3-32b              Alibaba          Apache-2.0           ← ready to install
    ○ deepseek-v3             DeepSeek         DeepSeek License     ← runner manifest only
```

To create an install manifest for a model that has staged weights:

```bash
# 1. Download weights using your tool of choice
huggingface-cli download Qwen/Qwen3-32B --local-dir /tmp/qwen3-32b-weights

# 2. Generate an install manifest skeleton
safebox-models make-install-manifest qwen-3-32b /tmp/qwen3-32b-weights

# 3. Edit the resulting .install.json to add real `sources` URLs
$EDITOR /opt/safebox-infrastructure/model-runners/vllm/manifests/qwen-3-32b.install.json

# 4. Verify the hash matches what was computed
safebox-models show qwen-3-32b

# 5. Have your M-of-N signers sign the manifest. (The CLI prints the hash;
#    that hash is what they sign.)
```

---

## Commands

### `catalog`

Lists every manifest discovered in the Infrastructure repo, grouped by runner. Filled circle (`●`) means a sibling `.install.json` exists and the model can be installed in production mode. Empty circle (`○`) means runner manifest only — the operator must provide an install manifest to install in production.

### `show <name>`

Prints the full details of a single manifest: vendor, license, GPU requirements, disk size, paths to both the runner manifest and (if present) the install manifest. Use `--json` for machine-readable output.

### `list`

Lists the models installed on this Safebox. By default, talks to the System component's `/models/list`. With `--local`, reads `/srv/safebox/models/` directly.

### `install <name>`

Installs a model.

**Production path** (default): reads the install manifest, computes the canonical hash, HMAC-signs an `/models/install` request, and POSTs to the System component. The System component re-validates everything, downloads the weight files from their `sources`, verifies each file's SHA-256, and atomically renames the staging directory into `/srv/safebox/models/<hash>/`.

**Local path** (`--local`): skips the System component entirely. Stages the runner manifest into `/etc/safebox/runners/<runner>/manifests/<name>.json`. Weights are expected to be pre-staged by the operator.

After either path, the CLI prints the docker run command for the runner.

Options:

- `--yes` — skip the confirmation prompt
- `--install-manifest <path>` — override the bundled install manifest
- `--local` — local-only mode (see above)

### `verify <name>`

Re-hashes the installed weight files and compares to the manifest's recorded SHA-256s. With `--local`, walks the directory directly. Without, calls `/models/<hash>/verify` on the System component (which does the same on the host's filesystem). Used in audit/sync workflows.

### `remove <name>`

Uninstalls a model. The System component atomically renames the directory into a trash location and rm -rf's it. With `--local`, does the same locally.

### `doctor`

Diagnoses common setup issues:

- Is the Infrastructure repo where the CLI expects?
- Does the model-runners/ directory exist and have manifests?
- How many catalog entries have install manifests (production-ready) vs only runner manifests?
- Is `/srv/safebox/models/` present and readable?
- Is the HMAC key present at `/etc/safebox/system.hmac`?
- Is the System component listening on `127.0.0.1:7780`?

Run this first when something doesn't work.

### `make-install-manifest <name> <weights-dir>`

Walks a directory of weight files, computes SHA-256 for each, and emits a skeleton install manifest the operator can edit before committing.

---

## Options

Every command accepts:

| Flag | Default | What it does |
|---|---|---|
| `--infrastructure-dir <path>` | `$SAFEBOX_INFRA` or `/opt/safebox-infrastructure` | Where to find the Infrastructure repo |
| `--system-url <url>` | `$SAFEBOX_SYSTEM_URL` or `http://127.0.0.1:7780` | System component URL |
| `--hmac-key-path <path>` | `$SAFEBOX_HMAC_KEY` or `/etc/safebox/system.hmac` | HMAC key file |
| `--install-manifest <path>` | (sibling `.install.json`) | Use this install manifest instead |
| `--local` | off | Skip the System component; filesystem ops directly |
| `--json` | off | Machine-readable JSON output |
| `--yes` / `-y` | off | Skip confirmation prompts |
| `--help` / `-h` | — | Show help |

Environment variables: `SAFEBOX_INFRA`, `SAFEBOX_SYSTEM_URL`, `SAFEBOX_HMAC_KEY`, `SAFEBOX_MODELS_DIR`, `SAFEBOX_RUNNER_CONFIG_DIR`, `SAFEBOX_DEBUG=1` for stack traces on errors.

---

## Security

**Manifest hash discipline.** The CLI computes the manifest hash using the same canonical-form algorithm as the System component (sorted keys, no whitespace, integers only — no floats). A unit test cross-checks against `aws/scripts/components/system/opsModels.js` to guarantee byte-for-byte agreement. If the canonicalizers ever diverge, every install fails fast with `MANIFEST_HASH_MISMATCH` rather than silently installing the wrong thing.

**HMAC signing.** Every request to the System component is signed with `hmac_sha256(timestamp + '.' + nonce + '.' + body, key)`. Headers: `X-Safebox-Timestamp`, `X-Safebox-Nonce`, `X-Safebox-Signature`. The key is read from `/etc/safebox/system.hmac` (or the path you pass) — never embedded in the CLI binary.

**M-of-N governance.** The CLI does not handle M-of-N signing itself. That happens out-of-band: signers approve a specific manifest hash, and the System component refuses to install anything whose hash doesn't match an approved one. The CLI is the thing that constructs the install request — the governance gate happens behind the System component.

**No automatic weight download in `--local` mode.** Local-mode installs deliberately do not pull from the network. The operator must stage weights with a tool of their choosing (huggingface-cli, manual download, internal mirror, etc.) and the CLI verifies their hashes locally if the operator provides an install manifest. This is on purpose — local mode is for development and single-operator deployments, both of which benefit from the operator knowing exactly where their bytes came from.

---

## Compare to the prior workflow

Before this CLI:

```bash
# Construct the install manifest manually
cat > /tmp/manifest.json <<EOF
{ ... 200 lines of JSON ... }
EOF

# Compute the canonical hash (no easy way without the System component code)
node -e "
  const {_computeManifestHash} = require('/opt/safebox-infrastructure/aws/scripts/components/system/opsModels');
  console.log(_computeManifestHash(require('/tmp/manifest.json')));
"

# Build the HMAC headers
TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODY=$(cat <<EOF
{ "managedContainer": "_host", "manifestHash": "abc...", "manifest": {...} }
EOF
)
SIG=$(printf '%s.%s.%s' "$TS" "$NONCE" "$BODY" | openssl dgst -sha256 -hmac "$(cat /etc/safebox/system.hmac)" -hex | awk '{print $2}')

# POST
curl -X POST http://127.0.0.1:7780/models/install \
  -H "X-Safebox-Timestamp: $TS" \
  -H "X-Safebox-Nonce: $NONCE" \
  -H "X-Safebox-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

After this CLI:

```bash
safebox-models install qwen-3-32b
```

That's the experience win. The operator who deploys a Safebox today doesn't think about HMAC, canonicalization, or curl flags — they think about which model they want to run.

---

## How this fits the runner ecosystem

The five production runners (`privacy-filter`, `mineru`, `vllm`, `whisper`, `comfyui`) each ship a `manifests/` directory with runner config in JSON form. The CLI scans those directories at runtime — adding a new model to the catalog is a one-file commit to the Infrastructure repo, no CLI changes required. The CLI also doesn't enforce any per-runner conventions; whatever the runner accepts in its manifest, the CLI shows.

This means the workflow for adding a new model end-to-end is:

1. Write a runner manifest at `model-runners/<runner>/manifests/<name>.json`
2. Either: write a sibling `.install.json` with `files[]` + `sources[]` + SHA-256s (production)
3. Or: pre-stage weights and use `--local` (dev)
4. `safebox-models install <name>`
5. Start the runner container with `MODEL_NAME=<name>`

Five steps, all reversible, all idempotent.

---

## Testing

The CLI ships with a unit test at `test/test-cli.js`. The most important test is the **byte-for-byte cross-check** of `canonicalize()` and `computeManifestHash()` against the System component's implementation at `aws/scripts/components/system/opsModels.js`. If those ever diverge, every production install fails with `MANIFEST_HASH_MISMATCH` — the test catches the divergence before it ships.

```bash
cd cli/safebox-models
node test/test-cli.js
```

52 assertions, including 20 canonicalize cases (null, bools, ints, strings with unicode/escapes, arrays, nested objects, full manifests), HMAC signing checks, byte-formatting, type rejection (floats, NaN, undefined), catalog scanning against the live repo, and `walkAndHash` against a temp directory.

---

## Future enhancements

Worth flagging as known not-yet-built:

- **Streaming progress for the install download.** Today the CLI POSTs the install request and waits for the System component to return. Big models can take 30+ minutes to download. A progress channel (Server-Sent Events from the System component or polling `/models/<hash>/status`) would let the CLI render a progress bar.
- **Model pinning.** `safebox-models pin <name>@<hash>` would record that a specific manifest hash is the approved one for this Safebox, and subsequent `install <name>` calls without an explicit hash would refuse to install anything else. Useful in production fleets.
- **Catalog update from a Safebox-signed remote.** Today the catalog is local (whatever ships with the Infrastructure repo). A signed remote catalog would let Anthropic (or Safebots Inc., or any operator) publish updated manifests that propagate to deployed Safeboxes after M-of-N approval.

None of these are gating for v1.0 — what's here is enough to actually install and manage models on a Safebox without hand-rolling HTTP requests.
