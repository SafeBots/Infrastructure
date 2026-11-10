# AWS: Building and Deploying Safeboxes

Internal operational guide for the Safebots team. Covers building the hardened golden AMI on Ubuntu 24.04 LTS and launching production safeboxes from it. The normative specification is `docs/HARDENING-PLAN.md`; this document is the runbook.

Production safeboxes have no shell, no SSH, no SSM, and no serial console: no human is ever inside the box, and a box that fails to boot or fails to announce is terminated and replaced, not repaired. Diagnostics happen against an offline encrypted snapshot, never a live session.

## How the build differs from a normal image build

The build instance is never captured. You attach a blank second EBS volume to an Ubuntu 24.04 build instance, and `build-image.sh` writes the finished image onto that volume as a read-only dm-verity root, then snapshots that volume and registers the AMI from it. The AMI contains only the bytes the verity builder wrote, hashed by dm-verity, with the root hash on the measured kernel command line. Nothing from the build host's own running root ends up in the image.

The build runs the component installers inside a chroot, not on the live instance. The installers only install files, write static configuration, strip attack surface, and enable units. They never start a service, never touch the TPM, never create a ZFS pool, and never read the metadata service. Everything that needs a live box — generating and sealing the ZFS and HMAC keys, creating the pool, and registering with the control plane — happens on the first boot of each production instance, bound to that instance's NitroTPM.

## Prerequisites

An AWS account, ideally a dedicated one that holds only safeboxes, with an IAM principal allowed to `ec2:RunInstances`, `ec2:CreateSnapshot`, `ec2:RegisterImage`, `ec2:CreateTags`, `ec2:DescribeInstances`, `ec2:DescribeSnapshots`, `ec2:CreateVolume`, `ec2:AttachVolume`, `ec2:DetachVolume`, and `ec2:TerminateInstances`.

A build instance running Ubuntu 24.04 LTS on a Nitro instance type (m5, c5, r5, m6i, or newer) with a blank second EBS volume (at least 8 GB; a 10 GB gp3 is plenty) attached as the image target. On Nitro the target appears as `/dev/nvme1n1` even though it is requested as `/dev/xvdf`; confirm with `lsblk`.

The build host must be Ubuntu 24.04 itself: the image is bootstrapped with `debootstrap` against the noble archive, which needs the `ubuntu-keyring` package to verify it, and the same release on both sides keeps the host's `grub-install`, `dracut`, and `veritysetup` compatible with what the chroot contains. The following host packages on the build instance (none of these end up in the image): `debootstrap`, `ubuntu-keyring`, `gdisk`, `e2fsprogs`, `dosfstools`, `cryptsetup-bin`, `rsync`, `util-linux`, `python3`, `jq`, `nvme-cli`, the AWS CLI v2 (from the AWS zip installer; the `awscli` apt package is v1), and `uefivars` (`pip install uefivars`, used to build the Secure Boot variable store). SSH to the build instance is fine; it is only the build host, and nothing it carries is captured.

## Step 1: launch the build instance

Launch an Ubuntu 24.04 Nitro instance with a blank second volume, then SSH in. Canonical publishes the current AMI id as an SSM parameter.

```bash
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --instance-type m5.xlarge \
  --key-name your-build-key \
  --subnet-id subnet-xxxxxxxx \
  --block-device-mappings '[
    {"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}},
    {"DeviceName":"/dev/xvdf","Ebs":{"VolumeSize":10,"VolumeType":"gp3"}}
  ]' \
  --metadata-options "HttpTokens=required" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=safebox-build}]'
```

Install the host build tooling (`sudo apt-get install -y debootstrap ubuntu-keyring gdisk e2fsprogs dosfstools cryptsetup-bin rsync util-linux python3 jq nvme-cli python3-pip`, the AWS CLI v2, and `pip install uefivars`), then clone the repository.

## Step 2: build and capture the image

Nothing is compiled during the build. The kernel is Canonical's signed `linux-aws` flavour and the ZFS module ships, signed with the same key, in its `linux-modules-extra` package; this is why every cloud builds Ubuntu (see "Why Ubuntu on every cloud" in `docs/HARDENING-PLAN.md`). The one digest you must supply is for the Node 22 tarball: `common/base/install-base.sh` refuses to run while `NODE_SHA256` is the placeholder, so either edit it there or export `SAFEBOX_NODE_SHA256` with the `node-v<ver>-linux-x64.tar.xz` line from `https://nodejs.org/dist/v<ver>/SHASUMS256.txt`.

Run the build against the blank target volume. `build-image.sh` debootstraps a minimal noble root, runs the `base` (`common/base/install-base.sh` with the `linux-aws` flavour), `system`, `dnsclient`, `autovhost`, and `safenet` installers in a chroot, cleans and verifies the chroot, writes the verity root onto the target, snapshots it, and registers the AMI.

```bash
cd Infrastructure
sudo -E ./aws/scripts/build-image.sh --target /dev/nvme1n1
```

Default components are all five; `base` and `system` are mandatory. Pass `--components base,system` to build a smaller image, `--no-capture` to build the disk without registering an AMI, or `--grub-password-hash <hash>` to supply your own GRUB superuser hash (otherwise a random one is generated and discarded, which is the recommended choice). `build-ami.sh` still works as an alias for `build-image.sh`.

The capture step registers the AMI with UEFI boot mode, NitroTPM (`--tpm-support v2.0`), ENA, and IMDSv2 required, from an encrypted gp3 snapshot that is deleted on termination, and attaches a Secure Boot variable store containing the Microsoft UEFI CA 2011 and the Microsoft Windows Production PCA 2011 in `db` (Ubuntu's shim is Microsoft-signed and its GRUB, kernel, and ZFS module are signed by Canonical's key that shim trusts, so no custom Secure Boot keys are needed). The exact call is:

```bash
aws ec2 register-image \
  --name safebox-<date>-<roothash8> \
  --architecture x86_64 --virtualization-type hvm --ena-support \
  --boot-mode uefi --tpm-support v2.0 --imds-support v2.0 \
  --root-device-name /dev/xvda \
  --uefi-data file://uefi-data.bin \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"SnapshotId":"snap-...","VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}]'
```

`build-image.sh` performs all of this and tags the AMI with `RootHash=<hash>`. It writes a manifest to `manifests/aws-<date>.json` recording the image id, root hash, the verity manifest, the inventory SHA-256, and the git commit. Record the root hash; it is what the control plane blesses and what every instance's TPM quote must match.

When the build finishes, terminate the build instance. It was only the host.

## Step 3: disable the consoles and agents at the account level

The on-image measures (no agents, masked gettys, GRUB password, measured verity root) are what actually hold; these account-level settings stop mistakes and insiders from re-enabling a path.

Disable the serial console for the account in this region, and keep it disabled with a Service Control Policy that denies anyone re-enabling it or pushing console/SSH keys or starting SSM sessions against safebox-tagged resources.

```bash
aws ec2 disable-serial-console-access
```

Attach an SCP (or an IAM policy on every principal that can touch these instances) denying, on safebox-tagged resources, the actions: `ec2:EnableSerialConsoleAccess`, `ec2-instance-connect:SendSerialConsoleSSHPublicKey`, `ec2-instance-connect:SendSSHPublicKey`, `ssm:StartSession`, and `ssm:SendCommand`. A dedicated AWS account for safeboxes makes this policy account-wide and removes the need to tag.

## Step 4: prepare the owner key and launch authorization

Each launch needs the owner's Ed25519 public key and a signed launch-authorization claim. The owner generates a keypair once (the public half is `owner-pubkey`), then for each launch signs a `launch_authorization` OCP claim that names the `safeboxId`, the `ownerPubkey`, and a validity window (at most 24 hours). The authorization is verified by the box on first boot and by every Safenet peer and DNS relay that receives the announce. Issue the authorization immediately before `terraform apply`, since its window is short-lived.

The two values go into the launch metadata as `owner-pubkey` (64 hex characters) and `launch-authorization` (base64-encoded signed claim). On first boot the box generates its own Ed25519 identity, obtains a NitroTPM quote over the policy PCRs, builds a signed `safebox_announce` claim chaining the launch authorization, and publishes it to the Safenet transparency log and the DNS relays baked into the image.

## Step 5: launch production safeboxes

Use the Terraform module in `aws/terraform/`. It launches from the AMI, attaches an empty 200 GB encrypted data volume (the first boot formats it into the pool; Terraform must never format or partition it), opens only 443 and 8443 inbound, requires IMDSv2 with a hop limit of 1, and passes the three metadata keys as a JSON object that the first-boot unit reads and never executes.

```hcl
module "safebox" {
  source = "./aws/terraform"

  ami_id             = "ami-0123456789abcdef0"
  instance_type      = "m5.xlarge"
  vpc_id             = "vpc-abc123"
  subnet_id          = "subnet-abc123"
  safebox_id           = "sb-prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization
}
```

`ami_id` must be the literal `ami-` id recorded in `manifests/`; the variable rejects names and filters so the launch is tied to a recorded root hash. There is no `dns_api_url` input: the DNS relay and Safenet log URLs are baked into the image at `/etc/safebox/defaults.json`, and changing them means rebuilding the image. Pass `owner_pubkey` and `launch_authorization` through `TF_VAR_` environment variables or a secrets manager, never a committed `.tfvars`. AMD SEV-SNP confidential compute is on by default (`skip_confidential_compute` defaults to false); it requires m6a/c6a/r6a instance types. The default image refuses to announce without an SEV-SNP report unless it was built with `allowUnencryptedMemory`. Set `skip_confidential_compute = true` only for dev/test on non-SEV types. Secure Boot and the vTPM come from the AMI, not from a Terraform flag. Set `allow_http = true` (default false) on boxes that will serve custom domains: autovhost's ACME HTTP-01 validation needs port 80 until TLS-ALPN-01 lands; the two-port security group stays as is otherwise. The host's own nftables input chain always accepts TCP 80 (nginx binds it); `allow_http` only decides whether the security group lets the internet reach it.

## What to expect on first boot

There is no shell and no console to watch. The box boots the measured verity root, the initramfs unseals (or, on first boot, generates and seals) the ZFS and HMAC keys to the local TPM, creates the pool on the empty data volume, reads `safebox-id`, `owner-pubkey` and `launch-authorization` from the metadata service, verifies the owner's signature on the launch authorization, and publishes a signed announce to the Safenet transparency log and the DNS relays. Verify success two ways: the announce appears in the Safenet log for the safebox id, and the attested health endpoint on 443 responds with a quote whose PCR values match the blessed image. If neither appears within a few minutes, the box failed closed; replace it.

## Troubleshooting

The build refuses to start with a message about `NODE_SHA256` being a placeholder: export `SAFEBOX_NODE_SHA256` or fill the digest in `common/base/install-base.sh`.

`debootstrap` fails verifying the noble Release file: the build host is missing `ubuntu-keyring`, or is not Ubuntu 24.04. Use a 24.04 build instance.

`build-image.sh` says the target is mounted or not a whole disk: you pointed `--target` at the wrong device. It is the blank second volume (`/dev/nvme1n1` on Nitro), not the build root. The script refuses any device that is mounted or carries a mounted partition.

`uefivars` not found during capture: install `python-uefivars` on the build host, or run with `--no-capture` and register the AMI manually with the flags in Step 2.

An instance boots but never announces: the launch authorization's validity window expired, its signature does not match the owner pubkey, or the image is not blessed. Check the Safenet log for the safebox id. Because there is no shell, you cannot inspect the box; terminate it, sign a fresh launch authorization, and relaunch. If every box from a given AMI fails to announce, the image's PCR values are not in any relay's accepted set, or the data volume was not empty at launch.

Attestation fails on a running instance: the PCR values bound to the blessed image do not match. Nothing on a verity root can be changed in place, so this means either the wrong AMI or a tampered one; replace it.

## Image rotation

A running safebox never changes. A patched safebox is a new image with a new root hash. To rotate: launch a fresh build instance, update the package set or the apt pins in `common/base/install-base.sh` if needed, run `build-image.sh` to produce a new AMI, publish the new root hash so Safenet peers and DNS relays accept announces from it, launch a single instance from it and confirm it announces and attests, then roll out by launching new instances from the new AMI and terminating the old ones. Never update packages in place; the verity root makes that impossible and the attestation would break anyway.

The AWS Nitro attestation chain is rooted in the AWS Nitro Root-G1 certificate, pinned by SHA-256 in `nitroTpmClient.js` and installed by `install-system.sh`. If AWS ever rotates that root, update the pin and rebuild.
