# Safebox launch module -- Azure (docs/HARDENING-PLAN.md, "Terraform").
#
# Launches one production safebox from a Specialized Trusted Launch image in
# a Compute Gallery (built by azure/scripts/build-image.sh). The module
# never builds images and never runs anything inside the VM: the only data
# it passes in is the three-key JSON in userData, which the image's
# first-boot unit reads and validates but does not execute.
#
# Resource choice: the VM is an azapi_resource, not azurerm_linux_virtual_machine.
#
#   The image is captured with --os-state Specialized because the box has
#   no Azure agent and no cloud-init, so it cannot be generalized and
#   re-provisioned; it boots exactly as captured. Azure rejects osProfile
#   on a VM created from a Specialized image ("osProfile is not allowed").
#   azurerm_linux_virtual_machine makes admin_username required and always
#   sends osProfile, so it cannot create this VM. The legacy
#   azurerm_virtual_machine can omit os_profile but has no securityProfile,
#   so it cannot turn on Secure Boot or the vTPM. azapi_resource sends the
#   ARM body as written: no osProfile, securityProfile with
#   TrustedLaunch/ConfidentialVM, userData, no diagnosticsProfile.
#
#   Consequence: provisionVMAgent and allowExtensionOperations live inside
#   osProfile and therefore cannot be set here. The compensating control is
#   two-fold: the agent is absent from the image (every extension and Run
#   Command needs it in the guest), and Azure Policy denies the extension,
#   runCommands and boot-diagnostics resources at the control plane. The
#   policies are defined and assigned at resource-group scope by this
#   module when manage_deny_policies = true; when it is false (the
#   default) the operator must assign them from azure/INSTRUCTIONS.md,
#   ideally at subscription scope. See the policy resources at the end.
#
# No managed identity, no boot diagnostics, no custom_data, no ignore_changes.

terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.85"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 1.13"
    }
  }
}

provider "azurerm" {
  features {}
}

provider "azapi" {}

data "azurerm_resource_group" "safebox" {
  name = var.resource_group_name
}

locals {
  name = "safebox-${var.safebox_id}"

  # Tag every resource so the Azure Policy assignments in INSTRUCTIONS.md
  # (deny extensions, deny boot diagnostics) can target safebox VMs.
  tags = {
    safebox    = "true"
    safebox_id = var.safebox_id
  }

  # The exact keys the first-boot unit reads from
  # /metadata/instance/compute/userData (HARDENING-PLAN.md, "Metadata keys
  # per cloud"). No other key is read; no value is executed.
  user_data = jsonencode({
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
  })

  security_type = var.skip_confidential_compute ? "TrustedLaunch" : "ConfidentialVM"

  # Confidential VMs require the OS disk's guest state to be encrypted with
  # a platform or customer key; VMGuestStateOnly is the platform-managed
  # choice. The property is rejected on a non-confidential size, so it is
  # only sent when confidential compute is enabled (the default).
  os_disk_managed = merge(
    { storageAccountType = "Premium_LRS" },
    var.skip_confidential_compute ? {} : { securityProfile = { securityEncryptionType = "VMGuestStateOnly" } }
  )
}

# -----------------------------------------------------------------------------
# Public IP: Standard SKU, static, so the announced address never changes.
# -----------------------------------------------------------------------------
resource "azurerm_public_ip" "safebox" {
  name                = "${local.name}-pip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

# -----------------------------------------------------------------------------
# NSG: 443 (nginx) and 8443 (dnsclient announce challenge). Port 80 is off
# unless allow_http is set; autovhost's HTTP-01 ACME flow and HTTP splash
# need it, the contract's two-port firewall does not.
#
# NOTE: This single-box module has wide-open egress (Azure NSG default).
# For governed egress control (inner Safebox restricted to outer Console
# only), use the two-box module at azure/terraform-console/ instead.
# -----------------------------------------------------------------------------
resource "azurerm_network_security_group" "safebox" {
  name                = "${local.name}-nsg"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.tags

  security_rule {
    name                       = "Allow-HTTPS"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Allow-Challenge"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = var.allow_http ? [1] : []
    content {
      name                       = "Allow-HTTP-ACME"
      priority                   = 120
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "80"
      source_address_prefix      = "*"
      destination_address_prefix = "*"
    }
  }

  # Azure's default rules deny every other inbound flow.
}

# -----------------------------------------------------------------------------
# NIC
# -----------------------------------------------------------------------------
resource "azurerm_network_interface" "safebox" {
  name                = "${local.name}-nic"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.safebox.id
  }
}

resource "azurerm_network_interface_security_group_association" "safebox" {
  network_interface_id      = azurerm_network_interface.safebox.id
  network_security_group_id = azurerm_network_security_group.safebox.id
}

# -----------------------------------------------------------------------------
# Data disk: empty. No partition table, no filesystem. The initramfs picks
# the only blank disk of at least 50 GB on first boot and creates the
# encrypted pool on it (safebox.datadisk=auto). Anything written here by
# Terraform would make the disk ineligible and the box would fail closed.
# -----------------------------------------------------------------------------
resource "azurerm_managed_disk" "data" {
  name                 = "${local.name}-data"
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  tags                 = local.tags
}

# -----------------------------------------------------------------------------
# VM. See the header for why this is azapi_resource.
# -----------------------------------------------------------------------------
resource "azapi_resource" "safebox" {
  type      = "Microsoft.Compute/virtualMachines@2024-03-01"
  name      = local.name
  location  = var.location
  parent_id = data.azurerm_resource_group.safebox.id
  tags      = local.tags

  # identity: deliberately absent. A managed identity would give code on
  # the box a credential for the Azure control plane.

  body = jsonencode({
    properties = {
      hardwareProfile = {
        vmSize = var.vm_size
      }

      storageProfile = {
        imageReference = {
          # A Compute Gallery image version id
          # (/subscriptions/.../galleries/safebox/images/safebox-prod/versions/<v>).
          id = var.image_id
        }
        osDisk = {
          name         = "${local.name}-osdisk"
          osType       = "Linux"
          createOption = "FromImage"
          # ReadOnly: the root is a dm-verity volume and is never written;
          # /boot is remounted read-write only by the initramfs on first boot.
          caching      = "ReadOnly"
          deleteOption = "Delete"
          managedDisk  = local.os_disk_managed
        }
        dataDisks = [
          {
            lun          = 0
            name         = azurerm_managed_disk.data.name
            createOption = "Attach"
            caching      = "None"
            deleteOption = "Detach"
            managedDisk = {
              id = azurerm_managed_disk.data.id
            }
          }
        ]
      }

      networkProfile = {
        networkInterfaces = [
          {
            id = azurerm_network_interface.safebox.id
            properties = {
              primary      = true
              deleteOption = "Detach"
            }
          }
        ]
      }

      securityProfile = {
        securityType = local.security_type
        uefiSettings = {
          secureBootEnabled = true
          vTpmEnabled       = true
        }
        # Requires the Microsoft.Compute/EncryptionAtHost feature to be
        # registered on the subscription; see variables.tf.
        encryptionAtHost = var.encryption_at_host
      }

      # Boot diagnostics off: the serial log and screenshot are a second
      # path to the console. INSTRUCTIONS.md has the Policy that denies
      # turning it on.
      diagnosticsProfile = {
        bootDiagnostics = {
          enabled = false
        }
      }

      # userData, not customData: customData is the cloud-init channel and
      # is exposed differently; userData is what the first-boot unit reads
      # from IMDS. Base64 of the three-key JSON.
      userData = base64encode(local.user_data)
    }
  })

  depends_on = [azurerm_network_interface_security_group_association.safebox]
}

# -----------------------------------------------------------------------------
# Deny policies (HARDENING-PLAN.md fix 4). A Specialized image cannot carry
# osProfile, so provisionVMAgent=false and allowExtensionOperations=false
# are not expressible on this VM. These Policy resources are the
# control-plane half of the compensating control (the other half is the
# agent being absent from the image). They deny, in the resource group:
#   - any Microsoft.Compute/virtualMachines/extensions resource,
#   - any Microsoft.Compute/virtualMachines/runCommands resource,
#   - any safebox-tagged VM whose bootDiagnostics.enabled is true.
# The rules are the same JSON as azure/INSTRUCTIONS.md, "Cloud-level
# policy". Definitions are subscription-level objects, so their names carry
# the safebox name to stay unique when several boxes share a subscription;
# the assignment is scoped to the resource group. Creating them needs
# Microsoft.Authorization/policyDefinitions/write and
# policyAssignments/write (Resource Policy Contributor) on the subscription
# and resource group, which is why this is opt-in: a deployer with only
# Virtual Machine Contributor would otherwise fail the whole apply.
#
# Note that extension resources do not inherit the VM's tags, so the
# extension/runCommand deny is unconditional within its scope. A
# resource-group assignment protects only VMs in this group; the
# subscription-scope assignment from INSTRUCTIONS.md is wider and is still
# the recommended placement for a dedicated subscription.
# -----------------------------------------------------------------------------
resource "azurerm_policy_definition" "deny_extensions" {
  count = var.manage_deny_policies ? 1 : 0

  name         = "${local.name}-deny-extensions"
  display_name = "Safebox: deny VM extensions and run commands (${local.name})"
  policy_type  = "Custom"
  mode         = "All"

  policy_rule = jsonencode({
    if = {
      anyOf = [
        { field = "type", equals = "Microsoft.Compute/virtualMachines/extensions" },
        { field = "type", equals = "Microsoft.Compute/virtualMachines/runCommands" }
      ]
    }
    then = { effect = "deny" }
  })
}

resource "azurerm_policy_definition" "deny_bootdiag" {
  count = var.manage_deny_policies ? 1 : 0

  name         = "${local.name}-deny-bootdiag"
  display_name = "Safebox: deny boot diagnostics on safebox VMs (${local.name})"
  policy_type  = "Custom"
  mode         = "All"

  policy_rule = jsonencode({
    if = {
      allOf = [
        { field = "type", equals = "Microsoft.Compute/virtualMachines" },
        { field = "tags['safebox']", equals = "true" },
        { field = "Microsoft.Compute/virtualMachines/diagnosticsProfile.bootDiagnostics.enabled", equals = "true" }
      ]
    }
    then = { effect = "deny" }
  })
}

resource "azurerm_resource_group_policy_assignment" "deny_extensions" {
  count = var.manage_deny_policies ? 1 : 0

  name                 = "${local.name}-deny-extensions"
  display_name         = "Safebox: deny VM extensions and run commands"
  resource_group_id    = data.azurerm_resource_group.safebox.id
  policy_definition_id = azurerm_policy_definition.deny_extensions[0].id
  enforce              = true
}

resource "azurerm_resource_group_policy_assignment" "deny_bootdiag" {
  count = var.manage_deny_policies ? 1 : 0

  name                 = "${local.name}-deny-bootdiag"
  display_name         = "Safebox: deny boot diagnostics on safebox VMs"
  resource_group_id    = data.azurerm_resource_group.safebox.id
  policy_definition_id = azurerm_policy_definition.deny_bootdiag[0].id
  enforce              = true
}
