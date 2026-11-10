# Variables for the AWS two-box Safebox launch module (Console + Inner)

variable "console_ami_id" {
  description = "AMI ID of the pre-built Nix-based Safebox Console image (outer Safebox). Must be the frozen Nix derivation image registered with UEFI boot mode and TPM v2.0."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.console_ami_id))
    error_message = "console_ami_id must be a literal AMI id (ami- followed by 8 to 17 hex digits)."
  }
}

variable "inner_ami_id" {
  description = "AMI ID of the pre-built hardened inner Safebox image (standard Safebox image with inner egress rules). Must be registered with UEFI boot mode, TPM v2.0, and Secure Boot."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.inner_ami_id))
    error_message = "inner_ami_id must be a literal AMI id (ami- followed by 8 to 17 hex digits)."
  }
}

variable "console_instance_type" {
  description = "EC2 instance type for the Console. The Console is lightweight (one Qbix app, egress proxy, Software Signer) and does not need GPU or large memory."
  type        = string
  default     = "m5.large"
}

variable "instance_type" {
  description = "EC2 instance type for the inner Safebox. Must be Nitro. Confidential compute (on by default) requires m6a/c6a/r6a; set skip_confidential_compute = true for non-SEV types."
  type        = string
  default     = "m5.xlarge"
}

variable "subnet_id" {
  description = "VPC subnet to launch both instances in. Must be the same subnet so they share a private network."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the security groups"
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

variable "data_volume_size_gb" {
  description = "Size of the inner Safebox EBS data volume for the ZFS pool (GB). Must be >= 50."
  type        = number
  default     = 200

  validation {
    condition     = var.data_volume_size_gb >= 50
    error_message = "The data volume must be at least 50 GB."
  }
}

variable "console_data_volume_size_gb" {
  description = "Size of the Console EBS data volume (GB). The Console stores keys, audit logs, and allowlist state; 50 GB is usually sufficient."
  type        = number
  default     = 50

  validation {
    condition     = var.console_data_volume_size_gb >= 20
    error_message = "The Console data volume must be at least 20 GB."
  }
}

variable "root_volume_size_gb" {
  description = "Size of the inner Safebox root (verity image) volume in GB"
  type        = number
  default     = 30
}

variable "console_root_volume_size_gb" {
  description = "Size of the Console root volume in GB. The Nix store is compact."
  type        = number
  default     = 20
}

variable "skip_confidential_compute" {
  description = "Set true to disable AMD SEV-SNP confidential compute. Default (false) enables SEV-SNP on both instances."
  type        = bool
  default     = false
}

variable "disable_api_termination" {
  description = "Enable EC2 termination protection on both instances."
  type        = bool
  default     = false
}

variable "iam_instance_profile" {
  description = "Optional IAM instance profile for the inner Safebox."
  type        = string
  default     = null
}

variable "console_iam_instance_profile" {
  description = "Optional IAM instance profile for the Console (needed if the Console provisions inner Safeboxes via AWS APIs)."
  type        = string
  default     = null
}

variable "allow_http" {
  description = "Also open inbound TCP 80 on both instances (ACME HTTP-01)."
  type        = bool
  default     = false
}
