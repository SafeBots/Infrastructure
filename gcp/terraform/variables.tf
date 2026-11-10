# Variables for the GCP safebox launch module

variable "image_self_link" {
  description = "Self-link (or projects/<project>/global/images/<name>) of one NAMED safebox image from manifests/. Image families (.../images/family/<f>) are rejected: a family resolves to whatever image was pushed last, so an attacker or a mistake that adds an image to the family would change what this module launches without any change to the Terraform state. Pin the name; the root hash in the manifest is only meaningful for a pinned image."
  type        = string

  validation {
    condition     = can(regex("^(https://www\\.googleapis\\.com/compute/v1/)?projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/global/images/[a-z]([-a-z0-9]*[a-z0-9])?$", var.image_self_link))
    error_message = "image_self_link must name one image: projects/<project>/global/images/<name> (optionally prefixed with https://www.googleapis.com/compute/v1/). Image families (images/family/<name>) are rejected on purpose; see gcp/INSTRUCTIONS.md."
  }
}

variable "project_id" {
  description = "GCP project ID (use a project dedicated to safeboxes; see gcp/INSTRUCTIONS.md)"
  type        = string
}

variable "zone" {
  description = "GCE zone"
  type        = string
  default     = "us-central1-a"
}

variable "machine_type" {
  description = "GCE machine type. Confidential compute (SEV-SNP) needs an n2d type."
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
  description = "Identifier of this safebox; delivered as the safebox-id metadata key"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,64}$", var.safebox_id))
    error_message = "safebox_id must match ^[a-z0-9-]{3,64}$ (the format safebox-firstboot validates)."
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
  description = "Size of the empty data disk the first boot turns into the encrypted ZFS pool (GB). Minimum 50."
  type        = number
  default     = 200

  validation {
    condition     = var.data_disk_size_gb >= 50
    error_message = "data_disk_size_gb must be at least 50; the initramfs ignores smaller disks."
  }
}

variable "boot_disk_size_gb" {
  description = "Boot disk size (GB); must be at least the captured image's disk size"
  type        = number
  default     = 20
}

variable "skip_confidential_compute" {
  description = "Set true to disable Confidential VM (AMD SEV-SNP). Default (false) enables it. Requires an n2d machine type. The image refuses to register (MEMORY_NOT_ENCRYPTED) when launched without SEV-SNP unless it was built with allowUnencryptedMemory."
  type        = bool
  default     = false
}

variable "allow_http" {
  description = "Also open port 80 for autovhost's ACME HTTP-01 challenges and HTTP splash page"
  type        = bool
  default     = false
}

variable "manage_deny_policies" {
  description = "Create and enforce, at project scope, the organization policy constraints and IAM deny policy that lock down serial ports, require Shielded VMs, and restrict metadata writes (the same rules as gcp/INSTRUCTIONS.md, \"Project policy\"). Needs Organization Policy Administrator and IAM Deny Admin on the project. Leaving this false means the operator must apply the gcloud commands from INSTRUCTIONS.md themselves; the instance is launched either way."
  type        = bool
  default     = false
}

variable "deploy_service_account_email" {
  description = "Email of the deploy service account exempted from the metadata deny policy (only used when manage_deny_policies = true). This is the SA that runs terraform apply; it must still be able to set instance metadata."
  type        = string
  default     = ""
}

variable "project_number" {
  description = "Numeric GCP project number (required when manage_deny_policies = true; used as the IAM deny policy attachment point)"
  type        = string
  default     = ""
}
