# Safebots Infrastructure

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0--pre-yellow.svg)](CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](CHANGELOG.md)

**Attested AMI for hosting the Safebox plugin.** Hardware-bound HMAC, deterministic build, single auditable HTTP API between Safebox and the host (the System component).

> **Status**: Pre-release working tree for the 1.0.0 launch. Versioning is held at 1.0.0 until first publication; subsequent changes increment 1.0.x.

---

## What this repo is

This repo builds an attested cloud AMI that runs the Safebox plugin. It is intentionally a thin Linux-level runtime layer: hardened OS, encrypted ZFS, hardened Docker, a single HTTP API (the System component) for the Safebox plugin to call when it needs to do something privileged on the host.

**The 1.0 installable surface is four components:**

- **`base`** — pinned packages, encrypted ZFS pool, hardened Docker, hardened PHP-FPM, hardened sysctls, SSH removed on the production AMI. The OS configuration that an auditor reads once and trusts.
- **`system`** — a small Node.js host service listening on per-container Unix domain sockets (one per managed container, plus one control socket for host operations). Safebox Node connects to a bind-mounted socket inside its container; the system component knows which container is calling from kernel-enforced socket identity, verifies the HMAC against that container's derived key, validates the request against `managed-containers.json`, dispatches to `child_process.execFile`, returns results. Test environments use a ZFS clone + keepalive pattern (aggressive 60s teardown unless pinged). The master HMAC key is bound to AWS Nitro attestation PCRs via HKDF — copying the disk to a different host produces a different key, and per-container keys are themselves HKDF-derived from the master so each container's key is cryptographically independent. See [`aws/docs/Safebox.md`](aws/docs/Safebox.md) for the transport and integration spec.
- **`dnsclient`** — separate systemd unit that handles IP announcement to the central DNS API. On boot reads its `safeboxId` + `accountToken` from `/etc/safebox/dnsclient.json` (populated by cloud-init from EC2 user-data), discovers its public IP via IMDSv2, generates a Nitro attestation document with `(safeboxId, reportedIp, challenge, timestamp)` bound into `user_data`, and POSTs to the configured DNS API. Re-announces on IP change and hourly heartbeat. Serves an HTTP challenge endpoint at port 8443 so the DNS API can confirm IP control. Separate process from `system` so dnsclient bugs can't reach the master HMAC key.
- **`autovhost`** — separate systemd unit that handles custom-domain provisioning. Listens on a Unix socket; nginx forwards unknown-Host requests via a mirror directive. Cascade: negative cache → DNS sanity check → ACME HTTP-01 against Let's Encrypt → write per-host server block + cert → debounced nginx reload. Lets customers attach arbitrary domains by pointing DNS at the box.

That's the actual 1.0 deliverable. Roughly 5800 lines of Node across all four components (System ~4200, dnsclient ~1000, autovhost ~600 plus the acme-client dependency) plus a ~400-line base installer plus the pinned-package manifest. The System component is the bulk; dnsclient and autovhost are small focused services that can each be audited in an afternoon.

## What this repo ALSO contains (designs and references, not yet installable)

These exist as engineering reference and pre-1.0 design work. They have spec docs and partial code, but no `install-<tier>.sh` script and no smoke tests against real hardware:

- **AI model supply chain (1.0 surface)** — the system component ships endpoints under `/models/*` ([wire spec](aws/docs/MODELS-PROTOCOL.md)) for installing, listing, verifying, and removing model weights. Every model is identified by the SHA-256 of its canonical manifest JSON; that hash is what Safebox M-of-N signs. Weights are downloaded from HTTPS sources (Hugging Face, S3, mirrors), verified against the manifest before any other process can touch them, and installed atomically into `/srv/safebox/models/<manifestHash>/`. Same `_host` scope as `dnf` — a compromised app-tenant cannot swap model weights without governance. The supply chain itself is 1.0; what's not yet 1.0 are the *runner containers* that consume the installed weights.
- **AI model runners** — [`model-runners/privacy-filter/`](model-runners/privacy-filter/) has a working 448-line FastAPI service (PII redaction); [`model-runners/stable-audio-3/`](model-runners/stable-audio-3/) has the skeleton for Stable Audio 3 (text-to-music + sound effects); [`model-runners/vllm/runner_extensions.py`](model-runners/vllm/runner_extensions.py) extends vLLM for the deterministic-inference path. The full ~80-model catalog with sizes and licenses is in [`docs/MODEL-CATALOG.md`](docs/MODEL-CATALOG.md); the runner inference protocol spec is in [`docs/MODEL-RUNNER-API-SPEC.md`](docs/MODEL-RUNNER-API-SPEC.md). What's missing: component installers (`aws/scripts/components/llm-tiny/install-llm-tiny.sh`, etc.) that publish model manifests, start the runner systemd units, and wire model serving sockets into the system component. Post-1.0 work.
- **Speech and vision tiers** — design docs under [`docs/future/`](docs/future/) (VibeVoice ASR, Nemotron-Omni, speech protocol implementation). Same status: real spec work, no installers yet.
- **Composable architecture** — the original design called for 20 modular components ([`docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md`](docs/future/SAFEBOX-COMPOSABLE-ARCHITECTURE.md)). 1.0 ships two of them (base + system), with the system component's `/models` endpoints serving as the foundation for the model-tier components to plug into.
- **GCP, Azure, and Oracle Cloud builds.** All three have TPM-based attestation suitable for the same architectural pattern. Implementation effort discussed below in "Multi-cloud."

The split is honest: 1.0 ships a complete, auditable AWS AMI with the system component (including the model supply chain), the base component, and the privacy-filter runner. Everything else is real engineering work for 1.1+ that builds on the same foundation.

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
├── base/                # OS hardening, ZFS, Docker, PHP-FPM, package pinning
│   ├── install-base.sh
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
└── autovhost/          # On-demand nginx vhost + ACME provisioning
    ├── autovhost.js       # Unix-socket handler + ACME cascade
    ├── config.js
    ├── nginx-templates/safebox-autovhost.conf
    ├── package.json       # acme-client 5.4
    ├── install-autovhost.sh
    └── units/safebox-autovhost.service
```

The base component is required. The system component depends on base. dnsclient and autovhost are independent of each other and of system at the process level — they just need `safebox-infra` to exist (which the system installer creates).

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

**Authentication:** HMAC-SHA-256. The master key is derived from a verified AWS Nitro attestation document via HKDF-SHA-256 over PCRs 0, 1, 4 — same AMI on same host → same master, different host → different master. Per-container keys are HKDF-derived from the master with `info = "safebox-container-<name>-v1"`, so each container's key is cryptographically independent.

**Privileged surface:** the system component runs as unprivileged `safebox-infra`. Operations that need elevation (`dnf`, `zfs`, `docker`) go through `sudo` against the tight allowlist. That sudoers file is the entire privileged surface — an auditor reads it and the system component's Node source and knows exactly what is possible. Read it: [`aws/scripts/components/system/sudoers/safebox-system`](aws/scripts/components/system/sudoers/safebox-system).

**Audit:** structured JSON via `journalctl -t safebox-system`. Each request emits one entry with the calling socket identity, method, path, status, duration, and request metadata.

Full protocol reference for Safebox integrators: [`aws/docs/Safebox.md`](aws/docs/Safebox.md) and [`aws/docs/SYSTEM-PROTOCOL.md`](aws/docs/SYSTEM-PROTOCOL.md).

### Storage architecture

ZFS is the storage layer for everything mutable: app data, container clones, MariaDB datadirs, test environments. Each tenant gets a dataset; tests get clones; backup is `zfs send`. Encryption is AES-256-GCM with the key sealed to TPM PCRs and only available after attested boot.

See [`aws/docs/ZFS-COMPLETE-GUIDE.md`](aws/docs/ZFS-COMPLETE-GUIDE.md) for the full storage model, [`aws/docs/MARIADB-SCALING-ANALYSIS.md`](aws/docs/MARIADB-SCALING-ANALYSIS.md) for how MariaDB sits on top of it, [`aws/docs/XTRABACKUP-PRIMARY.md`](aws/docs/XTRABACKUP-PRIMARY.md) for the backup story.

---

## Onboarding paths

The same AMI + components support three deployment paths. Customers pick the one that matches how much of the stack they want us to manage.

### Path A — Cloud-managed (CloudFormation one-click)

The polished path on AWS. Customer clicks a button on the Safebots dashboard, AWS prompts for region + a stack name, CloudFormation provisions an EC2 instance running our published AMI in their AWS account. The dnsclient component (see [`aws/scripts/components/dnsclient/`](aws/scripts/components/dnsclient/)) phones home on first boot with an attested announce, the central DNS API issues a record at `<safeboxId>.safebots.org` pointing at the new instance, and the customer is at their dashboard within ~3 minutes of clicking.

- **Trust anchor**: full Nitro attestation. The dnsclient binds (safeboxId, reportedIp, challenge, timestamp) into the NSM-signed COSE_Sign1 document. Central DNS API verifies the signature chain against the pinned AWS Nitro root cert before updating DNS.
- **Custom domains**: handled by the autovhost component ([`aws/scripts/components/autovhost/`](aws/scripts/components/autovhost/)). Customer points a CNAME at their box's hostname; on first hit, autovhost runs DNS sanity check → ACME HTTP-01 against Let's Encrypt → nginx vhost install → reload. Browser-trusted cert, end-to-end TLS, no third-party in the cleartext path.
- **Credit eligibility**: standard Marketplace listing; works with AWS Activate credits.

### Path B — Paste-IP (bring your own VM)

For customers who already have a Linux VM on any cloud (or bare metal). They run our bootstrap script with a registration token:

```bash
curl -L https://safebots.org/bootstrap > /tmp/b.sh
less /tmp/b.sh                       # read first
sudo bash /tmp/b.sh reg_xxxxxxxxxxxxxxxx
```

The script ([`aws/scripts/bootstrap-safebox.sh`](aws/scripts/bootstrap-safebox.sh)) detects the distro, installs Node.js / nginx / openssl / jq, downloads the Infrastructure tarball, runs `install-system.sh` + `install-dnsclient.sh` + `install-autovhost.sh` in order, registers the box with the control plane (POSTing the registration token + detected public IP), receives a `safeboxId` + `accountToken`, writes them to `/etc/safebox/dnsclient.json`, and starts the systemd units. Total time on a fresh Ubuntu/Debian/RHEL VM: ~2 minutes.

- **Trust anchor**: weaker than Path A. Without Nitro, the dnsclient runs in unattested mode (`allowUnattested: true` in dnsclient.json). The DNS API trusts the registration token and the announce-then-challenge handshake but cannot prove the OS image hasn't been modified. Suitable for customers whose threat model accepts this — most do.
- **Custom domains**: same autovhost flow as Path A.
- **No credit story**: the customer is paying for their own VM out of pocket. Activate credits don't apply because the workload doesn't run on an AWS Marketplace AMI.

### Path C — BYO DNS + autovhost only

For customers who already have a Safebox running (via Path A or B) and just want to attach more custom domains. No installer needed — the autovhost component is already running. The customer points a CNAME or A record at the box's IP, and on the first request to that hostname, autovhost provisions a cert and vhost automatically. No dashboard click required.

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

### SafeCloud failover (future)

A planned future component is the SafeCloud redundancy network: a peer-to-peer overlay where each running Safebox commits a fraction of its storage and compute to replicate other boxes in the network. When a box fails (instance terminated, hardware lost, network partition longer than threshold), the DNS API rolls its hostname to a peer that holds an up-to-date snapshot, and customer traffic continues against the failover peer without manual intervention.

This is service-for-payment: peers that provide actual storage/compute replication work get paid out of a redundancy pool funded by a fraction of network revenue. Mechanism and economics are specified in [`docs/future/SAFECLOUD-PROTOCOL.md`](docs/future/SAFECLOUD-PROTOCOL.md) (design doc, no implementation yet).

The dnsclient + autovhost components in 1.0 are the foundation: dnsclient is what lets a peer take over a hostname after failover, and autovhost is what lets the new peer serve customer-facing TLS for that hostname without manual cert provisioning. SafeCloud itself (snapshot replication, peer discovery, failover detection, redundancy accounting) is post-1.0.

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
- The system component has zero npm dependencies (Node 22 stdlib covers x509, ECDSA verify, CBOR is hand-rolled)
- AWS root cert pinned by SHA-256 at compile time and verified at install time

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

**1.1+:**
- LLM tier components (`llm-tiny`, `llm-small`, `llm-medium`, `llm-large`, `llm-xl`) — installers for the ~70-model catalog
- Speech and vision tiers (ASR, TTS, multimodal)
- GCP, Azure, and Oracle Cloud builds — per-cloud attestation clients (~3-5 days of work each)
- Per-request Ed25519 governance signatures (1.1 protocol upgrade)
- Runtime HMAC rotation without service downtime

## License

Apache 2.0. See [LICENSE](LICENSE).
