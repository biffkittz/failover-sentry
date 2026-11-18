# Tests of individual modules, where assertions can reach the modules' own resources.

mock_provider "azurerm" {
  source = "./tests/mocks/azurerm"
}

mock_provider "cloudflare" {
  source = "./tests/mocks/cloudflare"
}

mock_provider "time" {}

run "container_app_without_ingress_and_with_a_sidecar" {
  command = plan

  module {
    source = "./modules/container-app"
  }

  variables {
    name                         = "ca-test-console"
    resource_group_name          = "rg-test"
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/cae-test"
    identity_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-test"
    registry_server              = "crtest.azurecr.io"
    secrets                      = { "tunnel-token" = "https://kv-test.vault.azure.net/secrets/console-tunnel-token" }
    containers = [
      { name = "console", image = "crtest.azurecr.io/console:1", cpu = 0.5, memory = "1Gi", env = { A = "1" }, probe = { path = "/healthz", port = 8080 } },
      { name = "cloudflared", image = "cloudflare/cloudflared:2026.11.1", cpu = 0.25, memory = "0.5Gi", secret_env = { TUNNEL_TOKEN = "tunnel-token" } },
    ]
  }

  assert {
    condition     = length(azurerm_container_app.this.ingress) == 0
    error_message = "No ingress was requested."
  }

  assert {
    condition     = length(azurerm_container_app.this.template[0].container) == 2
    error_message = "The sidecar must run next to the main container."
  }

  assert {
    condition     = one([for secret in azurerm_container_app.this.secret : secret.key_vault_secret_id]) == "https://kv-test.vault.azure.net/secrets/console-tunnel-token"
    error_message = "Secrets must be Key Vault references."
  }
}

run "container_app_refuses_an_undeclared_secret" {
  command = plan

  module {
    source = "./modules/container-app"
  }

  variables {
    name                         = "ca-test-worker"
    resource_group_name          = "rg-test"
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/cae-test"
    identity_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-test"
    registry_server              = "crtest.azurecr.io"
    containers                   = [{ name = "worker", image = "crtest.azurecr.io/worker:1", cpu = 0.5, memory = "1Gi", secret_env = { KEY = "not-declared" } }]
  }

  expect_failures = [azurerm_container_app.this]
}

run "edge_router_requires_https_origins" {
  command = plan

  module {
    source = "./modules/edge-router"
  }

  variables {
    account_id     = "abcdef0123456789abcdef0123456789"
    zone_id        = "0123456789abcdef0123456789abcdef"
    script_name    = "test-edge"
    script_content = "export default { fetch() { return new Response('ok'); } };"
    hostname       = "dr.example.com"
    origins        = { east = "http://east.example.net", west = "https://west.example.net" }
    admin_secret   = "secret"
    service_name   = "storefront"
  }

  expect_failures = [var.origins]
}

run "alert_token_picks_the_narrowest_sending_permission" {
  command = plan

  module {
    source = "./modules/alert-email-token"
  }

  variables {
    account_id = "abcdef0123456789abcdef0123456789"
    token_name = "test token"
    permission_groups = [
      { id = "write-id", name = "Email Sending Write" },
      { id = "send-id", name = "Email Sending Send" },
      { id = "dns-id", name = "DNS Write" },
    ]
    preferred_permission_groups = ["Email Sending Send", "Email Sending Write"]
  }

  assert {
    condition     = cloudflare_account_token.this.policies[0].permission_groups[0].id == "send-id"
    error_message = "The token must get the narrowest permission group the account offers."
  }
}

run "alert_token_fails_clearly_without_email_sending" {
  command = plan

  module {
    source = "./modules/alert-email-token"
  }

  variables {
    account_id                  = "abcdef0123456789abcdef0123456789"
    token_name                  = "test token"
    permission_groups           = [{ id = "dns-id", name = "DNS Write" }]
    preferred_permission_groups = ["Email Sending Send"]
  }

  expect_failures = [cloudflare_account_token.this]
}
