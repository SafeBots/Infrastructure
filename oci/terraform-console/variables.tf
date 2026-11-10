# Variables for the OCI two-box Safebox launch module (Console + Inner)

variable "console_image_id" {
  description = "OCID of the pre-built Nix-based Safebox Console image (outer Safebox). Must be a custom image with UEFI Secure Boot and vTPM support."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.image\\.", var.console_image_id))
    error_message = "console_image_id must be an OCI image OCID."
  }
}

variable "inner_image_id" {
  description = "OCID of the pre-built hardened inner Safebox image. Must be a custom image with UEFI Secure Boot and vTPM support."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.image\\.", var.inner_image_id))
    error_message = "inner_image_id must be an OCI image OCID."
  }
}

variable "compartment_id" {
  description = "OCI compartment OCID for all resources"
  type        = string
}

variable "subnet_id" {
  description = "Subnet OCID to launch both instances in. Must be the same subnet so they share a private network."
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

# --- Console shape ---

variable "console_shape" {
  description = "OCI compute shape for the Console. The Console is lightweight."
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "console_shape_ocpus" {
  description = "Number of OCPUs for the Console flex shape"
  type        = number
  default     = 2
}

variable "console_shape_memory_in_gbs" {
  description = "Memory in GB for the Console flex shape"
  type        = number
  default     = 8
}

variable "console_boot_volume_size_gb" {
  description = "Size of the Console boot volume in GB. The Nix store is compact."
  type        = number
  default     = 50
}

variable "console_data_volume_size_gb" {
  description = "Size of the Console data volume (GB). Stores keys, audit logs, allowlist state."
  type        = number
  default     = 50

  validation {
    condition     = var.console_data_volume_size_gb >= 20
    error_message = "The Console data volume must be at least 20 GB."
  }
}

# --- Inner shape ---

variable "shape" {
  description = "OCI compute shape for the inner Safebox"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "shape_ocpus" {
  description = "Number of OCPUs for the inner Safebox flex shape"
  type        = number
  default     = 4
}

variable "shape_memory_in_gbs" {
  description = "Memory in GB for the inner Safebox flex shape"
  type        = number
  default     = 32
}

variable "boot_volume_size_gb" {
  description = "Size of the inner Safebox boot volume in GB"
  type        = number
  default     = 50
}

variable "data_volume_size_gb" {
  description = "Size of the inner Safebox data volume for the ZFS pool (GB)"
  type        = number
  default     = 200

  validation {
    condition     = var.data_volume_size_gb >= 50
    error_message = "The data volume must be at least 50 GB."
  }
}

# --- Shared options ---

variable "assign_public_ip" {
  description = "Assign public IPs to both instances"
  type        = bool
  default     = false
}

variable "confidential_compute_type" {
  description = "Confidential compute type: SEV_SNP (default), SEV, or NONE to disable."
  type        = string
  default     = "SEV_SNP"

  validation {
    condition     = contains(["SEV", "SEV_SNP", "NONE"], var.confidential_compute_type)
    error_message = "confidential_compute_type must be SEV, SEV_SNP, or NONE."
  }
}

variable "skip_memory_encryption" {
  description = "Set true to disable AMD memory encryption. Default (false) enables it when confidential_compute_type != NONE."
  type        = bool
  default     = false
}

variable "allow_http" {
  description = "Also open inbound TCP 80 on both instances (ACME HTTP-01)"
  type        = bool
  default     = false
}
