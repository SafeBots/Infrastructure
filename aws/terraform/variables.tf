# Variables for the AWS safebox launch module

variable "ami_id" {
  description = "AMI ID of the pre-built hardened safebox image (registered with UEFI boot mode, TPM v2.0, and a Secure Boot variable store). Must be a literal ami-... id from manifests/, never a name or filter: the module launches exactly the image whose root hash was recorded."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be a literal AMI id (ami- followed by 8 to 17 hex digits). Names, filters and aliases are rejected on purpose: only a pinned id ties the launch to a recorded root hash."
  }
}

variable "instance_type" {
  description = "EC2 instance type. Must be Nitro (for NitroTPM). Confidential compute (on by default) requires m6a/c6a/r6a; set skip_confidential_compute = true for non-SEV types."
  type        = string
  default     = "m5.xlarge"
}

variable "subnet_id" {
  description = "VPC subnet to launch the instance in"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the security group"
  type        = string
}

variable "safebox_id" {
  description = "Unique identifier for this safebox instance (matches ^[a-z0-9-]{3,64}$)"
  type        = string
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

variable "data_volume_size_gb" {
  description = "Size of the EBS data volume for the ZFS pool (GB). Created empty; the first boot formats it. Must be >= 50."
  type        = number
  default     = 200

  validation {
    condition     = var.data_volume_size_gb >= 50
    error_message = "The data volume must be at least 50 GB (the first-boot pool selector requires a >= 50 GB unformatted disk)."
  }
}

variable "root_volume_size_gb" {
  description = "Size of the root (verity image) volume in GB"
  type        = number
  default     = 30
}

variable "skip_confidential_compute" {
  description = "Set true to disable AMD SEV-SNP confidential compute. Default (false) enables SEV-SNP. Only valid on m6a/c6a/r6a instance types; the image refuses to register (MEMORY_NOT_ENCRYPTED) when launched without SEV-SNP unless it was built with allowUnencryptedMemory."
  type        = bool
  default     = false
}

variable "disable_api_termination" {
  description = "Enable EC2 termination protection. Defaults to false: a safebox that fails is replaced, not repaired."
  type        = bool
  default     = false
}

variable "iam_instance_profile" {
  description = "Optional IAM instance profile name to attach (e.g. for KMS/S3 access). Null means none."
  type        = string
  default     = null
}

variable "allow_http" {
  description = "Also open inbound TCP 80. Needed only when autovhost serves custom domains (ACME HTTP-01 challenges and the HTTP splash page); off by default to keep the contract's two-port firewall. Same name on all four modules."
  type        = bool
  default     = false
}
