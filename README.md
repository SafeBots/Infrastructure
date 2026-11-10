# Safebots Infrastructure

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0--pre-yellow.svg)](CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](CHANGELOG.md)

**Attested cloud images for hosting the Safebox plugin.** Two-box architecture: an outer Safebox Console (frozen Nix image, governance and egress control) wraps an inner Safebox (apps, models, workflows) that has zero direct internet access. Immutable dm-verity root, keys sealed in the TPM, one auditable HTTP API between Safebox and the host (the System component). Supports AWS, GCP, Azure, and OCI.

> **Status**: Pre-release working tree for the 1.0.0 launch. Versioning is held at 1.0.0 until first publication; subsequent changes increment 1.0.x.

---

## What this repo is

This repo builds attested cloud images that run the Safebox plugin across AWS, GCP, Azure, and OCI. It is intentionally a thin Linux-level runtime layer: a read-only, measured root filesystem, an encrypted ZFS pool whose key is sealed in the TPM, hardened Docker, and a single HTTP API (the System component) for the Safebox plugin to call when it needs to do something privileged on the host. Every image is Ubuntu 24.04 LTS, built by one shared installer in a chroot on a throwaway build instance; the only per-cloud pieces are the kernel flavour, the bootstrap and capture steps, the attestation client, and the Terraform module. The specification everything is checked against is [`docs/HARDENING-PLAN.md`](docs/HARDENING-PLAN.md).

**What is in `common/`, which is the image:**

- **`base`** — `common/base/install-base.sh`, the one base installer. Pinned Ubuntu packages, Canonical's signed kernel for the cloud (`linux-aws`, `linux-gcp`, `linux-azure`, `linux-oracle`) with its signed ZFS module, hardened Docker, PHP-FPM, nginx, MariaDB and sysctls, every agent and shell path removed and pinned out, the dracut initramfs that carries the unseal step. The OS configuration an auditor reads once and trusts.
- **`system`** — a small Node.js host service listening on per-container Unix domain sockets (one per managed container, plus one control socket for host operations). Safebox Node connects to a bind-mounted socket inside its container; the system component knows which container is calling from kernel-enforced socket identity, verifies the HMAC against that container's derived key, validates the request against `managed-containers.json`, dispatches to `child_process.execFile`, returns results. Test environments use a ZFS clone + keepalive pattern (aggressive 60s teardown unless pinged). The HMAC master is derived from a 32-byte seed that the initramfs unseals from the TPM and leaves on tmpfs at `/run/safebox/hmac-seed`; per-container keys are HKDF-derived from the master so each container's key is cryptographically independent, and each is written to tmpfs at `/run/safebox/keys/<name>/system.hmac` and bind-mounted read-only into its container at `/run/safebox/keys/system.hmac`, never into the tenant workspace. The source still lives under `aws/scripts/components/system/` for history and is installed identically on all four clouds. See [`aws/docs/Safebox.md`](aws/docs/Safebox.md) for the transport and integration spec.
- **`dnsclient`** — `common/dnsclient/`. Separate systemd unit that announces the box to the Safenet transparency log and DNS relays. Runs as its own user `safebox-dns` (uid 992). On first boot it reads `safeboxId`, `ownerPubkey` and `launchAuthorization` from `/var/lib/safebox/dns/dnsclient.json` (written by the first-boot unit from the metadata service), generates an Ed25519 identity, verifies the owner's signature on the launch authorization, obtains a TPM quote over the policy PCRs, builds a signed `safebox_announce` OCP claim, and publishes it to the Safenet transparency log and to the DNS relays listed in the image. Then it discovers its public IP, announces with a fresh quote, re-announces on IP change and hourly, and serves a challenge endpoint on 8443 so DNS relays can confirm IP control. Separate process from `system` so dnsclient bugs cannot reach the HMAC master.
- **`autovhost`** — `common/autovhost/`. Separate systemd unit that handles custom-domain provisioning. Listens on a Unix socket; nginx forwards unknown-Host requests via a mirror directive. Cascade: negative cache → DNS sanity check → ACME HTTP-01 against Let's Encrypt → write per-host server block + cert → debounced nginx reload. Lets customers attach arbitrary domains by pointing DNS at the box.
- **`boot`** — the initramfs unseal and seal scripts and the dracut module. On first boot they generate the pool key and the HMAC seed, create the pool on the empty data disk, seal both keys to the local TPM under PCRs 0, 2, 4, 7, 8, 9, 14 and 15, and extend PCR 15 so nothing later in the boot can unseal them again.
- **`image`** — the verity root builder, GRUB template and password tool, `fstab`, the pre-capture cleanup, and `verify-image.sh`, which fails the build on any gap.
- **`firstboot`** — the unit that replaces cloud-init. Reads exactly `safebox-id`, `owner-pubkey` and `launch-authorization` from the metadata service, validates them, writes them to the pool, and never executes anything. The DNS relay and Safenet log URLs are baked into the image and cannot be set from metadata.
- **`net`** — the nftables rules that cut containers off from the metadata service and allow it on the host only for root and `safebox-infra`.
- **`sudo`** — the sudoers file and the root-owned wrapper scripts it names. No wildcards; every privileged operation is a fixed path with validated arguments.
- **`attestation`** — the shared `tpm2_quote` helper the per-cloud attestation clients use.

Roughly 5800 lines of Node across system, dnsclient and autovhost (System ~4200, dnsclient ~1000, autovhost ~600 plus the acme-client dependency), plus the base installer and the shell under `common/boot`, `common/image`, `common/firstboot` and `common/sudo`. The System component is the bulk; dnsclient and autovhost are small focused services that can each be audited in an afternoon.

## What this repo ALSO contains (designs and references, not yet installable)

These exist as engineering reference and pre-1.0 design work. They have spec docs and partial code, but no `install-<tier>.sh` script and no smoke tests against real hardware:

- **AI model supply chain (1.0 surface)** — the system component ships endpoints under `/models/*` ([wire spec](aws/docs/MODELS-PROTOCOL.md)) for installing, listing, verifying, and removing model weights. Every model is identified by the SHA-256 of its canonical manifest JSON; that hash is what Safebox M-of-N signs. Weights are downloaded from HTTPS sources (Hugging Face, S3, mirrors), verified against the manifest before any other process can touch them, and installed atomically into `/srv/safebox/models/<manifestHash>/`. Only the control socket may call them, so a compromised app-tenant cannot swap model weights without governance. The supply chain itself is 1.0; what's not yet 1.0 are the *runner containers* that consume the installed weights.
- **AI model runners** — [`model-runners/privacy-filter/`](model-runners/privacy-filter/) has a working 448-line FastAPI service (PII redaction); [`model-runners/stable-audio-3/`](model-runners/stable-audio-3/) has the skeleton for Stable Audio 3 (text-to-music + sound effects); [`model-runners/vllm/runner_extensions.py`](model-runners/vllm/runner_extensions.py) extends vLLM for the deterministic-inference path. The full ~80-model catalog with sizes and licenses is in [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md); the runner inference protocol spec is in [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md). What's missing: component installers (`common/llm-tiny/install-llm-tiny.sh`, etc.) that publish model manifests, start the runner systemd units, and wire model serving sockets into the system component. Post-1.0 work.
- **Speech and vision tiers** — design docs under [`docs/future/`](docs/future/) (VibeVoice ASR, Nemotron-Omni, speech protocol implementation). Same status: real spec work, no installers yet.
- **Composable architecture** — the original design called for 20 modular components ([`docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md`](docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md)). 1.0 ships four of them (base, system, dnsclient, autovhost), with the system component's `/models` endpoints serving as the foundation for the model-tier components to plug into.

The split is honest: 1.0 ships complete, auditable golden images for all four clouds with the system component (including the model supply chain) and the base component. AI model runners are real engineering work for 1.1+ that builds on the same foundation.

## What this repo is NOT

- **The Safebox plugin** (governance, capabilities, sandboxed code execution) lives in [its own repo](https://github.com/Safebots/Safebox). A bug there is a plugin code change, not an image rebuild.
- **The Safenet protocol** (trust network, distributed package registry, Safebux payments, transparency log) lives in [its own repo](https://github.com/Safebots/Safenet). Safenet is a standalone Node.js package that runs inside the Infrastructure AMI but is developed and versioned independently — it handles trust and authorization while Safecloud handles encrypted chunk storage. See the [Safenet README](https://github.com/Safebots/Safenet) for the full architecture.
- **The Crypto plugin** (Q.Sandbox, OpenClaim signing, Merkle/Bloom data structures) lives in [its own repo](https://github.com/Safebots/Crypto).

Keeping the boundary clear keeps both sides auditable.

---

## Inductive Security

The Safebox Infrastructure is designed around a formal security model we call **Inductive Security**: mathematical induction applied to systems security. Instead of reasoning about every possible attack path, we prove that the system's security invariants hold at every reachable state by establishing a base case and an inductive step.

### The formal model

**Base case P(0):** The outer Safebox Console is a frozen Nix derivation. Its image is fully deterministic and reproducible — anyone can build it from source and verify the hash matches the deployed image. The Nix store is read-only; the image contains exactly one Qbix app (the Console) and nothing else. The base case is verifiable by any auditor, any time, without trusting anyone.

**Inductive step P(n) → P(n+1):** Every state transition — image updates, configuration changes, key rotations, allowlist modifications — requires M-of-N governance where **at least one signer is the box's own attested software** (the Software Signer, described below). The Software Signer enforces structural invariants: it will not co-sign an image update that removes dm-verity, will not co-sign an allowlist change for a bare IP address, will not co-sign its own removal from the required signers list. Humans provide liveness (the system can evolve); code provides safety (the invariants cannot be violated).

**Conclusion:** Every reachable state satisfies the security invariants. There is no path from P(0) to a state that violates the invariants, because every transition is guarded by software that checks the invariants before co-signing.

### The Software Signer

The Software Signer is code baked into the frozen Nix image of the outer Safebox Console. It holds a signing key sealed to the TPM and participates as a **required co-signer** in the M-of-N governance quorum. The key properties:

- **It is attested.** The TPM quote proves the Software Signer's code is the exact code in the blessed image. A modified image produces different PCR values and cannot unseal the signing key.
- **It enforces structural invariants, not policy.** The Software Signer judges the *shape* of a proposed change, not its content. It checks: does the new image still have dm-verity? Does the new allowlist entry resolve to a domain, not a bare IP? Does the new signer set still include a software signer? It does not judge whether a particular domain *should* be on the allowlist — that is for the human signers.
- **It cannot be removed.** The Software Signer will not co-sign a governance change that removes itself from the required signers. The only way to replace it is through **succession**: deploying a new outer Safebox with a new frozen image that contains a new Software Signer, and having the old quorum (including the old Software Signer) bless the new one.
- **It provides safety without liveness.** If the Software Signer goes down, the system stops evolving but does not become insecure. The existing configuration continues to run. This is the right failure mode: safety over liveness.

### Two-box architecture (outer + inner Safebox)

The Inductive Security model is realized through a physical two-box architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    OUTER SAFEBOX (Console)                   │
│                                                             │
│  Frozen Nix image — fully open source — never updated       │
│  except through governed succession                         │
│                                                             │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Safebox Console │  │   Software   │  │    Egress     │  │
│  │  (one Qbix app)  │  │   Signer     │  │   Allowlist   │  │
│  │                  │  │              │  │   (nftables)  │  │
│  │  • M-of-N gov    │  │  • Required  │  │              │  │
│  │  • Key custody   │  │    co-signer │  │  • Domain     │  │
│  │  • Provisioning  │  │  • Structural│  │    based      │  │
│  │  • Audit log     │  │    invariants│  │  • No bare IP │  │
│  └─────────────────┘  └──────────────┘  └───────────────┘  │
│                           │                                 │
│              ┌────────────┴────────────┐                    │
│              │   Private network link   │                    │
│              └────────────┬────────────┘                    │
│                           │                                 │
│  ┌────────────────────────┴──────────────────────────────┐  │
│  │                   INNER SAFEBOX                        │  │
│  │                                                       │  │
│  │  Standard Safebox image — runs N web apps, Safebots   │  │
│  │  workflows, models, closed-source plugins             │  │
│  │                                                       │  │
│  │  ZERO direct internet egress                          │  │
│  │  All outbound traffic → outer Safebox only            │  │
│  │                                                       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │  │
│  │  │ Qbix Apps│ │ Safebots │ │  Models  │ │ Plugins │  │  │
│  │  │ (N apps) │ │Workflows │ │ (vLLM,..)│ │(closed) │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Outer Safebox (Safebox Console):**

- **Frozen Nix image.** Built with Nix for full reproducibility. The image is never updated in place — changes go through governed succession (a new image blessed by the existing M-of-N quorum including the Software Signer).
- **Fully open source.** The entire outer Safebox is auditable by anyone. This is the trust anchor: you don't need to trust the operator, you verify the image hash.
- **One app only.** Runs exactly one Qbix app — the Safebox Console — which provides the governance interface for M-of-N operations: key management, allowlist changes, inner Safebox provisioning, audit log.
- **Egress gateway.** All outbound traffic from the inner Safebox passes through the outer Safebox's egress allowlist. The allowlist is domain-based (no bare IPs), governed by M-of-N with the Software Signer as required co-signer. The outer Safebox judges the *shape* of outbound requests (destination domain, protocol) but not their *content* — it is a structural filter, not a content inspector.
- **Key custody.** The outer Safebox holds the organization's governance keys, sealed to its own TPM. The inner Safebox requests signing operations through the private link; the outer Safebox applies governance policy before co-signing.
- **Provisioning.** The Console can provision and manage inner Safeboxes through cloud APIs (when granted the necessary IAM/service-account permissions). This includes launching new inner Safeboxes, rotating their images, and managing cross-account Safebox deployments where inner Safeboxes in other cloud accounts use large GPU instances that the operator's account does not have.

**Inner Safebox:**

- **Standard Safebox image.** Runs the full application stack: N web apps (PHP on the Qbix Platform), Safebots workflows (with the Orchestrator's `IPAddressDeny=any`), model inference containers, and closed-source plugins.
- **Zero direct internet egress.** The inner Safebox's nftables OUTPUT chain drops all traffic except to the outer Safebox's private IP. This closes the egress gap that existed in the single-box architecture, where web app containers had unrestricted outbound access.
- **Verified closed source.** The two-box architecture enables the transition from open-source to proprietary code while maintaining verifiable trust. The inner Safebox can run closed-source plugins — the outer Safebox (open source, auditable) controls what leaves. Proprietary plugins are released only to inner Safeboxes whose outer Safebox is attested by an M-of-N auditor set. "You can fork the lock. You can't fork the fact that no one trusts your key."

### Why two boxes instead of one

The single-box architecture had an egress gap: the Safebots Orchestrator enforces `systemd IPAddressDeny=any` on workflow execution, but web app containers (PHP apps running on the Qbix Platform) had unrestricted outbound access at the OS level. The cloud security groups had wide-open egress (`0.0.0.0/0`), and the host nftables rules only restricted access to the metadata service, not general outbound traffic.

The two-box architecture closes this gap structurally rather than with per-process policies. The inner Safebox cannot reach the internet at all — it can only talk to the outer Safebox. The outer Safebox is a minimal, frozen, fully auditable gateway. There is no way for code running on the inner Safebox to exfiltrate data except through the outer Safebox's governed allowlist.

This also cleanly separates concerns: the inner Safebox is where complexity lives (N apps, models, plugins, workflows), and the outer Safebox is where trust lives (governance, keys, egress control). The trust anchor is small enough to audit in a weekend.

---

## Quick Start

Each cloud has its own build script and INSTRUCTIONS.md with full step-by-step guides. The pattern is the same: on an Ubuntu 24.04 build instance with an empty second disk attached, run the build script against that disk. It debootstraps noble, runs the installers in a chroot, writes the result to the disk as a dm-verity root, and captures the disk as the cloud's image type. The build instance is never captured, and nothing on it is ever a safebox: keys are generated and sealed on the first boot of each production instance.

```bash
git clone https://github.com/Safebots/Infrastructure.git
cd Infrastructure
export SAFEBOX_NODE_SHA256=<sha256 of the pinned Node tarball>

# AWS: blank second EBS volume, appears as /dev/nvme1n1 on Nitro
sudo -E aws/scripts/build-image.sh --target /dev/nvme1n1

# GCP: blank persistent disk attached with --device-name=safebox-target
sudo -E gcp/scripts/build-image.sh --target /dev/disk/by-id/google-safebox-target

# Azure: blank managed disk at LUN 1
sudo -E azure/scripts/build-image.sh --target /dev/disk/azure/scsi1/lun1 --target-disk-name safebox-image-target --resource-group safebox-images-rg

# OCI: blank block volume
sudo -E oci/scripts/build-image.sh --target /dev/sdb
```

Every script takes `--components base,system,dnsclient,autovhost` (default all four), `--no-capture`, and `--grub-password-hash`; the build aborts if `verify-image.sh` finds any gap, and if you ask for a component that does not exist.

Detailed per-cloud guides: [`aws/INSTRUCTIONS.md`](aws/INSTRUCTIONS.md) · [`gcp/INSTRUCTIONS.md`](gcp/INSTRUCTIONS.md) · [`azure/INSTRUCTIONS.md`](azure/INSTRUCTIONS.md) · [`oci/INSTRUCTIONS.md`](oci/INSTRUCTIONS.md)

Terraform modules for launching instances from golden images: [`terraform/README.md`](terraform/README.md)

---

## Architecture

### Layout

```
common/                          Everything that is the same on all four clouds
├── base/install-base.sh         The one base installer; kernel flavour is the only per-cloud input
├── boot/                        safebox-unseal.sh, safebox-seal.sh, dracut/90safebox (initramfs unseal + first-boot seal)
├── image/                       build-verity-root.sh, verify-image.sh, cleanup-image.sh, grub.cfg.tmpl, make-grub-password.sh, fstab
├── firstboot/                   safebox-firstboot.sh + .service (reads two metadata keys, runs nothing), defaults.json
├── net/                         safebox-imds.nft, safebox-imds.sh, safebox-nftables.service (metadata firewall)
│                                safebox-inner-egress.nft (inner Safebox: deny all except outer Console IP)
├── console/                     Nix flake for the outer Safebox Console image (flake.nix, configuration.nix)
├── sudo/                        safebox-system sudoers file and bin/ wrappers (installed to /opt/safebox/bin/)
├── attestation/tpmQuote.js      tpm2_quote helper shared by the attestation clients
├── dnsclient/                   dnsclient.js, config.js, install-dnsclient.sh, units/, test/
└── autovhost/                   autovhost.js, config.js, install-autovhost.sh, nginx-templates/, units/, test/

aws/ gcp/ azure/ oci/            Only what differs per cloud
├── INSTRUCTIONS.md              Runbook: build host, build, capture, launch authorization, launch, account policy
├── README.md                    Short overview of the directory
├── scripts/build-image.sh       Bootstrap (debootstrap noble) and capture steps; the middle is shared
├── scripts/components/base/     Shim that sets the kernel flavour and calls common/base/install-base.sh
├── scripts/components/system/   install-system.sh (aws/ also holds the system component source, see below)
├── scripts/components/dnsclient/<cloud>AttestationClient.js
├── terraform/                   Launch module (inner Safebox)
├── terraform-console/           Launch module (outer Safebox Console, paired with inner)
└── manifests/                   One <cloud>-<date>.json per build: image id, root hash, inventory digest

aws/scripts/components/system/   The system component source, installed identically on every cloud
├── server.js                    routing, audit, identity reconciliation
├── sockets.js                   per-container socket lifecycle
├── auth.js                      HMAC sign/verify, nonce LRU
├── secret.js                    reads /run/safebox/hmac-seed, derives master and per-container keys
├── nitroTpmClient.js            AWS attestation client (NitroTPM through /dev/tpmrm0)
├── config.js                    managed-containers.json loader
├── opsSystem.js                 /system handler (npm/pip/cargo/gem/composer/git/migrate/zfs; dnf answers NOT_SUPPORTED)
├── opsTest.js                   /test handler (ZFS clone + docker + keepalive + yields)
├── opsModels.js                 /models handler (manifest-hash-verified weights)
├── opsContainers.js             /containers handler (lifecycle)
├── opsEmbed.js, embeddingsWorker.js   /embed handler and its forked worker
├── ocpVerify.js                 OCP claim verification — hybrid ES256 + ML-DSA-65 (FIPS 204)
├── governanceKeys.js            Trusted governance key registry with M-of-N thresholds and key rotation
├── launcher.js                  Measured TEE launcher — verifies publication claims, Merkle roots, creates execution manifests
├── delegation.js                Delegation chain verification for cross-Safebox operations
├── instanceIdentity.js          Instance identity from TPM-derived keys
├── shamirSplit.js               Shamir secret sharing for key escrow
├── transparency.js, succession.js, imageDistribution.js
├── package.json, package-lock.json    pinned deps; audit reads the lockfile
├── units/safebox-system.service
└── test/, testIntegration.js    unit suites (NODE_ENV=test node test/run.js) and the socket-level integration test (NODE_ENV=test node testIntegration.js)

tests/redteam/<cloud>.sh         Launches a box from a candidate image and attempts every vector in the hardening plan
terraform/README.md              The four launch modules, side by side
```

The base component is required. The system component depends on base. dnsclient and autovhost are independent of each other and of system at the process level; dnsclient runs as `safebox-dns` (uid 992) and autovhost as `safebox-infra` (uid 990); `install-base.sh` creates both users.

**Safenet** is bundled into the golden image as a standalone Node.js service under `aws/scripts/components/safenet/`. It runs its own HTTP server (default port 8443) and provides the trust, registry, and payment layer that Safeboxes use to discover and install packages. See the [Safenet repo](https://github.com/Safebots/Safenet) for the full protocol spec and README.

### System Protocol — interface to the Safebox plugin

The system component is the boundary between Infrastructure (the AMI layer) and the Safebox plugin (the application layer). It exposes privileged operations — package installs, version control, schema migrations, ZFS snapshots, test environments, model downloads, container lifecycle — that only the AMI is positioned to perform.

**Transport: per-container Unix domain sockets.** No TCP port. The system component listens on:

- One **control socket** at `/run/safebox/control.sock` (host-only, not bind-mounted into any container). Handles host-scope operations: `/models/*`, `/containers/*` lifecycle, `zfs-snapshot`, `zfs-rollback`.
- One **per-container socket** per managed container at `/run/safebox/containers/<name>.sock`. Each socket is designed to be bind-mounted into exactly one Docker container. Handles per-container operations: `npm`, `pip`, `cargo`, `gem`, `composer`, `git`, `migrate` (the tenant's own `/workspace/migrate.sh`, run inside its container), `/test`.

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

- `POST /system` — synchronous tool invocation. Per-container sockets dispatch `npm/pip/cargo/gem/composer/git/migrate` into the container via `docker exec` (`safebox-container exec <name> <tool> ...`; nothing from a tenant workspace ever runs on the host). The control socket dispatches the host-native tools. `dnf` is no longer a tool: on a verity root packages change only by image rotation, and the handler answers `NOT_SUPPORTED`.
- `POST /test`, `POST /test/<id>/keepalive`, `GET /test/<id>/yields`, `POST /test/<id>/stop`, `GET /test/<id>` — test environment lifecycle. Per-container sockets only.
- `POST /embed`, `POST /embed/unload`, `GET /embed/models`, `GET /embed/health` — embeddings via `@huggingface/transformers` in a forked subprocess. Per-container sockets only. Gated by `'embed'` in `allowedActions`. Models come from `/models/install`; the worker has `allowRemoteModels = false`. See [`aws/docs/EMBEDDINGS-PROTOCOL.md`](aws/docs/EMBEDDINGS-PROTOCOL.md).
- `POST /containers/create`, `POST /containers/destroy`, `GET /containers`, `POST /models/install`, `GET /models`, `POST /models/verify`, `POST /models/remove` — control socket only.

**Two allowlists, two governance speeds:**

| Layer | What it controls | Editable by |
|---|---|---|
| `managed-containers.json` | Per-container ACL: which `tool` actions each declared `managedContainer` may invoke. The system component returns `FORBIDDEN_ACTION` for anything not in `allowedActions`. | The system component itself, via `/containers/create` and `/containers/destroy`. SIGHUP reload — no restart. |
| `/etc/sudoers.d/safebox-system` | The entire root-elevation surface: a fixed list of root-owned wrapper paths under `/opt/safebox/bin/` with no argument wildcards. The wrappers validate every input. | Code review only — changes through a PR. The file is on the read-only verity root, so nothing on a running box can edit it. |

**Authentication:** HMAC-SHA-256. The master key is HKDF-SHA-256 of a 32-byte seed that the initramfs unseals from the TPM under the PCR policy and leaves on tmpfs at `/run/safebox/hmac-seed`; the system component reads it at start and keeps the master in memory only. The seed is generated once per instance on first boot and sealed to that TPM, so a copied disk on another host has no seed at all. Per-container keys are HKDF-derived from the master with `info = "safebox-container-<name>-v1"`, so each container's key is cryptographically independent.

**Privileged surface:** the system component runs as unprivileged `safebox-infra`, which is not in the `docker` group. Operations that need elevation (`zfs`, `docker`, the TPM quote) go through `sudo` to root-owned wrappers at fixed paths; the wrappers build the full argument list themselves. That sudoers file plus the wrappers are the entire privileged surface — an auditor reads them and the system component's Node source and knows exactly what is possible. Read them: [`common/sudo/safebox-system`](common/sudo/safebox-system) and [`common/sudo/bin/`](common/sudo/bin/).

**Audit:** structured JSON via `journalctl -t safebox-system`. Each request emits one entry with the calling socket identity, method, path, status, duration, and request metadata.

Full protocol reference for Safebox integrators: [`aws/docs/Safebox.md`](aws/docs/Safebox.md) and [`aws/docs/SYSTEM-PROTOCOL.md`](aws/docs/SYSTEM-PROTOCOL.md).

### Storage architecture

ZFS is the storage layer for everything mutable: `/var`, Docker, MariaDB, the dnsclient identity and credential, nginx vhosts, app data, container clones, test environments. The root filesystem is read-only and holds code and static configuration only; `/etc` is a tmpfs overlay that resets every boot. Each tenant gets a dataset; tests get clones; backup is `zfs send`. Encryption is AES-256-GCM with the key sealed to TPM PCRs 0, 2, 4, 7, 8, 9, 14 and 15 and unsealed only in the initramfs, before PCR 15 is extended.

See [`aws/docs/ZFS-COMPLETE-GUIDE.md`](aws/docs/ZFS-COMPLETE-GUIDE.md) for the full storage model, [`aws/docs/MARIADB-SCALING-ANALYSIS.md`](aws/docs/MARIADB-SCALING-ANALYSIS.md) for how MariaDB sits on top of it, [`aws/docs/XTRABACKUP-PRIMARY.md`](aws/docs/XTRABACKUP-PRIMARY.md) for the backup story.

---

## Onboarding paths

The golden image and its components support two deployment paths in 1.0. Both start from a built image on a VM with a vTPM; there is no path that starts from an existing VM.

### Path A — Cloud-managed (CloudFormation one-click)

The polished path on AWS. Customer clicks a button on the Safebots dashboard, AWS prompts for region + a stack name, CloudFormation provisions an EC2 instance running our published AMI in their AWS account. The dnsclient component (see [`common/dnsclient/`](common/dnsclient/)) publishes a signed announce on first boot with the owner's launch authorization and a TPM quote to the Safenet transparency log and DNS relays, a relay issues a record at `<safeboxId>.safebots.org` pointing at the new instance, and the customer is at their dashboard within ~3 minutes of clicking.

- **Trust anchor**: NitroTPM attestation. The dnsclient binds (safeboxId, reportedIp, challenge, timestamp) into the nonce of a TPM quote over the policy PCRs. The central DNS API verifies the quote's certificate chain against the pinned AWS Nitro root and the PCR values against the blessed image before updating DNS.
- **Custom domains**: handled by the autovhost component ([`common/autovhost/`](common/autovhost/)). Customer points a CNAME at their box's hostname; on first hit, autovhost runs DNS sanity check → ACME HTTP-01 against Let's Encrypt → nginx vhost install → reload. Browser-trusted cert, end-to-end TLS, no third-party in the cleartext path. HTTP-01 is validated over port 80, so the box must be launched with `allow_http = true` (the same Terraform variable on all four clouds) until TLS-ALPN-01 lands.
- **Credit eligibility**: standard Marketplace listing; works with AWS Activate credits.

On GCP, Azure and OCI the same image and the same first-boot flow are launched with the Terraform module under `<cloud>/terraform/` instead of CloudFormation; see [`terraform/README.md`](terraform/README.md).

### Path B — Paste-IP (bring your own VM): not available in 1.0

Earlier designs had a bootstrap script that installed the components onto any existing Linux VM and registered it in an unattested mode (`allowUnattested: true`). That is gone. Announcing now requires a TPM quote over the policy PCRs that matches a blessed image and a valid owner-signed launch authorization, and dnsclient no longer has an unattested mode, so a VM that was not launched from a built image on a vTPM cannot publish an announce. The old script is kept for reference at [`docs/future/bootstrap-safebox.sh.txt`](docs/future/bootstrap-safebox.sh.txt); an explicitly unattested tier may return in a later release.

### Path C — BYO DNS + autovhost only

For customers who already have a Safebox running via Path A and just want to attach more custom domains. No installer needed — the autovhost component is already running. The customer points a CNAME or A record at the box's IP, and on the first request to that hostname, autovhost provisions a cert and vhost automatically. No dashboard click required. The box must have been launched with `allow_http = true` for the HTTP-01 validation to reach it.

This is also the path for customers who want to embed Safebox via iframe under their own domain: they point `id.customer.com` and `chat.customer.com` at our box; we issue and serve real Let's Encrypt certs for both; the iframe loads with proper origin isolation and ITP-resistant session handling.

### Cross-cloud onboarding comparison

| Cloud | Path A polish | Terraform launch | Notes |
|---|---|---|---|
| **AWS** | Yes — CloudFormation one-click via Marketplace AMI | `aws/terraform/` | NitroTPM quotes, sealed keys. |
| **Azure** | Comparable (ARM "Deploy to Azure" button) | `azure/terraform/` | ARM template is straightforward to author. Trusted Launch vTPM quotes, sealed keys; Confidential VM optional. |
| **GCP** | Less polished — paste API key model | `gcp/terraform/` | GCP Marketplace has analogous one-click but UX is rougher. Shielded VM vTPM quotes, sealed keys; Confidential VM optional. |
| **Oracle Cloud (OCI)** | Less polished | `oci/terraform/` | OCI Marketplace exists. Shielded instance vTPM quotes, sealed keys; SEV optional. |
| **IBM Cloud / DigitalOcean / Hetzner / bare metal** | n/a | none | Not supported in 1.0: no built image, no vTPM-backed announce. |

For 1.0 we ship Path A polished on AWS only; the other three clouds launch the same image through Terraform. Path C works on every box launched this way.

### SafeCloud failover (future)

A planned future component is the SafeCloud redundancy network: a peer-to-peer overlay where each running Safebox commits a fraction of its storage and compute to replicate other boxes in the network. When a box fails (instance terminated, hardware lost, network partition longer than threshold), the DNS API rolls its hostname to a peer that holds an up-to-date snapshot, and customer traffic continues against the failover peer without manual intervention.

This is service-for-payment: peers that provide actual storage/compute replication work get paid out of a redundancy pool funded by a fraction of network revenue. Mechanism and economics are specified in [`docs/future/SAFECLOUD-PROTOCOL.md`](docs/future/SAFECLOUD-PROTOCOL.md) (design doc, no implementation yet).

The dnsclient + autovhost components in 1.0 are the foundation: dnsclient is what lets a peer take over a hostname after failover, and autovhost is what lets the new peer serve customer-facing TLS for that hostname without manual cert provisioning. SafeCloud itself (snapshot replication, peer discovery, failover detection, redundancy accounting) is post-1.0.

---

## Multi-cloud

All four clouds build the same image from the same installer: Ubuntu 24.04 LTS on a dm-verity root, encrypted ZFS, hardened Docker, a single system component listening on Unix domain sockets, both keys sealed in the TPM. Ubuntu everywhere because it is the only distribution that ships distro-signed ZFS kernel modules, and Secure Boot refuses to load anything else (see "Why Ubuntu on every cloud" in [`docs/HARDENING-PLAN.md`](docs/HARDENING-PLAN.md)). What differs per cloud is the kernel flavour, the bootstrap and capture commands, the attestation client that verifies the quote's certificate chain, and the agent packages that get removed.

| Cloud | OS | Attestation client | Key mechanism |
|---|---|---|---|
| **AWS** | Ubuntu 24.04 LTS, `linux-aws` | `aws/scripts/components/system/nitroTpmClient.js` | TPM-sealed keys, PCRs 0,2,4,7,8,9,14,15; NitroTPM quote chained to the AWS Nitro root |
| **GCP** | Ubuntu 24.04 LTS, `linux-gcp` | `gcp/scripts/components/dnsclient/gceAttestationClient.js` | TPM-sealed keys, PCRs 0,2,4,7,8,9,14,15; Shielded VM vTPM quote chained to Google's endorsement CA |
| **Azure** | Ubuntu 24.04 LTS, `linux-azure` | `azure/scripts/components/dnsclient/azureAttestationClient.js` | TPM-sealed keys, PCRs 0,2,4,7,8,9,14,15; Trusted Launch vTPM quote verified through Microsoft Azure Attestation |
| **OCI** | Ubuntu 24.04 LTS, `linux-oracle` | `oci/scripts/components/dnsclient/ociAttestationClient.js` | TPM-sealed keys, PCRs 0,2,4,7,8,9,14,15; shielded-instance vTPM quote chained to OCI's endorsement CA |

In every case the system component protocol stays identical (HMAC over canonical envelope, `managed-containers.json` allowlist, `/system` and `/test` endpoints), and the seal policy, unseal script, first-boot unit, sudoers file and wrappers are the same files from `common/`.

Each cloud directory contains: the bootstrap and capture halves of the build script (`scripts/build-image.sh`), a base-installer shim that sets the kernel flavour, the attestation client, build instructions (`INSTRUCTIONS.md`), a Terraform module (`terraform/`) for launching instances from the golden image, and the build manifests.

---

## Security

### Threat model

The adversary the image is built against is someone with ordinary administrative access to the cloud account: they can launch instances, snapshot and swap disks, pass user-data, push run-commands, and open consoles. An earlier build could be rooted by that adversary on all four clouds; [`docs/HARDENING-PLAN.md`](docs/HARDENING-PLAN.md) lists what was found and what closed it. The Infrastructure layer defends against:

- **Disk swap and offline edit.** The root filesystem is a read-only dm-verity volume; the kernel refuses any block whose hash does not match the tree, and the root hash is on the kernel command line, which GRUB measures into PCR 8. Editing the disk breaks verity at the first modified block; replacing the disk changes PCR 8 or 9; either way the sealed keys do not unseal.
- **Snapshot and relaunch elsewhere.** Both keys (ZFS pool key, HMAC seed) are generated on first boot and sealed to that instance's TPM under PCRs 0, 2, 4, 7, 8, 9, 14 and 15. A different VM has a different TPM. The data disk is encrypted and the root disk holds no secrets.
- **Get root later through a bug.** After the initramfs unseals, it extends PCR 15, so the policy no longer matches and nothing later in the boot can unseal the blobs again, root included. Root on a verity root cannot persist anything.
- **User-data, startup scripts, run-commands, extensions.** cloud-init is gone. A first-boot unit reads two named metadata values, validates their format, writes them to the pool, and exits; it runs nothing. The agent packages (SSM, Azure Linux agent, Google guest agents, Oracle Cloud agent) are removed and pinned out, and Terraform disables extension and agent operations at the cloud level.
- **Consoles.** Every getty, the rescue and emergency targets and the debug shell are masked; GRUB has a superuser password and a single hidden entry; `kernel.sysrq=0`; Terraform disables the serial console where the cloud offers a switch. An attacker who gets past GRUB lands on a read-only root with no keys and a pool that will not open.
- **Container to host root.** `safebox-infra` is not in the `docker` group. Every privileged operation is a root-owned wrapper at a fixed path with validated arguments; the sudoers file names those paths and nothing else, with no wildcards. There is no `dnf install` on the privileged surface.
- **Container to cloud credentials.** An nftables rule in `DOCKER-USER` drops all container traffic to the metadata address; the host allows it only for root and `safebox-infra`; OCI's legacy endpoints are off; AWS keeps the IMDSv2 hop limit at 1.
- **Unprivileged RCE in the Safebox plugin.** A bug in the plugin cannot escalate beyond the wrappers. SQL injection in PHP cannot forge a system component request because the HMAC master lives in the Node process's memory, not in PHP's.
- **Test environment escape.** Test containers run with network=none, read-only rootfs, no caps, `no-new-privileges`, in an isolated ZFS clone that is destroyed on teardown or after 60s of silence.
- **Drift.** `unattended-upgrades`, `snapd`, `ubuntu-advantage-tools` and the rest are removed. A running safebox never changes; a patched safebox is a new image with a new root hash.
- **Data exfiltration from the inner Safebox.** The inner Safebox has zero direct internet egress — its nftables OUTPUT chain drops everything except traffic to the outer Safebox Console's private IP. The outer Console enforces a domain-based egress allowlist governed by M-of-N with the Software Signer as required co-signer. A compromised web app or plugin on the inner Safebox cannot phone home because it cannot reach any address except the outer Console, and the outer Console will not proxy traffic to an ungoverned destination.
- **Governance invariant violations.** The Software Signer (attested code in the outer Console's frozen Nix image) is a required co-signer for all governance operations. It enforces structural invariants — dm-verity presence, domain-only allowlists, its own inclusion in the signer set — and will not co-sign changes that violate them. Humans provide liveness; code provides safety.

The Infrastructure layer does NOT defend against:

- **Compromised hypervisor or cloud provider.** The TPM is virtual and the provider runs it. The mitigation is confidential compute (SEV-SNP on AWS, GCP and Azure, SEV on OCI; TDX on Azure), which every Terraform module exposes as a boolean that defaults to off.
- **Compromised Safebox Node process.** If the plugin's Node side is rooted, it holds its own container's HMAC key and the system component will execute what that container is allowed to ask for. M-of-N governance lives inside Safebox, before the call. Per-request governance signatures (Ed25519) are the documented upgrade path for 1.1.

### What's defended

**Boot and keys**
- Secure Boot with the stock Microsoft-signed shim and Canonical-signed GRUB, kernel and ZFS module; no custom keys, no MOK
- Read-only dm-verity root; root hash on the measured kernel command line; `lockdown=integrity`
- ZFS pool key and HMAC seed sealed in the TPM under PCRs 0, 2, 4, 7, 8, 9, 14, 15; unsealed in the initramfs; PCR 15 extended afterwards so they cannot be unsealed again that boot
- Sealing happens per instance on first boot; the image contains no secrets
- Announcing requires a valid owner-signed launch authorization and a TPM quote whose PCR values match the blessed image, with each cloud's endorsement chain verified by Safenet peers and DNS relays
- `/etc` is a tmpfs overlay; every secret and every piece of mutable state is on the encrypted pool

**No way in**
- No sshd, no cloud-init, no cloud agents (SSM, walinuxagent, Google guest agents, oracle-cloud-agent), all pinned out so `apt install` fails
- Every getty, rescue, emergency and debug shell masked; `kernel.sysrq=0`
- GRUB superuser password, hidden single entry, recovery disabled
- Build operator account deleted before capture; every password locked, every shell `nologin`; `verify-image.sh` refuses to capture otherwise
- Terraform disables the serial console, extensions, agents and boot diagnostics where the cloud exposes a switch

**Runtime isolation**
- `safebox-infra` not in the `docker` group; privileged operations only through fixed-path wrappers named in the sudoers file, no wildcards
- Containers firewalled from the metadata service in `DOCKER-USER`; host access only for root and `safebox-infra`
- Docker userns-remap, `no-new-privileges`
- PHP `expose_php=Off`, dangerous functions disabled
- Hardened sysctls (kptr_restrict, dmesg_restrict, ptrace_scope, BPF restrictions, ICMP redirect drops)

**Egress control (two-box architecture)**
- Inner Safebox nftables OUTPUT drops all traffic except to the outer Console's private IP (`common/net/safebox-inner-egress.nft`)
- Inner Safebox cloud security group allows egress only to the outer Console's security group (no `0.0.0.0/0`)
- Outer Console enforces a domain-based egress allowlist; no bare IPs (the Software Signer will not co-sign them)
- Allowlist changes require M-of-N governance with the Software Signer as required co-signer
- The outer Console proxies governed egress on behalf of the inner Safebox; it judges destination shape (domain, protocol) not content

**Supply chain**
- One base installer, `common/base/install-base.sh`, with apt pins for every package and `Pin-Priority: -1` for everything that must never exist on the box
- Node tarball sha256-pinned; npm packages installed from a lockfile
- The system component's npm dependencies are `@huggingface/transformers` for the embeddings worker and `@noble/post-quantum` + `@noble/hashes` + `@noble/curves` for ML-DSA-65 (FIPS 204) hybrid signature verification, installed from the lockfile; Node's stdlib covers x509 and ECDSA verify
- Platform root certs pinned by SHA-256 fingerprint
- Every build writes a manifest with the root hash, the image inventory digest and the git commit; `verify-image.sh` runs before capture

**System component**
- HMAC-SHA-256 with 5-minute clock skew window, 10-minute nonce LRU
- Per-request `managedContainer` + `tool` authorization via `managed-containers.json`
- All execFile invocations use array argv with `--` separators; no shell interpretation anywhere
- Workspace prefix enforcement via `realpathSync` (leading-dash package names rejected, `/etc` workspace escapes rejected)
- Per-tool timeouts with SIGKILL on overrun
- Host-scope actions only from the control socket; `dnf` answers `NOT_SUPPORTED`

### Post-quantum hybrid verification

The system component implements hybrid post-quantum OCP claim verification via `ocpVerify.js`. Every governance claim — image blessings, key rotations, delegation chains — carries dual signatures: ES256 (P-256 + SHA-256) and ML-DSA-65 (FIPS 204). The verifier checks both; a break in either scheme alone does not compromise the system. Keys are identified by `data:key/` URIs:

- `data:key/es256;base64,<SPKI-DER>` — 91-byte P-256 public key
- `data:key/ml-dsa-65;base64,<raw-1952-byte-pk>` — 1952-byte ML-DSA-65 public key

The governance key registry (`governanceKeys.js`) supports identity deduplication: a signer with both an ES256 key and an ML-DSA-65 key counts once toward M-of-N thresholds. Key rotation is rate-limited with exponential backoff.

### Measured TEE launcher

`launcher.js` is the measured execution entry point. When a package is installed into a Safebox, the launcher:

1. Verifies the publication claim against the governance key registry (via `ocpVerify`)
2. Verifies package content against its Merkle root from the publication claim
3. Measures the execution environment (PCR values, image hash)
4. Creates an `execution_manifest` claim binding the source hash to the runtime environment
5. Launches the package in a sandboxed runtime with cgroup constraints

This establishes the full measurement chain from source code to running binary, all bound in OCP claims.

### Auditable image chain

Both this repo and [Safenet](https://github.com/Safebots/Safenet) are open source. Together they produce auditable disk images: Infrastructure at commit X plus Safenet at commit Y yields a golden image with SHA-256 hash H, and running Safeboxes attest to that hash via PCR measurements. The Safenet governance quorum publishes `image_blessing` claims — signed with hybrid ES256 + ML-DSA-65 — that approve specific image hashes, closing the loop between source code and running infrastructure.

### What's pending before we'd claim "audited"

- External code audit of the system component, `common/base/install-base.sh`, the initramfs scripts, the wrappers, and the Safenet protocol implementation by a third-party review house
- A hardware run of the full boot chain on each cloud: build, capture, launch, first-boot seal, reboot and unseal, announce with a verified quote accepted by a Safenet peer, and a confirmed fail-closed on a swapped disk (the synthetic test suite exercises the code paths, but none of this has been verified against real vTPMs on all four clouds yet)
- `tests/redteam/<cloud>.sh` passing in CI against every candidate image on every cloud
- Reproducible build verification (two independent builds from the same git commit producing byte-identical verity roots and the same root hash)

### Reporting vulnerabilities

Email security@safebots.ai. PGP key on the website.

---

## Documentation

**For auditors:**
- [`docs/RELEASE-NOTES-1.0.0.md`](docs/RELEASE-NOTES-1.0.0.md) — what the two adversarial reviews found and what was fixed
- [`docs/HARDENING-PLAN.md`](docs/HARDENING-PLAN.md) — what the adversarial review found, the fixes, and the normative implementation contract (layout, disk, command line, PCR policy, first boot, sudoers, build flow, Terraform, red team)
- [`aws/docs/AUDIT.md`](aws/docs/AUDIT.md) — the audit checklist, 6 phases
- [`aws/docs/ARCHITECTURE.md`](aws/docs/ARCHITECTURE.md) — full system architecture
- [`aws/docs/SECURITY-HARDENING.md`](aws/docs/SECURITY-HARDENING.md) — hardening details
- [`aws/docs/CASCADING-MANIFESTS.md`](aws/docs/CASCADING-MANIFESTS.md) — the SHA256 attestation chain

**For integrators (Safebox plugin team):**
- [`aws/docs/SYSTEM-PROTOCOL.md`](aws/docs/SYSTEM-PROTOCOL.md) — wire spec for the HTTP API
- [`aws/docs/QUICKSTART.md`](aws/docs/QUICKSTART.md) — fastest path to a running AMI
- [`docs/TRANSPARENCY.md`](docs/TRANSPARENCY.md), [`docs/SUCCESSION.md`](docs/SUCCESSION.md), [`docs/OCP-IN-BASE.md`](docs/OCP-IN-BASE.md) — transparency log, failover escrow, and OpenClaiming verification in the system component

**For operators:**
- [`aws/INSTRUCTIONS.md`](aws/INSTRUCTIONS.md), [`gcp/INSTRUCTIONS.md`](gcp/INSTRUCTIONS.md), [`azure/INSTRUCTIONS.md`](azure/INSTRUCTIONS.md), [`oci/INSTRUCTIONS.md`](oci/INSTRUCTIONS.md) — per-cloud runbooks
- [`terraform/README.md`](terraform/README.md) — the launch modules
- [`common/dnsclient/`](common/dnsclient/) and [`common/autovhost/`](common/autovhost/) — the announce and custom-domain components
- [`docs/AWS-NITRO-SETUP.md`](docs/AWS-NITRO-SETUP.md) — provisioning guide
- [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) — how Safebox governance maps to system calls
- [`aws/docs/BACKUP-STRATEGY.md`](aws/docs/BACKUP-STRATEGY.md) — backup architecture
- [`aws/docs/ZFS-COMPLETE-GUIDE.md`](aws/docs/ZFS-COMPLETE-GUIDE.md) — ZFS storage model
- [`aws/docs/MARIADB-SCALING-ANALYSIS.md`](aws/docs/MARIADB-SCALING-ANALYSIS.md), [`aws/docs/XTRABACKUP-PRIMARY.md`](aws/docs/XTRABACKUP-PRIMARY.md) — database

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

**Before 1.0:**
- Two-box architecture (outer Safebox Console + inner Safebox) deployed and tested on all four clouds
- Nix-based outer Console image with Software Signer and egress allowlist
- Inner Safebox egress deny-all except outer Console verified on all four clouds
- Hardware run of the full boot chain on each cloud and the red-team suite green in CI (see "What's pending")

**1.1+:**
- LLM tier components (`llm-tiny`, `llm-small`, `llm-medium`, `llm-large`, `llm-xl`) — installers for the ~70-model catalog
- Speech and vision tiers (ASR, TTS, multimodal)
- Per-request governance signatures via hybrid ES256 + ML-DSA-65 (1.1 protocol upgrade; the verification path is already implemented in `ocpVerify.js`)
- Confidential compute on by default once the attestation clients verify the SEV-SNP/TDX report alongside the TPM quote
- Source code auditing pipeline — LLM-based audit triggered on GitReceiver publication, with Safebux-metered query access

## License

Apache 2.0. See [LICENSE](LICENSE).
