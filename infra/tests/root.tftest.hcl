# Tests for the root module: wiring, naming, tags, the two-phase deployment and input validation.
#
# Every provider is mocked, so `terraform test` needs no Azure or Cloudflare credentials and creates nothing.
# Run from infra/:  terraform init -backend=false && terraform test

mock_provider "azurerm" {
  source = "./tests/mocks/azurerm"
}

mock_provider "cloudflare" {
  source = "./tests/mocks/cloudflare"
}

mock_provider "random" {}

# Mocked so mocked applies don't actually wait for RBAC propagation.
mock_provider "time" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
}

run "foundation_without_images_creates_no_apps" {
  command = apply

  assert {
    condition     = length(module.regional_app) == 0 && length(module.worker_app) == 0 && length(module.console_app) == 0
    error_message = "Without image_tag, no Container App may be created (the images don't exist yet)."
  }

  assert {
    condition     = length(module.regional_environment) == 2
    error_message = "Each protected region needs its own Container Apps environment."
  }

  assert {
    condition     = azurerm_resource_group.control.location == "westus2" && azurerm_resource_group.regional["eastus2"].location == "eastus2" && azurerm_resource_group.regional["centralus"].location == "centralus"
    error_message = "The control plane must run in a third region, each protected region in its own."
  }

  assert {
    condition     = alltrue([for group in concat([azurerm_resource_group.control], values(azurerm_resource_group.regional)) : group.tags["project"] == "fsentry" && group.tags["managed_by"] == "terraform"])
    error_message = "Every resource group must carry the project and managed_by tags."
  }

  assert {
    condition     = !contains(output.key_vault_secret_names, "temporal-api-key") && contains(output.key_vault_secret_names, "edge-admin-secret")
    error_message = "Generated secrets exist from the first apply; optional ones only once supplied."
  }

  assert {
    condition     = strcontains(output.next_steps, "az acr build")
    error_message = "The first apply must explain how to build the images."
  }
}

run "regions_name_each_other_and_the_edge_names_both" {
  command = apply

  assert {
    condition = alltrue([
      for region in output.sentry_config.regions :
      startswith(region.baseUrl, "https://ca-fsentry-demo-app-${region.id}.") && region.provider == "azure"
    ])
    error_message = "Each region's URL must be computed from its app name and environment domain."
  }

  assert {
    condition     = output.sentry_config.initialPrimaryRegionId == "eastus2" && output.sentry_config.edgePublicUrl == "https://dr.biffkittz.com"
    error_message = "The sentry configuration must carry the primary region and the edge URL."
  }

  assert {
    condition     = output.edge_url == "https://dr.biffkittz.com" && output.console_url == "https://sentry.biffkittz.com"
    error_message = "The host names must default to dr. and sentry.biffkittz.com."
  }
}

run "deploying_requires_temporal_and_github_settings" {
  command = plan

  variables {
    image_tag = "abc1234"
  }

  expect_failures = [var.image_tag]
}

run "rejects_an_initial_primary_outside_the_regions" {
  command = plan

  variables {
    initial_primary_region = "westeurope"
  }

  expect_failures = [var.initial_primary_region]
}

run "deploys_all_apps_with_images_and_settings" {
  command = apply

  variables {
    image_tag                    = "abc1234"
    temporal_namespace           = "failover-sentry.a1b2c"
    temporal_api_key             = "mock-temporal-api-key"
    github_oauth_client_id       = "Ov23limockclientid"
    github_oauth_client_secret   = "mock-github-secret"
    console_allowed_github_users = ["octocat"]
  }

  assert {
    condition     = length(module.regional_app) == 2 && length(module.worker_app) == 1 && length(module.console_app) == 1
    error_message = "With an image tag, the console, the worker and one app per region must exist."
  }

  assert {
    condition     = contains(output.key_vault_secret_names, "temporal-api-key") && contains(output.key_vault_secret_names, "github-oauth-client-secret")
    error_message = "The supplied secrets must go to Key Vault."
  }

  assert {
    condition     = strcontains(output.next_steps, "abc1234")
    error_message = "next_steps must report the deployed tag."
  }
}

run "alert_emails_add_a_sending_token" {
  command = apply

  variables {
    alert_email_recipients = ["ops@example.com"]
  }

  # Mocks can't produce Cloudflare's permission catalogue; the module has its own tests.
  override_module {
    target = module.alert_email_token
    outputs = {
      token    = "mock-email-token"
      token_id = "ed17574386854bf78a67040be0a770b0"
    }
  }

  assert {
    condition     = contains(output.key_vault_secret_names, "alert-email-api-token")
    error_message = "With recipients, the alert token must be stored for the worker."
  }
}
