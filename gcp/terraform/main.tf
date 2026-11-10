# Safebox Instance Launch Module - GCP
#
# Launches one production safebox from a captured image (gcp/scripts/
# build-image.sh). Does not build images.
#
# What the launched instance looks like (docs/HARDENING-PLAN.md, "Terraform"):
#   - Shielded VM: Secure Boot, vTPM and integrity monitoring all on. The
#     image's initramfs refuses to boot without a vTPM, so this is not
#     optional.
#   - No guest agent on the image, so the metadata keys below are read by
#     safebox-firstboot.service and nothing else. There is no startup-script
#     key and nothing on the box would run one.
#   - serial-port-enable and serial-port-logging-enable are FALSE at the
#     instance level; the project-level org policy constraints in
#     gcp/INSTRUCTIONS.md stop anyone turning them back on.
#   - The data disk is created empty. The first boot finds it (the only
#     disk with no partition table and at least 50 GB) and creates the
#     encrypted pool on it with a key sealed to this instance's vTPM.
#   - The service account carries only logging and monitoring write scopes.
#   - No ignore_changes on metadata: a drift in launch-authorization,
#     owner-pubkey or safebox-id is a change that must be seen in the plan.

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
  name = "safebox-${var.safebox_id}"

  # Metadata keys exactly as safebox-firstboot.sh reads them from
  # instance/attributes. The DNS API URL is baked into the image
  # (/etc/safebox/defaults.json) and cannot be overridden from metadata.
  firstboot_metadata = {
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
  }

  control_metadata = {
    "enable-oslogin"             = "FALSE"
    "block-project-ssh-keys"     = "TRUE"
    "serial-port-enable"         = "FALSE"
    "serial-port-logging-enable" = "FALSE"
  }

  ingress_ports = concat(["443", "8443"], var.allow_http ? ["80"] : [])
}

# -----------------------------------------------------------------------------
# Firewall: 443 (nginx TLS) and 8443 (dnsclient announce challenge). Port 80
# only when allow_http is set, for autovhost's HTTP-01 ACME challenges and
# its HTTP splash page.
#
# NOTE: This single-box module relies on GCP's implicit allow-all egress.
# For governed egress control (inner Safebox restricted to outer Console
# only), use the two-box module at gcp/terraform-console/ instead.
# -----------------------------------------------------------------------------
resource "google_compute_firewall" "safebox" {
  name    = "${local.name}-allow-ingress"
  network = var.network
  project = var.project_id

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = local.ingress_ports
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.name]
}

# -----------------------------------------------------------------------------
# Data disk: empty. No image, no snapshot, no filesystem. The initramfs
# creates safebox-pool on it at first boot.
# -----------------------------------------------------------------------------
resource "google_compute_disk" "data" {
  name    = "${local.name}-data"
  type    = "pd-ssd"
  size    = var.data_disk_size_gb
  zone    = var.zone
  project = var.project_id

  labels = {
    safebox = var.safebox_id
    role    = "data"
  }
}

# -----------------------------------------------------------------------------
# Service account: logging and monitoring writes only.
# -----------------------------------------------------------------------------
resource "google_service_account" "safebox" {
  account_id   = local.name
  display_name = "Safebox ${var.safebox_id}"
  project      = var.project_id
}

# -----------------------------------------------------------------------------
# Instance
# -----------------------------------------------------------------------------
resource "google_compute_instance" "safebox" {
  name         = local.name
  machine_type = var.machine_type
  zone         = var.zone
  project      = var.project_id

  tags = [local.name]

  # SEV-SNP needs an AMD Milan or newer host; the platform pin makes the
  # request fail at plan time rather than at boot on an unsupported family.
  min_cpu_platform = var.skip_confidential_compute ? null : "AMD Milan"

  can_ip_forward      = false
  deletion_protection = false

  boot_disk {
    auto_delete = true
    initialize_params {
      image = var.image_self_link
      size  = var.boot_disk_size_gb
      type  = "pd-ssd"
    }
  }

  attached_disk {
    source      = google_compute_disk.data.self_link
    device_name = "safebox-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork

    # Public IP: the DNS API calls back to the announce challenge on 8443.
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
    # Confidential VMs cannot be live-migrated; TERMINATE is required.
    on_host_maintenance = var.skip_confidential_compute ? "MIGRATE" : "TERMINATE"
    automatic_restart   = true
  }

  metadata = merge(local.control_metadata, local.firstboot_metadata)

  service_account {
    email  = google_service_account.safebox.email
    scopes = ["logging-write", "monitoring-write"]
  }

  labels = {
    safebox = var.safebox_id
  }

  depends_on = [google_compute_firewall.safebox]
}

# -----------------------------------------------------------------------------
# Project-level deny policies (opt-in). These are the Terraform equivalents
# of the gcloud commands in gcp/INSTRUCTIONS.md, "Project policy":
#
#   1. compute.disableSerialPortAccess  - no serial console
#   2. compute.disableSerialPortLogging - no serial port logging
#   3. compute.requireShieldedVm       - every VM must be shielded
#   4. IAM deny policy on compute.instances.setMetadata - only the deploy
#      service account can write instance metadata
#
# Set manage_deny_policies = true, provide project_number and
# deploy_service_account_email. Needs Organization Policy Administrator
# and the IAM Deny Admin role on the project.
# -----------------------------------------------------------------------------
resource "google_project_organization_policy" "disable_serial_port_access" {
  count   = var.manage_deny_policies ? 1 : 0
  project = var.project_id

  constraint = "compute.disableSerialPortAccess"

  boolean_policy {
    enforced = true
  }
}

resource "google_project_organization_policy" "disable_serial_port_logging" {
  count   = var.manage_deny_policies ? 1 : 0
  project = var.project_id

  constraint = "compute.disableSerialPortLogging"

  boolean_policy {
    enforced = true
  }
}

resource "google_project_organization_policy" "require_shielded_vm" {
  count   = var.manage_deny_policies ? 1 : 0
  project = var.project_id

  constraint = "compute.requireShieldedVm"

  boolean_policy {
    enforced = true
  }
}

resource "google_iam_deny_policy" "deny_set_metadata" {
  count  = var.manage_deny_policies ? 1 : 0
  parent = "cloudresourcemanager.googleapis.com/projects/${var.project_number}"
  name   = "safebox-deny-metadata"

  rules {
    description = "Only the deploy SA may set instance metadata"
    deny_rule {
      denied_principals  = ["principalSet://goog/public:all"]
      exception_principals = [
        "principal://iam.googleapis.com/projects/-/serviceAccounts/${var.deploy_service_account_email}"
      ]
      denied_permissions {
        included_permissions = ["compute.googleapis.com/instances.setMetadata"]
      }
    }
  }
}
