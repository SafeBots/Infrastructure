# Safebots Infrastructure

[![License](https://img.shields.io/badge/license-Source--Available-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0--pre-yellow.svg)](CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](CHANGELOG.md)

**Attested host image for the Safebox plugin.** Hardware-bound HMAC, deterministic build, single auditable HTTP API between Safebox and the host (the System component).

> **Status**: Pre-release working tree for the 1.0.0 launch. Versioning is held at 1.0.0 until first publication; subsequent changes increment 1.0.x.

> **Base layer, honestly**: the 1.0 base ships today as an Amazon-Linux/dnf AMI (`aws/scripts/components/base/install-base.sh`). The reproducible replacement — one pinned NixOS flake that builds a sealed, attestable image for AWS/GCP/Azure/Oracle/IBM/Alibaba — lives in `nixos/` and is in progress: see [`Nix.md`](Nix.md) (how it's built/sealed/attested per cloud) and [`Nix-turns.md`](Nix-turns.md) (the four-turn plan). Parity between the two is proven in [`nixos/PARITY.md`](nixos/PARITY.md). Until the NixOS build is verified on real hardware, the dnf AMI is the shipping base and reproducibility/attestation claims apply to the NixOS path, not the dnf one.

---

## Why this exists

The problem this solves is trust. If you run AI on someone else's server, you are trusting that the server does what they say — that it isn't logging your prompts, exfiltrating your data, or running different code than advertised. Normally you cannot check; you take it on faith. This repo removes the faith. It builds a host image whose exact contents can be measured by the hardware and proven to a remote party, so that "this box runs precisely this software and nothing else" becomes something you verify cryptographically rather than believe.

The mechanism is remote attestation. The host boots on confidential-compute hardware (AWS NitroTPM today, AMD SEV-SNP / vTPM on the other clouds) that measures the boot chain into a TPM and signs those measurements with a key rooted in the silicon. A verifier compares those signed measurements against a reference computed independently from public source. If they match, the box is provably running the blessed image; if a single bit differs, the measurement changes and the attestation fails. Secrets (like the disk-encryption key) are *sealed* to the measurement — the hardware releases them only when the box is in the blessed state, so a tampered image cannot decrypt the data it was trusted with.

For attestation to mean anything, the image has to be reproducible: a verifier must be able to rebuild it from source and get the identical measurement. That is why the base is moving to a pinned Nix closure (see the "Base layer, honestly" note above) — `dnf install` pulls whatever a mirror serves and can never reproduce bit-for-bit, whereas a hash-pinned Nix closure is a deterministic function of committed inputs. Reproducible build → deterministic measurement → meaningful attestation is the whole spine of the design, and the source-available license exists so anyone can actually perform that verification.

## What is attested, and what runs alongside it

Attestation covers the **base volume only** — the operating system, the hardened runtime, the System component, and the governance config. That is the thing that is measured, sealed, and reproducible. The base is deliberately small so it can be audited and so its measurement is stable across the lifetime of the image.

Everything large and changeable is **not** baked into the attested base — it is loaded alongside it as separate, mapped volumes:

- **Model weights** live on their own storage at `/srv/safebox/models/<manifestHash>/`, mounted **read-only** into the runners. They are far too large to bake into a measured image, and they change independently of the OS. Instead of being measured by the TPM, each model is governed by its own hash: the directory name is the SHA-256 of the model's canonical manifest, and that hash is what an M-of-N auditor quorum signs. Open-weight models are mounted here the same way — the supply chain verifies the weights against the signed manifest before anything can touch them. So the base is attested by measurement; the models are governed by content-addressed manifest signatures. Two mechanisms, same guarantee: nothing runs that a quorum didn't bless something content-addressed for.
- **Runner containers** (the processes that actually execute models) are digest-pinned images verified against the blessed base's allow-list before they start, and — under the layered-blessing model — an org's own app layers are additive-only over a platform-blessed standard container, blessed by that org's own M-of-N. See [Layered blessing](attestation/app-layers/README.md).
- **Application and user data** live on the encrypted ZFS volume, whose key is TPM-sealed to the attested measurement.

So the mental model is: a small, measured, reproducible **base volume** that attests itself, with models, runners, and data **mapped alongside** as volumes — each governed by its own content-addressed blessing rather than by being frozen into the base. This is what lets the box run 40+ GB of model weights and swap them over time while keeping the attested surface tiny and stable.

## How the two-AMI construction works (and why)

The last thing a hardened image must do is remove the final way in — SSH, and any cloud console or guest-agent shell — so that a running box has no interactive ingress at all. But you cannot build an image with no way in *and* configure it during the build, so the image is produced in two stages:

- **AMI-1, the builder** — a NixOS image whose only ingress is SSH. You boot it, and it is disposable. It is the *builder*, not the thing anyone attests or ships.
- **AMI-2, the attested image** — produced by running the deterministic **seal** (`attestation/ami2-seal/seal-ami2.sh`) against the builder: it removes sshd and host keys, scrubs SSM/waagent/google-guest-agent and every console agent, empties machine-id, logs, leases, and tmp, and normalizes every inode timestamp to a fixed epoch — **excluding** `/nix/store`, whose paths are content-addressed and must keep their canonical timestamps. The result has no ingress and a **deterministic measurement**: seal the same builder twice and the sealed images are byte-identical.

This two-stage split is what makes the attested measurement deterministic *by construction* rather than by hoping an entire OS image happens to be bit-reproducible (it is only ~91% so, which is useless for a hash — a PCR needs 100%). The builder can be messy; the seal constant-ises everything that varies; the sealed image is the reproducible, ingress-free, attestable artifact. The same NixOS config produces a builder and a sealed image for every supported cloud (AWS, GCP, Azure, Oracle, IBM, Alibaba) — only the disk format and the TPM/attestation particulars differ. Full detail: [`Nix.md`](Nix.md), [`attestation/ami2-seal/README.md`](attestation/ami2-seal/README.md).

## What this repo is

This repo builds an attested cloud image that runs the Safebox plugin. It is intentionally a thin Linux-level runtime layer: hardened OS, encrypted ZFS, hardened Docker, a single API (the System component) for the Safebox plugin to call when it needs to do something privileged on the host.

**The 1.0 installable surface is four components:**

- **`base`** — pinned packages, encrypted ZFS pool, hardened Docker, hardened PHP-FPM, hardened sysctls, SSH removed on the production AMI. The OS configuration that an auditor reads once and trusts.
- **`system`** — a small Node.js host service listening on per-container Unix domain sockets (one per managed container, plus one control socket for host operations). Safebox Node connects to a bind-mounted socket inside its container; the system component knows which container is calling from kernel-enforced socket identity, verifies the HMAC against that container's derived key, validates the request against `managed-containers.json`, dispatches to `child_process.execFile`, returns results. Test environments use a ZFS clone + keepalive pattern (aggressive 60s teardown unless pinged). The master HMAC key is bound to AWS Nitro attestation PCRs via HKDF — copying the disk to a different host produces a different key, and per-container keys are themselves HKDF-derived from the master so each container's key is cryptographically independent. See [`aws/docs/Safebox.md`](aws/docs/Safebox.md) for the transport and integration spec.
- **`dnsclient`** — separate systemd unit that handles IP announcement to the central DNS API. On boot reads its `safeboxId` + `accountToken` from `/etc/safebox/dnsclient.json` (populated by cloud-init from EC2 user-data), discovers its public IP via IMDSv2, generates a Nitro attestation document with `(safeboxId, reportedIp, challenge, timestamp)` bound into `user_data`, and POSTs to the configured DNS API. Re-announces on IP change and hourly heartbeat. Serves an HTTP challenge endpoint at port 8443 so the DNS API can confirm IP control. Separate process from `system` so dnsclient bugs can't reach the master HMAC key.
- **`autohost`** — separate systemd unit that handles custom-domain provisioning. This is the vendored public [Autohost](https://github.com/Safebots/Autohost) (pinned as a submodule at `vendor/autohost/`, unmodified) plus a Safebox config that maps Safebox paths/socket onto Autohost's config surface. Listens on a Unix socket; nginx forwards unknown-Host requests via a mirror directive. Cascade: negative cache → DNS sanity check → registrable-domain + per-IP + global rate limits → optional authorization hook → ACME HTTP-01 against Let's Encrypt → write per-host server block + cert → debounced nginx reload. Lets customers attach arbitrary domains by pointing DNS at the box. Safebox-specific governance (project/quota/token enforcement) plugs in through Autohost's `authorizeHook` seam without forking. See [`MIGRATION-autovhost-to-autohost.md`](aws/scripts/components/autohost/MIGRATION-autovhost-to-autohost.md).

That's the actual 1.0 deliverable. Roughly 5800 lines of Node across all four components (System ~4200, dnsclient ~1000, autohost ~600 from the vendored Autohost plus the acme-client dependency) plus a ~400-line base installer plus the pinned-package manifest. The System component is the bulk; dnsclient and autohost are small focused services that can each be audited in an afternoon.

## What this repo ALSO contains (designs and references, not yet installable)

These exist as engineering reference and pre-1.0 design work. They have spec docs and partial code, but no `install-<tier>.sh` script and no smoke tests against real hardware:

- **AI model supply chain (1.0 surface)** — the system component ships endpoints under `/models/*` ([wire spec](aws/docs/MODELS-PROTOCOL.md)) for installing, listing, verifying, and removing model weights. Every model is identified by the SHA-256 of its canonical manifest JSON; that hash is what Safebox M-of-N signs. Weights are downloaded from HTTPS sources (Hugging Face, S3, mirrors), verified against the manifest before any other process can touch them, and installed atomically into `/srv/safebox/models/<manifestHash>/`. Same `_host` scope as `dnf` — a compromised app-tenant cannot swap model weights without governance. The supply chain itself is 1.0; what's not yet 1.0 are the *runner containers* that consume the installed weights.
- **AI model runners** — ten production-ready Safebox-canonical runners: [`model-runners/privacy-filter/`](model-runners/privacy-filter/) (PII redaction), [`model-runners/mineru/`](model-runners/mineru/) (document extraction — PDF/DOCX/PPTX into LLM-ready Markdown), [`model-runners/vllm/`](model-runners/vllm/) (LLM chat/complete/embed via vLLM with five LLM family manifests), [`model-runners/whisper/`](model-runners/whisper/) (transcription via Faster-Whisper with five Whisper variants), [`model-runners/comfyui/`](model-runners/comfyui/) (text-to-image via ComfyUI with SDXL and FLUX manifests), [`model-runners/kokoro-tts/`](model-runners/kokoro-tts/) (text-to-speech via Kokoro 82M with English and multilingual manifests), [`model-runners/stable-audio-3/`](model-runners/stable-audio-3/) (text-to-audio via Stable Audio Open for music, SFX, ambient), [`model-runners/ltx-video/`](model-runners/ltx-video/) (text-to-video and image-to-video with synchronized audio via LTX-Video 2.3), [`model-runners/wan-video/`](model-runners/wan-video/) (sister video runner wrapping Wan 2.2 — MoE architecture for higher-quality finals; three manifests covering 5B and A14B variants), and [`model-runners/triposr/`](model-runners/triposr/) (image-to-3D-mesh via TripoSR). All share the same wire format (camelCase JSON, Unix socket transport, HMAC auth, audit-trail SHA-256 hashes). [`cli/safebox-models/`](cli/safebox-models/) provides the operator CLI for installing and managing these — wraps the System component's `/models/install` HMAC-gated API with a one-command UX and a `fetch-install-manifest` subcommand that materializes install manifests from HuggingFace's API on demand (so they never go stale in the repo). The full model catalog is in [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md); the runner inference protocol spec is in [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md). Post-1.0 runners: PBR-textured 3D (Hunyuan3D 2.1), audio-driven video (Wan 2.2-S2V), video editing (Wan VACE).
- **Speech and vision tiers** — design docs under [`docs/future/`](docs/future/) (VibeVoice ASR, Nemotron-Omni, speech protocol implementation). Same status: real spec work, no installers yet.
- **Composable architecture** — the original design called for 20 modular components ([`docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md`](docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md)). 1.0 ships two of them (base + system), with the system component's `/models` endpoints serving as the foundation for the model-tier components to plug into.
- **Reproducible NixOS base + six-cloud attested images.** The 1.0 base ships as an Amazon-Linux/dnf AMI, but the reproducible replacement is a single pinned NixOS flake (`nixos/`) that builds one image sealed (SSH removed, nondeterminism normalized) into an attestable, reproducible image for **AWS, GCP, Azure, Oracle (OCI), IBM Cloud, and Alibaba** — each instance deriving a unique per-instance identity from its vTPM for sealed, delegatable signing keys. How it's built, sealed, published, and attested per cloud: **[`Nix.md`](Nix.md)**. The four-turn plan to ship it: **[`Nix-turns.md`](Nix-turns.md)**.

The split is honest: 1.0 ships a complete, auditable AWS AMI with the system component (including the model supply chain), the base component, and the privacy-filter runner wired in. The other nine runners are production-ready code with passing tests, but they land through the model supply chain rather than being baked into the AMI — so they count as "ready to run" rather than "part of the installable base." Everything else is real engineering work for 1.1+ that builds on the same foundation.

## What this repo is NOT

- **The Safebox plugin** (governance, capabilities, sandboxed code execution) lives in [its own repo](https://github.com/Safebots/Safebox). A bug there is a plugin code change, not an AMI rebuild.
- **The Crypto plugin** (Q.Sandbox, OpenClaim signing, Merkle/Bloom data structures) lives in [its own repo](https://github.com/Safebots/Crypto).

Keeping the boundary clear keeps both sides auditable.

---

## Quick Start (AWS, 1.0)

```bash
git clone https://github.com/Safebots/Infrastructure.git
cd Infrastructure

# One-time per host: create the ZFS pool
sudo bash scripts/provision-safebox-ami.sh

# Generate the TPM-attested ZFS key
sudo bash scripts/setup-zfs-clones.sh

# Build the AMI with base + system
sudo bash aws/scripts/build-ami.sh base,system
```

The build script aborts loudly if you ask for a component that isn't installed (e.g. `base,llm-medium` will fail because `aws/scripts/components/llm-medium/` doesn't exist yet).

Detailed deployment guide: [`docs/AWS-NITRO-SETUP.md`](docs/AWS-NITRO-SETUP.md).

---

## Architecture

### Components (1.0)

```
aws/scripts/components/
├── base/                # OS hardening, ZFS, Docker, PHP-FPM, MariaDB (InnoDB⇄ZFS tuning), package pinning
│   ├── install-base.sh
│   ├── helpers/
│   │   └── flush-and-snapshot.sh   # FLUSH TABLES → clean ZFS snapshot for zfs-send replication
│   └── package.json
├── system/             # Safebox-facing host API via Unix domain sockets
│   ├── install-system.sh
│   ├── server.js          # routing, audit, identity reconciliation
│   ├── sockets.js         # per-container socket lifecycle
│   ├── auth.js            # HMAC sign/verify, nonce LRU
│   ├── secret.js          # Master key + per-container HKDF derivation
│   ├── nsmClient.js       # AWS Nitro attestation client
│   ├── cborDecode.js      # Minimal CBOR for attestation parsing
│   ├── config.js          # managed-containers.json loader
│   ├── opsSystem.js       # /system handler (npm/pip/cargo/gem/composer/dnf/git/migrate/zfs)
│   ├── opsTest.js         # /test handler (ZFS clone + docker + keepalive + yields)
│   ├── opsModels.js       # /models handler (manifest-hash-verified weights)
│   ├── opsContainers.js   # /containers handler (lifecycle)
│   ├── opsEmbed.js        # /embed handler (proxies to embeddings worker subprocess)
│   ├── embeddingsWorker.js # forked subprocess; loads @huggingface/transformers, runs inference
│   ├── package.json       # pinned npm deps (transformers, onnxruntime-node)
│   ├── package-lock.json  # locked versions + hashes; audit reads this
│   ├── sudoers/safebox-system          # the entire privileged surface
│   └── units/safebox-system.service
├── dnsclient/          # Attestation-signed IP announce + heartbeat
│   ├── dnsclient.js       # IMDS, announce, challenge server
│   ├── config.js          # /etc/safebox/dnsclient.json loader
│   ├── nsmClient.js       # NSM with user_data + nonce binding
│   ├── install-dnsclient.sh
│   └── units/safebox-dnsclient.service
├── autohost/           # On-demand nginx vhost + ACME provisioning (vendored Autohost)
│   ├── autohost.safebox.json      # Safebox config → Autohost's config surface
│   ├── nginx-templates/safebox-autohost.conf
│   ├── install-autohost.sh        # installs from vendor/autohost submodule
│   ├── MIGRATION-autovhost-to-autohost.md
│   ├── test/testAutohostSplash.js
│   └── units/safebox-autohost.service
└── (provisioner source: vendor/autohost/ — public Autohost submodule)
```

The base component is required. The system component depends on base. dnsclient and autohost are independent of each other and of system at the process level — they just need `safebox-infra` to exist (which the system installer creates). The autohost provisioner code itself lives in the `vendor/autohost/` submodule; the `autohost/` component supplies only Safebox config, the systemd unit, nginx wiring, and the installer.

### System Protocol — interface to the Safebox plugin

The system component is the boundary between Infrastructure (the AMI layer) and the Safebox plugin (the application layer). It exposes privileged operations — package installs, version control, schema migrations, ZFS snapshots, test environments, model downloads, container lifecycle — that only the AMI is positioned to perform.

**Transport: per-container Unix domain sockets.** No TCP port. The system component listens on:

- One **control socket** at `/run/safebox/control.sock` (host-only, not bind-mounted into any container). Handles host-scope operations: `dnf`, `/models/*`, `/containers/*` lifecycle.
- One **per-container socket** per managed container at `/run/safebox/containers/<name>.sock`. Each socket is designed to be bind-mounted into exactly one Docker container. Handles per-container operations: `npm`, `pip`, `cargo`, `gem`, `composer`, `git`, `/test`.

The socket a connection arrives on determines the calling container's identity. The system component verifies the HMAC against the key for THAT socket. Three layered defenses on every cross-container call:

1. **Kernel layer** — bind-mount topology. Container foo can only reach foo's socket; the path doesn't exist in any other container's filesystem namespace.
2. **Crypto layer** — per-container HMAC. Each container's key is HKDF-derived from the master with a per-container info string. Cryptographically independent keys.
3. **Application layer** — identity reconciliation. If the request body claims to act on a different container than the calling socket, the system component rejects with `WRONG_SOCKET`.

```
Safebox Node (inside container foo)             System component (host)
────────────                                    ──────────────────────
sign HMAC-SHA-256 over canonical                (verify HMAC against
   <timestamp>\n<nonce>\n<method>\n               foo's per-container key)
   <path>\n<body-sha256>                        (identity = foo, from socket)
POST /run/safebox/system.sock                   validate schema,
   (bind-mounted from host's                    check foo's allowedActions,
   /run/safebox/containers/foo.sock)            execFile(sudo docker exec
                                                  --user safebox-app
                                                  --workdir <containerWorkdir>
                                                  safebox-app-foo <tool> ...)
                                                       │
read JSON response                              ← emit audit entry to journal
{status, data} or {status, code, message}         return response
```

**Four endpoint families:**

- `POST /system` — synchronous tool invocation. Per-container sockets dispatch `npm/pip/cargo/gem/composer/git` into the container via `docker exec`. The control socket dispatches `dnf` directly on the host.
- `POST /test`, `POST /test/<id>/keepalive`, `GET /test/<id>/yields`, `POST /test/<id>/stop`, `GET /test/<id>` — test environment lifecycle. Per-container sockets only.
- `POST /embed`, `POST /embed/unload`, `GET /embed/models`, `GET /embed/health` — embeddings via `@huggingface/transformers` in a forked subprocess. Per-container sockets only. Gated by `'embed'` in `allowedActions`. Models come from `/models/install`; the worker has `allowRemoteModels = false`. See [`aws/docs/EMBEDDINGS-PROTOCOL.md`](aws/docs/EMBEDDINGS-PROTOCOL.md).
- `POST /containers/create`, `POST /containers/destroy`, `GET /containers`, `POST /models/install`, `GET /models`, `POST /models/verify`, `POST /models/remove` — control socket only.

**Two allowlists, two governance speeds:**

| Layer | What it controls | Editable by |
|---|---|---|
| `managed-containers.json` | Per-container ACL: which `tool` actions each declared `managedContainer` may invoke. The system component returns `FORBIDDEN_ACTION` for anything not in `allowedActions`. | The system component itself, via `/containers/create` and `/containers/destroy`. SIGHUP reload — no restart. |
| `/etc/sudoers.d/safebox-system` | The entire root-elevation surface. Declares exact argv shapes that `sudo` will accept. | Code review only — changes through a PR. |

**Authentication:** HMAC-SHA-256. The master key is derived from a verified AWS Nitro attestation document via HKDF-SHA-256 over PCRs 0, 1, 4 — same AMI on same host → same master, different host → different master. Per-container keys are HKDF-derived from the master with `info = "safebox-container-<name>-<keyEpoch>-v2"`, where `keyEpoch` is a per-create random string forgotten on container destroy — so each container's key is cryptographically independent, and re-creating a container with the same name yields a fresh key an old leaked key can't impersonate.

**Privileged surface:** the system component runs as unprivileged `safebox-infra`. Operations that need elevation (`dnf`, `zfs`, `docker`) go through `sudo` against the tight allowlist. That sudoers file is the entire privileged surface — an auditor reads it and the system component's Node source and knows exactly what is possible. Read it: [`aws/scripts/components/system/sudoers/safebox-system`](aws/scripts/components/system/sudoers/safebox-system).

**Audit:** structured JSON via `journalctl -t safebox-system`. Each request emits one entry with the calling socket identity, method, path, status, duration, and request metadata.

Full protocol reference for Safebox integrators: [`aws/docs/Safebox.md`](aws/docs/Safebox.md) and [`aws/docs/SYSTEM-PROTOCOL.md`](aws/docs/SYSTEM-PROTOCOL.md).

### How the pieces connect

The word "component" hides three different questions that don't line up one-to-one, so the table below splits them out. **Scope** is who a component serves (one container, or the whole host). **Where it runs** is native process vs Docker container. **How Safebox reaches it** is the part that actually explains the architecture — and the answer is never "a TCP port on localhost." Everything privileged goes through one of two brokers over Unix sockets, and everything else Safebox talks to directly as a native service.

Two brokers, because they own different risks:

- **System component** (native, unprivileged `safebox-infra`) — the package/source/storage broker. Handles `npm`/`pip`/`cargo`/`gem`/`composer`/`git` (per-container), and `dnf`/`zfs`/`migrate` (host). Gets elevation only through a tight `sudo` allowlist. One socket per container plus one control socket; the socket a call arrives on *is* the caller's identity (enforced by the kernel via bind-mount topology, not trusted from the request body).
- **system-protocol-api** (native, talks to `docker.sock`) — the container-lifecycle + model broker. Handles container start/stop/pull and model load/unload/cache-flush. Authenticated by peer UID (`SO_PEERCRED`) + HMAC + JTI replay protection.

| Component | Scope | Where it runs | How Safebox reaches it | Why that way |
|---|---|---|---|---|
| **MariaDB** | Systemwide (one server, per-tenant datasets) | Native process | **Directly** — app connects to the MySQL socket | It's a data service, not a privileged action. One buffer pool shared across tenants; isolation is per-dataset (`DATA DIRECTORY` + ZFS), not per-process. |
| **PHP-FPM** | Per-tenant (pool per tenant) | Native process | **Directly** — nginx → per-tenant FPM socket | Native is faster than containerized; systemd + `open_basedir` + ZFS quota give the isolation. |
| **Node.js** (tenant apps) | Per-tenant | Native process (systemd unit) | **Directly** — reverse-proxied | Per-tenant `User=`, `MemoryMax`, ZFS dataset. Same reasoning as PHP. |
| **nginx** | Systemwide | Native process | **Directly** (front door) + config **written by** system-protocol-api (`nginx-config` action) | Performance-critical; runs native. Config changes are the privileged part, so those route through the broker. |
| **npm / pip / cargo / gem / composer** | **Per-container** | Runs *inside* the app container | **System component**, per-container socket → `sudo docker exec --user U --workdir W` | Package installs must land in the container's own filesystem and user. The socket identity pins which container; the tool can't run with `execContext=host`. |
| **git** | **Per-container** | Inside the app container | **System component**, per-container socket → `docker exec` | Same as package managers — clones/pulls into the container's workspace. |
| **dnf** | **Systemwide** (`_host`) | Host | **System component**, control socket → `sudo dnf` | OS packages affect every tenant; needs the host-scope governance gate, same class as a system update. Control socket only. |
| **zfs** (snapshot / rollback / clone) | **Systemwide** (`_host`) | Host | **System component**, control socket → `sudo zfs` (argv allowlist) | Storage operations touch the pool the whole box shares. Destructive ops (`rollback -r`) are why the sudoers form is pinned exactly. |
| **Docker** (container start/stop/pull) | **Systemwide** | Host daemon | **system-protocol-api** → `docker.sock` | Lifecycle is the privileged part. This broker holds the docker socket so nothing else has to. |
| **Model runners** (vLLM, Whisper, ComfyUI, …) | Per-service (one model per container) | Docker container (GPU) | **Directly for inference** — Safebox → `/run/safebox/services/{id}.sock` (HMAC). **Via system-protocol-api for load/unload** | Inference is hot-path, so it's a direct HMAC'd socket call. Load/unload/evict is lifecycle, so it goes through the broker. Two sister video runners (LTX, Wan) share the `/v1/video/generate` shape on different socket ids. |
| **Model install** (fetch + verify weights) | **Systemwide** (`_host`) | Host | **System component**, control socket → `/models/*` | Weights are shared by every tenant; install is M-of-N-governed and hash-verified before the files go live. Control socket only. |
| **Test runs** (ZFS-clone sandbox) | **Per-container** | Docker container over a ZFS clone | **System component**, per-container socket → `/test/*` | A test runs in a throwaway clone of *that* container's data — so it's per-container by construction, never reachable from the control socket. |

The through-line: **hot paths connect directly** (MariaDB queries, PHP requests, model inference), **privileged actions go through a broker over a Unix socket** (package installs, storage ops, container lifecycle, model install), and **the socket carries the identity** so the broker never has to trust a "who am I" field in the request body. That last property is what lets the whole thing be audited by reading two Node sources and one sudoers file.

### Storage architecture

ZFS is the storage layer for everything mutable: app data, container clones, MariaDB datadirs, test environments. Each tenant gets a dataset; tests get clones; backup and cross-Safebox replication are `zfs send | ssh | zfs receive` — block-level, already-compressed, already-encrypted deltas against a snapshot, used instead of SQL replication. Encryption is AES-256-GCM with the key sealed to TPM PCRs and only available after attested boot.

Compression is transparent at the ZFS layer (lz4 by default, `MARIADB_COMPRESSION=zstd` for heavy row-repetition) — so it sits *below* MariaDB and *above* encryption, which is the only order where both work, since encrypted bytes don't compress. MariaDB-level encryption is deliberately off for exactly this reason. The MariaDB dataset is tuned for InnoDB: `recordsize=16k` (one InnoDB page = one ZFS record, no read-modify-write amplification), `primarycache=metadata` (InnoDB's buffer pool owns data caching; no double-buffering against the ARC), and `innodb_doublewrite=0` (redundant on ZFS's copy-on-write). For clean cross-Safebox snapshots, `/opt/safebox/bin/flush-and-snapshot.sh` wraps `FLUSH TABLES WITH READ LOCK` around an atomic snapshot.

See [`aws/docs/SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md`](aws/docs/SAFEBOX-ZFS-DOCKER-MARIADB-ARCHITECTURE.md) for the full InnoDB/ZFS model, [`aws/docs/ZFS-COMPLETE-GUIDE.md`](aws/docs/ZFS-COMPLETE-GUIDE.md) for the storage layout, and [`aws/docs/FLUSH-TABLES-UPDATE.md`](aws/docs/FLUSH-TABLES-UPDATE.md) for the snapshot/replication path.

---

## AI models and runners — how Safebox talks to models

This is the part that makes the box useful: it runs open-weight AI models — LLMs, diffusion image/video, speech, embeddings — locally, on the attested host, so prompts and data never leave the box. Two pieces make that work: the **model supply chain** (how weights get onto the box safely) and the **runners** (the processes that execute models and the wire protocol Safebox uses to call them).

### The supply chain: how weights get onto the box

Model weights are not baked into the attested base — they are installed alongside it and governed by hash. The System component exposes `/models/*` endpoints (install / list / verify / remove). Every model is described by a canonical manifest JSON, and the SHA-256 of that manifest is the model's identity — it is what an M-of-N auditor quorum signs. On install, the System component downloads the weights from HTTPS sources (Hugging Face, S3, mirrors listed in the manifest), verifies them against the manifest **before any other process can touch them**, and installs them atomically into `/srv/safebox/models/<manifestHash>/`. That directory is mounted **read-only** into the runner that consumes it. Because the path is the manifest hash and the manifest hash is what was signed, a forked or tampered runner cannot substitute different weights — the identity of the weights is fixed by the signature, not by trusting the runner. This is the same `_host`-scoped governance as the rest of the privileged surface: a compromised app tenant cannot swap model weights without an auditor quorum.

### The runners: one container per model, Unix-socket transport

A **runner** is a container that wraps a model backend (vLLM, ComfyUI, Whisper, etc.) and exposes it over the Safebox wire protocol. The deployment unit is deliberately simple: **one container, one manifest, one model.** A model like an LLM is loaded into GPU memory at container start and cannot be swapped in-process, so running several models means several containers — each with its own manifest, each listening on its own socket. Safebox routes a request to the right container by model name.

**The transport is Unix domain sockets, not network ports.** Each runner listens on a Unix socket under `/run/safebox/services/` (e.g. `/run/safebox/services/llm-qwen.sock`). This is a deliberate security choice: a Unix socket has no port, is not reachable over the network, and is bound by filesystem permissions and the container's mount namespace — so a runner is not exposed to anything the host doesn't explicitly connect to its socket. Where a backend only speaks HTTP internally (vLLM, for instance, runs an OpenAI-compatible server on `127.0.0.1:8000` inside its own container), the runner wrapper translates: it listens on the Unix socket, speaks the Safebox wire format outward, and proxies to the backend's loopback HTTP inward. That loopback port is never exposed outside the container; the socket is the only door.

Clients (the Safebox plugin, or the operator CLI) reach a runner exactly the way you would expect for a socket:

```bash
curl --unix-socket /run/safebox/services/llm-qwen.sock \
  -X POST http://localhost/v1/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Every runner speaks the **same wire format** regardless of what modality it serves: camelCase JSON over the Unix socket, HMAC authentication (timestamp + nonce + a 5-minute replay window), and audit-trail SHA-256 hashes so every invocation is accountable. A runner advertises what it can do via `/v1/capabilities` and enforces those flags — asking an embed-disabled model to embed returns 400 even if the underlying backend could. On the attested image, HMAC is required (`SAFEBOX_REQUIRE_HMAC` is on), so a runner cannot be driven by anything that lacks the shared key. Full protocol: [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md).

### The runner roster (all speak the same protocol)

Ten production runners ship as Safebox-canonical, each in [`model-runners/`](model-runners/), each translating its backend into the common camelCase-JSON / Unix-socket / HMAC / audit-hash wire format:

- **[`vllm`](model-runners/vllm/)** — LLM chat / complete / embed via vLLM (five LLM-family manifests); streaming via SSE.
- **[`privacy-filter`](model-runners/privacy-filter/)** — PII detection and redaction.
- **[`mineru`](model-runners/mineru/)** — document extraction (PDF/DOCX/PPTX → LLM-ready Markdown).
- **[`whisper`](model-runners/whisper/)** — speech-to-text via Faster-Whisper (five variants).
- **[`comfyui`](model-runners/comfyui/)** — text-to-image via ComfyUI (SDXL, FLUX).
- **[`kokoro-tts`](model-runners/kokoro-tts/)** — text-to-speech (English + multilingual).
- **[`stable-audio-3`](model-runners/stable-audio-3/)** — text-to-audio (music, SFX, ambient).
- **[`ltx-video`](model-runners/ltx-video/)** — text/image-to-video with synchronized audio.
- **[`wan-video`](model-runners/wan-video/)** — higher-quality video (Wan 2.2 MoE; 5B and A14B).
- **[`triposr`](model-runners/triposr/)** — image-to-3D-mesh.

Because the transport and auth are identical across all ten, Safebox integrates a new modality without new plumbing: install the weights through the supply chain, start the runner container against its socket, and call it with the same signed-JSON convention. The operator CLI ([`cli/safebox-models/`](cli/safebox-models/)) wraps the install side; the Safebox plugin routes inference by model name to the right socket.

### Installing a runner onto the attested box

A runner reaches the box the same governed way everything else does — it is a container image, digest-pinned and verified against the blessed base's allow-list before it starts (and, under [layered blessing](attestation/app-layers/README.md), an org's runner layer is additive-only over a platform-blessed standard container, signed by the org's own auditors). The runner's own dependencies (its Python/requirements, its wrapper) are frozen into that image digest; its weights are mounted read-only from the manifest-hash directory the supply chain populated. So bringing a model online is two governed steps — bless-and-install the weights (manifest hash, M-of-N), and run the digest-pinned runner container (allow-list + layered blessing) — and both are enforced fail-closed by the attested base. Nothing about a runner escapes the same content-addressed, quorum-blessed discipline as the rest of the system.

---

## Onboarding paths

The same AMI + components support three deployment paths. Customers pick the one that matches how much of the stack they want us to manage.

### Path A — Cloud-managed (CloudFormation one-click)

The polished path on AWS. Customer clicks a button on the Safebots dashboard, AWS prompts for region + a stack name, CloudFormation provisions an EC2 instance running our published AMI in their AWS account. The dnsclient component (see [`aws/scripts/components/dnsclient/`](aws/scripts/components/dnsclient/)) phones home on first boot with an attested announce, the central DNS API issues a record at `<safeboxId>.safebots.org` pointing at the new instance, and the customer is at their dashboard within ~3 minutes of clicking.

- **Trust anchor**: full Nitro attestation. The dnsclient binds (safeboxId, reportedIp, challenge, timestamp) into the NSM-signed COSE_Sign1 document. Central DNS API verifies the signature chain against the pinned AWS Nitro root cert before updating DNS.
- **Custom domains**: handled by the autohost component ([`aws/scripts/components/autohost/`](aws/scripts/components/autohost/)). Customer points a CNAME at their box's hostname; on first hit, autohost runs DNS sanity check → ACME HTTP-01 against Let's Encrypt → nginx vhost install → reload. Browser-trusted cert, end-to-end TLS, no third-party in the cleartext path.
- **Credit eligibility**: standard Marketplace listing; works with AWS Activate credits.

### Path B — Paste-IP (bring your own VM)

For customers who already have a Linux VM on any cloud (or bare metal). They run our bootstrap script with a registration token:

```bash
curl -L https://safebots.org/bootstrap > /tmp/b.sh
less /tmp/b.sh                       # read first
sudo bash /tmp/b.sh reg_xxxxxxxxxxxxxxxx
```

The script ([`aws/scripts/bootstrap-safebox.sh`](aws/scripts/bootstrap-safebox.sh)) detects the distro, installs Node.js / nginx / openssl / jq, downloads the Infrastructure tarball, runs `install-system.sh` + `install-dnsclient.sh` + `install-autohost.sh` in order, registers the box with the control plane (POSTing the registration token + detected public IP), receives a `safeboxId` + `accountToken`, writes them to `/etc/safebox/dnsclient.json`, and starts the systemd units. Total time on a fresh Ubuntu/Debian/RHEL VM: ~2 minutes.

- **Trust anchor**: weaker than Path A. Without Nitro, the dnsclient runs in unattested mode (`allowUnattested: true` in dnsclient.json). The DNS API trusts the registration token and the announce-then-challenge handshake but cannot prove the OS image hasn't been modified. Suitable for customers whose threat model accepts this — most do.
- **Custom domains**: same autohost flow as Path A.
- **No credit story**: the customer is paying for their own VM out of pocket. Activate credits don't apply because the workload doesn't run on an AWS Marketplace AMI.

### Path C — BYO DNS + autohost only

For customers who already have a Safebox running (via Path A or B) and just want to attach more custom domains. No installer needed — the autohost component is already running. The customer points a CNAME or A record at the box's IP, and on the first request to that hostname, autohost provisions a cert and vhost automatically. No dashboard click required.

This is also the path for customers who want to embed Safebox via iframe under their own domain: they point `id.customer.com` and `chat.customer.com` at our box; we issue and serve real Let's Encrypt certs for both; the iframe loads with proper origin isolation and ITP-resistant session handling.

### Cross-cloud onboarding comparison

| Cloud | Path A polish | Path B (paste-IP) | Notes |
|---|---|---|---|
| **AWS** | Yes — CloudFormation one-click via Marketplace AMI | Yes | Path A only on AWS. Full attestation via Nitro NSM. |
| **Azure** | Comparable (ARM "Deploy to Azure" button) | Yes | ARM template is straightforward to author; full attestation via SEV-SNP/MAA is 1.1+ work. |
| **GCP** | Less polished — paste API key model | Yes | GCP Marketplace has analogous one-click but UX is rougher. Confidential VM (SEV-SNP) attestation is 1.1+ work. |
| **Oracle Cloud (OCI)** | Less polished | Yes | OCI Marketplace exists; Shielded Instances attestation is 1.1+ work. |
| **IBM Cloud / DigitalOcean / Hetzner / bare metal** | n/a | Yes | Path B works on any Linux VM with public IP. |

For 1.0 we ship Path A polished on AWS only. Paths B and C work everywhere from day one because they don't depend on cloud-specific Marketplace integration.

### Safecloud failover (future)

A planned future component is the Safecloud redundancy network: a peer-to-peer overlay where each running Safebox commits a fraction of its storage and compute to replicate other boxes in the network. When a box fails (instance terminated, hardware lost, network partition longer than threshold), the DNS API rolls its hostname to a peer that holds an up-to-date snapshot, and customer traffic continues against the failover peer without manual intervention.

This is service-for-payment: peers that provide actual storage/compute replication work get paid out of a redundancy pool funded by a fraction of network revenue. The mechanism and economics are part of the Safecloud protocol design (tracked with the Safecloud/Intercloud work, not in this repo); no implementation ships in 1.0.

The dnsclient + autohost components in 1.0 are the foundation: dnsclient is what lets a peer take over a hostname after failover, and autohost is what lets the new peer serve customer-facing TLS for that hostname without manual cert provisioning. Safecloud itself (snapshot replication, peer discovery, failover detection, redundancy accounting) is post-1.0.

---

## Multi-cloud

The same architecture works on GCP, Azure, and Oracle Cloud — all four have TPM-based attestation suitable for binding the system component HMAC to (image, kernel, host) measurements. What differs is the attestation client, not the rest of the system component.

| Cloud | Attestation mechanism | What replaces `nsmClient.js` |
|---|---|---|
| **AWS** (shipped in 1.0) | Nitro Secure Module + AWS Nitro PKI | Existing `nsmClient.js` — execs `/usr/bin/nsm-cli`, verifies COSE_Sign1 against pinned AWS root cert |
| **GCP** | Shielded VM vTPM + AMD SEV-SNP or Intel TDX | New `gce-attestation-client.js` — uses `tpm2_quote` from `tpm2-tools` plus the Google Confidential Computing attestation API or direct AMD VCEK verification |
| **Azure** | vTPM + AMD SEV-SNP, with Microsoft Azure Attestation (MAA) service | New `azure-attestation-client.js` — reads SNP report from vTPM NVRAM at index `0x01400001`, verifies via MAA or direct AMD VCEK chain |
| **Oracle Cloud (OCI)** | Shielded Instances + Measured Boot + AMD SEV (E3/E4 shapes) | New `oci-attestation-client.js` — uses `tpm2_quote` for PCRs, verifies against OCI-published platform certs |

In every case the system component protocol stays identical (HMAC over canonical envelope, `managed-containers.json` allowlist, `/system` and `/test` endpoints). The PCR set we bind to may differ by cloud — AWS uses PCRs 0/1/4 because Nitro defines them that way; GCP/Azure/Oracle would use the TCG-standard PCR0 (firmware) + PCR7 (secure boot policy) + an instance-binding PCR. The `attestationDerive` HKDF function is unchanged.

**Effort estimate to add a new cloud:**

- **Per-cloud attestation client**: ~300-500 lines of Node. One file, parallel to `nsmClient.js`. Verifies that cloud's signed attestation evidence and extracts PCRs. Same shape: returns `{ pcrs: Map<int, Buffer> }`.
- **Per-cloud base installer**: ~400 lines, structurally similar to `aws/scripts/components/base/install-base.sh` but with cloud-specific package names, instance-metadata calls, and TPM device paths.
- **Per-cloud provisioning script**: ~200-400 lines, equivalent to `scripts/provision-safebox-ami.sh`.

Roughly 3-5 days of focused engineering per cloud, plus 1-2 days of testing on actual hardware in that cloud. The crypto layer (`attestationDerive`, the system component itself) doesn't change.

Prioritization is open. GCP probably first because Confidential VM is mature; Azure second because of strong customer demand for the MAA story; OCI third because its attestation service is weaker and the threat model needs more careful work.

---

## Security

### Threat model

The Infrastructure layer defends against:

- **Disk-copy attacks.** AMI snapshot exfiltrated to a different host produces a different HMAC key (PCR4 binds to the parent EC2 instance ID), so the copied AMI cannot speak to a Safebox plugin signed against the original.
- **Tampered AMI.** Any modification to the OS image, kernel, or bootloader changes PCR0/PCR1, which changes the derived HMAC key, which breaks all signed requests. Tampering is detected on first request.
- **Unprivileged-RCE in the Safebox plugin.** A bug in the plugin can't escalate beyond what the system component's sudoers file allows. SQL injection in PHP can't forge a system component request because the HMAC key lives in the Node process's memory, not in PHP's.
- **Test environment escape.** Test containers run as `nobody`, network=none, read-only rootfs, no caps, in an isolated ZFS clone that's destroyed on teardown or after 60s of silence.
- **Cross-tenant `dnf upgrade`.** A compromised app-tenant cannot trigger a system-wide package update affecting other tenants. The `_host` scope check rejects `dnf` from any non-`_host` managedContainer.

The Infrastructure layer does NOT defend against:

- **Compromised Safebox Node process.** If the plugin's Node side is rooted, it has the HMAC key and the system component will execute what it asks. M-of-N governance lives inside Safebox, before the call. Per-request governance signatures (Ed25519) are the documented upgrade path for 1.1.
- **Compromised AWS hypervisor.** Out of scope. We trust Nitro.
- **Insider with the AWS account.** AWS-side controls (SCPs, separate accounts, KMS policies) are the answer here, not Infrastructure.

### What's defended

**Hardware & boot**
- TPM 2.0 measured boot; PCRs 0, 1, 4 bind the system component HMAC to the (image, kernel, host) tuple
- AWS Nitro attestation document signed by AWS root CA (fingerprint pinned: `641a0321...0bb5b`)
- AWS root cert verified at every cold start AND at install time

**Zero interactive shell access on the production AMI**
- SSH removed from AMI-B (see "The Two-AMI Model" in [`aws/docs/AUDIT.md`](aws/docs/AUDIT.md))
- SSM agent removed
- All TTY logins disabled
- telnetd / RSH / VNC / FTP / TFTP / Cockpit removed (CVE-2026-32746 mitigated)

**Runtime isolation**
- Docker userns-remap enabled
- PHP `expose_php=Off`, dangerous functions disabled
- Hardened sysctls (kptr_restrict, dmesg_restrict, ptrace_scope, BPF restrictions, ICMP redirect drops)
- ZFS encryption (AES-256-GCM) with keys sealed to TPM PCRs

**Supply chain**
- All system packages version-pinned in `aws/manifests/safebox-packages.json`
- npm packages installed from a lockfile
- The privileged core of the system component has zero npm dependencies (Node 22 stdlib covers x509, ECDSA verify, CBOR is hand-rolled). The one dependency, `@huggingface/transformers`, is loaded only inside the forked embeddings subprocess (`embeddingsWorker.js`) — never in the process that holds the HMAC key and shells out via sudo — and is installed from a committed, integrity-hashed lockfile
- AWS root cert pinned by SHA-256 at compile time and verified at install time

**Updates & lifecycle**
- Everything up to the sealed AMI is built *before* SSH is removed; the running production box never fetches code interactively. The AMI itself is signed, so "the exact code that booted" is attested.
- After boot, updates flow through the same brokered tools the rest of the system uses — `npm` / `pip` / `composer` for language packages (installed from a locked, integrity-hashed manifest) and `git-clone` / `git-pull` / `git-checkout` for source components. **Every one re-checks Safebox M-of-N governance before it runs** — an update is the same class of privileged action as the original install, not a lower bar.
- Git-source components are pinned by **commit SHA**, which is a content-address of the tree. A checkout that lands on any commit other than the pinned one is a **hard failure** (`verifyCommit` in `docker/stmValidators.js`), so a moved ref or tampered mirror can't substitute a different tree under a fixed pin. This is what makes transitive approval enforceable: signing a parent commit pins its dependency commits by SHA, and those pins are verified, not trusted.

**System component**
- HMAC-SHA-256 with 5-minute clock skew window, 10-minute nonce LRU
- Per-request `managedContainer` + `tool` authorization via `managed-containers.json`
- All execFile invocations use array argv with `--` separators; no shell interpretation anywhere
- Workspace prefix enforcement via `realpathSync` (leading-dash package names rejected, `/etc` workspace escapes rejected)
- Per-tool timeouts with SIGKILL on overrun
- `_host` scope check enforces system-wide actions can only come from the host channel

### What's pending before we'd claim "audited"

- External code audit of the system component and `install-base.sh` by a third-party review house
- Real-NSM smoke run on an actual AWS Nitro host (the synthetic test suite exercises every code path, but production behavior of `nsm-cli` hasn't been verified against real hardware yet)
- Reproducible build verification (two independent builds from the same git commit producing byte-identical AMIs)

### Container runtime: Docker now, rootless later

Safebox is a **cosmopolitan** by design — a library that sits above every container on the box and brokers privileged operations without any tenant owning root. Version 1.0 rides on Docker: it's what the orchestrator (`docker/system-protocol-api.js`) drives through `dockerode`, it's what the GPU model runners get first-class support from via the NVIDIA Container Toolkit, and it's the runtime our test surface has actually been validated against.

The direction we want, though, is a **rootless cosmopolitan** — the same broker-above-all-containers model, but running on a container runtime that is itself unprivileged. [Podman](https://podman.io) is the natural target: daemonless and rootless, so a tenant escaping its container lands in an unprivileged user namespace rather than as root on the host. That reduction is squarely on-thesis for Safebox, where the whole premise is that trust should be structural rather than a matter of policy.

Two things keep us on Docker for 1.0 rather than switching now:

- **`dockerode` against Podman's Docker-compatible socket "mostly" works** — and "mostly" is not a word we'll accept in the one component that holds the container socket and execs into every tenant. A switch means re-running the full `system-protocol-api` test surface against Podman, especially the exec-stream and inspect-shape paths, before we'd trust it.
- **Rootless GPU passthrough is still fussy.** Ten GPU runners want `--gpus all`; rootless device access and cgroup delegation under the NVIDIA toolkit are sharp enough edges that we'd likely run GPU containers rootful anyway, which would waste the headline benefit for exactly those workloads.

So the plan is: **Docker for 1.0, Podman as a post-launch spike** once we can budget the revalidation. Between now and then the runtime stays behind a small adapter surface (`executeDockerOp` and the exec helpers) rather than leaking Docker-specific assumptions across the ops modules, and the input-hardening on the orchestrator's command builders is runtime-agnostic by nature — the same `sh -c` argv executes identically under either engine. One caveat we keep honest about: even rootless, the cosmopolitan is still the most privileged actor in the system, so runtime choice narrows the *tenant-escape* blast radius, not the *control-plane-compromise* one. The latter is what the M-of-N, nonce, and injection hardening in this repo is for.

### Reporting vulnerabilities

Email security@safebots.ai. PGP key on the website.

---

## Documentation

**For auditors:**
- [`aws/docs/AUDIT.md`](aws/docs/AUDIT.md) — the actual audit checklist, 6 phases
- [`aws/docs/ARCHITECTURE.md`](aws/docs/ARCHITECTURE.md) — full system architecture
- [`aws/docs/SECURITY-HARDENING.md`](aws/docs/SECURITY-HARDENING.md) — hardening details
- [`aws/docs/CASCADING-MANIFESTS.md`](aws/docs/CASCADING-MANIFESTS.md) — the SHA256 attestation chain

**For integrators (Safebox plugin team):**
- [`aws/docs/SYSTEM-PROTOCOL.md`](aws/docs/SYSTEM-PROTOCOL.md) — wire spec for the HTTP API
- [`aws/docs/QUICKSTART.md`](aws/docs/QUICKSTART.md) — fastest path to a running AMI

**For operators:**
- [`docs/AWS-NITRO-SETUP.md`](docs/AWS-NITRO-SETUP.md) — provisioning guide
- [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) — how Safebox governance maps to system calls
- [`aws/docs/BACKUP-STRATEGY.md`](aws/docs/BACKUP-STRATEGY.md) — backup architecture
- [`aws/docs/ZFS-COMPLETE-GUIDE.md`](aws/docs/ZFS-COMPLETE-GUIDE.md) — ZFS storage model
- [`aws/docs/MARIADB-SCALING-ANALYSIS.md`](aws/docs/MARIADB-SCALING-ANALYSIS.md) — database scaling
- [`aws/docs/XTRABACKUP-PRIMARY.md`](aws/docs/XTRABACKUP-PRIMARY.md) — database backup *(design history; see the status banner at its top — the implemented path is ZFS snapshot + `zfs send`, not XtraBackup/borg)*

**For AI/model integration (post-1.0):**
- [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md) — ~70 open-source models across tiny/small/medium/large/XL tiers with sizes and licenses
- [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md) — wire spec for the inference protocol
- [`docs/MODEL-INTEGRATION-GUIDE.md`](docs/MODEL-INTEGRATION-GUIDE.md) — how Safebox calls into model runners
- [`model-runners/privacy-filter/`](model-runners/privacy-filter/) — working PII redaction runner (Python + Dockerfile)

**Specifically NOT canonical yet (designs for 1.1+):**
- Everything under [`docs/future/`](docs/future/) — speech, vision, vLLM specifics, composable-architecture, etc.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Roadmap

**1.1+:**
- LLM tier components (`llm-tiny`, `llm-small`, `llm-medium`, `llm-large`, `llm-xl`) — installers for the ~70-model catalog
- Speech and vision tiers (ASR, TTS, multimodal)
- GCP, Azure, and Oracle Cloud builds — per-cloud attestation clients (~3-5 days of work each)
- Per-request Ed25519 governance signatures (1.1 protocol upgrade)
- Runtime HMAC rotation without service downtime

## License

Apache 2.0. See [LICENSE](LICENSE).

## What was tested

Run the whole suite with **`tests/run-all.sh`** (see [`tests/README.md`](tests/README.md)).
It aggregates every suite that runs without a GPU, Docker daemon, real TPM, or
Nix evaluator and exits non-zero on any failure. Latest run: **35 suites, 0failures.** Full boundary and pre-AMI checklist in
[`E2E-TEST-RESULTS.md`](E2E-TEST-RESULTS.md).

### Verified (runs in CI, offline)

- **JS system suite** (`aws/.../system/test/run.js`) — **15 files / 296
  assertions**: auth/HMAC, attestation derive + roundtrip, sockets, container
  routing, canonical models, lockfile hash, per-container keys, workdir
  sanitizer. All pass.
- **JS component tests** — dnsclient challenge/config/challenge-server/E2E
  (×4) and autohost splash. Pass.
- **CLI + docker validators** — `safebox-models` model-file discovery/SHA-256,
  and docker STM pinned-commit verify semantics (70 assertions). Pass.
- **Container hardening (seccomp/AppArmor)** — profiles are deny-by-default,
  block escape-prone syscalls (ptrace/keyctl/bpf/mount/unshare/…), the GPU
  profile is a superset of the base, and every compose `seccomp=` reference
  resolves. Pass.
- **PHP/web tier systemd sandbox** — the measured-base `phpfpm-safebox`
  service carries a `SystemCallFilter` (seccomp BPF) + filesystem sandbox; the
  test asserts it's present and that neither known-breaking setting
  (`~@resources`, forced W^X) is reintroduced. Pass.
- **Two-AMI seal coverage + DETERMINISM** — the seal is asserted to neutralize
  every enumerated nondeterminism source and preserve the `/nix/store`
  exclusion; **and a determinism test seals two builds that differ in every
  nondeterminism class and proves the sealed trees are byte-identical, the
  closure is preserved, and the check catches an uncovered source.** This is
  the load-bearing attestation property, tested every run. Pass.
  (`attestation/ami2-seal/`)
- **Model-runner unit tests** — all **13** runners' `test_runner.py`
  (translation, capacity, headers, HMAC delegation). Pass.
- **HMAC cross-repo parity + interop** — a request signed the
  `auth.js`/`LocalRunner` way **in Node** is verified by the **Python** shared
  runner module (`test_safebox_interop.sh`); parity test covers strong-form
  accepted and endpoint-swap / replay / weak-form / expired rejected. Pass.
- **Attestation chain E2E** — real Ed25519 bless → combine (M-of-N) → verify:
  **KOSHER**, and **NOT KOSHER** for insufficient signers / tampered / revoked,
  and **fail-closed** on an unverified hardware quote. Pass.
- **Structural** — every `.py` parses, `.json` valid, `.sh` `bash -n`, `.nix`
  brace-balanced.

### Issues this testing found and fixed

- **HMAC canonical-form divergence** across all runners (per the Safebox change
  request): consolidated to one shared verifier; `onnx` brought up from
  body-only signing to the full replay-protected canonical form. All 13 runners'
  vendored `safebox_auth.py` are byte-identical.
  ([`model-runners/HMAC-CANONICAL-FORM-FIX.md`](model-runners/HMAC-CANONICAL-FORM-FIX.md))
- **Two TTS runners had manifests but no implementation** (`chatterbox-tts`,
  `orpheus-tts`): only README + manifests existed — no `runner.py`/`Dockerfile`.
  Implemented from the `kokoro-tts` scaffold (Chatterbox MIT; Orpheus/Higgs-v2
  Apache), each with a `test_runner.py`.
- **10 runner unit tests were stale** — written against the old inline HMAC
  verifier, they broke (silently passing negative cases) after the shared-module
  consolidation. Rewritten to test the strong canonical form through the shared
  module; now correctly reject bad-sig / stale / replay / endpoint-swap.
- **PHP tier had app-level hardening only** (`disable_functions`) but no
  systemd sandbox — the untrusted-input-facing service ran unconfined at the
  syscall/filesystem level. Added a calibrated systemd sandbox (seccomp BPF via
  `SystemCallFilter` + `ProtectSystem=strict` + namespace/kernel protections),
  tuned to not break php-fpm's master or OPcache.
- **Container tier had no seccomp/AppArmor** — the compose services ran on
  Docker defaults only. Added deny-by-default seccomp (base + GPU variant) and
  an AppArmor confinement profile, wired per-service in `docker-compose.yml`
  and shipped in the measured base so the confinement policy is attested
  (`docker/security/README.md`). chromium (needs SYS_ADMIN) and the docker.sock
  orchestrator are documented deliberate exceptions.
- **`SAFEBOX_REQUIRE_HMAC` was unset** (defaulting off): now set true in the
  attested `nixos/hosts/safebox.nix` profile with a build assertion.

### NOT tested here — needs real hardware / paired repo

Not failures; outside a CI container's reach. Do before an AMI cut:

- **`nix flake check` / image build** — no Nix evaluator; the flake's `nixpkgs`
  input is an intentional `PIN_ME_TO_A_COMMIT_SHA` placeholder with no
  `flake.lock`, and `cache.nixos.org` is unreachable from CI. Nix is validated
  only to brace/`let`-`in` balance.
- **Two-AMI reproducibility (`verify-ami2-reproduces.sh`)** — Nix is ~91%
  bit-reproducible, not 100%, and a PCR needs 100%. So the attested image
  (AMI-2) is produced by sealing an SSH-only builder (AMI-1) with an auditable
  scrub that constant-ises the varying fields. Proving zero-diff needs two real
  builds + diffoscope on a build host — run it before trusting the AMI-2
  measurement. (`attestation/ami2-seal/README.md`)
- **System smoke test** (`system/test/smoke.js`) — a live-service integration
  test (HTTP on :7799); needs the running component, so it's skipped in CI and
  run by hand against a live box.
- **Live model serving** — no GPU/Docker; no runner has loaded weights or served
  a token. Per-shard weight SHA-256s and IPFS CIDs remain build-time
  placeholders. The two new TTS runners are structurally complete but their
  model-family `generate()` calls need a smoke test on real hardware.
- **Real hardware attestation quote** — no TPM/SEV-SNP; the per-cloud validators
  that set `_hardware_verified` chain to real cloud cert chains.
- **Runner-launch env forwarding** — confirm the launch unit forwards
  `SAFEBOX_REQUIRE_HMAC` (or adds `-e`) to `docker run` on a real boot.
- **Live-runner HMAC** — re-run the HMAC harnesses against a running runner over
  its socket, not just the shared module.

**The ordered real-hardware sequence to close all of the above and cut an AMI is
in [`PRE-AMI-RUNBOOK.md`](PRE-AMI-RUNBOOK.md).** The no-custom-software security
posture is stated in [`GENERATE-DONT-INSTALL.md`](GENERATE-DONT-INSTALL.md).
