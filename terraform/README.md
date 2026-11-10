# Safebox Terraform Modules

These modules launch safebox instances FROM pre-built golden images. They do not build images; image creation is handled by `<cloud>/scripts/build-image.sh` on a throwaway build instance, as described in each cloud's `INSTRUCTIONS.md` and specified in `docs/HARDENING-PLAN.md`.

Each cloud provider has its own self-contained Terraform module under `<cloud>/terraform/`. All four follow the same contract from the hardening plan: launch from the image with Secure Boot and the vTPM on, attach an empty data disk that the first boot formats into the encrypted pool, open only 443 and 8443 inbound, disable the cloud's agent, extension and console paths where a setting exists, and hand the box exactly three metadata values (`safebox-id`, `owner-pubkey` and `launch-authorization`) that the first-boot unit reads and never executes. The relays and Safenet peers the box announces to are not module inputs: they are baked into the image at `/etc/safebox/defaults.json` by the build (`dnsRelays`, `safenetLogs`), so the metadata cannot redirect a box to a relay of the operator's choosing. To change them, rebuild the image. No module has a startup script, user-data script, SSH key, or `ignore_changes` on metadata.

## Requirements

- Terraform >= 1.5
- The relevant cloud provider CLI configured with credentials
- A pre-built safebox golden image (AMI, GCE image, Azure Compute Gallery image version, or OCI custom image), built from Ubuntu 24.04 LTS by the build script
- An owner key (`node tools/dns-relay/authorize.js keygen owner.key` prints the `owner_pubkey`) and a launch authorization for this `safebox_id` signed with it (`node tools/dns-relay/authorize.js sign owner.key <safebox-id> [hours]`, at most 24 hours), issued shortly before `terraform apply`

## Modules

### AWS (`aws/terraform/`)

Provider: `hashicorp/aws ~> 5.31`

```hcl
module "safebox" {
  source = "./aws/terraform"

  ami_id             = "ami-0123456789abcdef0"
  instance_type      = "m5.xlarge"
  vpc_id             = "vpc-abc123"
  subnet_id          = "subnet-abc123"
  safebox_id           = "prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization
}
```

`ami_id` must be a literal `ami-` id from `manifests/`; the variable rejects names and filters. The module passes `safebox-id`, `owner-pubkey` and `launch-authorization` to the instance as a JSON metadata object read (never executed) by the first-boot unit. Secure Boot, the measured verity root, and the vTPM come from the AMI itself, not from a Terraform flag. The 200 GB data volume is created empty; the first boot formats it into the encrypted pool. `skip_confidential_compute` (default false, so SEV-SNP is on) disables AMD SEV-SNP confidential compute; set true only for non-SEV instance types like m5. `launch_authorization` is valid for at most 24 hours from signing, so sign it shortly before apply.

### GCP (`gcp/terraform/`)

Provider: `hashicorp/google >= 5.25, < 7.0`

```hcl
module "safebox" {
  source = "./gcp/terraform"

  image_self_link    = "projects/my-project/global/images/safebox-20260101-0a1b2c3d"
  project_id         = "my-project"
  zone               = "us-central1-a"
  safebox_id           = "prod-001"
  owner_pubkey         = var.owner_pubkey           # 64 hex, from authorize.js keygen
  launch_authorization = var.launch_authorization   # base64 claim from authorize.js sign, sensitive

  # skip_confidential_compute = true   # set true to disable SEV-SNP; needs an n2d machine_type when on (default)
  # allow_http = true                    # opens 80 for autovhost ACME HTTP-01
}
```

`image_self_link` must name one image (`projects/<project>/global/images/<name>`); the variable rejects image families (`images/family/<f>`) on purpose, because a family resolves to whatever image was pushed last and would let an image swap change what the module launches without touching the Terraform state. The GCP module delivers `safebox-id`, `owner-pubkey` and `launch-authorization` as instance metadata attributes, which `safebox-firstboot.service` reads on the box. It sets `enable-oslogin=FALSE`, `block-project-ssh-keys=TRUE`, `serial-port-enable=FALSE` and `serial-port-logging-enable=FALSE`, has no `startup-script` (the image has no agent that would run one), turns on Secure Boot, vTPM and integrity monitoring, creates an empty 200 GB pd-ssd data disk for the pool, and attaches a service account with only `logging-write` and `monitoring-write`. There is no `ignore_changes` on metadata. See `gcp/INSTRUCTIONS.md` for the org-policy constraints that keep the serial console and OS Login off at the project level.

### Azure (`azure/terraform/`)

Providers: `hashicorp/azurerm ~> 3.85` and `Azure/azapi ~> 1.13`. The VM is an `azapi_resource` because the image is a Specialized Compute Gallery version (no agent, no cloud-init, boots as captured) and Azure rejects `osProfile` for Specialized images, which `azurerm_linux_virtual_machine` always sends; the legacy `azurerm_virtual_machine` cannot set Secure Boot or vTPM. The module passes `safebox-id`, `owner-pubkey` and `launch-authorization` as a JSON object in `userData` (read from IMDS by the first-boot unit), turns on Secure Boot and vTPM, attaches an empty 200 GB data disk at LUN 0, leaves boot diagnostics off, attaches no managed identity, and sets no `custom_data`. Because a Specialized image cannot carry `osProfile`, `provisionVMAgent = false` and `allowExtensionOperations = false` cannot be set on the VM; the compensating control is the agent's absence from the image plus Azure Policy denies on extensions, run commands and boot diagnostics. Set `manage_deny_policies = true` to have the module define and assign those policies at resource-group scope (needs Resource Policy Contributor); with the default `false`, assign them yourself from `azure/INSTRUCTIONS.md`.

```hcl
module "safebox" {
  source = "./azure/terraform"

  image_id            = "/subscriptions/.../resourceGroups/safebox-images-rg/providers/Microsoft.Compute/galleries/safebox/images/safebox-prod/versions/20260101.0.0"
  resource_group_name = "safebox-rg"
  location            = "eastus"
  subnet_id           = "/subscriptions/.../subnets/default"
  safebox_id           = "prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization

  # skip_confidential_compute = true   # set true to fall back to Trusted Launch; needs DCasv5/ECasv5 when on (default)
  # encryption_at_host     = true   # needs the EncryptionAtHost subscription feature
  # allow_http             = true   # port 80 for autovhost HTTP-01 ACME; off by default
  # manage_deny_policies   = true   # module assigns the deny-extension/run-command/boot-diag policies at RG scope
}
```

### OCI (`oci/terraform/`)

Provider: `oracle/oci ~> 5.25`

```hcl
module "safebox" {
  source = "./oci/terraform"

  image_id           = "ocid1.image.oc1.iad.aaa..."   # safebox-<date>-<roothash8>, launch mode UEFI_64
  compartment_id     = "ocid1.compartment.oc1..aaa..."
  subnet_id          = "ocid1.subnet.oc1.iad.aaa..."
  safebox_id           = "prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization   # at most 24 h from signing
}
```

The OCI module launches a shielded instance (`platform_config`: Secure Boot, measured boot, vTPM; `skip_memory_encryption = false` (default) enables AMD SEV), disables every Oracle Cloud Agent plugin (`agent_config`), turns off the legacy IMDS v1 endpoints, attaches a 200 GB empty block volume for the pool, and passes exactly the three metadata keys `safebox-id`, `owner-pubkey` and `launch-authorization`. `image_id` must be an image OCID (`ocid1.image.oc1.<region>.<unique>`); the variable rejects anything else. There is no `ssh_authorized_keys` and no `user_data`. The NSG opens 443 and 8443; set `allow_http = true` only on boxes whose autovhost component must answer ACME HTTP-01 on port 80. See `oci/INSTRUCTIONS.md` for the IAM policy that keeps console connections out of the operators' hands.

## What each module creates

Every module provisions the same logical set of resources:

1. **Compute instance** from the golden image with Secure Boot and the vTPM on (AWS: from the AMI's UEFI and NitroTPM registration; GCP: Shielded VM flags; Azure: Trusted Launch; OCI: `platform_config`), the cloud agent and extension paths disabled (GCP OS Login and serial port off, Azure no boot diagnostics and, since a Specialized image cannot carry the agent/extension flags, the deny policies described above, OCI every agent plugin off and legacy IMDS off, AWS IMDSv2 with hop limit 1), no SSH keys, no startup or user-data script.
2. **Data volume**, 200 GB by default, attached empty. The first boot finds the one blank disk, creates the encrypted pool on it, and seals the key to the TPM. Terraform must never format, partition, or reuse it.
3. **Firewall / security group** allowing only ports 443 (HTTPS) and 8443 (dnsclient challenge endpoint), plus 80 when `allow_http = true`. The variable has the same name on all four modules and defaults to false. Custom domains need it: autovhost obtains certificates with ACME HTTP-01, which Let's Encrypt validates over port 80, so a box that will serve customer hostnames must be launched with `allow_http = true` until TLS-ALPN-01 (validation over 443) lands. Note what the variable does and does not control: the host's own nftables input chain (`common/net/safebox-imds.nft`, policy drop) always accepts TCP 80 because nginx binds it for ACME and the splash page; `allow_http` decides whether the cloud firewall lets the internet reach it. The host chain otherwise admits only loopback, established traffic, ICMP, 443, 8443 and DHCP replies.
4. **Three metadata values**, `safebox-id`, `owner-pubkey` and `launch-authorization`, delivered the way each cloud's first-boot unit expects (AWS: JSON in user-data over IMDSv2; GCP: instance attributes; Azure: JSON in `userData`; OCI: metadata keys). The unit validates their shape and writes them to the pool; nothing in the metadata is ever executed. The relays and Safenet peers the box announces to come from `/etc/safebox/defaults.json` in the image, not from metadata.

Confidential compute is on by default on every module (set `skip_confidential_compute = true` to disable); it is the mitigation for a hypervisor-level adversary, which is outside what the image itself defends against.

| Cloud | Image variable (validated shape) | Confidential-compute variable | HTTP (port 80) variable | Other |
|---|---|---|---|---|
| AWS | `ami_id` (`ami-<hex>`) | `skip_confidential_compute` | `allow_http` | |
| GCP | `image_self_link` (named image only, no families) | `skip_confidential_compute` | `allow_http` | |
| Azure | `image_id` (gallery image version id) | `skip_confidential_compute` | `allow_http` | `manage_deny_policies` |
| OCI | `image_id` (`ocid1.image.oc1.<region>.<unique>`) | `skip_memory_encryption` | `allow_http` | |

## Two-box modules (`<cloud>/terraform-console/`)

Each cloud also has a `terraform-console/` module that launches the **two-box architecture**: an outer Safebox Console paired with an inner Safebox. The Console is the Inductive Security base case — a frozen Nix image running one Qbix app, the Software Signer, and the egress proxy. The inner Safebox is a standard Safebox image whose egress is restricted to the Console's private IP at both the cloud firewall level and the host nftables level.

The two-box module creates two instances, two security groups, and two data volumes. The Console is launched first; the inner Safebox's metadata includes `console-ip` pointing to the Console's private IP, which `safebox-firstboot` writes to `/etc/safebox/console-ip` for the inner egress nftables rules.

```hcl
# AWS example
module "safebox_pair" {
  source = "./aws/terraform-console"

  console_ami_id     = "ami-0aaa..."   # Nix-based Console image
  inner_ami_id       = "ami-0bbb..."   # Standard Safebox image with inner egress rules
  vpc_id             = "vpc-abc123"
  subnet_id          = "subnet-abc123"
  safebox_id           = "prod-001"
  owner_pubkey         = var.owner_pubkey
  launch_authorization = var.launch_authorization
}
```

The inner Safebox's security group allows egress ONLY to the Console's security group — no `0.0.0.0/0`. This is the cloud-level enforcement; the host-level enforcement is `common/net/safebox-inner-egress.nft`, which drops all OUTPUT traffic except to the Console's private IP. Belt and suspenders.

Use the single-box modules (`<cloud>/terraform/`) for standalone Safeboxes that don't need the two-box architecture. Use the two-box modules when you need governed egress control, the Software Signer, or the verified closed source model.

## Sensitive values

`launch_authorization` is marked `sensitive` in all modules so it stays out of plan output; pass it via environment variable (`TF_VAR_launch_authorization`) rather than a committed `.tfvars` file. It is not a credential: it is a signed public statement by the owner key that this `safebox_id` may launch within a window of at most 24 hours, and the box includes it verbatim in every announce it publishes to the transparency log. Someone who reads it later from the instance metadata, the console, or a snapshot learns the owner's public key and an expired authorization. `owner_pubkey` is public. There is no account or registration variable of any kind: the box's identity is the Ed25519 key it generates on first boot, and relying parties verify its announces themselves (`common/attestation/verifyAnnounce.js`). Keep the owner's private key (`owner.key`) where you keep signing keys; it is what lets you authorize launches, and a launch authorization signed by any other key is simply ignored by relying parties that know your key.
