# GCP: Building and Deploying Safeboxes

Operational guide for building the Safebox GCE image (Ubuntu 24.04 LTS, noble, on a dm-verity root with a TPM-sealed ZFS pool) and launching production safeboxes from it. The normative description of what the image is and why is `docs/HARDENING-PLAN.md`; this file is the procedure.

A production safebox has no shell and no console: there is no sshd, no guest agent, no OS Login, no getty, no serial console, and no rescue target, and a box that fails to boot or fails to announce is replaced from the image, not repaired.

## Prerequisites

Use a project dedicated to safeboxes. The org-policy constraints and the IAM deny policy in "Project policy" below apply to the whole project, and nothing else should run under them.

The build VM is an ordinary Ubuntu 24.04 LTS instance with a Shielded VM configuration. It must be 24.04: the image is bootstrapped with `debootstrap` against the noble archive and verified with `ubuntu-keyring`, and keeping host and chroot on the same release keeps `grub-install`, `dracut`, and `veritysetup` compatible. It is never captured; it only hosts the chroot and the target disk. It needs outbound HTTPS to `archive.ubuntu.com` (or the GCE mirror), `nodejs.org`, `registry.npmjs.org` and `www.gstatic.com`, and the following host packages: `debootstrap ubuntu-keyring gdisk dosfstools e2fsprogs cryptsetup-bin rsync python3 jq grub-common sudo dracut-core google-cloud-cli`.

```bash
ZONE=us-central1-a
PROJECT=my-safebox-project

gcloud compute instances create safebox-build \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type=n2-standard-4 \
  --image-project=ubuntu-os-cloud --image-family=ubuntu-2404-lts-amd64 \
  --boot-disk-size=40GB --boot-disk-type=pd-ssd \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --scopes=compute-rw \
  --metadata=enable-oslogin=TRUE

# The target disk: empty, becomes the image. 10 GB is enough for the
# verity root (ESP 512 MB + /boot 1 GB + root ~4-6 GB + hash tree).
gcloud compute disks create safebox-target \
  --project="$PROJECT" --zone="$ZONE" --size=10GB --type=pd-ssd
gcloud compute instances attach-disk safebox-build \
  --project="$PROJECT" --zone="$ZONE" \
  --disk=safebox-target --device-name=safebox-target

gcloud compute ssh safebox-build --project="$PROJECT" --zone="$ZONE"
sudo apt-get update && sudo apt-get install -y debootstrap ubuntu-keyring gdisk dosfstools \
  e2fsprogs cryptsetup-bin rsync python3 jq grub-common sudo dracut-core
```

The build VM's service account needs `compute.disks.use`, `compute.images.create`, `compute.images.get` and `compute.instances.detachDisk` on the project (`roles/compute.storageAdmin` plus `roles/compute.instanceAdmin.v1` on the build VM is the simplest grant). The `compute-rw` scope lets `gcloud` on the VM use the service account without a key file.

The device name given at attach time is what the build script uses: the disk appears as `/dev/disk/by-id/google-safebox-target`, and the script derives the GCE disk name `safebox-target` from that path for the capture step.

## Build

```bash
git clone https://github.com/Safebots/Infrastructure.git
cd Infrastructure

# Node 22 is installed from the nodejs.org tarball; the digest must be pinned.
# Take the line for node-v<ver>-linux-x64.tar.xz from
# https://nodejs.org/dist/v<ver>/SHASUMS256.txt (the version is at the top of
# common/base/install-base.sh) and either edit NODE_SHA256
# there or export it:
export SAFEBOX_NODE_SHA256=<sha256>

sudo -E ./gcp/scripts/build-image.sh --target /dev/disk/by-id/google-safebox-target
```

Options: `--components base,system,dnsclient,autovhost,safenet` (default all five; `base` and `system` are mandatory), `--grub-password-hash <grub.pbkdf2.sha512...>` (default: a random passphrase hashed by `common/image/make-grub-password.sh` and discarded), `--rootfs /mnt/safebox-rootfs`, `--no-capture`, `--zone`, `--project`, `--image-family safebox`.

The script runs, in order: `debootstrap` of a minimal noble root; the five installers inside a chroot (`common/base/install-base.sh` with the `linux-gcp` kernel flavour, then system, dnsclient, autovhost, safenet) with the repository bind-mounted read-only at `/opt/safebox-src`; `common/image/cleanup-image.sh` and `common/image/verify-image.sh` from the host against the rootfs (the build stops on any assertion); `common/image/build-verity-root.sh`, which partitions the target disk, writes the root as a dm-verity volume, installs the signed shim and GRUB with the superuser password and the measured command line, and prints the root hash; then the capture step. It writes `manifests/gcp-<date>.json` with the image id, the root hash, the verity manifest, the inventory digest and the git commit.

Package versions are pinned in `common/base/install-base.sh` through `/etc/apt/preferences.d/safebox` in the image: each package is pinned to the version noble ships (priority 1001), and every package that must never exist on the box (sshd, cloud-init, the Google agents, initramfs-tools, snapd, unattended-upgrades, ubuntu-advantage-tools and the rest) is pinned to -1 so apt refuses to install it even as a dependency. Docker is Ubuntu's `docker.io`, chosen over docker-ce to avoid a second third-party repository. The kernel is Canonical's signed `linux-gcp` flavour; the ZFS module ships signed in its `linux-modules-extra` package, so nothing is compiled and nothing needs a Machine Owner Key. The exact versions installed are recorded in `/opt/safebox/manifests/base.json` on the image and in the inventory next to the manifest.

A build takes 15 to 25 minutes, most of it `npm ci`; there is no ZFS compile. The rootfs directory is left in place on failure for inspection and can be deleted after a successful build.

## Capture

`build-image.sh` performs the capture unless `--no-capture` is given. It detaches the target disk from the build VM (so the image is taken from a closed device) and runs the equivalent of:

```bash
gcloud compute images create safebox-<YYYYMMDD>-<roothash8> \
  --project="$PROJECT" \
  --source-disk=safebox-target --source-disk-zone="$ZONE" \
  --family=safebox \
  --guest-os-features=UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE,GVNIC,SEV_SNP_CAPABLE \
  --labels=roothash-a=<first 32 hex>,roothash-b=<last 32 hex>,safebox=image \
  --description="safebox verity root; roothash=<64 hex>"
```

`UEFI_COMPATIBLE` is the flag that makes the image launchable as a Shielded VM with Secure Boot and a vTPM. Shielded VM firmware trusts the Microsoft UEFI CA, which signs Ubuntu's shim; shim in turn trusts Canonical's key, which signs GRUB, the kernel and the ZFS module, so no custom Secure Boot keys are enrolled. `SEV_SNP_CAPABLE` allows the same image to launch as a Confidential VM. The root hash is split across two labels because a GCE label value is limited to 63 characters; the full hash is in the description and in `manifests/gcp-<date>.json`.

To capture by hand after `--no-capture`, detach the disk first (`gcloud compute instances detach-disk safebox-build --disk=safebox-target`) and run the command above, or add `--force` to image an attached disk. The target disk can be deleted once the image exists; the build VM can be deleted or kept for the next build.

## Preparing the owner key and launch authorization

Every launch needs the owner's Ed25519 public key and a signed launch-authorization claim. The owner generates a keypair once (the public half is `owner-pubkey`, 64 hex characters); for each launch, the owner signs a `launch_authorization` OCP claim that names the `safeboxId`, the `ownerPubkey`, and a validity window (at most 24 hours). Sign the authorization immediately before `terraform apply`, since its window is short-lived.

The box verifies the owner's signature on first boot and every Safenet peer and DNS relay verifies it again when the announce arrives. Pass both values to Terraform through `TF_VAR_owner_pubkey` and `TF_VAR_launch_authorization`; never write them into a `.tfvars` file that is committed.

## Launch

```hcl
module "safebox" {
  source = "./gcp/terraform"

  image_self_link    = "projects/my-safebox-project/global/images/safebox-20260101-0a1b2c3d"
  project_id         = "my-safebox-project"
  zone               = "us-central1-a"
  safebox_id         = "prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization
  # skip_confidential_compute = true   # set true to disable SEV-SNP (on by default); requires an n2d machine_type when enabled. The default image refuses to announce without an SEV-SNP report unless built with allowUnencryptedMemory.
  # allow_http                  = true   # port 80 for autovhost ACME HTTP-01
}
```

```bash
export TF_VAR_owner_pubkey=<owner public key hex>
export TF_VAR_launch_authorization=<base64 signed claim>
terraform init
terraform apply
```

The module creates the firewall rule (443 and 8443, plus 80 when `allow_http = true`; custom domains need it, since autovhost's ACME HTTP-01 validation runs over port 80 until TLS-ALPN-01 lands), an empty 200 GB pd-ssd data disk, a service account with only `logging-write` and `monitoring-write`, and the instance with Secure Boot, vTPM and integrity monitoring on, `serial-port-enable=FALSE`, `serial-port-logging-enable=FALSE`, `enable-oslogin=FALSE`, `block-project-ssh-keys=TRUE`, and the three first-boot metadata keys `safebox-id`, `owner-pubkey` and `launch-authorization`. There is no startup script, no `ignore_changes`, and no `dns_api_url` input: the DNS relay and Safenet log URLs are baked into the image at `/etc/safebox/defaults.json` and changing them means a rebuild. `allow_http` gates only the VPC firewall rule; the host's own nftables input chain always accepts TCP 80 because nginx binds it for ACME.

`image_self_link` must name one image, `projects/<project>/global/images/<name>`. The variable rejects `projects/<project>/global/images/family/safebox` on purpose: a family resolves to whichever image was pushed to it last, so anyone who can add an image to the family (or a mistake in a build) would change what every future `terraform apply` launches without any change to the Terraform configuration or state, and the root hash in the manifest would no longer say anything about the running box. The build script still tags images with `--family safebox` so operators can browse them with `gcloud compute images describe-from-family`; copy the named image from the manifest into `image_self_link`.

## Project policy

The instance-level settings stop mistakes; the project-level constraints stop an operator with instance admin rights from undoing them. Apply all three to the dedicated project.

### Option A: Terraform-managed (recommended)

Set `manage_deny_policies = true` in the module call and provide `project_number` and `deploy_service_account_email`. The module creates the three org-policy constraints and the IAM deny policy as Terraform resources, so they are tracked in state and visible in `terraform plan`. The applying principal needs the Organization Policy Administrator and IAM Deny Admin roles on the project.

```hcl
module "safebox" {
  source = "./gcp/terraform"
  # ... other variables ...
  manage_deny_policies           = true
  project_number                 = "123456789012"
  deploy_service_account_email   = "safebox-deploy@my-safebox-project.iam.gserviceaccount.com"
}
```

### Option B: Manual gcloud commands

If you prefer to manage policies outside Terraform (for example, at organization scope rather than project scope), apply the three constraints and the deny policy by hand:

```bash
gcloud resource-manager org-policies enable-enforce compute.disableSerialPortAccess  --project="$PROJECT"
gcloud resource-manager org-policies enable-enforce compute.disableSerialPortLogging --project="$PROJECT"
gcloud resource-manager org-policies enable-enforce compute.requireShieldedVm        --project="$PROJECT"
```

`compute.requireOsLogin` is not needed: the image has no sshd and no OS Login agent, so there is nothing for OS Login to govern either way.

Instance metadata is the only input channel the box reads, so restrict who can write it. An IAM deny policy that denies `compute.instances.setMetadata` to every principal except the deploy service account keeps a compromised operator account from swapping `launch-authorization` or adding keys the box ignores anyway:

```bash
cat > deny-metadata.json <<EOF
{
  "displayName": "safebox: only the deploy SA may set instance metadata",
  "rules": [{
    "denyRule": {
      "deniedPrincipals": ["principalSet://goog/public:all"],
      "exceptionPrincipals": ["principal://iam.googleapis.com/projects/-/serviceAccounts/safebox-deploy@${PROJECT}.iam.gserviceaccount.com"],
      "deniedPermissions": ["compute.googleapis.com/instances.setMetadata"]
    }
  }]
}
EOF
gcloud iam policies create safebox-deny-metadata \
  --attachment-point="cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}" \
  --kind=denypolicies --policy-file=deny-metadata.json
```

### Deploy service account (both options)

Use a dedicated deploy service account for `terraform apply`, grant it `roles/compute.instanceAdmin.v1`, `roles/compute.imageUser` and `roles/iam.serviceAccountUser` on the project, and give humans `roles/compute.viewer`.

## What to expect on first boot

Nothing is visible from the console, because there is none. The sequence inside the box is: firmware and shim, GRUB (measures the command line into PCR 8 and the kernel and initramfs into PCR 9), the initramfs opens the verity root and `safebox-unseal.service` finds no sealed blobs, generates the pool key and the HMAC seed, creates `safebox-pool` on the empty data disk, seals both keys to the vTPM under the PCR policy, extends PCR 15 so nothing later in the boot can unseal them again, and switches root. `safebox-firstboot.service` reads `safebox-id`, `owner-pubkey` and `launch-authorization` from the metadata server, validates their format and writes `/var/lib/safebox/dnsclient.json` with the DNS relay and Safenet log URLs from the image's `/etc/safebox/defaults.json`. `safebox-dnsclient.service` generates an Ed25519 identity, verifies the owner's signature on the launch authorization, takes a vTPM quote, builds a signed `safebox_announce` OCP claim chaining the launch authorization, and publishes it to the Safenet transparency log and the DNS relays.

Verify from outside, in this order. First, within two to three minutes of `terraform apply`, `curl -sk https://<public_ip>/` returns the autovhost splash and `curl -s http://<public_ip>:8443/.well-known/safebox-announce-challenge/x` returns an HTTP 404 from dnsclient: the box booted, unsealed, mounted the pool and started its services. Second, the announce appears in the Safenet transparency log for `safebox-id`, which proves the vTPM quote matched the blessed image's PCR values and the launch authorization was accepted. A box that answers on 8443 but never announces has a launch-authorization problem; a box that never answers on 8443 did not get through the initramfs.

## Troubleshooting

There is no log to read on the box and no way to log in; diagnosis is by elimination from the outside, and the fix is always to replace the instance. The usual causes, in order of likelihood:

Launched without a vTPM or without Secure Boot: `safebox-unseal.service` requires `/dev/tpmrm0`, and the boot fails closed. The Terraform module always sets all three Shielded VM flags; a hand launch must pass `--shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring`.

No eligible data disk, or more than one: the initramfs selects the single attached disk that has no partition table, no filesystem signature and at least 50 GB. A reused disk that already carries a pool, a second blank disk, or a disk under 50 GB makes it fail closed. Give the instance exactly one fresh data disk.

Launch authorization rejected: the validity window expired, the signature does not match the owner pubkey, or the `safeboxId` in the claim does not match the metadata key. The box stays up and unannounced and `safebox-firstboot.service` will not run again once `announced` exists, so sign a new launch authorization and relaunch the instance rather than editing metadata in place.

Quote rejected: the control plane compares the PCR values in the quote with the values recorded for the image. A quote mismatch on a freshly built image means the image was not launched as a Shielded VM, or the control plane has not been given this image's root hash and expected PCRs from `manifests/gcp-<date>.json`.

Metadata unreadable: `safebox-firstboot.service` retries the metadata server for about thirty seconds. If the instance was created with a network that blocks `169.254.169.254` (a custom route or a firewall egress rule), the box never learns its id. Only the deploy path should write metadata; see "Project policy".

The red-team script `tests/redteam/gcp.sh <image-name>` launches a throwaway instance from an image and attempts each attack path in `docs/HARDENING-PLAN.md` with `gcloud`, printing PASS when the attack fails as expected. Run it against every new image before adding it to the family.

## Image rotation

A running safebox never changes. A patched package, a new kernel, a changed configuration, or a new component version means a new build, a new root hash, a new image in the `safebox` family and a new manifest in `manifests/`. Publish the new image's root hash and expected PCR values so Safenet peers and DNS relays accept announces from it, launch replacement instances with fresh launch authorizations, move traffic, then destroy the old instances.

The old data disk cannot be attached to a box built from a new image: the pool key is sealed to the old image's PCR 8 and 9 values, and a new image's initramfs would find a disk that already has a pool and refuse to boot. Data moves between generations through the application's own backup and replication path (`scripts/backup.sh`, `scripts/replicate.sh`), not by swapping disks. Delete the old data disk after the migration is confirmed; its contents are encrypted with a key that no longer exists anywhere.

Keep old images until every box launched from them is gone, then `gcloud compute images deprecate` them with `--state=OBSOLETE` so a stale `image_self_link` fails at plan time instead of launching an old root.
