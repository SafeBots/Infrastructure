output "instance_id" {
  description = "GCE instance ID"
  value       = google_compute_instance.safebox.instance_id
}

output "instance_name" {
  description = "GCE instance name"
  value       = google_compute_instance.safebox.name
}

output "zone" {
  description = "Zone the instance runs in"
  value       = google_compute_instance.safebox.zone
}

output "private_ip" {
  description = "Private IP address of the instance"
  value       = google_compute_instance.safebox.network_interface[0].network_ip
}

output "public_ip" {
  description = "Public IP address of the instance (the address dnsclient announces)"
  value       = google_compute_instance.safebox.network_interface[0].access_config[0].nat_ip
}

output "service_account_email" {
  description = "Service account attached to the instance"
  value       = google_service_account.safebox.email
}

output "data_disk_name" {
  description = "Name of the data disk holding safebox-pool"
  value       = google_compute_disk.data.name
}

output "image" {
  description = "Image the instance was launched from"
  value       = var.image_self_link
}

output "confidential_compute" {
  description = "Whether the instance was launched as a Confidential VM"
  value       = !var.skip_confidential_compute
}
