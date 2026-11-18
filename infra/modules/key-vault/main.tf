# Key Vault holds every secret the sentry's containers use. Access is Azure RBAC, granted per secret, so each
# identity reads only what it uses (the regional workloads can't read the Temporal API key, for example).

resource "azurerm_key_vault" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  sku_name            = "standard"

  rbac_authorization_enabled = true
  purge_protection_enabled   = var.purge_protection_enabled
  soft_delete_retention_days = var.soft_delete_retention_days

  # The public endpoint stays on: every request still needs an Entra ID token and an RBAC role, and Container Apps'
  # Key Vault references are not a "trusted Microsoft service" for the vault firewall.
  network_acls {
    bypass         = "AzureServices"
    default_action = "Allow"
  }

  tags = var.tags
}

# RBAC-mode vaults give Owners no data-plane access by default: the principal running Terraform needs this role to
# write the secrets below.
resource "azurerm_role_assignment" "administrator" {
  for_each = toset(concat([var.administrator_principal_id], var.additional_administrator_principal_ids))

  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# New role assignments take a minute or two to take effect; writing secrets at once would fail with 403.
resource "time_sleep" "administrator_rbac" {
  create_duration = var.rbac_propagation_wait

  triggers = {
    role_assignment_ids = join(",", [for assignment in azurerm_role_assignment.administrator : assignment.id])
  }
}

resource "azurerm_key_vault_secret" "this" {
  for_each = var.secret_names

  name         = each.value
  value        = var.secret_values[each.key]
  content_type = "text/plain"
  key_vault_id = azurerm_key_vault.this.id
  tags         = var.tags

  depends_on = [time_sleep.administrator_rbac]
}

# Read access to one secret per assignment (least privilege).
resource "azurerm_role_assignment" "secret_reader" {
  for_each = var.secret_readers

  scope                = azurerm_key_vault_secret.this[each.value.secret].resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value.principal_id
  principal_type       = "ServicePrincipal"
}

resource "time_sleep" "reader_rbac" {
  create_duration = var.rbac_propagation_wait

  triggers = {
    role_assignment_ids = join(",", [for assignment in azurerm_role_assignment.secret_reader : assignment.id])
  }
}
