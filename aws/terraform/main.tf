# Safebox Instance Launch Module — AWS
#
# Launches an EC2 instance from a pre-built, hardened safebox AMI. It does NOT
# build images (the bash scripts do that) and it runs NO startup script on the
# instance: the only thing passed to the box is a small JSON object of metadata
# that safebox-firstboot.service reads and never executes (docs/HARDENING-PLAN.md
# fix 2). Secure Boot, the measured verity root, and the vTPM come from the AMI
# itself (registered with --boot-mode uefi --tpm-support v2.0 and a Secure Boot
# variable store); there is no per-instance toggle for those on AWS.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31"
    }
  }
}

# -----------------------------------------------------------------------------
# Security group — HTTPS and the challenge endpoint only, no SSH
# -----------------------------------------------------------------------------
resource "aws_security_group" "safebox" {
  name        = "safebox-${var.safebox_id}"
  description = "Safebox instance: HTTPS (443) and challenge endpoint (8443) only"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Safebox announce challenge endpoint (relying parties verify the announced IP here)"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Port 80 only when allow_http is set: autovhost's ACME HTTP-01 challenge
  # and its HTTP splash page need it on boxes that serve custom domains.
  # Off by default to keep the contract's two-port firewall.
  dynamic "ingress" {
    for_each = var.allow_http ? [1] : []
    content {
      description = "HTTP (autovhost ACME HTTP-01 and splash)"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # NOTE: This single-box module has wide-open egress. For governed egress
  # control (inner Safebox restricted to outer Console only), use the two-box
  # module at aws/terraform-console/ instead.
  egress {
    description = "All outbound (announces to the Safenet log and DNS relays; the package-free box needs only API egress)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "safebox-${var.safebox_id}"
  }
}

data "aws_subnet" "selected" {
  id = var.subnet_id
}

# -----------------------------------------------------------------------------
# EBS data volume — ZFS pool backing store, created EMPTY
# -----------------------------------------------------------------------------
# No filesystem and no partition table: the first boot's initramfs selects the
# single unformatted disk >= 50 GB (safebox.datadisk=auto) and creates the
# encrypted pool on it. Terraform must therefore never format or partition it.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "safebox-${var.safebox_id}-data"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.safebox.id
}

# -----------------------------------------------------------------------------
# EC2 instance
# -----------------------------------------------------------------------------
resource "aws_instance" "safebox" {
  ami           = var.ami_id
  instance_type = var.instance_type
  subnet_id     = var.subnet_id

  vpc_security_group_ids = [aws_security_group.safebox.id]

  # No key pair: production safeboxes have no shell and no SSH.
  key_name = null

  # Termination protection is off by default (a box that fails is replaced, not
  # repaired); operators may turn it on per instance.
  disable_api_termination = var.disable_api_termination

  # Optional IAM instance profile (e.g. for KMS or S3 access from the box).
  iam_instance_profile = var.iam_instance_profile

  # IMDSv2 required; hop limit 1 so a container cannot reach the metadata
  # service through the host (second layer behind the nftables DROP). Instance
  # tags are NOT exposed via IMDS.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  # Confidential compute (AMD SEV-SNP). Off by default (the user's rule:
  # boolean options default to falsy). Only valid on m6a/c6a/r6a instance
  # types; enabling it on other types will fail at apply time.
  cpu_options {
    amd_sev_snp = var.skip_confidential_compute ? "disabled" : "enabled"
  }

  # Metadata the box reads on first boot. This is DATA, not a script:
  # safebox-firstboot.service fetches it via IMDSv2, validates the two keys,
  # and writes /var/lib/safebox/dns/dnsclient.json. Nothing here is executed.
  # The DNS API URL is baked into the image (/etc/safebox/defaults.json) and
  # cannot be overridden from metadata.
  user_data = jsonencode({
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
  })

  # The launch authorization expires within 24 hours and is consumed by the
  # first announce; a changed authorization should be a deliberate relaunch,
  # so do NOT replace the instance just because user_data changed, and do
  # NOT ignore_changes on it either.
  user_data_replace_on_change = false

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
  }

  tags = {
    Name = "safebox-${var.safebox_id}"
  }
}
