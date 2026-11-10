# Variables for the Azure safebox launch module.

variable "image_id" {
  description = "Resource id of the Compute Gallery image VERSION built by azure/scripts/build-image.sh (/subscriptions/.../galleries/<gallery>/images/<definition>/versions/<v>). Must be a Specialized, TrustedLaunch (or ConfidentialVMSupported) definition."
  type        = string

  validation {
    condition     = can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.Compute/galleries/[^/]+/images/[^/]+/versions/[0-9]+\\.[0-9]+\\.[0-9]+$", var.image_id))
    error_message = "image_id must be a Compute Gallery image version id; plain managed images cannot launch Trusted Launch VMs."
  }
}

variable "vm_size" {
  description = "VM size. Must support Trusted Launch (Gen2). Confidential compute (on by default) requires a confidential size: DCasv5/DCadsv5/ECasv5/ECadsv5 (AMD SEV-SNP) or DCesv5/ECesv5 (Intel TDX); set skip_confidential_compute = true for non-CVM types."
  type        = string
  default     = "Standard_D4s_v5"
}

variable "resource_group_name" {
  description = "Resource group to deploy into. A dedicated subscription is recommended (see INSTRUCTIONS.md, policy section)."
  type        = string
}

variable "location" {
  description = "Azure region. Must match the gallery image version's target region."
  type        = string
  default     = "eastus"
}

variable "subnet_id" {
  description = "Subnet resource id for the NIC."
  type        = string
}

variable "safebox_id" {
  description = "Identifier of this safebox; becomes the safebox-id metadata key."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,64}$", var.safebox_id))
    error_message = "safebox_id must match ^[a-z0-9-]{3,64}$ (the first-boot unit rejects anything else)."
  }
}

variable "owner_pubkey" {
  description = "The owner's Safenet Ed25519 public key, 64 lowercase hex characters (tools/dns-relay/authorize.js keygen). Delivered as the owner-pubkey metadata key; not a secret."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.owner_pubkey))
    error_message = "owner_pubkey must be 64 lowercase hex characters."
  }
}

variable "launch_authorization" {
  description = "Base64 launch_authorization OCP claim signed by the owner key for this safebox_id (tools/dns-relay/authorize.js sign), valid for at most 24 hours. Delivered as the launch-authorization metadata key. Marked sensitive to keep it out of plan output, though it is a signed public statement, not a credential: nothing can be obtained with it except announcing this one box within its window."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9+/=_-]{64,8192}$", var.launch_authorization))
    error_message = "launch_authorization must be base64 (64 to 8192 characters)."
  }
}

variable "data_disk_size_gb" {
  description = "Size of the empty data disk the first boot turns into the encrypted ZFS pool. At least 50 GB (the initramfs ignores smaller disks)."
  type        = number
  default     = 200

  validation {
    condition     = var.data_disk_size_gb >= 50
    error_message = "data_disk_size_gb must be at least 50."
  }
}

variable "skip_confidential_compute" {
  description = "Set true to fall back to Trusted Launch instead of Confidential VM (AMD SEV-SNP / Intel TDX). Default (false) enables Confidential VM. Requires a confidential vm_size and a gallery image definition created with SecurityType=ConfidentialVMSupported. The image refuses to register (MEMORY_NOT_ENCRYPTED) when launched without confidential compute unless it was built with allowUnencryptedMemory."
  type        = bool
  default     = false
}

variable "encryption_at_host" {
  description = "Encrypt the OS and data disk caches on the host with platform keys. Requires the Microsoft.Compute/EncryptionAtHost feature to be registered on the subscription (az feature register --namespace Microsoft.Compute --name EncryptionAtHost)."
  type        = bool
  default     = false
}

variable "allow_http" {
  description = "Also open inbound TCP 80. Needed only if autovhost's HTTP-01 ACME challenges and the HTTP splash page must be reachable; off by default to keep the contract's two-port firewall."
  type        = bool
  default     = false
}

variable "manage_deny_policies" {
  description = "Define and assign, at resource-group scope, the Azure Policies that deny VM extensions, run commands, and boot diagnostics (the same rules as azure/INSTRUCTIONS.md, \"Cloud-level policy\"). A Specialized image cannot carry osProfile, so provisionVMAgent=false and allowExtensionOperations=false cannot be set on the VM; these policies are the control-plane half of the compensating control. Needs Resource Policy Contributor on the subscription and resource group. Leaving this false means the operator must assign the policies from INSTRUCTIONS.md themselves (subscription scope recommended); the VM is launched either way."
  type        = bool
  default     = false
}
