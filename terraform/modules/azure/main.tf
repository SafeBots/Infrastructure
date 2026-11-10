# terraform/modules/azure — attested Safebox on Azure Confidential VM (SEV-SNP/TDX).
# refactor.md Phase 2.2. Image (VHD) from `nix build .#azure`.

terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.0" }
  }
}

variable "resource_group" { type = string }
variable "location"       { type = string  default = "eastus" }
variable "image_id"       { type = string  description = "Safebox NixOS managed image (from nix build .#azure VHD)" }
variable "vm_size"        { type = string  default = "Standard_DC4as_v5" } # SEV-SNP confidential
variable "subnet_id"      { type = string }
variable "data_disk_gb"   { type = number  default = 200 }

provider "azurerm" { features {} }

resource "azurerm_network_interface" "safebox" {
  name                = "safebox-nic"
  location            = var.location
  resource_group_name = var.resource_group
  ip_configuration {
    name                          = "internal"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "safebox" {
  name                = "safebox"
  resource_group_name = var.resource_group
  location            = var.location
  size                = var.vm_size
  network_interface_ids = [azurerm_network_interface.safebox.id]

  # Confidential VM: encrypted RAM + vTPM measured boot + attestation.
  vtpm_enabled        = true
  secure_boot_enabled = true

  source_image_id = var.image_id
  os_disk {
    caching                          = "ReadWrite"
    storage_account_type             = "Premium_LRS"
    security_encryption_type         = "VMGuestStateOnly"   # CVM disk security
  }

  # No admin_ssh_key — Bug-5 zero-shell invariant. Azure requires either a
  # password or SSH key at create; use a throwaway locked credential and rely
  # on hardening.nix (no sshd in the closure) so the credential is inert.
  admin_username                  = "unused"
  disable_password_authentication = true
  admin_ssh_key {
    username   = "unused"
    public_key = "ssh-ed25519 AAAA_PLACEHOLDER_INERT_NO_SSHD_IN_IMAGE"
  }
}

resource "azurerm_managed_disk" "data" {
  name                 = "safebox-data"
  location             = var.location
  resource_group_name  = var.resource_group
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_gb   # ZFS pool device (separate; F2)
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.safebox.id
  lun                = 0
  caching            = "ReadWrite"
}

output "vm_id"      { value = azurerm_linux_virtual_machine.safebox.id }
output "private_ip" { value = azurerm_network_interface.safebox.private_ip_address }
