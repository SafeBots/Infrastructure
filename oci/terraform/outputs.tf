output "instance_id" {
  description = "OCI compute instance OCID"
  value       = oci_core_instance.safebox.id
}

output "boot_volume_id" {
  description = "Boot volume OCID (the verity image; nothing on it is state)"
  value       = oci_core_instance.safebox.boot_volume_id
}

output "data_volume_id" {
  description = "Block volume OCID that holds the encrypted ZFS pool"
  value       = oci_core_volume.data.id
}

output "private_ip" {
  description = "Private IP address of the instance"
  value       = oci_core_instance.safebox.private_ip
}

output "public_ip" {
  description = "Public IP address of the instance (empty when assign_public_ip is false)"
  value       = oci_core_instance.safebox.public_ip
}

output "nsg_id" {
  description = "Network Security Group OCID"
  value       = oci_core_network_security_group.safebox.id
}
