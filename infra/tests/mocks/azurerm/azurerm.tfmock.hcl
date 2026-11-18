# Realistic values for computed attributes of mocked azurerm resources. The provider still validates arguments during
# a mocked apply (that a scope is a well-formed Azure resource ID, for example), so each type gets a value in its
# real format. Every instance of a type shares these values, which is fine for tests.

mock_data "azurerm_client_config" {
  defaults = {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    tenant_id       = "11111111-1111-1111-1111-111111111111"
    object_id       = "22222222-2222-2222-2222-222222222222"
    client_id       = "33333333-3333-3333-3333-333333333333"
  }
}

mock_resource "azurerm_resource_group" {
  defaults = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock"
  }
}

mock_resource "azurerm_log_analytics_workspace" {
  defaults = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    workspace_id = "66666666-6666-6666-6666-666666666666"
  }
}

mock_resource "azurerm_user_assigned_identity" {
  defaults = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
    principal_id = "44444444-4444-4444-4444-444444444444"
    client_id    = "55555555-5555-5555-5555-555555555555"
    tenant_id    = "11111111-1111-1111-1111-111111111111"
  }
}

mock_resource "azurerm_container_registry" {
  defaults = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.ContainerRegistry/registries/crmock"
    login_server = "crmock.azurecr.io"
  }
}

mock_data "azurerm_container_registry" {
  defaults = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-shared/providers/Microsoft.ContainerRegistry/registries/crshared"
    login_server = "crshared.azurecr.io"
  }
}

mock_resource "azurerm_role_assignment" {
  defaults = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleAssignments/77777777-7777-7777-7777-777777777777"
  }
}

mock_resource "azurerm_role_definition" {
  defaults = {
    id                          = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/88888888-8888-8888-8888-888888888888|/subscriptions/00000000-0000-0000-0000-000000000000"
    role_definition_id          = "88888888-8888-8888-8888-888888888888"
    role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/88888888-8888-8888-8888-888888888888"
  }
}

mock_resource "azurerm_key_vault" {
  defaults = {
    id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.KeyVault/vaults/kv-mock"
    vault_uri = "https://kv-mock.vault.azure.net/"
  }
}

mock_resource "azurerm_key_vault_secret" {
  defaults = {
    id                      = "https://kv-mock.vault.azure.net/secrets/secret-mock/0123456789abcdef0123456789abcdef"
    versionless_id          = "https://kv-mock.vault.azure.net/secrets/secret-mock"
    resource_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.KeyVault/vaults/kv-mock/secrets/secret-mock/versions/0123456789abcdef0123456789abcdef"
    resource_versionless_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.KeyVault/vaults/kv-mock/secrets/secret-mock"
    version                 = "0123456789abcdef0123456789abcdef"
  }
}

mock_resource "azurerm_container_app_environment" {
  defaults = {
    id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    default_domain                = "mock-1a2b3c.region.azurecontainerapps.io"
    static_ip_address             = "20.0.0.1"
    custom_domain_verification_id = "0000000000000000000000000000000000000000000000000000000000000000"
  }
}

mock_resource "azurerm_container_app" {
  defaults = {
    id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-mock/providers/Microsoft.App/containerApps/ca-mock"
    latest_revision_name = "ca-mock--0000001"
    latest_revision_fqdn = "ca-mock--0000001.mock-1a2b3c.region.azurecontainerapps.io"
  }
}
