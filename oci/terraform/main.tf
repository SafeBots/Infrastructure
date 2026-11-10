# Safebox Instance Launch Module - OCI
#
# Launches one safebox from a pre-built golden image (oci/scripts/build-image.sh)
# as a shielded instance: UEFI_64 launch mode, Secure Boot, measured boot and
# a vTPM, with every OCI agent plugin disabled, the legacy IMDS v1 endpoints
# off, and no SSH key or user-data script of any kind. The only thing passed
# to the box is three metadata keys (safebox-id, owner-pubkey and
# launch-authorization)
# that safebox-firstboot reads and validates; it never executes
# anything from metadata (docs/HARDENING-PLAN.md, fix 2).
#
# This module does not build images. There is no `ignore_changes` on
# metadata: a change to the launch authorization is a real change and must be
# visible in the plan.

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.25"
    }
  }
}

locals {
  # Platform config type: today OCI only supports AMD_VM for plain SEV.
  # When OCI ships SEV-SNP shapes, the type will be AMD_VM_SEV_SNP and the
  # guest will produce a signed VCEK attestation report.
  platform_config_type = {
    "SEV"     = "AMD_VM"
    "SEV_SNP" = "AMD_VM"  # TODO: change to "AMD_VM_SEV_SNP" when OCI adds the type
    "NONE"    = "AMD_VM"
  }

  effective_memory_encryption = var.confidential_compute_type != "NONE" && !var.skip_memory_encryption
}

data "oci_core_subnet" "selected" {
  subnet_id = var.subnet_id
}

# -----------------------------------------------------------------------------
# Network Security Group: 443 (nginx TLS) and 8443 (dnsclient challenge
# listener) inbound, everything outbound (the two-port firewall of the
# contract). Port 80 is closed unless allow_http is set; the
# autovhost component's ACME HTTP-01 challenge and its HTTP splash page
# need it, so set it on boxes that provision customer hostnames.
#
# NOTE: This single-box module has wide-open egress. For governed egress
# control (inner Safebox restricted to outer Console only), use the two-box
# module at oci/terraform-console/ instead.
# -----------------------------------------------------------------------------
resource "oci_core_network_security_group" "safebox" {
  compartment_id = var.compartment_id
  vcn_id         = data.oci_core_subnet.selected.vcn_id
  display_name   = "safebox-${var.safebox_id}-nsg"
}

resource "oci_core_network_security_group_security_rule" "https_ingress" {
  network_security_group_id = oci_core_network_security_group.safebox.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTPS"

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "challenge_ingress" {
  network_security_group_id = oci_core_network_security_group.safebox.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "dnsclient announce challenge"

  tcp_options {
    destination_port_range {
      min = 8443
      max = 8443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "http_ingress" {
  count = var.allow_http ? 1 : 0

  network_security_group_id = oci_core_network_security_group.safebox.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTP (autovhost ACME HTTP-01 and splash)"

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

resource "oci_core_network_security_group_security_rule" "all_egress" {
  network_security_group_id = oci_core_network_security_group.safebox.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "All egress"
}

# -----------------------------------------------------------------------------
# Data disk for the ZFS pool. Empty: no partition table, no filesystem. The
# initramfs on first boot selects it as the only blank disk >= 50 GB
# (safebox.datadisk=auto), creates the encrypted pool and seals the key to
# the vTPM. Terraform must never format it.
# -----------------------------------------------------------------------------
resource "oci_core_volume" "data" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-${var.safebox_id}-data"
  size_in_gbs         = var.data_volume_size_gb
  vpus_per_gb         = 20
}

resource "oci_core_volume_attachment" "data" {
  attachment_type                     = "paravirtualized"
  instance_id                         = oci_core_instance.safebox.id
  volume_id                           = oci_core_volume.data.id
  display_name                        = "safebox-${var.safebox_id}-data-attach"
  is_pv_encryption_in_transit_enabled = true
}

# -----------------------------------------------------------------------------
# Compute instance
# -----------------------------------------------------------------------------
resource "oci_core_instance" "safebox" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-${var.safebox_id}"
  shape               = var.shape

  shape_config {
    ocpus         = var.shape_ocpus
    memory_in_gbs = var.shape_memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = var.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id              = var.subnet_id
    assign_public_ip       = var.assign_public_ip
    nsg_ids                = [oci_core_network_security_group.safebox.id]
    display_name           = "safebox-${var.safebox_id}-vnic"
    hostname_label         = "safebox-${var.safebox_id}"
    skip_source_dest_check = false
  }

  # Shielded instance: UEFI firmware with Secure Boot (the image's shim is
  # signed by the Microsoft UEFI CA), measured boot into the vTPM, and the
  # vTPM itself, which the initramfs seals the pool key to.
  #
  # Confidential compute: the platform_config type controls the memory
  # encryption technology. Today only AMD_VM (plain SEV) is available on OCI
  # E4/E5 shapes — no guest attestation report. When OCI ships SEV-SNP
  # shapes, set confidential_compute_type = "SEV_SNP" and update the
  # platform_config_type map in locals to "AMD_VM_SEV_SNP"; that gives the
  # guest a signed VCEK attestation report matching Azure/GCP parity.
  platform_config {
    type                               = local.platform_config_type[var.confidential_compute_type]
    is_secure_boot_enabled             = true
    is_measured_boot_enabled           = true
    is_trusted_platform_module_enabled = true
    is_memory_encryption_enabled       = local.effective_memory_encryption
  }

  launch_options {
    boot_volume_type                    = "PARAVIRTUALIZED"
    network_type                        = "PARAVIRTUALIZED"
    is_consistent_volume_naming_enabled = true
  }
  is_pv_encryption_in_transit_enabled = true

  # The Oracle Cloud Agent is not in the image; this makes the cloud side
  # agree so no plugin (Run Command, OS Management, Bastion) is expected.
  agent_config {
    are_all_plugins_disabled = true
    is_management_disabled   = true
    is_monitoring_disabled   = true
  }

  # IMDS v1 has no request header and is reachable by anything that can
  # open a socket; only /opc/v2 with the Oracle bearer header is served.
  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  # Exactly the two keys safebox-firstboot reads. No ssh_authorized_keys,
  # no user_data: the image has no sshd and no cloud-init, and the firstboot
  # unit would ignore a script anyway. The DNS API URL is baked into the
  # image and cannot be overridden from metadata.
  metadata = {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
  }

  # A safebox is replaced, not repaired. Nothing on the boot volume is worth
  # keeping after the instance is gone: the state is on the data volume.
  preserve_boot_volume = false

  freeform_tags = {
    "safebox-id" = var.safebox_id
    "safebox"    = "true"
  }
}

# -----------------------------------------------------------------------------
# Compartment IAM policy (opt-in). The Terraform equivalent of the OCI CLI
# policy in oci/INSTRUCTIONS.md, "Step 5":
#
# The operations group gets manage access to instances, volumes, and network
# resources, and read access to images — but NOT to:
#   - instance-console-connection  (serial console)
#   - instance-agent-command-family (Run Command)
#   - bastion-family                (managed SSH)
#
# By granting only the four named resource types (not instance-family or
# compute-family, which bundle the dangerous ones), those operations fail
# with NotAuthorizedOrNotFound.
#
# Set manage_deny_policies = true, provide tenancy_id and ops_group_name.
# Needs manage-policies permission on the compartment or tenancy.
# -----------------------------------------------------------------------------
resource "oci_identity_policy" "safebox_ops" {
  count          = var.manage_deny_policies ? 1 : 0
  compartment_id = var.tenancy_id
  name           = "safebox-ops-${var.safebox_id}"
  description    = "Safebox operations: manage instances and volumes, no console connections or agent commands"

  statements = [
    "Allow group ${var.ops_group_name} to manage instances in compartment id ${var.compartment_id}",
    "Allow group ${var.ops_group_name} to manage volume-family in compartment id ${var.compartment_id}",
    "Allow group ${var.ops_group_name} to use virtual-network-family in compartment id ${var.compartment_id}",
    "Allow group ${var.ops_group_name} to read instance-images in compartment id ${var.compartment_id}",
  ]
}
