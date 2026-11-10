# AWS: Safebox Image and Deployment

This directory holds the AWS-specific parts of the Safebox build. Everything that is the same on every cloud lives in `../common/`; the full specification of what the image is and why is [`../docs/HARDENING-PLAN.md`](../docs/HARDENING-PLAN.md), and the step-by-step runbook for this cloud is [`INSTRUCTIONS.md`](INSTRUCTIONS.md).

## What is here

```
aws/
├── INSTRUCTIONS.md                 The runbook: build host, build, capture, token, launch, policy, red team
├── scripts/
│   ├── build-image.sh              Bootstrap and capture steps for AWS; everything between is shared
│   ├── build-ami.sh                Alias for build-image.sh
│   └── components/
│       ├── base/install-base.sh    Shim: sets the `linux-aws` kernel flavour and calls common/base/install-base.sh
│       ├── system/                 The system component itself (Node.js source, units, tests) and its installer;
│       │                           shared by all four clouds, kept here for history. nitroTpmClient.js is the AWS attestation client
│       ├── safenet/                Safenet P2P overlay (canonical source; installed by common/safenet/install-safenet.sh)
│       ├── autovhost/README.md     Pointer; the component moved to common/autovhost/
│       └── dnsclient/README.md     Pointer; the component moved to common/dnsclient/
├── terraform/                      Launch module: AMI, empty data volume, two-port security group, IMDSv2 hop limit 1, two metadata keys in user-data
├── manifests/                      One `aws-<date>.json` per build: image id, root hash, verity manifest, inventory digest, git commit
└── docs/                           Design documents for the component layer (ZFS, MariaDB, model runners, AUDIT.md); most predate the hardening plan
```

The red-team test for this cloud is `../tests/redteam/aws.sh`.

## The flow in one paragraph

An Ubuntu 24.04 LTS build instance with an empty second disk runs `scripts/build-image.sh --target <disk>`. The script debootstraps a minimal noble root, runs the five component installers in a chroot (base with the `linux-aws` kernel, system, dnsclient, autovhost, safenet), cleans and verifies the chroot, writes it to the target disk as a read-only dm-verity root with a password-protected single GRUB entry, and snapshots the target EBS volume and registers an AMI with UEFI boot, NitroTPM, IMDSv2 required, and a Secure Boot variable store. The build instance is never captured. On first boot of each production instance the initramfs generates the ZFS pool key and the HMAC seed, creates the encrypted pool on the empty data disk, and seals both keys to that instance's TPM under PCRs 0, 2, 4, 7, 8, 9, 14 and 15; a first-boot unit reads `safebox-id`, `owner-pubkey` and `launch-authorization` from the metadata service and dnsclient verifies the owner's signature, obtains a TPM quote (verified against the AWS Nitro root certificate (NitroTPM quotes through `/dev/tpmrm0`)), and publishes a signed announce to the Safenet transparency log and the DNS relays. There is no cloud-init, no agent, no shell, and no console.

## OS

Ubuntu 24.04 LTS (noble) on every cloud, because it is the only distribution that ships distro-signed ZFS kernel modules, which Secure Boot requires to load them. The per-cloud difference is the kernel flavour (`linux-aws`); the installer, the package pins, and the hardening are shared in `common/base/install-base.sh`.
