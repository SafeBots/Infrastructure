# Artifact Updates: Hash Pinning, M-of-N Signing, and Sunset Workflow

How a Safebox community adds, updates, and retires **any artifact** under M-of-N governance — AI models, RPM packages, npm packages, pip packages, HuggingFace files, custom binaries. One pipeline, one trust pattern, one audit format. The companion auditor-facing doc is [INDUCTIVE-TRUST.md](./INDUCTIVE-TRUST.md). The install pipeline implementation is in [`aws/scripts/components/system/opsArtifacts.js`](../aws/scripts/components/system/opsArtifacts.js) (dispatcher) and [`opsModels.js`](../aws/scripts/components/system/opsModels.js) (canonical validator). The unified manifest schema applies to every artifact kind; the per-kind install step is what differs.

| Kind | Action type | Install destination | Source of hashes |
|---|---|---|---|
| `model` | `models/install` | `/srv/safebox/models/<manifestHash>/` | HuggingFace API + local sha256sum |
| `rpm` | `packages/system/install` | `dnf localinstall` of verified files | `rpm -qp --queryformat '%{SIGSHA256}'` or `dnf repoquery --location` |
| `npm` | `packages/node/install` | `/var/lib/safebox/node-runtime/<consumer>/node_modules/` | `npm view <pkg>@<version> dist.integrity` |
| `pip` | `packages/python/install` | `pip install --require-hashes` into a venv | PyPI JSON API: `https://pypi.org/pypi/<pkg>/<version>/json → .urls[].digests.sha256` |
| `hf-file` | `hf-files/install` | `/srv/safebox/hf-cache/<manifestHash>/` | HuggingFace API: `.siblings[].lfs.sha256` |
| `binary` | `binaries/install` | `/srv/safebox/binaries/<manifestHash>/` | Local sha256sum after verifying upstream signature |

The rest of this document walks through each lifecycle stage in detail. The pattern is identical across kinds — sections 2 through 7 apply to every artifact, with kind-specific notes inline where the install step differs.

The original model-focused content is preserved in section 8 for engineers operating purely in the model lifecycle. The unified system is a strict generalization: nothing about model installs changed except that they now run through `opsArtifacts.js`'s dispatcher.

---

## 1. The lifecycle of an artifact on a Safebox

```
                                                    ┌─────────────────┐
   baseline manifest                                │ /srv/safebox/   │
   (in this repo, with                              │   models/       │
   placeholder sha256s)                             │     <hash>/     │
          │                                         │       *.json    │
          ▼                                         │       weights/  │
   ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
   │ A. populate  │ ─► │ B. M-of-N     │ ─► │ C. install   │
   │   hashes     │    │    sign       │    │   verify     │
   └──────────────┘    └───────────────┘    └──────────────┘
        ▲                                          │
        │                                          ▼
        │                                   ┌──────────────┐
        │   ┌──────────────────────────────►│ D. runtime   │
        │   │                               │   use        │
        │   │                               └──────────────┘
        │   │                                       │
   ┌────┴───┴──────┐                                │
   │ E. update     │ ◄──────────────────────────────┤
   │   path        │     new version, new hashes,   │
   └───────────────┘     M-of-N signs again         │
                                                    │
                                            ┌───────▼──────┐
                                            │ F. sunset    │
                                            │   workflow   │
                                            └──────────────┘
```

Five states, one signing gate at each transition that changes state. The same M-of-N governance that gates `dnf install` gates every model lifecycle event.

---

## 2. Stage A — Populating per-file SHA-256s

The manifests in `config/artifacts/<kind>/*.json` ship with placeholder SHA-256 values (sixty-four zeros). This is intentional: the canonical hashes change every time an upstream file is updated, and the manifests in this repo are templates, not signed authority.

A community deploying an artifact fills in the real hashes via path 1 (registry API) or path 2 (download-and-compute), ideally both. The per-kind commands are:

### For models (kind: `model`)

```bash
# HuggingFace publishes sha256 in the API for every LFS file:
curl -sL https://huggingface.co/api/models/openai/whisper-large-v3 \
  | jq '.siblings[] | select(.lfs) | {filename: .rfilename, sha256: .lfs.sha256}'

# Or download and compute locally:
curl -sL -o /tmp/model.safetensors \
  https://huggingface.co/openai/whisper-large-v3/resolve/main/model.safetensors
sha256sum /tmp/model.safetensors
```

### For RPM packages (kind: `rpm`)

```bash
# Read the published hash from Amazon Linux repodata:
dnf repoquery --location --queryformat='%{name} %{checksum_type}:%{checksum}' nginx

# Or download and compute:
dnf download nginx --downloadonly --destdir=/tmp/
sha256sum /tmp/nginx*.rpm

# Bonus — verify the GPG signature, which Amazon Linux applies by default:
rpm -K /tmp/nginx*.rpm
```

### For npm packages (kind: `npm`)

```bash
# Read the integrity hash from the npm registry (sha512 base64-encoded):
npm view express@4.18.2 dist.integrity

# Read the tarball URL:
npm view express@4.18.2 dist.tarball

# Download and compute both sha256 and integrity locally:
npm pack express@4.18.2
sha256sum express-4.18.2.tgz
# For npm integrity check, the registry already provides it via dist.integrity.
```

The manifest carries both `sha256` (universal) and `integrity` (npm-native sha512). Both must verify before install.

### For pip packages (kind: `pip`)

```bash
# Read the sha256 from PyPI's JSON API:
curl -sL https://pypi.org/pypi/fastapi/0.115.0/json \
  | jq '.urls[] | {filename: .filename, sha256: .digests.sha256}'

# Or download and compute:
pip download fastapi==0.115.0 --no-deps --dest /tmp/
pip hash /tmp/fastapi-*.whl
```

For a whole dependency graph, `pip-compile --generate-hashes` produces a locked requirements.txt automatically.

### For HuggingFace standalone files (kind: `hf-file`)

```bash
curl -sL https://huggingface.co/api/datasets/<repo> \
  | jq '.siblings[] | select(.lfs) | {filename: .rfilename, sha256: .lfs.sha256}'
```

### Path 3 (high-assurance) — compare both, fail loudly on mismatch

Production communities should do both registry-API lookup and local-compute, refusing to sign the manifest if the values disagree. A mismatch can indicate a registry account compromise, a CDN cache poisoning, or a regional MITM. The infrastructure refuses to install when path 1 ≠ path 2; this is also what the install-time verification does for every download attempt against the signed manifest.

After this stage, the manifest still lives in your staging environment. It is not yet authoritative.

---

## 3. Stage B — M-of-N signing the manifest

Once every file's sha256 is populated, the manifest is canonicalized to RFC 8785 JSON (sorted keys, no whitespace), sha256'd to produce the **manifest hash**, and submitted as a Safebox `Safebox/action` of type `models/install` with the manifest in the action's attributes.

The action enters the standard M-of-N approval flow:

```
   manifest (with all hashes) ─► canonicalize ─► sha256 ─► action stream
                                                                │
                                                                ▼
                                                    ┌─────────────────────┐
                                                    │ Policy: 3 of 5      │
                                                    │ approvers must sign │
                                                    └─────────────────────┘
                                                                │
                                            ┌───────────────────┼───────────────────┐
                                            ▼                   ▼                   ▼
                                       Auditor #1          Auditor #2          Auditor #3
                                       signs OCP           signs OCP           signs OCP
                                                                │
                                                                ▼
                                                       executeApproved
                                                       fires once (TOCTOU-safe
                                                       atomic UPDATE per
                                                       Safebox.md audit log)
                                                                │
                                                                ▼
                                                       POST /models/install
                                                       (carrying verifiedOpToken)
                                                                │
                                                                ▼
                                                        installer runs
```

Signers use the OpenClaim envelope (`Safebox.Signature.buildClaim` in the Safebox plugin source) — the same ES256 (P-256 + SHA-256) signature format used for any privileged-action approval. There is no model-specific signing path; model installs are governance events like any other.

The policy attached to `models/install` is community-configurable. Common defaults:

| Community size | Default M-of-N | Rationale |
|---|---|---|
| Startup pilot (1–5 users) | 1 of 1 (auto-approve) or 2 of 3 | Friction-minimized; rely on container isolation |
| Mid-market regulated | 3 of 5 | Two compromised approvers tolerated |
| Healthcare / finance / DoD | 5 of 9 | Four compromised approvers tolerated |
| Sovereign deployment | M-of-N with cross-jurisdiction signers | No single-jurisdiction subpoena suffices |

The signed manifest, with all signatures attached, becomes part of the Safebox stream record. It can be replayed, audited, exported to compliance teams, and verified by any party with the signer public keys — including from a web browser. This is the cryptographic record that replaces SOC 2 sampling for model deployment events.

---

## 4. Stage C — Install verification

`opsModels.handleInstall()` receives the manifest and the `verifiedOpToken` (a short-lived bearer token the system component issues only after enough signatures land). For each file in `manifest.files`:

1. The installer attempts `sources[0]`, then `sources[1]`, etc. The first source to return a 200 is used. (Mirror fallback as documented in `opsModels.js:187`, `downloadWithFallback()`.)
2. The downloaded file's size is checked against `sizeBytes`. Mismatch → abort, delete partial download, throw.
3. The file's sha256 is computed and compared against the manifest's `sha256`. Mismatch → abort, delete, throw.
4. If both pass, the file is moved into the staging directory at `/srv/safebox/models/.staging/<manifestHash>/<path>`.
5. After every file passes, the staging directory is atomically renamed to `/srv/safebox/models/<manifestHash>/`.

The atomic rename guarantees that runners see either the complete installed model or no model at all — never a half-installed state. The directory name IS the manifest hash. An auditor inspecting the running filesystem can compute the manifest's canonical hash from the JSON file inside the directory and compare it to the directory name; equal hashes mean the install matches the signed manifest exactly.

---

## 5. Stage D — Runtime use by runners

Runners mount `/srv/safebox/models/<manifestHash>/` **read-only** at the path expected by the runner type. For the runners defined in this repo:

| Model | Runner type | Mount path inside container |
|---|---|---|
| YuE | `yue-music` | `/srv/safebox/models/<hash>/` |
| Mochi 1 | `diffusion-video` | `/srv/safebox/models/<hash>/` |
| FLUX.1 schnell | `comfyui-image` | `/srv/safebox/models/<hash>/` |
| Kokoro 82M | `kokoro-tts` | `/srv/safebox/models/<hash>/` |
| Whisper Large v3 | `whisper-asr` | `/srv/safebox/models/<hash>/` |
| TripoSR | `triposr-3d` | `/srv/safebox/models/<hash>/` |
| LLM (vLLM tier) | `vllm` | `/srv/safebox/models/<hash>/` |
| LLM (llama.cpp tier) | `llama-cpp` | `/srv/safebox/models/<hash>/model.gguf` |

Runners do not fetch their own weights and have no write access to the model directory. This is the supply-chain separation: weight acquisition is M-of-N gated and host-scoped; weight usage is process-scoped and read-only. A compromised runner cannot substitute different weights for the ones the community signed off on.

---

## 6. Stage E — Updating an existing model

The simplest case: a new version of a model is published upstream (Whisper Large v4, FLUX.1 schnell-1.1, etc). The community decides to upgrade. The flow:

1. **A new manifest is prepared** with the new version's hashes (path 1+2 as above). The `version` field bumps; the manifest's content differs; therefore the manifest hash differs; therefore the install directory will be different.
2. **The new manifest goes through M-of-N signing** just like the first install. The same threshold, the same signers, the same auditable record.
3. **The installer installs the new version alongside the old one** — `/srv/safebox/models/<old-hash>/` and `/srv/safebox/models/<new-hash>/` coexist.
4. **A separate action retargets the runner** to the new model — typically a `runner/config` action that updates the runner's `LLAMA_MODEL_PATH` (or equivalent) environment variable. This action is also M-of-N gated.
5. **Once the new model is serving traffic**, an optional cleanup action retires the old version (Stage F).

The two-step pattern (install new, then retarget) is deliberate. It lets the community A/B compare the new model against the old without committing to it, and it makes rollback to the old model a one-action operation. If the new version misbehaves, the runner config can be flipped back in a single signed action — the old weights are still on disk.

### Rolling forward on minor patches

For minor patches where the upstream community simply re-uploads a tokenizer file or a config json, the new manifest can be signed with just the changed file's hash bumped. The directory name still changes (because the manifest hash changes), but the install is small.

---

## 7. Stage F — Sunsetting a model

A model is retired when:

- Its license terms change (rare but happens — vendor reclassifies, switches to NC, adds a revenue cap)
- A safety issue is discovered in the upstream weights
- The community decides to consolidate on fewer models
- Storage pressure on the AMI's ZFS pool requires reclaiming space

The sunset workflow is a `models/remove` action against the manifest hash. Like every other lifecycle event, M-of-N signs it. On execution:

1. The runner is first reconfigured to point away from this model (otherwise active inference would fail mid-request)
2. The system component takes a ZFS snapshot of `/srv/safebox/models/<hash>/` for rollback
3. The directory is removed
4. The audit log records the sunset event, with the reason field carrying the policy-text from the signing auditors

If a model needs to be reinstated after sunset, the original signed manifest is still in the Safebox stream record. Reinstalling is re-running the original `models/install` action — same hashes, same signers, same outcome.

---

## 8. Where the manifests live

This repo (`Infrastructure/config/artifacts/<kind>/*.json`) holds **baseline templates** with placeholder hashes. They are not authoritative — they're the starting point a deployment uses to construct its own signed manifest. The placeholder hashes (`0000...0000`) ensure these files cannot be accidentally signed; the validation in `opsModels.js` will reject them because no real file ever has all-zero sha256.

Authoritative signed manifests live in three places after signing:

1. **Inside the Safebox stream record**, as the attributes of the `Safebox/action` stream that triggered the install. This is the canonical source — every signature is attached, and the record is the audit trail.
2. **On the filesystem of the running Safebox**, at `/srv/safebox/models/<manifestHash>/manifest.json`. This is the runtime-accessible copy used by the runners and by `opsModels.handleVerify()` for on-demand re-verification.
3. **Optionally mirrored to a community manifest registry** (`https://manifests.<community>.example/<manifestHash>.json`) for cross-community sharing. Communities running the same model can adopt each other's signed manifests rather than re-signing from scratch — provided they trust the original signers.

Cross-community manifest sharing is what makes Safebox a network rather than an island. Two healthcare networks both running Whisper Large v3 for medical transcription can share the same signed manifest, with both communities' compliance teams signing off on it. The infrastructure treats them as the same install; the audit trail records both signing events.

---

## 9. Catalog vs manifest — what's the difference

The model **catalog** (in `docs/MODEL-CATALOG.md`) is human-readable documentation about what models exist, what licenses they have, what hardware they need. It changes as the team adds new options or updates recommendations. Catalog changes are made via PR like any docs change.

The model **manifest** (in `config/artifacts/<kind>/<name>.json`) is the machine-readable template that gets populated with hashes and signed for install. Manifest changes are made by PR for the template, then by M-of-N signing for the populated version that actually deploys.

A model lives in both. The catalog is the menu; the manifest is the recipe.

---

## 10. A note on supply-chain attacks via mirrors

The `sources` array in the manifest is a list of URLs the installer will try in order. This is a feature — it provides redundancy when HuggingFace is slow and lets organizations mirror weights to internal infrastructure for air-gapped deployment. But it's also a class of attack to defend against.

The defense is the sha256 verification. A compromised mirror that serves a malicious file with a different hash will fail verification and the install will abort. A compromised mirror that serves the same hash file as HF is, by definition, not serving a malicious file.

For high-assurance deployments, manifests can specify a single source — typically the community's own internal mirror, fed by an offline-verified copy of HF weights. The HF URL is then unreferenced in the signed manifest. This trades convenience for tighter attack surface: an HF account compromise can no longer reach the installed Safebox.

For most deployments, two-source manifests (HF primary, internal S3 fallback) are the right tradeoff: speed and redundancy from HF, sovereignty from the mirror, hash verification as the final gate.

---

## 11. The TL;DR for the next engineer reading this

1. Manifests in `config/artifacts/<kind>/` are templates. Real deployments populate hashes via HF API or local computation, ideally both.
2. Populated manifests get M-of-N signed via the standard `Safebox/action` flow with policy type `models/install`.
3. The install pipeline (`opsModels.js`) verifies sha256 on every file before atomic-renaming into place.
4. Directory name = manifest hash. Auditors verify by computing the canonical hash of the manifest JSON and comparing it to the directory name.
5. Updates install alongside, then retarget. Rollback is a runner config change, not a re-install.
6. Sunset is a `models/remove` action. ZFS snapshot before deletion lets the change be reversed.
7. The catalog is the menu. The manifest is the recipe. Both live in version control; only the manifest is signed.
