output "console_instance_id" {
  description = "OCID of the outer Safebox Console instance"
  value       = oci_core_instance.console.id
}

output "console_private_ip" {
  description = "Private IP of the Console (the inner Safebox's sole egress destination)"
  value       = oci_core_instance.console.private_ip
}

output "console_public_ip" {
  description = "Public IP of the Console (if assigned)"
  value       = oci_core_instance.console.public_ip
}

output "inner_instance_id" {
  description = "OCID of the inner Safebox instance"
  value       = oci_core_instance.inner.id
}

output "inner_private_ip" {
  description = "Private IP of the inner Safebox"
  value       = oci_core_instance.inner.private_ip
}

output "inner_public_ip" {
  description = "Public IP of the inner Safebox (if assigned)"
  value       = oci_core_instance.inner.public_ip
}

output "console_nsg_id" {
  description = "NSG OCID of the Console"
  value       = oci_core_network_security_group.console.id
}

output "inner_nsg_id" {
  description = "NSG OCID of the inner Safebox (egress restricted to Console)"
  value       = oci_core_network_security_group.inner.id
}

output "console_data_volume_id" {
  description = "Block volume OCID backing the Console's ZFS pool"
  value       = oci_core_volume.console_data.id
}

output "inner_data_volume_id" {
  description = "Block volume OCID backing the inner Safebox's ZFS pool"
  value       = oci_core_volume.inner_data.id
}
