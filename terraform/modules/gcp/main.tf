# terraform/modules/gcp — attested Safebox on GCE Confidential VM (SEV-SNP).
# refactor.md Phase 2.2. Image from `nix build .#gce`, uploaded to GCS + created
# as a Compute image. SEV-SNP gives encrypted RAM + measured boot via vTPM.

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

variable "project"     { type = string }
variable "region"      { type = string  default = "us-central1" }
variable "zone"        { type = string  default = "us-central1-a" }
variable "image"       { type = string  description = "Safebox NixOS GCE image (from nix build .#gce)" }
variable "machine_type"{ type = string  default = "n2d-standard-4" } # AMD, SEV-SNP capable
variable "data_disk_gb"{ type = number  default = 200 }

provider "google" { project = var.project  region = var.region  zone = var.zone }

resource "google_compute_disk" "data" {
  name = "safebox-data"
  size = var.data_disk_gb
  type = "pd-ssd"
  zone = var.zone
}

resource "google_compute_instance" "safebox" {
  name         = "safebox"
  machine_type = var.machine_type
  zone         = var.zone

  # Confidential VM: encrypted RAM + attestation (SEV-SNP).
  confidential_instance_config {
    enable_confidential_compute = true
    confidential_instance_type  = "SEV_SNP"
  }
  # Measured boot via vTPM + integrity monitoring.
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  boot_disk { initialize_params { image = var.image } }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "safebox-data"   # ZFS pool device (separate from boot; F2)
  }

  network_interface {
    network = "default"
    access_config {}               # egress; the box is a full networked VM
  }

  # No SSH keys added — Bug-5 zero-shell invariant.
}

output "instance_name" { value = google_compute_instance.safebox.name }
output "internal_ip"   { value = google_compute_instance.safebox.network_interface[0].network_ip }
