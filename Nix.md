# Building, sealing, and attesting the Safebox NixOS image on every cloud

This document describes exactly how the Safebox base image is built from Nix, how it is sealed (SSH removed, nondeterminism normalized) into a bootable cloud image, how that image is made available in each cloud's marketplace/custom-image system, and how each running instance attests itself and derives a unique per-instance identity from which private signing keys can be delegated. It covers AWS, GCP, Azure, Oracle (OCI), IBM Cloud, and Alibaba Cloud.

Companion: `Nix-turns.md` is the four-turn execution plan for making this real. This file is the *what and how*; that file is the *do it in four steps*.

## The shape of the whole thing

One pinned NixOS configuration (`nixos/flake.nix` + `nixos/modules/`) is the entire OS — not a layer on top of Amazon Linux or Ubuntu, but the distro itself, fixed by a single nixpkgs commit hash. From that one config we build a per-cloud disk image, boot it once as an SSH-ingress **builder**, run the deterministic **seal** that removes SSH and normalizes every source of nondeterminism, and register the sealed result as the image customers launch. Because the sealed image's contents are fixed by construction, its boot measurement (the PCR values a TPM records) is deterministic and reproducible: anyone can rebuild from the same commit, seal, and confirm they get the identical measurement. That reproducible measurement is what makes remote attestation meaningful — a verifier compares the instance's live PCRs against the measurement they independently computed from public source.

## Step-by-step: build → seal → publish → attest

### 1. Build the image from the pinned flake

`nix build .#<cloud>-builder` produces the SSH-ingress builder image in that cloud's disk format (AWS/GCP/Azure have native formats; Oracle/IBM/Alibaba use the portable qcow2 that each imports). Reproducibility comes from the pinned `nixpkgs` rev plus a committed `flake.lock`: the same inputs produce the same closure, every time, on any builder. This is the single most important property and the reason the base is Nix — `dnf install` pulls "whatever the mirror serves today," which can never attest reproducibly.

### 2. Boot the builder and seal it

The builder image's only ingress is SSH (declared in `nixos/hosts/ami1-builder.nix`). Boot it, then run `attestation/image-seal/seal-image.sh`, which: removes sshd, host keys, and login homes; empties machine-id; scrubs logs, caches, seeds, leases, cloud-init state, tmp, and shell histories; asserts that no remote-access agent (SSM, waagent, google-guest-agent, telnetd, etc.) is present; and normalizes every inode mtime to a fixed epoch — **excluding** `/nix/store`, whose paths are content-addressed and must keep their canonical timestamps or the closure hashes break. The result is a rootfs whose measurement is deterministic by construction, not by hoping the whole Nix closure happens to be bit-reproducible (it is only ~91%, which is not enough for a PCR). This is the "two-AMI" technique: the builder (AMI-1) is disposable; the sealed image (AMI-2) is the artifact. `attestation/image-seal/verify-ami2-reproduces.sh` seals two independent builds and diffs them to prove byte-identical output.

### 3. Register the sealed image as the bootable/marketplace image

Package the sealed rootfs into the cloud's image format and register it. For a private fleet this is a custom image; for distribution it is a marketplace listing. The per-cloud mechanics are in the table below. The registered image is immutable and content-addressed by its measurement — that is what a customer launches, and what they can attest.

### 4. Each instance attests and derives its unique identity

When a customer boots the image on a confidential-compute instance, the platform's TPM/vTPM records the boot measurements into PCRs. The instance requests an attestation document (signed by the platform's hardware root of trust) that contains those PCRs. A verifier checks: (a) the signature chains to the cloud's/AMD's/Intel's hardware root, proving it is genuine confidential hardware, and (b) the PCRs equal the reference measurement independently computed from the pinned source. Only then does the verifier release secrets or trust the box.

Crucially, **each instance's vTPM carries a unique Endorsement Key (EK)** burned/derived per instance. That per-instance unique key is the root from which the box derives further keys: an Attestation Key (AK) for signing quotes, and application signing keys that can be *sealed to the boot measurement* (released by the TPM only when the PCRs match the blessed image) and *delegated* downward. This is exactly the "each instance has its own unique thing, from which private signing keys can be derived/delegated" property — it is the standard TPM EK→AK→sealed-key hierarchy, and it means a signing key minted on a blessed box cannot be extracted to, or reproduced on, any other box. Safebox already uses this shape on AWS today (the ZFS key is TPM-sealed to the auditor policy via PolicyAuthorize); the migration generalizes it to every cloud's vTPM.

## Per-cloud specifics (build format, publish path, attestation, per-instance identity)

Every cloud below offers AMD SEV / SEV-SNP confidential VMs (AMD confirms all six as SEV adopters), so the confidential-compute substrate is uniform; what differs is the image format, the attestation service, and a few maturity caveats.

### AWS — the reference, already working

- **Build format:** `amazon` → AMI. **Publish:** import as a private AMI, or list on AWS Marketplace.
- **Attestation:** NitroTPM (measured boot into PCRs, signed by the Nitro Hypervisor) plus **EC2 instance attestation**, which went GA in September 2025. AWS publishes an official **Nix framework for building attestable, bit-reproducible AMIs** (`aws/nitrotpm-attestation-samples`) and a `nitro-tpm-pcr-compute` utility that computes the reference PCRs (PCR4/PCR7/PCR12) from the image's Unified Kernel Image at build time — this is a strong external validation that our exact approach (Nix + UKI + PCR reference) is the intended one.
- **Requirements our image must meet:** UEFI boot mode, Secure Boot, a TPM 2.0 CRB driver, and a UKI (which our `measured-boot.nix` lanzaboote setup produces). NitroTPM has no pre-built AMIs — you must configure your own, which is precisely what our flake does.
- **Per-instance identity:** NitroTPM per-instance keys, sealable to PCRs; integrates with KMS so key operations can be gated on attestation. We already use `/dev/nsm` for Nitro attestation docs today.

### GCP — Confidential VM + Shielded vTPM

- **Build format:** `gce` → GCE image (upload the tarball to a GCS bucket, register as a custom image). **Publish:** private image, or GCP Marketplace.
- **Attestation:** Confidential VM with vTPM. `go-tpm-tools` requests a hardware attestation report from the AMD Secure Processor (SEV-SNP) or Intel TDX module; the vTPM's PCRs are signed by an Attestation Key linked to the SEV-SNP report.
- **Per-instance identity:** each Shielded/Confidential VM has a unique vTPM EK, retrievable with `gcloud compute instances get-shielded-identity` (returns the per-instance EKPub and its cert). This lets a verifier confirm "this specific instance in this project/zone signed this," and is the delegation root for per-instance signing keys.

### Azure — Confidential VM + MAA

- **Build format:** `azure` → VHD → managed image. **Publish:** private image, or Azure Marketplace.
- **Attestation:** Confidential VM generates a SEV-SNP (or TDX) hardware report at boot, accessible through the vTPM; the report embeds the vTPM's public attestation key (AKPub), linking the vTPM PCR quotes to the hardware report. Microsoft Azure Attestation (MAA) is the verifier, or you verify the raw AMD report yourself. Relying parties (Azure Key Vault Premium/mHSM) release secrets via Secure Key Release gated on the attestation result.
- **Per-instance identity:** per-VM vTPM with AKPub captured in the hardware report; the vTPM state in VMGS is protected so keys sealed to it (LUKS, app signing keys) stay confidential to the guest.

### Oracle (OCI) — SEV-SNP with BYAS

- **Build format:** `qcow` → custom image import. **Publish:** private custom image, or OCI Marketplace.
- **Attestation:** newer E5/E6 shapes support **AMD SEV-SNP** with hardware-backed attestation and **Bring Your Own Attestation Service (BYAS)** — you run your own verifier, which fits Safebox's auditor model perfectly (the attestation service is *ours*, not the cloud's). Legacy E3/E4 shapes are SEV-only (memory encryption, no SNP attestation) — target E5/E6.
- **Honest caveat:** OCI **custom images do not support Secure Boot**. Our measured-boot chain depends on UEFI Secure Boot for a meaningful PCR7. On OCI we either rely on SEV-SNP attestation (which attests the launch measurement directly, independent of vTPM Secure Boot) or work with Oracle on a Secure-Boot-capable path. This is the one place the measured-boot story differs and must be validated on real E5/E6 hardware.
- **Per-instance identity:** per-VM key generated at VM creation, held in the AMD Secure Processor, inaccessible to guest/hypervisor/Oracle; SEV-SNP report is the per-instance attestation root.

### IBM Cloud — SEV-SNP confidential VMs

- **Build format:** `qcow`/`ova` → custom image import. **Publish:** private image, or IBM Cloud catalog.
- **Attestation:** IBM offers AMD SEV-SNP confidential VMs (AMD lists IBM as a SEV adopter). Attestation is via the SEV-SNP report from the AMD Secure Processor; verification through IBM's confidential-computing tooling or your own verifier.
- **Per-instance identity:** per-VM SEV key in the AMD Secure Processor; SEV-SNP report as the per-instance root. Validate the exact IBM image-import + attestation flow on IBM's specific confidential profiles.

### Alibaba Cloud — confidential VMs, region-gated

- **Build format:** `qcow`/`vhd` → custom image import. **Publish:** private image, or Alibaba Cloud Marketplace.
- **Attestation:** Alibaba offers confidential VMs with vTPM (AMD lists Alibaba as a SEV adopter; the e-vTPM literature lists Alibaba among vTPM-providing clouds). Confidential-compute and attestation availability is **region-limited**, so treat Alibaba as "runs the reproducible image everywhere; attests where the confidential hardware/region allows."
- **Per-instance identity:** per-VM vTPM/SEV key where confidential shapes are available.

## What is uniform vs what varies

Uniform across all six: the NixOS closure, the reproducible build, the seal (SSH removal + nondeterminism normalization), the two-AMI technique, the EK→AK→sealed-key per-instance identity model, and the AMD-SEV confidential substrate. Varies per cloud: the disk format (native for AWS/GCP/Azure, qcow2 import for OCI/IBM/Alibaba), the attestation verifier (Nitro/EC2-attestation, go-tpm-tools, MAA, BYAS, IBM tooling, Alibaba tooling — Safebox can and should run its *own* verifier everywhere, which BYAS explicitly blesses), and two real caveats: OCI custom images lack Secure Boot (rely on SEV-SNP launch attestation there), and Alibaba confidential availability is region-gated.

## Why this is the right architecture, in one paragraph

The image is reproducible because it is a pinned Nix closure; the sealed measurement is deterministic because the seal normalizes everything outside the content-addressed store; the attestation is meaningful because a verifier can independently recompute the reference measurement from public source and compare it to the hardware-signed PCRs; and each instance is uniquely identifiable and can hold non-exfiltratable signing keys because its vTPM EK is per-instance and keys can be sealed to the blessed measurement. That chain — reproducible build → deterministic seal → hardware attestation → per-instance sealed keys — is the same on every cloud, which is exactly why one NixOS config can serve all six while giving each instance its own cryptographic identity rooted in confidential hardware.
