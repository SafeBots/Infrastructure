output "vm_id" {
  description = "Azure VM resource id"
  value       = azapi_resource.safebox.id
}

output "vm_name" {
  description = "Azure VM name (for az vm commands and the red-team script)"
  value       = azapi_resource.safebox.name
}

output "private_ip" {
  description = "Private IP address of the VM"
  value       = azurerm_network_interface.safebox.private_ip_address
}

output "public_ip" {
  description = "Public IP address of the VM; this is what dnsclient announces"
  value       = azurerm_public_ip.safebox.ip_address
}

output "nsg_id" {
  description = "Network Security Group id"
  value       = azurerm_network_security_group.safebox.id
}

output "data_disk_id" {
  description = "Managed data disk id (the encrypted ZFS pool lives here after first boot)"
  value       = azurerm_managed_disk.data.id
}

output "security_type" {
  description = "TrustedLaunch or ConfidentialVM"
  value       = local.security_type
}
