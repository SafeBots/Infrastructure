output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.safebox.id
}

output "private_ip" {
  description = "Private IP address of the instance"
  value       = aws_instance.safebox.private_ip
}

output "public_ip" {
  description = "Public IP address of the instance (if assigned)"
  value       = aws_instance.safebox.public_ip
}

output "security_group_id" {
  description = "Security group ID attached to the instance"
  value       = aws_security_group.safebox.id
}

output "data_volume_id" {
  description = "EBS data volume ID backing the ZFS pool"
  value       = aws_ebs_volume.data.id
}
