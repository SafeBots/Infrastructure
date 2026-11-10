# OCI: Building and Deploying Safeboxes

Operational guide for building the safebox golden image on Ubuntu 24.04 LTS and launching production safeboxes from it on OCI. The normative specification is `docs/HARDENING-PLAN.md`; this document is the sequence of commands that implements it on OCI.

Production safeboxes have no shell, no SSH, no console connection and no cloud agent: a box that fails to boot or fails to announce is terminated and replaced from the image, never repaired in place.

## How the image is built

The image is not a snapshot of a configured instance. A throwaway Ubuntu 24.04 build instance assembles a fresh noble root filesystem in a chroot (`debootstrap`), runs the five component installers inside it (`common/base/install-base.sh` with the `linux-oracle` kernel flavour, then system, dnsclient, autovhost, safenet), removes every account and key, verifies the result, and writes it to a second, empty block volume as a read-only dm-verity root with a single measured GRUB entry. That volume is exported as qcow2, uploaded to Object Storage, and imported as a custom image with launch mode `UEFI_64`. The build instance itself is never captured.

The root hash of the verity tree is on the kernel command line and in the image's `roothash` freeform tag. It changes whenever any byte of the root filesystem changes, so a given image OCID corresponds to exactly one root hash, and a TPM quote from a running box proves which image booted.

## Prerequisites

- An OCI tenancy with a dedicated compartment for safebox resources (recommended: `safebox`), a VCN with a subnet that has outbound internet access, and an Object Storage bucket for image uploads.
- A build instance: `VM.Standard.E4.Flex` (4 OCPU, 16 GB is enough) from the current Canonical Ubuntu 24.04 platform image, in the same region as the bucket. It must be 24.04: the image is bootstrapped with `debootstrap` against the noble archive and verified with `ubuntu-keyring`, and the host's `grub-install`, `dracut`, and `veritysetup` must match the chroot's release. SSH access to the build instance is fine; it is discarded afterwards.
- A second block volume (50 GB, the OCI minimum; the image needs about 10 GB) attached to the build instance, paravirtualized, and left completely empty. This is `--target`. It must not be the boot volume.
- Host packages on the build instance: `sudo apt-get install -y debootstrap ubuntu-keyring gdisk e2fsprogs dosfstools cryptsetup-bin rsync grub-common python3 jq qemu-utils git` and the OCI CLI (`pip install oci-cli`), configured for a principal with the builder policy below.
- The repository: `git clone https://github.com/Safebots/Infrastructure.git`.
- The sha256 of the Node 22 tarball. Nothing is compiled during the build: the kernel is Canonical's signed `linux-oracle` flavour and the ZFS module ships, signed with the same key, in its `linux-modules-extra` package. The one digest the build needs is Node's, pinned as `NODE_SHA256` in `common/base/install-base.sh`; if it is still the placeholder, export `SAFEBOX_NODE_SHA256` with the `node-v<ver>-linux-x64.tar.xz` line from `https://nodejs.org/dist/v<ver>/SHASUMS256.txt` or pin it there before building.

IAM for the builder (a group `safebox-builders` in compartment `safebox`):

```
Allow group safebox-builders to manage instance-images in compartment safebox
Allow group safebox-builders to manage objects in compartment safebox where target.bucket.name='safebox-images'
Allow group safebox-builders to read buckets in compartment safebox
Allow group safebox-builders to read objectstorage-namespaces in tenancy
```

## Step 1: Build

On the build instance, as root, with the empty target volume attached (check `lsblk`; with consistent device naming it is `/dev/oracleoci/oraclevdb`, which resolves to `/dev/sdb`):

```bash
export OCI_COMPARTMENT_ID=ocid1.compartment.oc1..aaaa
export OCI_BUCKET=safebox-images
cd Infrastructure
sudo -E ./oci/scripts/build-image.sh --target /dev/sdb
```

Options: `--components base,system,dnsclient,autovhost,safenet` (default all five; `base` and `system` are mandatory), `--grub-password-hash <grub.pbkdf2.sha512...>` (default: a random passphrase that is generated and discarded; nobody is supposed to get past GRUB on a production box), `--rootfs /mnt/safebox-rootfs`, and `--no-capture` to stop after the verity disk is written.

The build takes 15 to 25 minutes, most of it `npm ci`. It stops on the first failed assertion of `common/image/verify-image.sh` (agent package present, unlocked account, login shell, setuid binary outside the allowlist, missing dracut module, GRUB without a password) and leaves the chroot at `--rootfs` for inspection.

On success it prints `ROOTHASH=<64 hex>` and `IMAGE_ID=<ocid>` and writes three files under `manifests/`: `oci-<date>.json` (image id, root hash, verity partition UUIDs, inventory hash, git commit), `oci-<date>-verity.json`, and `oci-<date>-inventory.json` (every package, user, enabled and masked unit in the image). Commit them.

## Step 2: What capture did

`build-image.sh` runs these commands; they are listed so an auditor can check them and so a capture can be redone from the `--no-capture` disk by hand:

```bash
qemu-img convert -f raw -O qcow2 -c -p /dev/sdb safebox-<date>-<roothash8>.qcow2
oci os object put --bucket-name safebox-images --name safebox-<date>-<roothash8>.qcow2 --file safebox-<date>-<roothash8>.qcow2
oci compute image import from-object \
  --compartment-id "$OCI_COMPARTMENT_ID" --bucket-name safebox-images --namespace "$(oci os ns get --query data --raw-output)" \
  --name safebox-<date>-<roothash8>.qcow2 --display-name safebox-<date>-<roothash8> \
  --launch-mode UEFI_64 --source-image-type QCOW2 \
  --operating-system "Canonical Ubuntu" --operating-system-version 24.04
oci compute image get --image-id <image-ocid> --wait-for-state AVAILABLE
oci compute image update --image-id <image-ocid> --freeform-tags '{"roothash":"<roothash>"}'
oci compute image-shape-compatibility-entry add --image-id <image-ocid> --shape-name VM.Standard.E4.Flex
oci compute image-shape-compatibility-entry add --image-id <image-ocid> --shape-name VM.Standard.E5.Flex
```

`--launch-mode UEFI_64` is what makes shielded launches possible: Secure Boot, measured boot and the vTPM are properties of the launch (`platform_config`), but OCI only offers them for images in UEFI launch mode on shapes listed as compatible. OCI's Secure Boot validates against the Microsoft UEFI CA, which signs Ubuntu's `shim-signed` in the image; shim trusts Canonical's key, which signs GRUB, the `linux-oracle` kernel and its ZFS module, so no custom keys are enrolled and the stock signed chain boots as-is.

## Step 3: Prepare the owner key and launch authorization

Each launch needs the owner's Ed25519 public key and a signed launch-authorization claim. The owner generates a keypair once (the public half is `owner-pubkey`, 64 hex characters); for each launch, the owner signs a `launch_authorization` OCP claim naming the `safeboxId`, the `ownerPubkey`, and a validity window (at most 24 hours). Sign the authorization immediately before `terraform apply`, since its window is short-lived.

The box verifies the owner's signature on first boot, and every Safenet peer and DNS relay verifies it again when the announce arrives. Export both as `TF_VAR_owner_pubkey` and `TF_VAR_launch_authorization`; do not write them to a file.

## Step 4: Launch with Terraform

```bash
cd Infrastructure/oci/terraform
export TF_VAR_owner_pubkey=<owner public key hex>
export TF_VAR_launch_authorization=<base64 signed claim>
terraform init
terraform apply \
  -var image_id=<image-ocid> \
  -var compartment_id=ocid1.compartment.oc1..aaaa \
  -var subnet_id=ocid1.subnet.oc1.iad.aaaa \
  -var safebox_id=prod-001
```

The module launches a `VM.Standard.E4.Flex` shielded instance with `platform_config { is_secure_boot_enabled, is_measured_boot_enabled, is_trusted_platform_module_enabled }` all true, `agent_config` with every plugin disabled and management and monitoring off, `instance_options { are_legacy_imds_endpoints_disabled = true }`, paravirtualized boot and network with in-transit encryption, a 200 GB empty block volume at 20 VPU/GB, and an NSG that admits only TCP 443 and 8443, plus 80 when `allow_http = true` (default false; custom domains need it, since autovhost's ACME HTTP-01 validation runs over port 80 until TLS-ALPN-01 lands). The metadata map is exactly `safebox-id`, `owner-pubkey` and `launch-authorization`; there is no `ssh_authorized_keys`, no `user_data`, and no `dns_api_url` input (the DNS relay and Safenet log URLs are baked into the image at `/etc/safebox/defaults.json`; to change them, rebuild). `image_id` must be an image OCID of the form `ocid1.image.oc1.<region>.<unique>`; the variable rejects display names and lookups so the launch is tied to a recorded root hash. AMD memory encryption is on by default (`skip_memory_encryption` defaults to false, `confidential_compute_type` defaults to `"SEV_SNP"`). Because plain SEV yields no guest attestation report the default image refuses to announce (`MEMORY_NOT_ENCRYPTED`) unless the shape provides SEV-SNP or TDX or the image was built with `allowUnencryptedMemory`. `allow_http` gates only the NSG rule for port 80; the host's own nftables input chain always accepts TCP 80 because nginx binds it for ACME HTTP-01.

## Confidential compute (AMD SEV / SEV-SNP)

### Current state: plain AMD SEV only

OCI's E4 and E5 Flex shapes support AMD SEV (Secure Encrypted Virtualization), which encrypts VM memory with per-VM keys managed by the AMD Secure Processor. Memory encryption is on by default (`skip_memory_encryption` defaults to false).

Plain SEV does **not** produce a guest attestation report. The hardware encrypts memory, but the guest cannot prove to a remote verifier that it is running inside an encrypted VM. The safebox image's attestation client checks for a signed attestation report; when none is available, the image refuses to announce (`MEMORY_NOT_ENCRYPTED`) unless it was built with `allowUnencryptedMemory`.

**For production on OCI today**, build the image with `--allow-unencrypted-memory` (memory encryption is already on by default). This is the recommended posture. The image contents are open-source code on a dm-verity root — every byte is publicly hashed and auditable, so there is nothing in the image itself that benefits from memory encryption. What SEV protects is the runtime state: the private keys generated on first boot, the ZFS pool encryption keys sealed to the TPM, and the plaintext of tenant data in the Node.js heap. With memory encryption on (the default), a hypervisor-level attacker (rogue cloud employee, compromised firmware) cannot read the VM's RAM.

What you do not get until OCI ships SEV-SNP is proof to a remote verifier that memory encryption is actually on. The safebox asserts it is encrypted, and OCI's API confirms the launch configuration requested SEV, but there is no hardware-signed attestation report from AMD's Secure Processor the way AWS, Azure and GCP provide. You are trusting OCI's infrastructure to honour the flag — reasonable for a feature they sell and operate, but not the same as a cryptographic proof. When SEV-SNP shapes land (see below), rebuild without `--allow-unencrypted-memory` and the full attestation chain closes.

### Future: SEV-SNP on OCI

AMD SEV-SNP (Secure Nested Paging) adds guest attestation: the AMD Secure Processor signs a VCEK attestation report that a remote verifier can check against AMD's published root certificates, proving the VM runs with encrypted memory on genuine AMD hardware. This matches what Azure and GCP already provide.

When OCI ships SEV-SNP-capable shapes:

1. Check shape capabilities:
   ```bash
   oci compute shape list --compartment-id <compartment-ocid> \
     --query "data[?contains(name, 'SEV_SNP') || contains(\"platform-config-options\".\"secure-boot-options\".\"allowed-values\", 'SEV_SNP')]"
   ```

2. Update the Terraform module:
   - Set `confidential_compute_type = "SEV_SNP"` in your `.tfvars`
   - Update the `platform_config_type` map in `main.tf` locals: change the `"SEV_SNP"` entry from `"AMD_VM"` to `"AMD_VM_SEV_SNP"` (the OCI provider's type name for SEV-SNP shapes)
   - Use an SEV-SNP-capable shape (replace the default `VM.Standard.E4.Flex`)

3. Update the attestation client (`oci/scripts/components/system/ociAttestationClient.js`) to fetch and verify the VCEK report from `/dev/sev-guest` or the OCI IMDS attestation endpoint.

4. Rebuild the image without `--allow-unencrypted-memory` — the attestation client can now verify the SEV-SNP report.

### Terraform variables

| Variable | Type | Default | Meaning |
|---|---|---|---|
| `skip_memory_encryption` | bool | `false` | Set true to disable AMD memory encryption. Default (false) enables it for production. |
| `confidential_compute_type` | string | `"SEV_SNP"` | `SEV_SNP` (default), `SEV` (fallback for shapes without SNP), or `NONE` (dev/test only). Controls platform_config type and the encryption level. When set to `NONE`, memory encryption is forced off regardless of `skip_memory_encryption`. |

## Step 5: Cloud-level policy against consoles, agents and run commands

The on-image measures hold on their own (no getty, GRUB password, verity root, sealed keys), but the cloud account should also refuse the operations that would try to get in. OCI IAM is allow-only, so the policy is written by granting the operations group what it needs and omitting the console connection resource type.

### Option A: Terraform-managed (recommended)

Set `manage_deny_policies = true` in the module call and provide `tenancy_id` and `ops_group_name`. The module creates the compartment policy as a Terraform resource, so it is tracked in state and visible in `terraform plan`. The applying principal needs manage-policies permission on the tenancy.

```hcl
module "safebox" {
  source = "./oci/terraform"
  # ... other variables ...
  manage_deny_policies = true
  tenancy_id           = "ocid1.tenancy.oc1..aaaa"
  ops_group_name       = "safebox-ops"
}
```

### Option B: Manual OCI CLI

If you prefer to manage policies outside Terraform, create a dedicated compartment and give the operations group these statements, and only these:

```bash
oci iam policy create --compartment-id <tenancy-or-parent-ocid> --name safebox-ops --description "Safebox operations: no console connections" \
  --statements '[
    "Allow group safebox-ops to manage instances in compartment safebox",
    "Allow group safebox-ops to manage volume-family in compartment safebox",
    "Allow group safebox-ops to use virtual-network-family in compartment safebox",
    "Allow group safebox-ops to read instance-images in compartment safebox"
  ]'
```

### Why these specific grants (both options)

`instance-console-connection` is deliberately absent, so `oci compute instance-console-connection create` fails with `NotAuthorizedOrNotFound` for this group. Do not use `Allow group safebox-ops to manage instance-family`: the `instance-family` aggregate includes `instance-console-connection`, `console-history` and `instance-agent-command-family`, which is exactly the set we are keeping out. The same reasoning excludes `bastion-family`: a managed-SSH Bastion session needs the agent's Bastion plugin, which is disabled and absent from the image, but there is no reason to let the group create one.

Enable Cloud Guard at the tenancy level with a detector rule that alerts on `CreateInstanceConsoleConnection`, `UpdateInstance` events that change `agentConfig`, and `CreateInstanceAgentCommand` in the safebox compartment. Any such event in production is either a mistake or an incident.

## Step 6: First boot and verification

There is nothing to log in to. The first boot runs, in order: shim and GRUB measure the command line and kernel into the vTPM; the initramfs opens the verity root, finds the one blank disk of at least 50 GB, creates the encrypted pool, seals the pool key and the HMAC seed to PCRs 0, 2, 4, 7, 8, 9, 14 and 15, and extends PCR 15 so nothing after the initramfs can unseal again; `safebox-firstboot.service` reads the three metadata keys (`safebox-id`, `owner-pubkey`, `launch-authorization`) from `/opc/v2/instance/metadata/` and writes `dnsclient.json` on the pool; `safebox-dnsclient.service` generates the Ed25519 identity, verifies the owner's signature on the launch authorization, obtains a TPM quote, builds a signed `safebox_announce` OCP claim, and publishes it to the Safenet transparency log and the DNS relays.

Verify from the outside:

1. The announce appears in the Safenet transparency log for the safebox id. This is the proof that the box booted the blessed image: Safenet peers and DNS relays reject a quote whose PCR 8 and 9 do not match the image's command line, kernel and initramfs.
2. The attested health endpoint the control plane exposes for the box reports healthy, and the box answers on 8443 (`curl -s -o /dev/null -w '%{http_code}' http://<public-ip>:8443/` returns 404, which is dnsclient's answer to anything but a valid challenge path). dnsclient opens 8443 only after registration succeeds; before that, port 443 answering with the autovhost splash is the only sign of life.
3. `oci compute instance get --instance-id <ocid>` shows `"are-legacy-imds-endpoints-disabled": true`, `"is-secure-boot-enabled": true`, `"is-measured-boot-enabled": true`, `"is-trusted-platform-module-enabled": true`, and `"are-all-plugins-disabled": true`.

Then run the red team script against the image before putting it into production: `tests/redteam/oci.sh <image-ocid>` launches throwaway instances and attempts every vector in the hardening plan.

## Troubleshooting

Every failure mode is diagnosed from outside the box, because there is no inside.

The announce never appears and the box does not answer on 443 within 10 minutes: the boot failed closed. Causes, most likely first: the data volume was not empty or is smaller than 50 GB (the initramfs refuses to pick a disk that has a partition table or a filesystem signature); the instance was launched without the vTPM (`platform_config` missing or the shape not shielded-capable; the unseal unit requires `/dev/tpmrm0`); the image was imported without `--launch-mode UEFI_64`. The serial console output is visible read-only in the OCI console under the instance's "Console history" (`oci compute console-history capture`); the initramfs logs `safebox-unseal: FATAL: <reason>` to it. Fix the launch parameters and relaunch; do not try to repair the instance.

The announce never appears but 443 answers: the box booted but did not announce. The launch authorization's validity window expired, its signature does not match the owner pubkey, or the `safeboxId` in the claim does not match the metadata key; or `safebox-id` failed validation (`^[a-z0-9-]{3,64}$`). Terminate, sign a new launch authorization, relaunch. There is no way to hand a new authorization to a running box, by design.

Announce rejected with a PCR mismatch: the box is not running the blessed image. Either the image OCID in Terraform is stale, or something changed the boot path. Treat as an incident; do not whitelist the new values.

The build fails in `verify-image.sh`: the message names the assertion. The most common are a package that pulled in `openssh-client` as a dependency (check the apt pins in `common/base/install-base.sh` and the inventory), and a setuid binary added by a new package (extend the `chmod u-s` loop, never the allowlist).

`debootstrap` fails verifying the noble Release file: the build host is missing `ubuntu-keyring`, or is not Ubuntu 24.04.

The initramfs logs `zfs: module verification failed` or `Key was rejected by service`: the ZFS module in the image is not the Canonical-signed one. This happens only if a kernel flavour other than `linux-oracle` was installed or `zfs-dkms` built a local module; `install-base.sh` refuses both, so treat it as a broken build and rebuild from a clean checkout rather than enrolling a MOK.

## Image rotation

A running safebox never changes: package operations are not on its privileged surface and the root is read-only. A fix, a package update, or a kernel update is a new image.

1. Change the pins in `common/base/install-base.sh` (package versions, the Node digest) or the component sources.
2. Build on a fresh build instance (Step 1). Commit the new `manifests/oci-<date>*.json`.
3. Publish the new root hash so Safenet peers and DNS relays accept announces from the new image.
4. Run `tests/redteam/oci.sh <new-image-ocid>`.
5. For each production safebox: launch a new instance from the new image with a new, empty data volume and a fresh launch authorization (a new `safebox_id`, or the old one after the previous box's key is revoked), verify the announce appears, migrate tenant data through the application's own replication, then terminate the old instance and delete its volumes. The old data volume cannot be carried over: its pool key is sealed to the old boot volume's blobs and the old boot's PCR values, and the initramfs only adopts a disk with no ZFS signature, so a reattached old volume makes the new box fail closed.
6. After every box is on the new image, revoke the old root hash from the accepted set and delete the old image (`oci compute image delete`).

Do not run `apt-get upgrade` anywhere but in a new build. Do not attach a running safebox's boot volume to anything.
