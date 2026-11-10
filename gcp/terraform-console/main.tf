# Safebox Console + Inner Launch Module — GCP (Two-Box Architecture)
#
# Launches a paired outer Safebox Console and inner Safebox from pre-built
# images. The Console is the Inductive Security base case: a frozen Nix
# derivation that runs one Qbix app and provides governed egress, M-of-N
# governance with the Software Signer, and key custody. The inner Safebox
# has zero direct internet egress — all outbound traffic goes through the
# Console's governed proxy.
#
# Deploy the Console first; the inner Safebox references the Console's
# private IP for its egress-only network link.

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.25, < 7.0"
    }
  }
}

locals {
  console_name = "safebox-console-${var.safebox_id}"
  inner_name   = "safebox-inner-${var.safebox_id}"

  control_metadata = {
    "enable-oslogin"             = "FALSE"
    "block-project-ssh-keys"     = "TRUE"
    "serial-port-enable"         = "FALSE"
    "serial-port-logging-enable" = "FALSE"
  }

  console_firstboot_metadata = {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "console"
  }

  ingress_ports = concat(["443", "8443"], var.allow_http ? ["80"] : [])
}

# -----------------------------------------------------------------------------
# Firewall — Console: HTTPS + challenge + inner private link
# -----------------------------------------------------------------------------
resource "google_compute_firewall" "console_ingress" {
  name    = "${local.console_name}-allow-ingress"
  network = var.network
  project = var.project_id

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = local.ingress_ports
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.console_name]
}

resource "google_compute_firewall" "console_inner_link" {
  name    = "${local.console_name}-inner-link"
  network = var.network
  project = var.project_id

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["9443"]
  }

  # Only the inner Safebox may reach the Console's private link port
  source_tags = [local.inner_name]
  target_tags = [local.console_name]
}

# -----------------------------------------------------------------------------
# Firewall — Inner Safebox: HTTPS inbound, egress only to Console
# -----------------------------------------------------------------------------
resource "google_compute_firewall" "inner_ingress" {
  name    = "${local.inner_name}-allow-ingress"
  network = var.network
  project = var.project_id

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = local.ingress_ports
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.inner_name]
}

# CRITICAL: deny all egress from the inner Safebox except to the Console.
# GCP VPC firewall egress rules are allow-based with an implicit allow-all
# default, so we need a high-priority deny rule and a lower-priority allow
# to the Console IP.
resource "google_compute_firewall" "inner_deny_egress" {
  name     = "${local.inner_name}-deny-egress"
  network  = var.network
  project  = var.project_id
  priority = 900

  direction = "EGRESS"

  deny {
    protocol = "all"
  }

  # Applies to the inner Safebox only
  target_tags        = [local.inner_name]
  destination_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "inner_allow_console_egress" {
  name     = "${local.inner_name}-allow-console-egress"
  network  = var.network
  project  = var.project_id
  priority = 800

  direction = "EGRESS"

  allow {
    protocol = "tcp"
  }

  target_tags        = [local.inner_name]
  destination_ranges = ["${google_compute_instance.console.network_interface[0].network_ip}/32"]
}

resource "google_compute_firewall" "inner_allow_metadata_egress" {
  name     = "${local.inner_name}-allow-metadata-egress"
  network  = var.network
  project  = var.project_id
  priority = 800

  direction = "EGRESS"

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }

  target_tags        = [local.inner_name]
  destination_ranges = ["169.254.169.254/32"]
}

# -----------------------------------------------------------------------------
# Data disks
# -----------------------------------------------------------------------------
resource "google_compute_disk" "console_data" {
  name    = "${local.console_name}-data"
  type    = "pd-ssd"
  size    = var.console_data_disk_size_gb
  zone    = var.zone
  project = var.project_id

  labels = {
    safebox = var.safebox_id
    role    = "console-data"
  }
}

resource "google_compute_disk" "inner_data" {
  name    = "${local.inner_name}-data"
  type    = "pd-ssd"
  size    = var.data_disk_size_gb
  zone    = var.zone
  project = var.project_id

  labels = {
    safebox = var.safebox_id
    role    = "inner-data"
  }
}

# -----------------------------------------------------------------------------
# Service accounts
# -----------------------------------------------------------------------------
resource "google_service_account" "console" {
  account_id   = local.console_name
  display_name = "Safebox Console ${var.safebox_id}"
  project      = var.project_id
}

resource "google_service_account" "inner" {
  account_id   = local.inner_name
  display_name = "Safebox Inner ${var.safebox_id}"
  project      = var.project_id
}

# -----------------------------------------------------------------------------
# Console instance (outer Safebox)
# -----------------------------------------------------------------------------
resource "google_compute_instance" "console" {
  name         = local.console_name
  machine_type = var.console_machine_type
  zone         = var.zone
  project      = var.project_id

  tags = [local.console_name]

  min_cpu_platform    = var.skip_confidential_compute ? null : "AMD Milan"
  can_ip_forward      = false
  deletion_protection = false

  boot_disk {
    auto_delete = true
    initialize_params {
      image = var.console_image_self_link
      size  = var.console_boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  attached_disk {
    source      = google_compute_disk.console_data.self_link
    device_name = "safebox-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    access_config {}
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  dynamic "confidential_instance_config" {
    for_each = var.skip_confidential_compute ? [] : [1]
    content {
      enable_confidential_compute = true
      confidential_instance_type  = "SEV_SNP"
    }
  }

  scheduling {
    on_host_maintenance = var.skip_confidential_compute ? "MIGRATE" : "TERMINATE"
    automatic_restart   = true
  }

  metadata = merge(local.control_metadata, local.console_firstboot_metadata)

  service_account {
    email  = google_service_account.console.email
    scopes = ["logging-write", "monitoring-write"]
  }

  labels = {
    safebox = var.safebox_id
    role    = "console"
  }

  depends_on = [google_compute_firewall.console_ingress]
}

# -----------------------------------------------------------------------------
# Inner Safebox instance
# -----------------------------------------------------------------------------
resource "google_compute_instance" "inner" {
  name         = local.inner_name
  machine_type = var.machine_type
  zone         = var.zone
  project      = var.project_id

  tags = [local.inner_name]

  min_cpu_platform    = var.skip_confidential_compute ? null : "AMD Milan"
  can_ip_forward      = false
  deletion_protection = false

  boot_disk {
    auto_delete = true
    initialize_params {
      image = var.inner_image_self_link
      size  = var.boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  attached_disk {
    source      = google_compute_disk.inner_data.self_link
    device_name = "safebox-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    access_config {}
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  dynamic "confidential_instance_config" {
    for_each = var.skip_confidential_compute ? [] : [1]
    content {
      enable_confidential_compute = true
      confidential_instance_type  = "SEV_SNP"
    }
  }

  scheduling {
    on_host_maintenance = var.skip_confidential_compute ? "MIGRATE" : "TERMINATE"
    automatic_restart   = true
  }

  # The inner Safebox gets the Console's private IP so safebox-firstboot
  # writes /etc/safebox/console-ip for the inner egress nftables rules.
  metadata = merge(local.control_metadata, {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "inner"
    "console-ip"           = google_compute_instance.console.network_interface[0].network_ip
  })

  service_account {
    email  = google_service_account.inner.email
    scopes = ["logging-write", "monitoring-write"]
  }

  labels = {
    safebox = var.safebox_id
    role    = "inner"
  }

  depends_on = [
    google_compute_firewall.inner_ingress,
    google_compute_instance.console
  ]
}
