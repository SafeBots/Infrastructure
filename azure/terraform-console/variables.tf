# Variables for the Azure two-box Safebox launch module (Console + Inner)

variable "console_image_id" {
  description = "Azure Compute Gallery image version ID for the Nix-based Safebox Console (outer Safebox). Path format: /subscriptions/.../providers/Microsoft.Compute/galleries/.../images/.../versions/..."
  type        = string

  validation {
    condition     = can(regex("^/subscriptions/[0-9a-f-]+/resourceGroups/.+/providers/Microsoft.Compute/galleries/.+/images/.+/versions/.+$", var.console_image_id))
    error_message = "console_image_id must be a full Azure Compute Gallery image version resource ID."
  }
}

variable "inner_image_id" {
  description = "Azure Compute Gallery image version ID for the hardened inner Safebox image."
  type        = string

  validation {
    condition     = can(regex("^/subscriptions/[0-9a-f-]+/resourceGroups/.+/providers/Microsoft.Compute/galleries/.+/images/.+/versions/.+$", var.inner_image_id))
    error_message = "inner_image_id must be a full Azure Compute Gallery image version resource ID."
  }
}

variable "console_vm_size" {
  description = "Azure VM size for the Console. The Console is lightweight (one Qbix app, egress proxy, Software Signer) and does not need GPU or large memory."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "vm_size" {
  description = "Azure VM size for the inner Safebox. Confidential VM (on by default) requires DCasv5/ECasv5 series; set skip_confidential_compute = true for non-CVM types."
  type        = string
  default     = "Standard_D4s_v5"
}

variable "resource_group_name" {
  description = "Name of the Azure resource group. Must already exist."
  type        = string
}

variable "location" {
  description = "Azure region (e.g. eastus2)"
  type        = string
}

variable "subnet_id" {
  description = "Subnet resource ID to attach both VMs to. Must be in the same VNet so they share a private network."
  type        = string
}

variable "safebox_id" {
  description = "Unique identifier for this safebox pair (matches ^[a-z0-9-]{3,64}$)"
  type        = string
}

variable "owner_pubkey" {
  description = "The owner's Safenet Ed25519 public key, 64 lowercase hex characters."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.owner_pubkey))
    error_message = "owner_pubkey must be 64 lowercase hex characters."
  }
}

variable "launch_authorization" {
  description = "Base64 launch_authorization OCP claim signed by the owner key, valid for at most 24 hours."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9+/=_-]{64,8192}$", var.launch_authorization))
    error_message = "launch_authorization must be base64 (64 to 8192 characters)."
  }
}

variable "data_disk_size_gb" {
  description = "Size of the inner Safebox data disk for the ZFS pool (GB). Must be >= 50."
  type        = number
  default     = 200

  validation {
    condition     = var.data_disk_size_gb >= 50
    error_message = "The data disk must be at least 50 GB."
  }
}

variable "console_data_disk_size_gb" {
  description = "Size of the Console data disk (GB). The Console stores keys, audit logs, and allowlist state; 50 GB is usually sufficient."
  type        = number
  default     = 50

  validation {
    condition     = var.console_data_disk_size_gb >= 20
    error_message = "The Console data disk must be at least 20 GB."
  }
}

variable "skip_confidential_compute" {
  description = "Set true to fall back to Trusted Launch instead of Confidential VM (AMD SEV-SNP). Default (false) enables Confidential VM on both instances."
  type        = bool
  default     = false
}

variable "encryption_at_host" {
  description = "Enable encryption at host for both VMs (encrypts temp disk, cache, and data-in-transit between host and storage)."
  type        = bool
  default     = false
}

variable "manage_deny_policies" {
  description = "Create and assign Azure Policy definitions to deny VM extensions, run commands, and boot diagnostics on safebox VMs in this resource group."
  type        = bool
  default     = false
}

variable "allow_http" {
  description = "Also open inbound TCP 80 on both VMs (ACME HTTP-01)."
  type        = bool
  default     = false
}
