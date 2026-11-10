# Turn 3 runbook: verify attestation on real confidential hardware, per cloud

Turn 3 is the one turn that cannot run in CI — it requires a real confidential-compute instance per cloud. This runbook is the exact sequence to execute it once you have Nix (Turn 1 done) and cloud access. It does NOT run here; nothing in this repo can produce a real attestation document. Run these on a machine with Nix + the relevant cloud CLI.

## Prerequisites (from Turns 1–2)

- Turn 1 done: `flake.lock` committed, `nix build .#<cloud>-builder` produces an image.
- Turn 2 done: `nixos/PARITY.md` confirms base parity.
- Per cloud: an account with permission to import a custom image and launch a confidential-compute instance, and the cloud CLI installed (`aws`, `gcloud`, `az`, `oci`, `ibmcloud`, `aliyun`).

## The three checks, every cloud

For each cloud you are proving exactly three things:
1. **Boots + networks** — the sealed image comes up and reaches the network.
2. **Valid attestation** — the vTPM / SEV-SNP report is produced and its signature chains to the hardware root of trust (proving genuine confidential hardware).
3. **PCRs match reference** — the live boot measurements equal the reference measurement you independently computed from the pinned source (proving it is the blessed image, unmodified).

Do them in maturity order: AWS → GCP → Azure → OCI → IBM → Alibaba.

## Per-cloud sequence

### AWS (reference — lowest risk, we already attest here)

```
# 1. Build + seal (Turn 1 output), then register as an AMI.
nix build .#ami-builder
# boot the builder, run the seal, snapshot -> register-image (UEFI, TPM 2.0, Secure Boot on):
aws ec2 register-image --name safebox-attested-<date> --boot-mode uefi \
    --tpm-support v2.0 --uefi-data <secure-boot-blob> --architecture x86_64 \
    --root-device-name /dev/xvda --block-device-mappings <sealed-snapshot>

# 2. Compute the REFERENCE PCRs from the image's UKI (AWS's own tool):
nitro-tpm-pcr-compute --image /path/to/UKI.efi
#   -> {"PCR4":..., "PCR7":..., "PCR12":...}   <-- save this as the reference

# 3. Launch a NitroTPM instance from the AMI, then on the instance read the
#    live attestation document and compare PCR4/7/12 to the reference above.
#    (Safebox already uses /dev/nsm for Nitro attestation docs; the dnsclient
#    path is the working example to generalize.)
```
Pass = attestation doc's PCR4/7/12 equal the `nitro-tpm-pcr-compute` reference, and the doc's signature verifies against the AWS Nitro root.

### GCP (Confidential VM + Shielded vTPM)

```
nix build .#gce-builder    # -> raw.tar.gz; upload to GCS, create custom image
gcloud compute images create safebox-attested-<date> --source-uri gs://<bucket>/<image>.tar.gz

# Launch a Confidential VM with vTPM + secure boot:
gcloud compute instances create sb1 --image safebox-attested-<date> \
    --confidential-compute --shielded-secure-boot --shielded-vtpm \
    --shielded-integrity-monitoring --machine-type n2d-standard-2 \
    --min-cpu-platform="AMD Milan"

# Per-instance identity (the unique EK):
gcloud compute instances get-shielded-identity sb1    # -> ekPub/ekCert

# On the instance, use go-tpm-tools to get the attestation + SEV-SNP report:
#   go-tpm-tools/gotpm attest ...   -> vTPM quote signed by AK, linked to SEV-SNP
```
Pass = go-tpm-tools attestation verifies, SEV-SNP report chains to AMD root, PCRs match reference.

### Azure (Confidential VM + MAA)

```
nix build .#azure-builder   # -> VHD; upload to a storage account, create managed image
az image create -g <rg> -n safebox-attested-<date> --source <vhd-uri> --hyper-v-generation V2

# Launch a Confidential VM (DCa*/ECa* SKU, SEV-SNP):
az vm create -g <rg> -n sb1 --image safebox-attested-<date> \
    --security-type ConfidentialVM \
    --os-disk-security-encryption-type DiskWithVMGuestState --enable-vtpm true \
    --size Standard_DC2as_v5

# On the instance: guest attestation lib -> SEV-SNP report (embeds vTPM AKPub);
# verify with Microsoft Azure Attestation (MAA) or verify the raw AMD report.
```
Pass = MAA returns a positive attestation (or raw SEV-SNP verifies), PCRs match reference.

### Oracle OCI (SEV-SNP + BYAS — note the Secure Boot caveat)

```
nix build .#oci-builder    # -> qcow2; import as a custom image
oci compute image import from-object-storage ...
# IMPORTANT: OCI custom images do NOT support Secure Boot. So PCR7 (secure-boot
# state) is not available; rely on the SEV-SNP LAUNCH measurement instead, which
# attests the initial image directly, independent of vTPM Secure Boot.

# Launch on an E5/E6 shape with confidential computing enabled (SEV-SNP):
oci compute instance launch --shape VM.Standard.E5.Flex \
    --is-confidential-computing-enabled true ...

# Use Bring-Your-Own-Attestation-Service (BYAS): run YOUR verifier (fits the
# Safebox auditor model — the attestation service is ours), check the SEV-SNP
# report's launch measurement against the reference computed from source.
```
Pass = SEV-SNP launch measurement equals reference, report chains to AMD root. (No PCR7; documented deviation.)

### IBM Cloud (SEV-SNP)

```
nix build .#ibm-builder    # -> qcow2; import as a custom image
ibmcloud is image-create safebox-attested-<date> --file <cos-uri> ...
# Launch a confidential (SEV-SNP) profile instance, then retrieve the SEV-SNP
# report from the AMD Secure Processor and verify against reference + AMD root.
```
Pass = SEV-SNP report verifies, launch measurement matches reference. Confirm IBM's exact confidential profile names at run time.

### Alibaba (region-gated confidential)

```
nix build .#alibaba-builder    # -> qcow2/vhd; import as a custom image
aliyun ecs ImportImage ...
# Launch a confidential VM in a region/instance-family that supports it
# (availability is region-limited — confirm first). Retrieve vTPM/SEV report,
# verify against reference.
```
Pass where confidential shapes exist; otherwise record "image boots; attestation pending confidential availability in region."

## Recording results

For each cloud, capture: the reference measurement (from source), the live attestation document, PASS/FAIL on each of the three checks, and any deviation (OCI Secure Boot, Alibaba region). Anything that fails because a kernel module or agent is missing gets added to the flake declaratively and re-tested — that is the loop, and it leaves a better-documented base than any vendor image because every dependency becomes explicit.

## What "Turn 3 done" means

All target clouds show: boots + networks, attestation verifies to the hardware root, and PCRs/launch-measurement match the source-derived reference — with the two known deviations (OCI Secure Boot → SEV-SNP launch attestation; Alibaba → region-gated) documented rather than hand-waved. At that point the reproducible image is proven attesting, and Turn 4 wires it into one pipeline.
