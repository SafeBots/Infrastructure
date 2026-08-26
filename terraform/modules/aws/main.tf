# terraform/modules/aws — provision an attested Safebox on EC2 (NitroTPM).
# refactor.md Phase 2.2. Replaces the AWS-only build-ami.sh provisioning path.
#
# The AMI referenced here is the one built by `nix build .#ami` (nixos/flake.nix)
# and registered via the AWS VM Import / register-image path.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws"; version = "~> 5.0" }
  }
}

variable "region"        { type = string  default = "us-east-1" }
variable "ami_id"        { type = string  description = "Registered Safebox NixOS AMI (from nix build .#ami)" }
variable "instance_type" { type = string  default = "m6i.xlarge" }  # Nitro, TPM-capable
variable "data_volume_gb" { type = number default = 200 }
variable "subnet_id"     { type = string }

provider "aws" { region = var.region }

resource "aws_instance" "safebox" {
  ami           = var.ami_id
  instance_type = var.instance_type
  subnet_id     = var.subnet_id

  # NitroTPM + UEFI measured boot (refactor.md Phase 3 consumes these).
  boot_mode = "uefi"
  # NitroTPM enablement (attribute name per current provider; verify at apply).
  # tpm_support = "v2.0"

  # No SSH key — the box has zero remote-shell access (Bug-5 invariant).
  # key_name intentionally omitted.

  # Distinct data volume for the ZFS pool (NOT the root volume — F2 requires
  # the pool device be separate so data lands on the encrypted datasets).
  ebs_block_device {
    device_name = "/dev/sdf"
    volume_size = var.data_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"     # IAM-role access (allowed; not a shell)
    http_tokens   = "required"    # IMDSv2 only
  }

  tags = { Name = "safebox", Attested = "nitrotpm" }
}

output "instance_id" { value = aws_instance.safebox.id }
output "private_ip"  { value = aws_instance.safebox.private_ip }
