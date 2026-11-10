output "console_vm_id" {
  description = "Azure resource ID of the outer Safebox Console VM"
  value       = azapi_resource.console.id
}

output "console_vm_name" {
  description = "Name of the Console VM"
  value       = azapi_resource.console.name
}

output "console_private_ip" {
  description = "Private IP of the Console (the inner Safebox's sole egress destination)"
  value       = azurerm_network_interface.console.private_ip_address
}

output "console_public_ip" {
  description = "Public IP of the Console"
  value       = azurerm_public_ip.console.ip_address
}

output "inner_vm_id" {
  description = "Azure resource ID of the inner Safebox VM"
  value       = azapi_resource.inner.id
}

output "inner_vm_name" {
  description = "Name of the inner Safebox VM"
  value       = azapi_resource.inner.name
}

output "inner_private_ip" {
  description = "Private IP of the inner Safebox"
  value       = azurerm_network_interface.inner.private_ip_address
}

output "inner_public_ip" {
  description = "Public IP of the inner Safebox"
  value       = azurerm_public_ip.inner.ip_address
}

output "console_nsg_id" {
  description = "NSG ID of the Console"
  value       = azurerm_network_security_group.console.id
}

output "inner_nsg_id" {
  description = "NSG ID of the inner Safebox (egress restricted to Console)"
  value       = azurerm_network_security_group.inner.id
}

output "console_data_disk_id" {
  description = "Managed disk ID backing the Console's ZFS pool"
  value       = azurerm_managed_disk.console_data.id
}

output "inner_data_disk_id" {
  description = "Managed disk ID backing the inner Safebox's ZFS pool"
  value       = azurerm_managed_disk.inner_data.id
}

output "security_type" {
  description = "Security type used for both VMs (TrustedLaunch or ConfidentialVM)"
  value       = local.security_type
}
