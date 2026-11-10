output "console_instance_id" {
  description = "EC2 instance ID of the outer Safebox Console"
  value       = aws_instance.console.id
}

output "console_private_ip" {
  description = "Private IP of the Console (the inner Safebox's sole egress destination)"
  value       = aws_instance.console.private_ip
}

output "console_public_ip" {
  description = "Public IP of the Console (if assigned)"
  value       = aws_instance.console.public_ip
}

output "inner_instance_id" {
  description = "EC2 instance ID of the inner Safebox"
  value       = aws_instance.inner.id
}

output "inner_private_ip" {
  description = "Private IP of the inner Safebox"
  value       = aws_instance.inner.private_ip
}

output "inner_public_ip" {
  description = "Public IP of the inner Safebox (if assigned)"
  value       = aws_instance.inner.public_ip
}

output "console_security_group_id" {
  description = "Security group ID of the Console"
  value       = aws_security_group.console.id
}

output "inner_security_group_id" {
  description = "Security group ID of the inner Safebox (egress restricted to Console)"
  value       = aws_security_group.inner.id
}

output "console_data_volume_id" {
  description = "EBS data volume ID backing the Console's ZFS pool"
  value       = aws_ebs_volume.console_data.id
}

output "inner_data_volume_id" {
  description = "EBS data volume ID backing the inner Safebox's ZFS pool"
  value       = aws_ebs_volume.inner_data.id
}
