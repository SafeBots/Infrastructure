# Azure: Building and Deploying Safeboxes

Operational guide for building the Safebox image on Ubuntu 24.04 LTS and launching production safeboxes from it on Azure. The normative specification is `docs/HARDENING-PLAN.md`; this file is the Azure-specific procedure.

Production safeboxes have no shell, no SSH, no serial console, no Azure agent and no extensions; a box that fails to boot or to announce is replaced from the image, never repaired in place.

## How the image works

The root filesystem is a read-only dm-verity volume whose hash is on the kernel command line, measured by GRUB into the vTPM. The pool key and the HMAC seed are generated on the first boot of each instance and sealed to that instance's vTPM under a PCR policy that covers the firmware, Secure Boot state, GRUB, the command line, the kernel and the initramfs. All mutable state (`/var`, Docker, MariaDB, the dnsclient identity and credential, nginx vhosts) lives on an encrypted ZFS pool on a separate data disk. `/etc` is a volatile overlay. The image is captured as a Specialized Compute Gallery version with `SecurityType=TrustedLaunch`, because there is no agent to generalize with and because plain managed images cannot launch Trusted Launch VMs.

## Prerequisites

- A subscription dedicated to safeboxes. The policies in the "Cloud-level policy" section are applied at subscription scope and would get in the way of anything else running there.
- A resource group for images (`safebox-images-rg` below) and one for production VMs. The build VM and its disks can live in the images group.
- RBAC for the operator who builds: `Virtual Machine Contributor` plus `Disk Snapshot Contributor` on the images group, and the ability to create `Microsoft.Compute/galleries/*` there (Contributor on the group is the simple answer). RBAC for launching: Contributor on the production group. Nobody needs `Microsoft.SerialConsole/serialPorts/connect/action`; the custom role below leaves it out.
- `az` CLI 2.60 or newer, logged in with `az login` and pointed at the subscription with `az account set`.
- Terraform 1.5 or newer for launching.
- A VNet and subnet with outbound internet access. Safeboxes make outbound HTTPS to the DNS API and to Let's Encrypt; inbound is 443 and 8443 only.

## Step 1: Build VM

The build VM is a throwaway Ubuntu 24.04 LTS Gen2 VM with a second, empty managed disk at LUN 1. It must be 24.04 because the image is bootstrapped with `debootstrap` against the noble archive, verified with `ubuntu-keyring`, and the host's `grub-install`, `dracut`, and `veritysetup` must match the chroot's release. The image is written to that second disk; the build VM's own OS disk is never captured.

```bash
RG=safebox-images-rg
LOC=eastus
az group create --name "$RG" --location "$LOC"

az vm create \
  --resource-group "$RG" \
  --name safebox-build \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_D4s_v5 \
  --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true \
  --os-disk-size-gb 64 \
  --admin-username builder --generate-ssh-keys \
  --public-ip-sku Standard

# The image target: 16 GB is enough (512 MB ESP + 1 GB /boot + root + hash tree).
# Production OS disks are created from the gallery version at this size.
az disk create --resource-group "$RG" --name safebox-image-target --size-gb 16 --sku Premium_LRS --hyper-v-generation V2
az vm disk attach --resource-group "$RG" --vm-name safebox-build --name safebox-image-target --lun 1
```

SSH into the build VM (this is the only VM in the process that ever has SSH) and install the host tools. The build VM needs `az` too, logged in with an identity that can snapshot the target disk and write to the gallery.

```bash
sudo apt-get update
sudo apt-get install -y debootstrap ubuntu-keyring gdisk e2fsprogs dosfstools cryptsetup-bin rsync python3 jq sudo udev util-linux grub-common git
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login
git clone https://github.com/Safebots/Infrastructure.git
cd Infrastructure
```

`grub-common` provides `grub-mkpasswd-pbkdf2` for the GRUB password hash. Without it the build generates the hash inside the chroot instead, which also works.

## Step 2: Build

The Node 22 tarball is sha256-pinned. The placeholder in `common/base/install-base.sh` must be replaced, or the digest passed in the environment, before the first build; take it from `https://nodejs.org/dist/v22.11.0/SHASUMS256.txt` (the `node-v22.11.0-linux-x64.tar.xz` line).

```bash
export SAFEBOX_NODE_SHA256=<sha256 of node-v22.11.0-linux-x64.tar.xz>
sudo -E azure/scripts/build-image.sh \
  --target /dev/disk/azure/scsi1/lun1 \
  --target-disk-name safebox-image-target \
  --resource-group "$RG"
```

Options: `--components base,system,dnsclient,autovhost,safenet` (default all five; `base` and `system` are mandatory), `--grub-password-hash <grub.pbkdf2.sha512...>` (default: a random passphrase that is discarded), `--rootfs /mnt/safebox-rootfs`, `--security-type TrustedLaunch|ConfidentialVMSupported` (the gallery definition feature; use `ConfidentialVMSupported` once if Confidential VMs will ever be launched from this definition), `--no-capture` (stop after writing the target disk), `--mirror` (Ubuntu mirror; default `azure.archive.ubuntu.com`). `SAFEBOX_DNS_API_URL` in the environment overrides the DNS API URL baked into `/etc/safebox/defaults.json`; `SAFEBOX_APT_PINS` points at a `package=version` file (see "Image rotation").

The build takes roughly fifteen minutes: debootstrap of noble, the five installers in the chroot (`common/base/install-base.sh` with the `linux-azure` kernel flavour, `install-system.sh`, `common/dnsclient/install-dnsclient.sh`, `common/autovhost/install-autovhost.sh`, `common/safenet/install-safenet.sh`), `common/image/cleanup-image.sh` and `common/image/verify-image.sh` run from the host against the rootfs directory, then `common/image/build-verity-root.sh` partitions the target disk and writes the verity root and GRUB. `verify-image.sh` aborts the build on any gap (an agent package present, an unlocked account, a login shell, a missing dracut module, a setuid binary outside the allowlist), and nothing is captured in that case.

The last lines of output are `ROOTHASH=<64 hex>` and, after capture, `IMAGE_ID=<gallery version id>`. The build also writes `manifests/azure-<date>.json` into the repository with the root hash, the verity manifest, the image id and the sha256 of the image inventory; commit it.

## Step 3: Capture

`build-image.sh` does this itself unless `--no-capture` was given. The exact commands, for reference or for a manual capture of a disk written with `--no-capture`:

```bash
DISK_ID=$(az disk show -g "$RG" -n safebox-image-target --query id -o tsv)
az snapshot create -g "$RG" -n safebox-<date>-<roothash8> --source "$DISK_ID" --hyper-v-generation V2 --sku Standard_LRS --tags roothash=<roothash>
az sig create -g "$RG" --gallery-name safebox --location "$LOC"            # once
az sig image-definition create -g "$RG" --gallery-name safebox \
  --gallery-image-definition safebox-prod --location "$LOC" \
  --publisher Safebots --offer safebox --sku prod \
  --os-type Linux --os-state Specialized --hyper-v-generation V2 --architecture x64 \
  --features SecurityType=TrustedLaunch                                 # once
az sig image-version create -g "$RG" --gallery-name safebox \
  --gallery-image-definition safebox-prod --gallery-image-version <date>.0.0 \
  --location "$LOC" --target-regions "$LOC" \
  --os-snapshot "$(az snapshot show -g "$RG" -n safebox-<date>-<roothash8> --query id -o tsv)" \
  --tags roothash=<roothash>
```

The flags that matter: `--hyper-v-generation V2` (UEFI; Secure Boot and vTPM exist only on Gen2), `--os-state Specialized` (no deprovisioning, boots as captured), `--features SecurityType=TrustedLaunch` (lets a VM with `secureBootEnabled` and `vTpmEnabled` launch from it). Terraform's `image_id` is the gallery image version id printed by the last command.

After capture, deallocate and delete the build VM and the target disk. Neither is needed again and the build VM has SSH.

## Step 4: Prepare the owner key and launch authorization

Each launch needs the owner's Ed25519 public key and a signed launch-authorization claim. The owner generates a keypair once (the public half is `owner-pubkey`, 64 hex characters); for each launch, the owner signs a `launch_authorization` OCP claim naming the `safeboxId`, the `ownerPubkey`, and a validity window (at most 24 hours). Sign the authorization immediately before `terraform apply`, since its window is short-lived.

The box verifies the owner's signature on first boot, and every Safenet peer and DNS relay verifies it again when the announce arrives. Pass both values to Terraform as `TF_VAR_owner_pubkey` and `TF_VAR_launch_authorization`; do not write them to a `.tfvars` file that is committed.

## Step 5: Launch with Terraform

```bash
cd azure/terraform
export TF_VAR_owner_pubkey=<owner public key hex>
export TF_VAR_launch_authorization=<base64 signed claim>
terraform init
terraform apply \
  -var image_id=<gallery image version id> \
  -var resource_group_name=safebox-prod-rg \
  -var location="$LOC" \
  -var subnet_id=<subnet id> \
  -var safebox_id=prod-001
```

What the module creates: a Standard static public IP, an NSG allowing inbound 443 and 8443 only, a NIC, an empty 200 GB Premium data disk at LUN 0, and the VM with Secure Boot and vTPM on, boot diagnostics off, no managed identity, no `customData`, and `userData` set to the base64 JSON `{"safebox-id":...,"owner-pubkey":...,"launch-authorization":...}`. There is no `dns_api_url` input: the DNS relay and Safenet log URLs are baked into the image at `/etc/safebox/defaults.json`, and changing them means rebuilding the image. The VM is created through `azapi_resource` with no `osProfile`, because Azure refuses `osProfile` on a VM from a Specialized image and `azurerm_linux_virtual_machine` cannot omit it (see the comment at the top of `azure/terraform/main.tf`). The same constraint means `provisionVMAgent = false` and `allowExtensionOperations = false` cannot be set on this VM; the control is the agent's absence from the image plus the deny policies in the "Cloud-level policy" section below, which the module can assign for you with `manage_deny_policies = true`.

Confidential VM (AMD SEV-SNP or Intel TDX) is on by default; it needs a `DCasv5`/`ECasv5`/`DCesv5`/`ECesv5` size and an image definition created with `ConfidentialVMSupported`. Set `skip_confidential_compute = true` for dev/test on non-CVM types; the default image refuses to announce without an SEV-SNP or TDX report unless it was built with `allowUnencryptedMemory`. Other options, off by default: `encryption_at_host` (needs `az feature register --namespace Microsoft.Compute --name EncryptionAtHost`), `allow_http` (opens port 80 in the NSG; required on boxes that serve custom domains, because autovhost's ACME HTTP-01 validation runs over port 80 until TLS-ALPN-01 lands; the host's own nftables input chain always accepts 80 because nginx binds it), `manage_deny_policies` (defines and assigns the deny-extensions, deny-run-commands and deny-boot-diagnostics policies at resource-group scope; needs Resource Policy Contributor on the subscription and the resource group; when left false you must assign them yourself as described below).

The data disk must stay empty: the initramfs picks the one blank disk of at least 50 GB and creates the encrypted pool on it. If zero or more than one disk qualifies, the box fails closed.

## Cloud-level policy: consoles, extensions, agents

These settings stop mistakes. The on-image measures (no agent, no getty, verity root, sealed keys) are what hold against an insider with subscription rights. Apply them to the dedicated subscription.

Disable the serial console for the whole subscription. This flips `Microsoft.SerialConsole/consoleServices/default` to disabled; `az serial-console connect` then fails with a "disabled" error for every VM.

```bash
az extension add --name serial-console
az serial-console disable
```

Deny VM extensions (Run Command, VMAccess, Custom Script) and the managed run-command resource type. Extension resources do not carry the parent VM's tags, so this is a subscription-scope deny, which is why the subscription is dedicated. The Terraform module can define and assign the same two policies at resource-group scope when `manage_deny_policies = true`; that covers only VMs in that resource group and needs Resource Policy Contributor, so the subscription-scope assignment below is still the recommended placement. Either way, the policies are the control-plane half of the compensating control for the agent flags that a Specialized image cannot carry.

```json
{
  "properties": {
    "displayName": "Safebox: deny VM extensions and run commands",
    "mode": "All",
    "policyRule": {
      "if": {
        "anyOf": [
          { "field": "type", "equals": "Microsoft.Compute/virtualMachines/extensions" },
          { "field": "type", "equals": "Microsoft.Compute/virtualMachines/runCommands" }
        ]
      },
      "then": { "effect": "deny" }
    }
  }
}
```

Deny boot diagnostics on safebox-tagged VMs (the serial log and screenshot are a read path to the console).

```json
{
  "properties": {
    "displayName": "Safebox: deny boot diagnostics on safebox VMs",
    "mode": "All",
    "policyRule": {
      "if": {
        "allOf": [
          { "field": "type", "equals": "Microsoft.Compute/virtualMachines" },
          { "field": "tags['safebox']", "equals": "true" },
          { "field": "Microsoft.Compute/virtualMachines/diagnosticsProfile.bootDiagnostics.enabled", "equals": "true" }
        ]
      },
      "then": { "effect": "deny" }
    }
  }
}
```

```bash
SUB=$(az account show --query id -o tsv)
az policy definition create --name safebox-deny-extensions --rules deny-extensions.json --mode All
az policy definition create --name safebox-deny-bootdiag --rules deny-bootdiag.json --mode All
az policy assignment create --name safebox-deny-extensions --policy safebox-deny-extensions --scope "/subscriptions/$SUB"
az policy assignment create --name safebox-deny-bootdiag --policy safebox-deny-bootdiag --scope "/subscriptions/$SUB"
```

Serial console RBAC: `Virtual Machine Contributor` includes `Microsoft.SerialConsole/serialPorts/connect/action`. Give operators a custom role instead, built from `Virtual Machine Contributor` with that action removed (`az role definition create --role-definition role.json` where `NotActions` lists `Microsoft.SerialConsole/serialPorts/connect/action` and `Microsoft.Compute/virtualMachines/extensions/write`, `Microsoft.Compute/virtualMachines/runCommand/action`). A deny assignment on the data action is not creatable through the CLI (deny assignments come only from Blueprints and deployment stacks); disabling the console at subscription scope is the control that actually bites.

Agents: `walinuxagent`, `linux-cloud-tools-azure` (Hyper-V KVP and file-copy daemons) and `hyperv-daemons` are removed from the image and pinned at apt priority -1 by `common/base/install-base.sh`. There is no subscription setting for this; `az vm run-command invoke` and every extension fail because nothing in the guest listens.

## What to expect on first boot

Nothing visible. The VM has no console, no serial output you can read (boot diagnostics are off), and no shell. First boot takes a few minutes: the initramfs creates the pool on the data disk and seals the keys, the first-boot unit reads `userData`, dnsclient publishes its announce to the Safenet transparency log and the DNS relays, nginx and the system component start.

Verify from the outside, in this order:

1. The VM reports `PowerState/running` in `az vm get-instance-view`.
2. Port 443 accepts TCP connections (nginx is up, so the root opened and the pool mounted): `nc -z -w5 <public-ip> 443`.
3. The announce appears in the Safenet transparency log for the safebox id. If this does not appear within ten minutes of the VM running, the announce failed: the launch authorization's validity window expired, its signature did not match the owner pubkey, the quote did not match the blessed image, or `userData` was wrong.
4. The attested health endpoint answers: dnsclient's announce includes a fresh vTPM quote, and the DNS API's record for the box shows a recent `lastAnnounce`.

## Troubleshooting

There is no way in. Every answer below ends in "replace the box".

**VM runs but port 443 never opens.** The root did not open or the pool was not created. Causes: the data disk is not blank (Terraform or an operator wrote to it; the initramfs refuses it), more than one blank disk is attached, the VM was launched without vTPM or Secure Boot (the unseal unit requires `/dev/tpmrm0`), or the gallery definition is not TrustedLaunch. Check `az vm show --query securityProfile` and the data disk, fix the launch, destroy and re-apply.

**Port 443 opens but the box never announces.** The launch authorization's validity window expired or its signature does not match the owner pubkey (sign a new one and re-apply with a fresh VM; a box never re-reads `userData` after it has written `dnsclient.json`), the Safenet peers rejected the quote (PCR values differ from the blessed image: confirm `image_id` is the version whose `roothash` tag matches the manifest), or the Safenet log URLs baked into the image (`/etc/safebox/defaults.json`) are unreachable from the VNet.

**`terraform apply` fails with "osProfile is not allowed".** The VM resource is sending `osProfile`; the module must stay on `azapi_resource` with no `osProfile`. If someone switched it to `azurerm_linux_virtual_machine`, switch it back.

**`terraform apply` fails on `securityEncryptionType`.** Confidential VM is on (the default) but `vm_size` is not a confidential size, or the image definition was created without `ConfidentialVMSupported`. Set `skip_confidential_compute = true` for non-CVM sizes.

**The build fails in `verify-image.sh`.** The message names the gap. Do not work around it; fix the installer and rebuild.

**The build fails at `dracut`** with a missing `systemd-veritysetup` or `zfs` module. noble's `dracut` must ship `systemd-veritysetup`, `zfs-dracut` must be installed, and the signed `zfs.ko` must be present in the `linux-modules-extra-azure` package for the installed kernel; `install-base.sh` checks all three and prints which is absent. A missing `zfs.ko` means the wrong kernel flavour was installed.

**Forensics.** Deallocate the VM, snapshot the data disk, and analyze it offline with the pool key, which you do not have: the key is sealed to that VM's vTPM and is never written anywhere else. What a snapshot gives you is encrypted blocks. This is by design. Logs that must survive a box go out through the system component's audit stream, not through disk forensics.

## Image rotation

A running safebox never changes. A patched safebox is a new image with a new root hash.

1. Rebuild from a fresh build VM (Step 1) with the same procedure. To freeze package versions to the previous build's, copy `apt-pins.resolved.txt` from the previous build (it is at `/opt/safebox/manifests/` inside the rootfs during the build, and its sha256 is in `manifests/azure-<date>.json`) into `azure/manifests/apt-pins.txt`, edit the lines you intend to change, and commit it; `install-base.sh` installs exactly those versions and fails on any mismatch.
2. Publish the new image's PCR values and root hash so Safenet peers and DNS relays accept announces from it.
3. Launch one box from the new version, confirm registration and the attested health endpoint, and run `tests/redteam/azure.sh <new image version id>`.
4. Roll: for each box, sign a fresh launch authorization, `terraform apply` a new VM with the new `image_id` and a new data disk, confirm the announce appears, then destroy the old one. Data that must carry over moves through the application's own replication, not by reattaching the old data disk; the old pool's key is sealed to the old VM's vTPM and cannot be opened by the new one.
5. Delete old gallery versions once no box uses them, and keep the `manifests/azure-<date>.json` files.

Do not `apt-get upgrade` a running safebox. It cannot work on a verity root, and the `/system` endpoint returns `NOT_SUPPORTED` for package operations for the same reason.
