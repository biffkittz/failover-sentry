# Azure Container Registry for the sentry's images. Pulls authenticate with managed identities (AcrPull), never with
# the admin user, which stays disabled. Basic is the cheapest SKU; it has no firewall, so every push and pull still
# needs a Microsoft Entra ID token.
resource "azurerm_container_registry" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku
  admin_enabled       = false
  tags                = var.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  for_each = var.pull_principal_ids

  scope                = azurerm_container_registry.this.id
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
