# Safebox Console Launch Module — AWS (Outer Safebox)
#
# Launches the outer Safebox Console from a pre-built Nix-based AMI. The
# Console is the Inductive Security base case: a frozen, fully open-source
# image that runs one Qbix app (the Safebox Console) and provides:
#
#   1. Governed egress proxy for the paired inner Safebox
#   2. M-of-N governance gateway with the Software Signer
#   3. Key custody (organization keys sealed to this box's TPM)
#   4. Inner Safebox provisioning via AWS APIs
#
# The Console is always deployed FIRST, and the inner Safebox module
# (aws/terraform/) references the Console's security group and private IP
# to set up the egress-only network link.
#
# The Console image is a frozen Nix derivation. It is never updated in place;
# changes go through governed succession (a new image blessed by the existing
# M-of-N quorum including the Software Signer).

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
# Security group — Console: HTTPS + inner Safebox private link
# -----------------------------------------------------------------------------
resource "aws_security_group" "console" {
  name        = "safebox-console-${var.safebox_id}"
  description = "Safebox Console: HTTPS (443), challenge (8443), inner link (9443)"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS — Console web UI"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Safebox announce challenge endpoint"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Inner Safebox private link (egress proxy + governance API)"
    from_port   = 9443
    to_port     = 9443
    protocol    = "tcp"
    # Restricted to the inner Safebox's security group
    security_groups = [aws_security_group.inner.id]
  }

  dynamic "ingress" {
    for_each = var.allow_http ? [1] : []
    content {
      description = "HTTP (ACME HTTP-01)"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # The Console needs outbound access: it is the egress gateway.
  # Its own egress allowlist is enforced at the application level
  # by the egress proxy, not at the security group level.
  egress {
    description = "All outbound (Console is the egress gateway)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "safebox-console-${var.safebox_id}"
  }
}

# -----------------------------------------------------------------------------
# Security group — Inner Safebox: egress ONLY to Console
# -----------------------------------------------------------------------------
resource "aws_security_group" "inner" {
  name        = "safebox-inner-${var.safebox_id}"
  description = "Inner Safebox: HTTPS inbound, egress only to Console"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Safebox announce challenge endpoint"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.allow_http ? [1] : []
    content {
      description = "HTTP (ACME HTTP-01)"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # CRITICAL: Inner Safebox egress is restricted to the Console only.
  # This is the cloud-level enforcement of the two-box architecture's
  # egress gap closure. The inner box's nftables rules provide the
  # second layer (defense in depth).
  egress {
    description = "Egress to Console only (governed proxy)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    security_groups = [aws_security_group.console.id]
  }

  # Allow metadata service access (needed for firstboot)
  egress {
    description = "Cloud metadata service"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["169.254.169.254/32"]
  }

  tags = {
    Name = "safebox-inner-${var.safebox_id}"
  }
}

data "aws_subnet" "selected" {
  id = var.subnet_id
}

# -----------------------------------------------------------------------------
# Console EBS data volume
# -----------------------------------------------------------------------------
resource "aws_ebs_volume" "console_data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.console_data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "safebox-console-${var.safebox_id}-data"
  }
}

resource "aws_volume_attachment" "console_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.console_data.id
  instance_id = aws_instance.console.id
}

# -----------------------------------------------------------------------------
# Inner Safebox EBS data volume
# -----------------------------------------------------------------------------
resource "aws_ebs_volume" "inner_data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "safebox-inner-${var.safebox_id}-data"
  }
}

resource "aws_volume_attachment" "inner_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.inner_data.id
  instance_id = aws_instance.inner.id
}

# -----------------------------------------------------------------------------
# Console EC2 instance (outer Safebox)
# -----------------------------------------------------------------------------
resource "aws_instance" "console" {
  ami           = var.console_ami_id
  instance_type = var.console_instance_type
  subnet_id     = var.subnet_id

  vpc_security_group_ids = [aws_security_group.console.id]

  key_name = null

  disable_api_termination = var.disable_api_termination

  iam_instance_profile = var.console_iam_instance_profile

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  cpu_options {
    amd_sev_snp = var.skip_confidential_compute ? "disabled" : "enabled"
  }

  user_data = jsonencode({
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "console"
  })

  user_data_replace_on_change = false

  root_block_device {
    volume_type = "gp3"
    volume_size = var.console_root_volume_size_gb
    encrypted   = true
  }

  tags = {
    Name = "safebox-console-${var.safebox_id}"
    Role = "console"
  }
}

# -----------------------------------------------------------------------------
# Inner Safebox EC2 instance
# -----------------------------------------------------------------------------
resource "aws_instance" "inner" {
  ami           = var.inner_ami_id
  instance_type = var.instance_type
  subnet_id     = var.subnet_id

  vpc_security_group_ids = [aws_security_group.inner.id]

  key_name = null

  disable_api_termination = var.disable_api_termination

  iam_instance_profile = var.iam_instance_profile

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  cpu_options {
    amd_sev_snp = var.skip_confidential_compute ? "disabled" : "enabled"
  }

  # The inner Safebox gets the Console's private IP in metadata so
  # safebox-firstboot can write /etc/safebox/console-ip, which the
  # inner egress nftables rules use as the sole allowed destination.
  user_data = jsonencode({
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "inner"
    "console-ip"           = aws_instance.console.private_ip
  })

  user_data_replace_on_change = false

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
  }

  tags = {
    Name = "safebox-inner-${var.safebox_id}"
    Role = "inner"
  }

  depends_on = [aws_instance.console]
}
