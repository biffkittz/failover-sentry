# The Azure Container Registry for the sentry's images: either created here or an existing one (one shared with
# another project, for example). Either way, pulls authenticate with managed identities (AcrPull), never with the
# admin user.

# Created when no existing registry is given. Basic is the cheapest SKU; it has no firewall, so every push and pull
# still needs a Microsoft Entra ID token.
resource "azurerm_container_registry" "this" {
  count = var.existing == null ? 1 : 0

  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku
  admin_enabled       = false
  tags                = var.tags
}

# Read, not managed: its owner keeps managing it, and this module only adds AcrPull grants on it.
data "azurerm_container_registry" "existing" {
  count = var.existing == null ? 0 : 1

  name                = var.existing.name
  resource_group_name = var.existing.resource_group_name
}

locals {
  # Exactly one of the two exists.
  registry = {
    id           = one(concat(azurerm_container_registry.this[*].id, data.azurerm_container_registry.existing[*].id))
    name         = one(concat(azurerm_container_registry.this[*].name, data.azurerm_container_registry.existing[*].name))
    login_server = one(concat(azurerm_container_registry.this[*].login_server, data.azurerm_container_registry.existing[*].login_server))
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  for_each = var.pull_principal_ids

  scope                = local.registry.id
  role_definition_name = "AcrPull"
  principal_id         = each.value
  # Managed identities are service principals; saying so skips a directory lookup that can fail for an identity
  # created moments earlier.
  principal_type = "ServicePrincipal"
}

# Role assignments take a minute or two to reach every region. Without this pause, a Container App created in the
# same apply could fail its first image pull with "unauthorized".
resource "time_sleep" "acr_pull_propagation" {
  create_duration = var.rbac_propagation_wait

  triggers = {
    role_assignment_ids = join(",", [for assignment in azurerm_role_assignment.acr_pull : assignment.id])
  }
}
