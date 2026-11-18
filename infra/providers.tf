terraform {
  # Terraform 1.17 is the current release line. The upper bound keeps a future major version, which may contain
  # breaking changes, from being used by accident.
  required_version = ">= 1.17.1, < 2.0.0"

  required_providers {
    # Every Azure resource. azurerm covers all of them, so the azapi provider isn't needed.
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.14"
    }
    # The console's Cloudflare Tunnel and DNS record, the edge router (Worker, KV, custom domain) and the alert email
    # token.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29"
    }
    # Approved addition: generated secrets (session key, HMAC secrets for webhooks and admin APIs).
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    # Approved addition: short waits that let new Azure role assignments propagate before they are used. Only the
    # modules use it; it is declared here so the root module pins every provider version in one place.
    # tflint-ignore: terraform_unused_required_providers
    time = {
      source  = "hashicorp/time"
      version = "~> 0.14"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id

  # azurerm 5 registers no resource providers unless asked. Register exactly the ones this configuration uses (a
  # no-op when they're already registered).
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.App",
    "Microsoft.ContainerRegistry",
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.OperationalInsights",
  ]

  features {
    key_vault {
      # A demo: destroy purges the vault, so re-creating it later doesn't collide with a soft-deleted one.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }

    resource_group {
      # Refuse to delete a resource group that still holds resources Terraform doesn't know about.
      prevent_deletion_if_contains_resources = true
    }
  }
}

# Authenticates with the API token in the CLOUDFLARE_API_TOKEN environment variable (see docs/DEPLOYMENT.md). The
# token is deliberately not a Terraform variable, so it can't end up in a tfvars file.
provider "cloudflare" {}
