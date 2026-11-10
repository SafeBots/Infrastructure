# Variables for the GCP two-box Safebox launch module (Console + Inner)

variable "console_image_self_link" {
  description = "Self-link of the Nix-based Safebox Console image (outer Safebox). Must name one image, not a family."
  type        = string

  validation {
    condition     = can(regex("^(https://www\\.googleapis\\.com/compute/v1/)?projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/global/images/[a-z]([-a-z0-9]*[a-z0-9])?$", var.console_image_self_link))
    error_message = "console_image_self_link must name one image: projects/<project>/global/images/<name>. Families are rejected."
  }
}

variable "inner_image_self_link" {
  description = "Self-link of the hardened inner Safebox image (standard Safebox with inner egress rules). Must name one image, not a family."
  type        = string

  validation {
    condition     = can(regex("^(https://www\\.googleapis\\.com/compute/v1/)?projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/global/images/[a-z]([-a-z0-9]*[a-z0-9])?$", var.inner_image_self_link))
    error_message = "inner_image_self_link must name one image: projects/<project>/global/images/<name>. Families are rejected."
  }
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "zone" {
  description = "GCE zone (both instances launch in the same zone)"
  type        = string
  default     = "us-central1-a"
}

variable "console_machine_type" {
  description = "GCE machine type for the Console. Lightweight: one Qbix app, egress proxy, Software Signer."
  type        = string
  default     = "e2-standard-2"
}

variable "machine_type" {
  description = "GCE machine type for the inner Safebox. Confidential compute needs n2d."
  type        = string
  default     = "e2-standard-4"
}

variable "network" {
  description = "VPC network name or self-link"
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "VPC subnetwork name or self-link"
  type        = string
  default     = "default"
}

variable "safebox_id" {
  description = "Identifier for this safebox pair"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,64}$", var.safebox_id))
    error_message = "safebox_id must match ^[a-z0-9-]{3,64}$."
  }
}

variable "owner_pubkey" {
  description = "Owner's Safenet Ed25519 public key, 64 lowercase hex characters."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.owner_pubkey))
    error_message = "owner_pubkey must be 64 lowercase hex characters."
  }
}

variable "launch_authorization" {
  description = "Base64 launch_authorization OCP claim, valid for at most 24 hours."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9+/=_-]{64,8192}$", var.launch_authorization))
    error_message = "launch_authorization must be base64 (64 to 8192 characters)."
  }
}

variable "data_disk_size_gb" {
  description = "Size of the inner Safebox data disk for the ZFS pool (GB). Minimum 50."
  type        = number
  default     = 200

  validation {
    condition     = var.data_disk_size_gb >= 50
    error_message = "data_disk_size_gb must be at least 50."
  }
}

variable "console_data_disk_size_gb" {
  description = "Size of the Console data disk (GB). Stores keys, audit logs, allowlist state."
  type        = number
  default     = 50

  validation {
    condition     = var.console_data_disk_size_gb >= 20
    error_message = "console_data_disk_size_gb must be at least 20."
  }
}

variable "boot_disk_size_gb" {
  description = "Inner Safebox boot disk size (GB)"
  type        = number
  default     = 20
}

variable "console_boot_disk_size_gb" {
  description = "Console boot disk size (GB). The Nix store is compact."
  type        = number
  default     = 15
}

variable "skip_confidential_compute" {
  description = "Set true to disable Confidential VM (AMD SEV-SNP). Default (false) enables it. Requires n2d machine types."
  type        = bool
  default     = false
}

variable "allow_http" {
  description = "Also open inbound TCP 80 on both instances (ACME HTTP-01)."
  type        = bool
  default     = false
}
