# Variables for the OCI safebox launch module

variable "image_id" {
  description = "OCID of the safebox golden image (built by oci/scripts/build-image.sh, launch mode UEFI_64). Must be an image OCID from manifests/, never a display name or a platform image lookup."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.image\\.oc[0-9]+\\.[a-z0-9-]*\\.[a-z0-9]{40,}$", var.image_id))
    error_message = "image_id must be a custom image OCID of the form ocid1.image.oc<realm>.<region>.<unique> (the region part may be empty). Names and data-source lookups are rejected on purpose: only a pinned OCID ties the launch to a recorded root hash."
  }
}

variable "compartment_id" {
  description = "Compartment OCID the instance, volume and NSG are created in"
  type        = string
}

variable "subnet_id" {
  description = "Subnet OCID to launch the instance in; its availability domain is used for the volume"
  type        = string
}

variable "safebox_id" {
  description = "Identifier of this safebox, ^[a-z0-9-]{3,64}$; delivered as the safebox-id metadata key"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,64}$", var.safebox_id))
    error_message = "safebox_id must match ^[a-z0-9-]{3,64}$."
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

variable "shape" {
  description = "Compute shape; must support shielded instances (VM.Standard.E4.Flex or VM.Standard.E5.Flex)"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "shape_ocpus" {
  description = "OCPUs for the flex shape"
  type        = number
  default     = 4
}

variable "shape_memory_in_gbs" {
  description = "Memory in GB for the flex shape"
  type        = number
  default     = 64
}

variable "boot_volume_size_gb" {
  description = "Boot volume size in GB (the image is a few GB; OCI minimum is 50)"
  type        = number
  default     = 50
}

variable "data_volume_size_gb" {
  description = "Size in GB of the empty block volume that becomes the ZFS pool on first boot; at least 50"
  type        = number
  default     = 200

  validation {
    condition     = var.data_volume_size_gb >= 50
    error_message = "data_volume_size_gb must be at least 50; the initramfs only adopts blank disks of 50 GB or more."
  }
}

variable "assign_public_ip" {
  description = "Give the VNIC a public IP; the DNS API's announce challenge reaches the box on 8443"
  type        = bool
  default     = true
}

variable "allow_http" {
  description = "Also open port 80 in the NSG, needed only when the autovhost component serves ACME HTTP-01 challenges and the HTTP splash"
  type        = bool
  default     = false
}

variable "skip_memory_encryption" {
  description = "Set true to disable AMD memory encryption (platform_config.is_memory_encryption_enabled). Default (false) enables it when confidential_compute_type != NONE."
  type        = bool
  default     = false
}

variable "confidential_compute_type" {
  description = <<-EOT
    Memory encryption technology to request. Controls the platform_config type
    and the availability of a guest attestation report.

    "SEV_SNP" — AMD SEV-SNP (default). Per-VM keys with guest attestation via
                a signed VCEK report. Requires shapes that support SEV-SNP.
    "SEV"     — AMD SEV (fallback for E4/E5 Flex shapes). Memory is encrypted
                with per-VM keys but no guest attestation report is produced;
                the image refuses to announce (MEMORY_NOT_ENCRYPTED) unless
                built with allowUnencryptedMemory.
    "NONE"    — No memory encryption; for dev/test only. skip_memory_encryption
                is forced true regardless of its setting.
  EOT
  type        = string
  default     = "SEV_SNP"

  validation {
    condition     = contains(["SEV", "SEV_SNP", "NONE"], var.confidential_compute_type)
    error_message = "confidential_compute_type must be one of: SEV, SEV_SNP, NONE."
  }
}

variable "manage_deny_policies" {
  description = "Create the compartment IAM policy that restricts operations to the safebox contract: manage instances and volumes, use networks, read images — but no console connections, no agent commands, and no bastion sessions (the same grants as oci/INSTRUCTIONS.md, \"Step 5\"). Needs manage-policies permission on the compartment or tenancy. Leaving this false means the operator must create the policy from INSTRUCTIONS.md themselves; the instance is launched either way."
  type        = bool
  default     = false
}

variable "tenancy_id" {
  description = "Tenancy OCID (required when manage_deny_policies = true; the policy is created at tenancy scope so the compartment reference resolves)"
  type        = string
  default     = ""
}

variable "ops_group_name" {
  description = "Name of the OCI IAM group to grant safebox operations permissions to (only used when manage_deny_policies = true)"
  type        = string
  default     = "safebox-ops"
}
