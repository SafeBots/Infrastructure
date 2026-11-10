# OCI: Safebox Image and Deployment

This directory holds the OCI-specific parts of the Safebox build. Everything that is the same on every cloud lives in `../common/`; the full specification of what the image is and why is [`../docs/HARDENING-PLAN.md`](../docs/HARDENING-PLAN.md), and the step-by-step runbook for this cloud is [`INSTRUCTIONS.md`](INSTRUCTIONS.md).

## What is here

```
oci/
├── INSTRUCTIONS.md                 The runbook: build host, build, capture, token, launch, policy, red team
├── scripts/
│   ├── build-image.sh              Bootstrap and capture steps for OCI; everything between is shared
│   └── components/
│       ├── base/install-base.sh    Shim: sets the `linux-oracle` kernel flavour and calls common/base/install-base.sh
│       ├── system/install-system.sh
│       └── dnsclient/ociAttestationClient.js
│                                   Attestation client dnsclient loads on this cloud
├── terraform/                      Launch module: image, empty data disk, two-port firewall, Secure Boot + vTPM, agents and consoles off, two metadata keys
├── manifests/                      One `oci-<date>.json` per build: image id, root hash, verity manifest, inventory digest, git commit
```

The red-team test for this cloud is `../tests/redteam/oci.sh`.

## The flow in one paragraph

An Ubuntu 24.04 LTS build instance with an empty second disk runs `scripts/build-image.sh --target <disk>`. The script debootstraps a minimal noble root, runs the five component installers in a chroot (base with the `linux-oracle` kernel, system, dnsclient, autovhost, safenet), cleans and verifies the chroot, writes it to the target disk as a read-only dm-verity root with a password-protected single GRUB entry, and converts the target block volume to qcow2, uploads it to Object Storage, and imports it as a custom image in `UEFI_64` launch mode. The build instance is never captured. On first boot of each production instance the initramfs generates the ZFS pool key and the HMAC seed, creates the encrypted pool on the empty data disk, and seals both keys to that instance's TPM under PCRs 0, 2, 4, 7, 8, 9, 14 and 15; a first-boot unit reads `safebox-id`, `owner-pubkey` and `launch-authorization` from the metadata service and dnsclient verifies the owner's signature, obtains a TPM quote (verified against the OCI shielded-instance vTPM endorsement chain), and publishes a signed announce to the Safenet transparency log and the DNS relays. There is no cloud-init, no agent, no shell, and no console.

## OS

Ubuntu 24.04 LTS (noble) on every cloud, because it is the only distribution that ships distro-signed ZFS kernel modules, which Secure Boot requires to load them. The per-cloud difference is the kernel flavour (`linux-oracle`); the installer, the package pins, and the hardening are shared in `common/base/install-base.sh`.
