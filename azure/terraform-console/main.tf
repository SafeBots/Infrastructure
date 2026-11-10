# Safebox Console Launch Module — Azure (Outer + Inner Safebox)
#
# Launches a paired outer Safebox Console and inner Safebox from pre-built
# Specialized images in a Compute Gallery. The Console is the Inductive
# Security base case: a frozen, fully open-source Nix image that runs one
# Qbix app (the Safebox Console) and provides:
#
#   1. Governed egress proxy for the paired inner Safebox
#   2. M-of-N governance gateway with the Software Signer
#   3. Key custody (organization keys sealed to this box's TPM)
#   4. Inner Safebox provisioning via Azure APIs
#
# The Console is always deployed FIRST; the inner Safebox gets the Console's
# private IP in its userData so the inner egress nftables rules can restrict
# all outbound traffic to the Console only.
#
# Both VMs are azapi_resource (see azure/terraform/main.tf header for why:
# Specialized images reject osProfile, and only azapi_resource can omit it
# while still setting securityProfile for Trusted Launch / Confidential VM).

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
  console_name = "safebox-console-${var.safebox_id}"
  inner_name   = "safebox-inner-${var.safebox_id}"

  tags = {
    safebox    = "true"
    safebox_id = var.safebox_id
  }

  console_tags = merge(local.tags, { role = "console" })
  inner_tags   = merge(local.tags, { role = "inner" })

  console_user_data = jsonencode({
    "safebox-id"           = var.safebox_id
    "owner-pubkey"         = var.owner_pubkey
    "launch-authorization" = var.launch_authorization
    "role"                 = "console"
  })

  security_type = var.skip_confidential_compute ? "TrustedLaunch" : "ConfidentialVM"

  os_disk_managed = merge(
    { storageAccountType = "Premium_LRS" },
    var.skip_confidential_compute ? {} : { securityProfile = { securityEncryptionType = "VMGuestStateOnly" } }
  )
}

# -----------------------------------------------------------------------------
# Public IPs: Standard SKU, static
# -----------------------------------------------------------------------------
resource "azurerm_public_ip" "console" {
  name                = "${local.console_name}-pip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.console_tags
}

resource "azurerm_public_ip" "inner" {
  name                = "${local.inner_name}-pip"
  resource_group_name = var.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.inner_tags
}

# -----------------------------------------------------------------------------
# NSG — Console: HTTPS, challenge, inner private link
# -----------------------------------------------------------------------------
resource "azurerm_network_security_group" "console" {
  name                = "${local.console_name}-nsg"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.console_tags

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

  # Inner Safebox private link: only the inner box's NIC can reach 9443.
  security_rule {
    name                       = "Allow-Inner-Link"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "9443"
    source_address_prefix      = azurerm_network_interface.inner.private_ip_address
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = var.allow_http ? [1] : []
    content {
      name                       = "Allow-HTTP-ACME"
      priority                   = 130
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "80"
      source_address_prefix      = "*"
      destination_address_prefix = "*"
    }
  }

  # Console is the egress gateway — outbound is open at NSG level.
  # Application-level egress allowlist is enforced by the egress proxy.
}

# -----------------------------------------------------------------------------
# NSG — Inner Safebox: egress ONLY to Console
# -----------------------------------------------------------------------------
resource "azurerm_network_security_group" "inner" {
  name                = "${local.inner_name}-nsg"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.inner_tags

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

  # CRITICAL: Inner Safebox egress restricted to Console only.
  # This is the cloud-level enforcement of the two-box architecture.
  # The inner box's nftables rules provide the second layer.
  security_rule {
    name                       = "Allow-Egress-To-Console"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = azurerm_network_interface.console.private_ip_address
  }

  # Allow metadata service for firstboot
  security_rule {
    name                       = "Allow-Metadata"
    priority                   = 110
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "169.254.169.254"
  }

  # Deny all other outbound
  security_rule {
    name                       = "Deny-All-Outbound"
    priority                   = 4096
    direction                  = "Outbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# -----------------------------------------------------------------------------
# NICs
# -----------------------------------------------------------------------------
resource "azurerm_network_interface" "console" {
  name                = "${local.console_name}-nic"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.console_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.console.id
  }
}

resource "azurerm_network_interface" "inner" {
  name                = "${local.inner_name}-nic"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = local.inner_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.inner.id
  }
}

resource "azurerm_network_interface_security_group_association" "console" {
  network_interface_id      = azurerm_network_interface.console.id
  network_security_group_id = azurerm_network_security_group.console.id
}

resource "azurerm_network_interface_security_group_association" "inner" {
  network_interface_id      = azurerm_network_interface.inner.id
  network_security_group_id = azurerm_network_security_group.inner.id
}

# -----------------------------------------------------------------------------
# Data disks: empty, no partition table
# -----------------------------------------------------------------------------
resource "azurerm_managed_disk" "console_data" {
  name                 = "${local.console_name}-data"
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.console_data_disk_size_gb
  tags                 = local.console_tags
}

resource "azurerm_managed_disk" "inner_data" {
  name                 = "${local.inner_name}-data"
  resource_group_name  = var.resource_group_name
  location             = var.location
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  tags                 = local.inner_tags
}

# -----------------------------------------------------------------------------
# Console VM (outer Safebox)
# -----------------------------------------------------------------------------
resource "azapi_resource" "console" {
  type      = "Microsoft.Compute/virtualMachines@2024-03-01"
  name      = local.console_name
  location  = var.location
  parent_id = data.azurerm_resource_group.safebox.id
  tags      = local.console_tags

  body = jsonencode({
    properties = {
      hardwareProfile = {
        vmSize = var.console_vm_size
      }

      storageProfile = {
        imageReference = {
          id = var.console_image_id
        }
        osDisk = {
          name         = "${local.console_name}-osdisk"
          osType       = "Linux"
          createOption = "FromImage"
          caching      = "ReadOnly"
          deleteOption = "Delete"
          managedDisk  = local.os_disk_managed
        }
        dataDisks = [
          {
            lun          = 0
            name         = azurerm_managed_disk.console_data.name
            createOption = "Attach"
            caching      = "None"
            deleteOption = "Detach"
            managedDisk = {
              id = azurerm_managed_disk.console_data.id
            }
          }
        ]
      }

      networkProfile = {
        networkInterfaces = [
          {
            id = azurerm_network_interface.console.id
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
        encryptionAtHost = var.encryption_at_host
      }

      diagnosticsProfile = {
        bootDiagnostics = {
          enabled = false
        }
      }

      userData = base64encode(local.console_user_data)
    }
  })

  depends_on = [azurerm_network_interface_security_group_association.console]
}

# -----------------------------------------------------------------------------
# Inner Safebox VM
# -----------------------------------------------------------------------------
resource "azapi_resource" "inner" {
  type      = "Microsoft.Compute/virtualMachines@2024-03-01"
  name      = local.inner_name
  location  = var.location
  parent_id = data.azurerm_resource_group.safebox.id
  tags      = local.inner_tags

  body = jsonencode({
    properties = {
      hardwareProfile = {
        vmSize = var.vm_size
      }

      storageProfile = {
        imageReference = {
          id = var.inner_image_id
        }
        osDisk = {
          name         = "${local.inner_name}-osdisk"
          osType       = "Linux"
          createOption = "FromImage"
          caching      = "ReadOnly"
          deleteOption = "Delete"
          managedDisk  = local.os_disk_managed
        }
        dataDisks = [
          {
            lun          = 0
            name         = azurerm_managed_disk.inner_data.name
            createOption = "Attach"
            caching      = "None"
            deleteOption = "Detach"
            managedDisk = {
              id = azurerm_managed_disk.inner_data.id
            }
          }
        ]
      }

      networkProfile = {
        networkInterfaces = [
          {
            id = azurerm_network_interface.inner.id
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
        encryptionAtHost = var.encryption_at_host
      }

      diagnosticsProfile = {
        bootDiagnostics = {
          enabled = false
        }
      }

      # Inner Safebox gets the Console's private IP so safebox-firstboot
      # writes /etc/safebox/console-ip for the egress nftables rules.
      userData = base64encode(jsonencode({
        "safebox-id"           = var.safebox_id
        "owner-pubkey"         = var.owner_pubkey
        "launch-authorization" = var.launch_authorization
        "role"                 = "inner"
        "console-ip"           = azurerm_network_interface.console.private_ip_address
      }))
    }
  })

  depends_on = [
    azurerm_network_interface_security_group_association.inner,
    azapi_resource.console
  ]
}

# -----------------------------------------------------------------------------
# Deny policies (same as azure/terraform/main.tf). Opt-in.
# -----------------------------------------------------------------------------
resource "azurerm_policy_definition" "deny_extensions" {
  count = var.manage_deny_policies ? 1 : 0

  name         = "safebox-${var.safebox_id}-deny-extensions"
  display_name = "Safebox: deny VM extensions and run commands (${var.safebox_id})"
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

  name         = "safebox-${var.safebox_id}-deny-bootdiag"
  display_name = "Safebox: deny boot diagnostics on safebox VMs (${var.safebox_id})"
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

  name                 = "safebox-${var.safebox_id}-deny-ext"
  display_name         = "Safebox: deny VM extensions and run commands"
  resource_group_id    = data.azurerm_resource_group.safebox.id
  policy_definition_id = azurerm_policy_definition.deny_extensions[0].id
  enforce              = true
}

resource "azurerm_resource_group_policy_assignment" "deny_bootdiag" {
  count = var.manage_deny_policies ? 1 : 0

  name                 = "safebox-${var.safebox_id}-deny-bd"
  display_name         = "Safebox: deny boot diagnostics on safebox VMs"
  resource_group_id    = data.azurerm_resource_group.safebox.id
  policy_definition_id = azurerm_policy_definition.deny_bootdiag[0].id
  enforce              = true
}
