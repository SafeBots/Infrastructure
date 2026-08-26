# terraform/modules/oci — attested Safebox on OCI (AMD SEV Confidential VM).
# refactor.md Phase 2.2. Image (QCOW2) from `nix build .#oci`, imported as a
# custom image. OCI has thinner first-party attestation tooling — more of the
# verification is built by us (refactor.md Phase 3, per-cloud).

terraform {
  required_providers {
    oci = { source = "oracle/oci", version = "~> 5.0" }
  }
}

variable "compartment_ocid" { type = string }
variable "availability_domain" { type = string }
variable "subnet_ocid"      { type = string }
variable "image_ocid"       { type = string  description = "Safebox NixOS custom image (from nix build .#oci)" }
variable "shape"            { type = string  default = "VM.Standard.E4.Flex" } # AMD, SEV-capable
variable "data_volume_gb"   { type = number default = 200 }

resource "oci_core_instance" "safebox" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  shape               = var.shape
  shape_config { ocpus = 4  memory_in_gbs = 16 }

  # Confidential (SEV) + measured boot options.
  platform_config {
    type                        = "AMD_VM"
    is_memory_encryption_enabled = true      # SEV memory encryption
    is_secure_boot_enabled       = true
    is_measured_boot_enabled     = true
    is_trusted_platform_module_enabled = true
  }

  source_details {
    source_type = "image"
    source_id   = var.image_ocid
  }

  create_vnic_details {
    subnet_id        = var.subnet_ocid
    assign_public_ip = false
  }

  # No SSH key in metadata — Bug-5 zero-shell invariant.
}

resource "oci_core_volume" "data" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "safebox-data"
  size_in_gbs         = var.data_volume_gb   # ZFS pool device (separate; F2)
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.safebox.id
  volume_id       = oci_core_volume.data.id
}

output "instance_id" { value = oci_core_instance.safebox.id }
output "private_ip"  { value = oci_core_instance.safebox.private_ip }
