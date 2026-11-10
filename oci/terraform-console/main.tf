# Safebox Console Launch Module — OCI (Outer + Inner Safebox pair)
#
# Launches the two-box Safebox architecture on OCI:
#
#   1. Outer Safebox Console — frozen Nix image, governance gateway, egress
#      proxy, key custody, Software Signer (Inductive Security base case).
#   2. Inner Safebox — standard hardened image, runs N apps / models / plugins,
#      ZERO direct internet egress (all outbound goes through the Console).
#
# The Console is deployed first; the inner Safebox references its private IP
# for the egress-only network link. Both are shielded instances with vTPM,
# Secure Boot, and measured boot.
#
# This module does not build images and does not run anything inside either VM.

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

# =============================================================================
# Console NSG — HTTPS, challenge, inner private link, full egress
# =============================================================================
resource "oci_core_network_security_group" "console" {
  compartment_id = var.compartment_id
  vcn_id         = data.oci_core_subnet.selected.vcn_id
  display_name   = "safebox-console-${var.safebox_id}-nsg"
}

resource "oci_core_network_security_group_security_rule" "console_https_in" {
  network_security_group_id = oci_core_network_security_group.console.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTPS — Console web UI"

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "console_challenge_in" {
  network_security_group_id = oci_core_network_security_group.console.id
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

resource "oci_core_network_security_group_security_rule" "console_inner_link_in" {
  network_security_group_id = oci_core_network_security_group.console.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = oci_core_network_security_group.inner.id
  source_type               = "NETWORK_SECURITY_GROUP"
  description               = "Inner Safebox private link (egress proxy + governance API)"

  tcp_options {
    destination_port_range {
      min = 9443
      max = 9443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "console_http_in" {
  count = var.allow_http ? 1 : 0

  network_security_group_id = oci_core_network_security_group.console.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTP (ACME HTTP-01)"

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

# Console has full egress — it IS the egress gateway.
# Application-level allowlist enforced by the egress proxy service.
resource "oci_core_network_security_group_security_rule" "console_all_egress" {
  network_security_group_id = oci_core_network_security_group.console.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "All egress (Console is the egress gateway)"
}

# =============================================================================
# Inner NSG — HTTPS in, egress ONLY to Console
# =============================================================================
resource "oci_core_network_security_group" "inner" {
  compartment_id = var.compartment_id
  vcn_id         = data.oci_core_subnet.selected.vcn_id
  display_name   = "safebox-inner-${var.safebox_id}-nsg"
}

resource "oci_core_network_security_group_security_rule" "inner_https_in" {
  network_security_group_id = oci_core_network_security_group.inner.id
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

resource "oci_core_network_security_group_security_rule" "inner_challenge_in" {
  network_security_group_id = oci_core_network_security_group.inner.id
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

resource "oci_core_network_security_group_security_rule" "inner_http_in" {
  count = var.allow_http ? 1 : 0

  network_security_group_id = oci_core_network_security_group.inner.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTP (ACME HTTP-01)"

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

# CRITICAL: Inner egress restricted to Console NSG only.
# Cloud-level enforcement of the two-box egress gap closure.
# Belt-and-suspenders with the inner box's nftables OUTPUT deny-all.
resource "oci_core_network_security_group_security_rule" "inner_console_egress" {
  network_security_group_id = oci_core_network_security_group.inner.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = oci_core_network_security_group.console.id
  destination_type          = "NETWORK_SECURITY_GROUP"
  description               = "Egress to Console only (governed proxy)"
}

# Allow metadata service for firstboot (169.254.169.254)
resource "oci_core_network_security_group_security_rule" "inner_metadata_egress" {
  network_security_group_id = oci_core_network_security_group.inner.id
  direction                 = "EGRESS"
  protocol                  = "6"
  destination               = "169.254.169.254/32"
  destination_type          = "CIDR_BLOCK"
  description               = "Cloud metadata service (firstboot)"

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

# =============================================================================
# Console data volume
# =============================================================================
resource "oci_core_volume" "console_data" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-console-${var.safebox_id}-data"
  size_in_gbs         = var.console_data_volume_size_gb
  vpus_per_gb         = 20
}

resource "oci_core_volume_attachment" "console_data" {
  attachment_type                     = "paravirtualized"
  instance_id                         = oci_core_instance.console.id
  volume_id                           = oci_core_volume.console_data.id
  display_name                        = "safebox-console-${var.safebox_id}-data-attach"
  is_pv_encryption_in_transit_enabled = true
}

# =============================================================================
# Inner data volume
# =============================================================================
resource "oci_core_volume" "inner_data" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-inner-${var.safebox_id}-data"
  size_in_gbs         = var.data_volume_size_gb
  vpus_per_gb         = 20
}

resource "oci_core_volume_attachment" "inner_data" {
  attachment_type                     = "paravirtualized"
  instance_id                         = oci_core_instance.inner.id
  volume_id                           = oci_core_volume.inner_data.id
  display_name                        = "safebox-inner-${var.safebox_id}-data-attach"
  is_pv_encryption_in_transit_enabled = true
}

# =============================================================================
# Console instance (outer Safebox)
# =============================================================================
resource "oci_core_instance" "console" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-console-${var.safebox_id}"
  shape               = var.console_shape

  shape_config {
    ocpus         = var.console_shape_ocpus
    memory_in_gbs = var.console_shape_memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = var.console_image_id
    boot_volume_size_in_gbs = var.console_boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id              = var.subnet_id
    assign_public_ip       = var.assign_public_ip
    nsg_ids                = [oci_core_network_security_group.console.id]
    display_name           = "safebox-console-${var.safebox_id}-vnic"
    hostname_label         = "safebox-console-${var.safebox_id}"
    skip_source_dest_check = false
  }

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

  agent_config {
    are_all_plugins_disabled = true
    is_management_disabled   = true
    is_monitoring_disabled   = true
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "console"
  }

  preserve_boot_volume = false

  freeform_tags = {
    "safebox-id" = var.safebox_id
    "safebox"    = "true"
    "role"       = "console"
  }
}

# =============================================================================
# Inner Safebox instance
# =============================================================================
resource "oci_core_instance" "inner" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_core_subnet.selected.availability_domain
  display_name        = "safebox-inner-${var.safebox_id}"
  shape               = var.shape

  shape_config {
    ocpus         = var.shape_ocpus
    memory_in_gbs = var.shape_memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = var.inner_image_id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id              = var.subnet_id
    assign_public_ip       = var.assign_public_ip
    nsg_ids                = [oci_core_network_security_group.inner.id]
    display_name           = "safebox-inner-${var.safebox_id}-vnic"
    hostname_label         = "safebox-inner-${var.safebox_id}"
    skip_source_dest_check = false
  }

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

  agent_config {
    are_all_plugins_disabled = true
    is_management_disabled   = true
    is_monitoring_disabled   = true
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  # Inner Safebox metadata includes console-ip so safebox-firstboot can write
  # /etc/safebox/console-ip, which the inner egress nftables rules use.
  metadata = {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "inner"
    "console-ip"           = oci_core_instance.console.private_ip
  }

  preserve_boot_volume = false

  freeform_tags = {
    "safebox-id" = var.safebox_id
    "safebox"    = "true"
    "role"       = "inner"
  }

  depends_on = [oci_core_instance.console]
}
