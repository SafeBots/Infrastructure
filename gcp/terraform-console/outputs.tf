output "console_instance_id" {
  description = "GCE instance ID of the outer Safebox Console"
  value       = google_compute_instance.console.instance_id
}

output "console_instance_name" {
  description = "GCE instance name of the Console"
  value       = google_compute_instance.console.name
}

output "console_private_ip" {
  description = "Private IP of the Console (the inner Safebox's sole egress destination)"
  value       = google_compute_instance.console.network_interface[0].network_ip
}

output "console_public_ip" {
  description = "Public IP of the Console"
  value       = google_compute_instance.console.network_interface[0].access_config[0].nat_ip
}

output "inner_instance_id" {
  description = "GCE instance ID of the inner Safebox"
  value       = google_compute_instance.inner.instance_id
}

output "inner_instance_name" {
  description = "GCE instance name of the inner Safebox"
  value       = google_compute_instance.inner.name
}

output "inner_private_ip" {
  description = "Private IP of the inner Safebox"
  value       = google_compute_instance.inner.network_interface[0].network_ip
}

output "inner_public_ip" {
  description = "Public IP of the inner Safebox"
  value       = google_compute_instance.inner.network_interface[0].access_config[0].nat_ip
}

output "console_service_account_email" {
  description = "Service account of the Console"
  value       = google_service_account.console.email
}

output "inner_service_account_email" {
  description = "Service account of the inner Safebox"
  value       = google_service_account.inner.email
}

output "console_data_disk_name" {
  description = "Console data disk name"
  value       = google_compute_disk.console_data.name
}

output "inner_data_disk_name" {
  description = "Inner Safebox data disk name"
  value       = google_compute_disk.inner_data.name
}
