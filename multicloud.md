# Multi-Cloud Safebox Architecture

How the Safebox infrastructure works across AWS, Azure, GCP and OCI, what each cloud contributes, and how the pieces fit together.

## Design principles

A safebox is the same thing on every cloud: a hardened, attestable, unattended compute instance that boots a dm-verity root, seals its secrets to a vTPM, and announces itself to the Safenet transparency log with a signed OCP claim. The cloud supplies the hardware trust anchor (TPM, confidential VM, Secure Boot firmware) and the network; everything above the firmware is identical code.

The infrastructure is organized to make that work:

- **`common/`** holds everything that is the same on every cloud: the base installer, the boot chain, the first-boot unit, dm-verity tooling, the image verifier, the dnsclient, the autovhost, the safenet protocol, and all shared attestation logic. This is ~6,000+ lines of code that ships in every image regardless of cloud.
- **`<cloud>/`** holds only the things that differ: the attestation client (how the box talks to *this* cloud's TPM and attestation service), the image builder (how to write a disk and capture an image on *this* cloud), the Terraform module (how to launch an instance with *this* cloud's API), and the operational instructions.

## Repository layout

```
Infrastructure/
├── common/                          # Cloud-neutral code (~6,000+ lines)
│   ├── attestation/                 # Shared attestation logic (OCP claims, Ed25519)
│   ├── base/install-base.sh         # Base OS: debootstrap, kernel, Node.js, ZFS, apt pins
│   ├── boot/                        # GRUB config, kernel command line, PCR policy
│   ├── firstboot/                   # safebox-firstboot.service and unseal logic
│   ├── image/                       # build-verity-root.sh, cleanup, verify, grub password
│   ├── dnsclient/install-dnsclient.sh  # DNS relay client component
│   ├── autovhost/                   # Automatic virtual hosting with ACME
│   ├── safenet/install-safenet.sh   # Safenet protocol overlay (P2P registry, claims, payments)
│   ├── keyd/                        # Key management daemon
│   ├── nameserver/                  # Internal nameserver
│   ├── net/                         # Network configuration
│   └── sudo/                        # Sudo removal and lockdown
│
├── aws/
│   ├── scripts/
│   │   ├── build-image.sh           # AMI builder: debootstrap → verity → snapshot → register
│   │   └── components/
│   │       ├── base/install-base.sh # (placeholder — delegates to common)
│   │       ├── system/
│   │       │   ├── install-system.sh  # System component installer (canonical source for all clouds)
│   │       │   ├── nitroTpmClient.js  # AWS NitroTPM attestation client
│   │       │   └── *.js               # ~25 system modules (shared across clouds)
│   │       └── safenet/             # Canonical Safenet source (13 modules)
│   ├── terraform/                   # EC2 launch module
│   └── INSTRUCTIONS.md
│
├── azure/
│   ├── scripts/
│   │   ├── build-image.sh           # Managed Image builder
│   │   └── components/
│   │       └── system/
│   │           ├── install-system.sh  # Copies from aws/; swaps in Azure attestation client
│   │           └── azureAttestationClient.js  # MAA JWT/JWKS + AMD VCEK P-384
│   ├── terraform/                   # azapi_resource VM launch + deny policies
│   └── INSTRUCTIONS.md
│
├── gcp/
│   ├── scripts/
│   │   ├── build-image.sh           # GCE image builder
│   │   └── components/
│   │       └── system/
│   │           ├── install-system.sh  # Copies from aws/; swaps in GCE attestation client
│   │           └── gceAttestationClient.js  # vTPM EK cert chain + AMD SEV-SNP ARK
│   ├── terraform/                   # GCE instance launch + org policies
│   └── INSTRUCTIONS.md
│
├── oci/
│   ├── scripts/
│   │   ├── build-image.sh           # OCI custom image builder (qcow2 → Object Storage → import)
│   │   └── components/
│   │       └── system/
│   │           ├── install-system.sh  # Copies from aws/; swaps in OCI attestation client
│   │           └── ociAttestationClient.js  # TPM EK cert + measured boot log replay
│   ├── terraform/                   # OCI instance launch + compartment policies
│   └── INSTRUCTIONS.md
│
├── tests/
│   ├── redteam/                     # Per-cloud red team scripts
│   │   ├── aws.sh
│   │   ├── azure.sh
│   │   ├── gcp.sh
│   │   └── oci.sh
│   └── multicloud/                  # Cross-cloud integration tests
│       ├── test-peer-discovery.sh   # Verify safeboxes find each other across clouds
│       ├── test-cross-attestation.sh # Verify cross-cloud claim verification
│       └── test-safenet-mesh.sh     # Verify Safenet registry consistency
│
├── .github/workflows/
│   ├── build-images.yml             # CI/CD: multi-cloud image builds
│   └── test-multicloud.yml          # CI/CD: cross-cloud integration tests
│
├── docs/                            # Normative specs (HARDENING-PLAN.md, etc.)
└── multicloud.md                    # ← this file
```

## How a safebox image is built

Every cloud follows the same five-stage pipeline, run by that cloud's `build-image.sh`:

1. **Debootstrap** a minimal Ubuntu 24.04 (noble) root filesystem into a chroot on a blank disk. The kernel flavour is cloud-specific (`linux-aws`, `linux-azure`, `linux-gcp`, `linux-oracle`) because Canonical ships cloud-optimized kernels with the right drivers and signed ZFS modules.

2. **Run the component installers** inside the chroot, in dependency order:
   - `base` — `common/base/install-base.sh`: Node.js (sha256-pinned tarball), ZFS tools, apt pins that block every unwanted package at priority -1, account lockdown, setuid stripping, dracut modules.
   - `system` — `<cloud>/scripts/components/system/install-system.sh`: Copies the ~25 system modules from the AWS canonical source, removes `nitroTpmClient.js`, and installs the cloud-specific attestation client as `attestationClient.js`.
   - `dnsclient` — `common/dnsclient/install-dnsclient.sh`: DNS relay client for publishing the safebox announce and handling DNS challenges.
   - `autovhost` — `common/autovhost/install-autovhost.sh`: Automatic TLS virtual hosting with Let's Encrypt ACME.
   - `safenet` — `common/safenet/install-safenet.sh`: Safenet P2P overlay (registry, discovery, claims, payments, transparency log).

3. **Verify** — `common/image/verify-image.sh` asserts no agent packages, no unlocked accounts, no login shells, no unexpected setuid binaries, all required dracut modules present, and GRUB has a superuser password. The build stops on the first failure.

4. **Write the verity root** — `common/image/build-verity-root.sh` partitions the target disk (512 MB ESP, 1 GB /boot, root + hash tree), writes the root as a dm-verity volume with a hash tree, installs the signed shim and GRUB with the measured command line containing the root hash, and prints the root hash.

5. **Capture** — Cloud-specific image registration:
   - **AWS**: Snapshot the EBS volume, register as AMI with `--tpm-support v2.0 --imds-support v2.0`, UEFI boot mode, Secure Boot variable store with Microsoft UEFI CA.
   - **Azure**: Snapshot the managed disk, create a Compute Gallery image version with `--os-state Specialized --features SecurityType=TrustedLaunch`.
   - **GCP**: Detach the disk, create a GCE image with `--guest-os-features=UEFI_COMPATIBLE,SEV_SNP_CAPABLE`.
   - **OCI**: Convert disk to qcow2, upload to Object Storage, import with `--launch-mode UEFI_64`.

Each build writes a manifest to `manifests/<cloud>-<date>.json` with the image ID, root hash, verity manifest, inventory digest, and git commit.

## System component and attestation

The system component is the Node.js application that runs inside every safebox. Its ~25 modules (safebox lifecycle, health, attestation endpoint, audit log, etc.) are **canonical in `aws/scripts/components/system/`** and copied verbatim to every cloud during the build. The only cloud-specific file is the attestation client:

| Cloud | Attestation client | Trust anchor | Attestation method |
|-------|-------------------|--------------|-------------------|
| AWS | `nitroTpmClient.js` | NitroTPM + Nitro Enclaves | vTPM quote; Nitro Root-G1 cert pinned by SHA-256 |
| Azure | `azureAttestationClient.js` | vTPM + AMD SEV-SNP | MAA JWT/JWKS token; AMD VCEK P-384 cert chain |
| GCP | `gceAttestationClient.js` | vTPM + optional SEV-SNP | EK cert chain from GCE CA (SHA-256 pinned); AMD SEV-SNP ARK (pinned) |
| OCI | `ociAttestationClient.js` | TPM + measured boot | TPM EK cert from manufacturer roots (pre-staged); platform cert from IMDS at runtime |

Every attestation client exposes the same interface: `getAttestation()` returns a signed OCP claim containing the safebox-id, the vTPM quote, the PCR values, and the cloud identifier. This makes cross-cloud verification straightforward — verifiers check the Ed25519 signature on the OCP claim, not the cloud-specific quote format.

## Safenet: the cross-cloud overlay

Safenet is the P2P protocol that ties safeboxes together across clouds. Its 13 modules are pure Node.js with no cloud-specific bindings:

- **SafenetNode** — The main daemon; joins the mesh and manages peer connections.
- **Registry** — Distributed package registry for safebox components.
- **Discovery** — Peer discovery across clouds using the DNS relays and transparency log.
- **Claims** — OCP Ed25519 signed claims: launch authorization, safebox announce, name claims, revocations.
- **Verify** — Claim verification; Ed25519 signature checks are cloud-neutral.
- **Payments** — Settlement protocol for paid operations.
- **TransparencyLog** — Append-only log of all claims; consistency verification across nodes.
- **Publisher** / **GitReceiver** — Package publishing and git-based deployment.
- **ZoneCompiler** / **Identity** — DNS zone compilation and identity management.
- **SystemComponent** — Bridge between the system component and Safenet.

Safenet is installed from the canonical source in `aws/scripts/components/safenet/` by `common/safenet/install-safenet.sh`. Because it has no cloud-specific code, the same modules run on every cloud. Cross-cloud peer verification works because each safebox's `safebox_announce` claim is signed with Ed25519 (cloud-neutral), chaining the launch authorization that was verified against the owner's public key.

## Terraform launch modules

Each cloud's `<cloud>/terraform/` is a self-contained Terraform module that launches one production safebox from a pre-built image. They share the same contract:

**Inputs** (common to all clouds):
- `safebox_id` — Unique identifier for this safebox.
- `owner_pubkey` — Owner's Ed25519 public key (64 hex characters).
- `launch_authorization` — Base64-encoded signed OCP claim.
- `allow_http` — Whether to open port 80 for ACME HTTP-01 challenges (default: false).

**What each module creates**:
- A shielded/trusted-launch instance from the golden image.
- An empty data disk (≥50 GB) — the initramfs creates the encrypted ZFS pool on first boot.
- A firewall/NSG/security group allowing inbound TCP 443 and 8443, plus 80 if `allow_http` is set.
- Metadata containing only `safebox-id`, `owner-pubkey`, and `launch-authorization`.

**What differs by cloud**:

| Feature | AWS | Azure | GCP | OCI |
|---------|-----|-------|-----|-----|
| VM resource | `aws_instance` | `azapi_resource` (no osProfile) | `google_compute_instance` | `oci_core_instance` |
| Secure Boot | AMI attribute | Gallery definition | Shielded VM config | `platform_config` |
| Confidential VM | SEV-SNP (`m6a`+) | SEV-SNP/TDX (`DCasv5`+) | SEV-SNP (`n2d`) | AMD SEV only (no attestation report) |
| Deny policies | SCP (manual) | Azure Policy (Terraform-managed) | Org policies (Terraform-managed) | Compartment policies (Terraform-managed) |
| Console lockdown | `disable-serial-console-access` + SCP | `az serial-console disable` + deny policy | `compute.disableSerialPortAccess` org policy | Omit `instance-console-connection` from IAM |
| Image reference | AMI ID | Gallery image version ID | Image self-link | Image OCID |
| Metadata channel | Instance metadata (IMDSv2) | userData (base64 JSON) | Instance metadata | Instance metadata (IMDS v2 only) |

## Confidential compute support

Confidential VMs provide hardware-enforced memory encryption with a guest attestation report, proving the VM's memory is encrypted and untampered. The default safebox image **refuses to announce** without a confidential compute attestation report unless it was built with `allowUnencryptedMemory`.

| Cloud | Technology | Shape/Size | Guest attestation | Status |
|-------|-----------|------------|------------------|--------|
| AWS | AMD SEV-SNP via Nitro | `m6a`, `c6a`, `r6a` | Yes — Nitro attestation document | ✅ Production ready |
| Azure | AMD SEV-SNP or Intel TDX | `DCasv5`, `ECasv5`, `DCesv5`, `ECesv5` | Yes — MAA token | ✅ Production ready |
| GCP | AMD SEV-SNP | `n2d` machine types | Yes — vTPM + SEV-SNP report | ✅ Production ready |
| OCI | AMD SEV (plain) | E4.Flex, E5.Flex | ❌ No guest attestation report | ⚠️ Limited — no TEE attestation |

**OCI production posture**: Memory encryption is on by default (`skip_memory_encryption` defaults to false, `confidential_compute_type` defaults to `"SEV_SNP"`). Build with `--allow-unencrypted-memory` for shapes that only support plain SEV (no guest attestation report). The image contents are open-source code on a publicly hashed dm-verity root — nothing in the image benefits from memory encryption. SEV protects the runtime state: first-boot private keys, ZFS pool encryption keys, and tenant data in the Node.js heap. The gap is remote attestation: OCI's plain SEV provides no hardware-signed report from AMD's Secure Processor, so a verifier trusts OCI's API that SEV is on rather than having a cryptographic proof. When OCI ships SEV-SNP shapes, rebuild without `--allow-unencrypted-memory` and the full attestation chain closes.

## Cloud-level deny policies

Beyond the on-image hardening (no agent, no sshd, no getty, verity root, sealed keys), each cloud needs control-plane policies that prevent operators from re-enabling attack paths. These are managed in Terraform where possible:

### AWS
SCPs (Service Control Policies) applied manually at the account level:
- Deny `ec2:EnableSerialConsoleAccess`
- Deny `ec2-instance-connect:SendSerialConsoleSSHPublicKey`, `SendSSHPublicKey`
- Deny `ssm:StartSession`, `ssm:SendCommand`

### Azure
Azure Policy definitions managed by Terraform (`manage_deny_policies = true`):
- Deny `Microsoft.Compute/virtualMachines/extensions` (Run Command, VMAccess, Custom Script)
- Deny `Microsoft.Compute/virtualMachines/runCommands`
- Deny boot diagnostics on safebox-tagged VMs

Plus manual: `az serial-console disable` at subscription scope.

### GCP
Organization policies managed by Terraform (`manage_deny_policies = true`):
- `compute.disableSerialPortAccess` — enforced
- `compute.disableSerialPortLogging` — enforced
- `compute.requireShieldedVm` — enforced
- IAM deny policy blocking `compute.instances.setMetadata` for all except the deploy service account

### OCI
Compartment policies managed by Terraform (`manage_deny_policies = true`):
- Allow-only IAM: grant `manage instances`, `manage volume-family`, `use virtual-network-family`, `read instance-images`
- Deliberately omit `instance-console-connection`, `console-history`, `instance-agent-command-family`
- Cloud Guard detector rules for `CreateInstanceConsoleConnection`, `UpdateInstance` agent config changes

## First boot sequence

Identical on every cloud, after the firmware and shim/GRUB measured boot:

1. **Initramfs** opens the dm-verity root (hash on kernel command line, measured in PCR 8).
2. **`safebox-unseal.service`** checks for sealed blobs in the vTPM:
   - *First boot*: Finds the one blank disk ≥50 GB (no partition table, no filesystem), creates an encrypted ZFS pool (`safebox-pool`), generates the pool key and HMAC seed, seals both to the vTPM under PCR policy {0, 2, 4, 7, 8, 9, 14, 15}, extends PCR 15 to prevent late unseal.
   - *Subsequent boots*: Unseals the keys from the vTPM, imports the pool.
3. **`safebox-firstboot.service`** reads `safebox-id`, `owner-pubkey`, and `launch-authorization` from the cloud's metadata service, validates format, writes `dnsclient.json` to the pool.
4. **`safebox-dnsclient.service`** generates an Ed25519 identity, verifies the owner's signature, takes a vTPM quote, builds a signed `safebox_announce` OCP claim, publishes to the Safenet transparency log and DNS relays.
5. **Services start**: nginx (TLS on 443), the system component, Safenet, dnsclient (challenge listener on 8443).

## CI/CD pipeline

The GitHub Actions workflow at `.github/workflows/build-images.yml` automates multi-cloud image builds:

- **Trigger**: Push to `main` changing `Infrastructure/**`, or manual dispatch with cloud selection.
- **Matrix**: One job per cloud (aws, azure, gcp, oci), each setting up the cloud's CLI and credentials.
- **Build**: Runs `<cloud>/scripts/build-image.sh` with the appropriate flags.
- **Output**: Image ID captured and stored as a workflow artifact.
- **Post-build**: Cross-cloud integration tests if multiple clouds built successfully.

The test workflow at `.github/workflows/test-multicloud.yml` runs the cross-cloud integration tests against existing safebox endpoints.

## Cross-cloud integration tests

The `tests/multicloud/` directory contains three test suites:

1. **`test-peer-discovery.sh`** — Verifies that safeboxes on different clouds can discover each other via the `/api/peers` endpoint and that each box's attestation claim contains the required fields.

2. **`test-cross-attestation.sh`** — For each pair of safeboxes on different clouds, sends one's attestation claim to the other's `/api/verify` endpoint. Verifies that Ed25519 signature verification succeeds across clouds (the signature is cloud-neutral even though the underlying TPM quote format differs).

3. **`test-safenet-mesh.sh`** — Verifies that all nodes are registered in the Safenet registry, tests name claim propagation across clouds, and checks transparency log consistency.

## Image rotation

Safeboxes are immutable. A package update, a kernel patch, or a configuration change produces a new image with a new root hash. The rotation procedure is the same on every cloud:

1. Build a new image from a fresh build instance.
2. Publish the new root hash to Safenet peers and DNS relays.
3. Launch one test instance, confirm it announces and attests.
4. Run `tests/redteam/<cloud>.sh` against the new image.
5. Roll: launch new instances with fresh launch authorizations, migrate tenant data through application-level replication, terminate old instances.
6. Revoke the old root hash and delete old images.

Data does not migrate by reattaching disks: each instance's pool key is sealed to its own vTPM and its own image's PCR values. Reattaching an old data disk to a new-image instance makes it fail closed. Data moves through the application's own backup and replication (`scripts/backup.sh`, `scripts/replicate.sh`).

## Quick reference: per-cloud INSTRUCTIONS.md

Each cloud's `INSTRUCTIONS.md` is the complete operational runbook for that cloud:

- **`aws/INSTRUCTIONS.md`** — AMI build on Nitro instances, SCP lockdown, NitroTPM attestation.
- **`azure/INSTRUCTIONS.md`** — Compute Gallery image build, `azapi_resource` launch, Azure Policy deny rules, MAA attestation.
- **`gcp/INSTRUCTIONS.md`** — GCE image build, org-policy constraints, IAM deny policies, vTPM + SEV-SNP attestation.
- **`oci/INSTRUCTIONS.md`** — qcow2 image build, OCI custom image import, compartment policies, TPM + measured boot attestation, AMD SEV limitations.

The normative specification for what every safebox must be is `docs/HARDENING-PLAN.md`. This file and the per-cloud runbooks are the procedure.
