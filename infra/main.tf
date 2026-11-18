# The Failover Sentry on Azure Container Apps and Cloudflare.
#
#   operators ──HTTPS──▶ Cloudflare (sentry.biffkittz.com) ──Tunnel──▶ console (cloudflared sidecar, no ingress)
#                                                                         │ Temporal client (API key)
#   worker (Temporal workflows + activities) ◀──────── Temporal Cloud ◀──┘
#     │ probes, signed DB orders ─────────────▶ demo workload, region A (Container App, its own environment)
#     │                                  └────▶ demo workload, region B          ▲
#     │ ARM: stop/start (fencing), tags ─────────────────────────────────────────┘
#     │ signed routing writes ───▶ Cloudflare Worker + KV (dr.biffkittz.com) ──proxies──▶ active region
#     └ alert emails ───▶ Cloudflare Email Service
#   regions ──signed replication webhook──▶ console's webhook gateway ──signal──▶ the sentry
#
# The control plane (worker, console, Key Vault, logs) lives in a third region, so an outage in either protected
# region can't take the sentry down with it. The registry is created there too, unless an existing one is used. docs/ARCHITECTURE.md explains each decision.

data "azurerm_client_config" "current" {}

data "cloudflare_zone" "this" {
  filter = {
    name = var.dns_zone_name
  }
}

locals {
  name         = "${var.project}-${var.environment}"         # e.g. fsentry-demo
  compact_name = substr(replace(local.name, "-", ""), 0, 13) # for names that allow no hyphens
  # Deterministic, so every plan computes the same names. (A changing value such as timestamp() would rename, and
  # so replace, the registry and the Key Vault on every apply.)
  suffix = coalesce(var.name_suffix, substr(sha256("${var.subscription_id}/${local.name}"), 0, 6))

  tags = merge(var.tags, {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
    application = "failover-sentry"
  })

  # Cloud Adoption Framework abbreviations. Registry and Key Vault names are global, so they carry the suffix.
  names = {
    resource_group      = "rg-${local.name}"
    log_analytics       = "log-${local.name}"
    container_registry  = "cr${local.compact_name}${local.suffix}"
    key_vault           = "kv-${local.compact_name}-${local.suffix}"
    control_environment = "cae-${local.name}"
    console_app         = "ca-${local.name}-console"
    worker_app          = "ca-${local.name}-worker"
    identity_console    = "id-${local.name}-console"
    identity_worker     = "id-${local.name}-worker"
    identity_regional   = "id-${local.name}-regional"
    tunnel              = "${local.name}-console"
    edge_worker         = "${local.name}-edge"
    fencing_role        = "Failover Sentry fencing operator (${local.name})"
  }

  regional_names = {
    for key, region in var.regions : key => {
      resource_group = "rg-${local.name}-${key}"
      environment    = "cae-${local.name}-${key}"
      app            = "ca-${local.name}-app-${key}"
    }
  }

  deploy_apps           = var.image_tag != null
  cloudflare_account_id = data.cloudflare_zone.this.account.id

  # Each regional app's host name is <app name>.<its environment's default domain>, known as soon as the environment
  # exists. Computing it (rather than reading it from the app) lets the regions name each other as replication peers,
  # and the edge name them both, without a dependency cycle.
  regional_urls = {
    for key, names in local.regional_names : key => "https://${names.app}.${module.regional_environment[key].default_domain}"
  }
  regional_app_ids = {
    for key, names in local.regional_names :
    key => "/subscriptions/${var.subscription_id}/resourceGroups/${names.resource_group}/providers/Microsoft.App/containerApps/${names.app}"
  }

  # The sentry's configuration, identical for the worker and the console (both validate it at startup).
  sentry_config = {
    serviceName            = var.service_name
    edgePublicUrl          = "https://${var.edge_hostname}"
    consoleUrl             = "https://${var.console_hostname}"
    initialPrimaryRegionId = var.initial_primary_region
    regions = [
      for key, region in var.regions : {
        id              = key
        displayName     = region.display_name
        provider        = "azure"
        baseUrl         = local.regional_urls[key]
        azureResourceId = local.regional_app_ids[key]
      }
    ]
    health = {
      probeIntervalSeconds = var.health_policy.probe_interval_seconds
      probeTimeoutMs       = var.health_policy.probe_timeout_ms
      failureThreshold     = var.health_policy.failure_threshold
      degradedLatencyMs    = var.health_policy.degraded_latency_ms
      windowSize           = var.health_policy.window_size
      reportEveryProbes    = var.health_policy.report_every_probes
    }
    failover = {
      autoFailoverEnabled               = var.failover_policy.auto_failover_enabled
      cooldownSeconds                   = var.failover_policy.cooldown_seconds
      replicationTimeoutSeconds         = var.failover_policy.replication_timeout_seconds
      stallEscalationSeconds            = var.failover_policy.stall_escalation_seconds
      edgePropagationTimeoutSeconds     = var.failover_policy.edge_propagation_timeout_seconds
      stabilizationSeconds              = var.failover_policy.stabilization_seconds
      stabilizationProbeIntervalSeconds = var.failover_policy.stabilization_probe_interval_seconds
      stabilizationFailureThreshold     = var.failover_policy.stabilization_failure_threshold
      fenceComputeOnForcedFailover      = var.failover_policy.fence_compute_on_forced_failover
    }
  }
  sentry_config_json = jsonencode(local.sentry_config)

  temporal_address = var.temporal_namespace == null ? null : coalesce(var.temporal_address, "${var.temporal_namespace}.tmprl.cloud:7233")

  # Optional pieces, decided on whether a secret is set (only that fact is unwrapped from "sensitive").
  temporal_configured = nonsensitive(var.temporal_api_key != null)
  github_configured   = nonsensitive(var.github_oauth_client_secret != null)
  alerts_enabled      = length(var.alert_email_recipients) > 0
  alert_sender        = "${var.alert_email_sender_username}@${var.dns_zone_name}"

  image = {
    worker   = "${module.registry.login_server}/${var.image_repositories.worker}:${coalesce(var.image_tag, "none")}"
    console  = "${module.registry.login_server}/${var.image_repositories.console}:${coalesce(var.image_tag, "none")}"
    regional = "${module.registry.login_server}/${var.image_repositories.regional}:${coalesce(var.image_tag, "none")}"
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# Resource groups, logs and identities
# ---------------------------------------------------------------------------------------------------------------------

resource "azurerm_resource_group" "control" {
  name     = local.names.resource_group
  location = var.control_location
  tags     = local.tags
}

# One resource group per protected region, as a real multi-region deployment would have.
resource "azurerm_resource_group" "regional" {
  for_each = var.regions

  name     = local.regional_names[each.key].resource_group
  location = each.value.location
  tags     = merge(local.tags, { region = each.key })
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = local.names.log_analytics
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_analytics_retention_days
  # A cost guard for a demo: ingestion stops for the day at the cap.
  daily_quota_gb = var.log_analytics_daily_quota_gb
  tags           = local.tags
}

# User-assigned identities exist before the apps, so their AcrPull and Key Vault grants can propagate in time for the
# first image pull and secret lookup.
resource "azurerm_user_assigned_identity" "console" {
  name                = local.names.identity_console
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "worker" {
  name                = local.names.identity_worker
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "regional" {
  name                = local.names.identity_regional
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  tags                = local.tags
}

# ---------------------------------------------------------------------------------------------------------------------
# What the worker may do to the regions: fence (stop) and recover (start) their Container Apps, and tag them. A custom
# role, because the built-in Container Apps Operator also allows every other action (exec, log streams, secrets).
# ---------------------------------------------------------------------------------------------------------------------

resource "azurerm_role_definition" "fencing" {
  name        = local.names.fencing_role
  scope       = "/subscriptions/${var.subscription_id}"
  description = "Read, start and stop Container Apps: what the Failover Sentry needs to fence a failed region and recover it."

  permissions {
    actions = [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/start/action",
      "Microsoft.App/containerApps/stop/action",
    ]
  }

  assignable_scopes = [for group in azurerm_resource_group.regional : group.id]
}

resource "azurerm_role_assignment" "worker_fencing" {
  for_each = var.regions

  scope              = azurerm_resource_group.regional[each.key].id
  role_definition_id = azurerm_role_definition.fencing.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.worker.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "worker_tags" {
  for_each = var.regions

  scope                = azurerm_resource_group.regional[each.key].id
  role_definition_name = "Tag Contributor"
  principal_id         = azurerm_user_assigned_identity.worker.principal_id
  principal_type       = "ServicePrincipal"
}

# ---------------------------------------------------------------------------------------------------------------------
# Registry and secrets
# ---------------------------------------------------------------------------------------------------------------------

# Created in the control region, or an existing registry (existing_container_registry) that this configuration only
# grants AcrPull on.
module "registry" {
  source = "./modules/registry"

  existing            = var.existing_container_registry
  name                = local.names.container_registry
  location            = azurerm_resource_group.control.location
  resource_group_name = azurerm_resource_group.control.name
  sku                 = var.container_registry_sku
  pull_principal_ids = {
    console  = azurerm_user_assigned_identity.console.principal_id
    worker   = azurerm_user_assigned_identity.worker.principal_id
    regional = azurerm_user_assigned_identity.regional.principal_id
  }
  rbac_propagation_wait = var.rbac_propagation_wait
  tags                  = local.tags
}

# Generated secrets: nobody handles them. They live in Key Vault and, marked sensitive, in the remote state.
resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "random_password" "region_admin_secret" {
  length  = 48
  special = false
}

resource "random_password" "edge_admin_secret" {
  length  = 48
  special = false
}

resource "random_password" "webhook_secret" {
  length  = 48
  special = false
}

locals {
  # Key Vault secret names by a static key. Optional secrets exist only once their value is supplied.
  key_vault_secret_names = merge(
    {
      session_secret      = "console-session-secret"
      region_admin_secret = "region-admin-secret"
      edge_admin_secret   = "edge-admin-secret"
      webhook_secret      = "webhook-signing-secret"
      tunnel_token        = "console-tunnel-token"
    },
    local.temporal_configured ? { temporal_api_key = "temporal-api-key" } : {},
    local.github_configured ? { github_client_secret = "github-oauth-client-secret" } : {},
    local.alerts_enabled ? { alert_email_token = "alert-email-api-token" } : {},
  )

  key_vault_secret_values = merge(
    {
      session_secret      = random_password.session_secret.result
      region_admin_secret = random_password.region_admin_secret.result
      edge_admin_secret   = random_password.edge_admin_secret.result
      webhook_secret      = random_password.webhook_secret.result
      tunnel_token        = module.console_tunnel.token
    },
    local.temporal_configured ? { temporal_api_key = var.temporal_api_key } : {},
    local.github_configured ? { github_client_secret = var.github_oauth_client_secret } : {},
    local.alerts_enabled ? { alert_email_token = module.alert_email_token[0].token } : {},
  )

  # Which identity reads which secret (each reads only what it uses).
  key_vault_secret_readers = merge(
    {
      "console: session"      = { secret = "session_secret", principal_id = azurerm_user_assigned_identity.console.principal_id }
      "console: region admin" = { secret = "region_admin_secret", principal_id = azurerm_user_assigned_identity.console.principal_id }
      "console: webhook"      = { secret = "webhook_secret", principal_id = azurerm_user_assigned_identity.console.principal_id }
      "console: tunnel"       = { secret = "tunnel_token", principal_id = azurerm_user_assigned_identity.console.principal_id }
      "worker: region admin"  = { secret = "region_admin_secret", principal_id = azurerm_user_assigned_identity.worker.principal_id }
      "worker: edge admin"    = { secret = "edge_admin_secret", principal_id = azurerm_user_assigned_identity.worker.principal_id }
      "regional: admin"       = { secret = "region_admin_secret", principal_id = azurerm_user_assigned_identity.regional.principal_id }
      "regional: webhook"     = { secret = "webhook_secret", principal_id = azurerm_user_assigned_identity.regional.principal_id }
    },
    local.temporal_configured ? {
      "console: temporal" = { secret = "temporal_api_key", principal_id = azurerm_user_assigned_identity.console.principal_id }
      "worker: temporal"  = { secret = "temporal_api_key", principal_id = azurerm_user_assigned_identity.worker.principal_id }
    } : {},
    local.github_configured ? {
      "console: github" = { secret = "github_client_secret", principal_id = azurerm_user_assigned_identity.console.principal_id }
    } : {},
    local.alerts_enabled ? {
      "worker: alert email" = { secret = "alert_email_token", principal_id = azurerm_user_assigned_identity.worker.principal_id }
    } : {},
  )
}

module "key_vault" {
  source = "./modules/key-vault"

  name                                   = local.names.key_vault
  location                               = azurerm_resource_group.control.location
  resource_group_name                    = azurerm_resource_group.control.name
  tenant_id                              = data.azurerm_client_config.current.tenant_id
  administrator_principal_id             = data.azurerm_client_config.current.object_id
  additional_administrator_principal_ids = var.key_vault_additional_administrators
  secret_names                           = local.key_vault_secret_names
  secret_values                          = local.key_vault_secret_values
  secret_readers                         = local.key_vault_secret_readers
  rbac_propagation_wait                  = var.rbac_propagation_wait
  tags                                   = local.tags
}

# ---------------------------------------------------------------------------------------------------------------------
# Cloudflare: the console's tunnel, the edge router and the alert email token
# ---------------------------------------------------------------------------------------------------------------------

module "console_tunnel" {
  source = "./modules/cloudflare-tunnel"

  account_id = local.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.id
  name       = local.names.tunnel
  hostname   = var.console_hostname
}

module "edge_router" {
  source = "./modules/edge-router"

  account_id           = local.cloudflare_account_id
  zone_id              = data.cloudflare_zone.this.id
  script_name          = local.names.edge_worker
  script_content       = file("${path.module}/../apps/edge-router/src/worker.js")
  hostname             = var.edge_hostname
  origins              = local.regional_urls
  admin_secret         = random_password.edge_admin_secret.result
  service_name         = var.service_name
  kv_cache_ttl_seconds = var.edge_kv_cache_ttl_seconds
}

# Cloudflare's catalogue of token permissions, from which the alert token's (Email Sending) is picked.
data "cloudflare_account_api_token_permission_groups_list" "this" {
  count = local.alerts_enabled ? 1 : 0

  account_id = local.cloudflare_account_id
}

module "alert_email_token" {
  source = "./modules/alert-email-token"
  count  = local.alerts_enabled ? 1 : 0

  account_id                  = local.cloudflare_account_id
  token_name                  = "${local.name} sentry: send alert emails (managed by Terraform, project:${var.project})"
  permission_groups           = data.cloudflare_account_api_token_permission_groups_list.this[0].result
  preferred_permission_groups = var.cloudflare_email_sending_permission_groups
}

# ---------------------------------------------------------------------------------------------------------------------
# Container Apps: environments, the demo workload in each region, and the control plane
# ---------------------------------------------------------------------------------------------------------------------

module "control_environment" {
  source = "./modules/container-app-environment"

  name                       = local.names.control_environment
  location                   = azurerm_resource_group.control.location
  resource_group_name        = azurerm_resource_group.control.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

module "regional_environment" {
  source   = "./modules/container-app-environment"
  for_each = var.regions

  name                       = local.regional_names[each.key].environment
  location                   = each.value.location
  resource_group_name        = azurerm_resource_group.regional[each.key].name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = merge(local.tags, { region = each.key })
}

# The protected demo workload. Exactly one replica per region: its simulated database lives in memory.
module "regional_app" {
  source   = "./modules/container-app"
  for_each = local.deploy_apps ? var.regions : {}

  name                         = local.regional_names[each.key].app
  resource_group_name          = azurerm_resource_group.regional[each.key].name
  container_app_environment_id = module.regional_environment[each.key].id
  identity_id                  = azurerm_user_assigned_identity.regional.id
  registry_server              = module.registry.login_server
  ingress                      = { external = true, target_port = 8080 }
  min_replicas                 = 1
  max_replicas                 = 1

  secrets = {
    "region-admin-secret" = module.key_vault.secret_ids["region_admin_secret"]
    "webhook-secret"      = module.key_vault.secret_ids["webhook_secret"]
  }

  containers = [{
    name   = "app"
    image  = local.image.regional
    cpu    = var.container_sizes.regional_cpu
    memory = var.container_sizes.regional_memory
    env = {
      REGION_ID   = each.key
      REGION_NAME = each.value.display_name
      PEERS       = join(",", [for other, url in local.regional_urls : "${other}=${url}" if other != each.key])
      WEBHOOK_URL = "https://${var.console_hostname}/api/webhooks/replication"
      APP_VERSION = coalesce(var.image_tag, "none")
    }
    secret_env = {
      ADMIN_SHARED_SECRET = "region-admin-secret"
      WEBHOOK_SECRET      = "webhook-secret"
    }
    # /livez ignores chaos, so the platform never restarts (and so "heals") a region the chaos panel took down.
    probe = { path = "/livez", port = 8080 }
  }]

  tags = merge(local.tags, { component = "demo-workload", region = each.key })
}

module "worker_app" {
  source = "./modules/container-app"
  count  = local.deploy_apps ? 1 : 0

  name                         = local.names.worker_app
  resource_group_name          = azurerm_resource_group.control.name
  container_app_environment_id = module.control_environment.id
  identity_id                  = azurerm_user_assigned_identity.worker.id
  registry_server              = module.registry.login_server
  # One replica is plenty: Temporal hands each task to exactly one worker, and replicas only add capacity.
  min_replicas = 1
  max_replicas = 1

  secrets = merge(
    {
      "temporal-api-key"    = module.key_vault.secret_ids["temporal_api_key"]
      "region-admin-secret" = module.key_vault.secret_ids["region_admin_secret"]
      "edge-admin-secret"   = module.key_vault.secret_ids["edge_admin_secret"]
    },
    local.alerts_enabled ? { "alert-email-token" = module.key_vault.secret_ids["alert_email_token"] } : {},
  )

  containers = [{
    name   = "worker"
    image  = local.image.worker
    cpu    = var.container_sizes.worker_cpu
    memory = var.container_sizes.worker_memory
    env = merge(
      {
        SENTRY_CONFIG_JSON = local.sentry_config_json
        TEMPORAL_ADDRESS   = local.temporal_address
        TEMPORAL_NAMESPACE = var.temporal_namespace
        TASK_QUEUE         = var.temporal_task_queue
        COMPUTE_PROVIDER   = "azure"
        AZURE_CLIENT_ID    = azurerm_user_assigned_identity.worker.client_id
        ALERT_PROVIDER     = local.alerts_enabled ? "cloudflare-email" : "log"
        ALERT_MIN_SEVERITY = var.alert_min_severity
        APP_VERSION        = coalesce(var.image_tag, "none")
      },
      local.alerts_enabled ? {
        CLOUDFLARE_ACCOUNT_ID = local.cloudflare_account_id
        ALERT_EMAIL_FROM      = local.alert_sender
        ALERT_EMAIL_TO        = join(",", var.alert_email_recipients)
      } : {},
    )
    secret_env = merge(
      {
        TEMPORAL_API_KEY    = "temporal-api-key"
        REGION_ADMIN_SECRET = "region-admin-secret"
        EDGE_ADMIN_SECRET   = "edge-admin-secret"
      },
      local.alerts_enabled ? { CLOUDFLARE_EMAIL_API_TOKEN = "alert-email-token" } : {},
    )
    probe = { path = "/healthz", port = 8081 }
  }]

  tags = merge(local.tags, { component = "worker" })

  # Fencing and tagging must work from the worker's first failover.
  depends_on = [azurerm_role_assignment.worker_fencing, azurerm_role_assignment.worker_tags]
}

# The console: Fastify (API, GitHub sign-in, webhook gateway, the Vue app) plus cloudflared, which connects the
# tunnel. No ingress at all: Cloudflare reaches the console only through the tunnel.
module "console_app" {
  source = "./modules/container-app"
  count  = local.deploy_apps ? 1 : 0

  name                         = local.names.console_app
  resource_group_name          = azurerm_resource_group.control.name
  container_app_environment_id = module.control_environment.id
  identity_id                  = azurerm_user_assigned_identity.console.id
  registry_server              = module.registry.login_server
  min_replicas                 = 1
  max_replicas                 = 1

  secrets = {
    "temporal-api-key"     = module.key_vault.secret_ids["temporal_api_key"]
    "session-secret"       = module.key_vault.secret_ids["session_secret"]
    "github-client-secret" = module.key_vault.secret_ids["github_client_secret"]
    "webhook-secret"       = module.key_vault.secret_ids["webhook_secret"]
    "region-admin-secret"  = module.key_vault.secret_ids["region_admin_secret"]
    "tunnel-token"         = module.key_vault.secret_ids["tunnel_token"]
  }

  containers = [
    {
      name   = "console"
      image  = local.image.console
      cpu    = var.container_sizes.console_cpu
      memory = var.container_sizes.console_memory
      env = {
        NODE_ENV             = "production"
        PUBLIC_URL           = "https://${var.console_hostname}"
        SENTRY_CONFIG_JSON   = local.sentry_config_json
        TEMPORAL_ADDRESS     = local.temporal_address
        TEMPORAL_NAMESPACE   = var.temporal_namespace
        TASK_QUEUE           = var.temporal_task_queue
        AUTH_MODE            = "github"
        GITHUB_CLIENT_ID     = var.github_oauth_client_id
        GITHUB_ALLOWED_USERS = join(",", var.console_allowed_github_users)
        APP_VERSION          = coalesce(var.image_tag, "none")
      }
      secret_env = {
        TEMPORAL_API_KEY       = "temporal-api-key"
        SESSION_SECRET         = "session-secret"
        GITHUB_CLIENT_SECRET   = "github-client-secret"
        WEBHOOK_SIGNING_SECRET = "webhook-secret"
        REGION_ADMIN_SECRET    = "region-admin-secret"
      }
      probe = { path = "/healthz", port = 8080 }
    },
    {
      name   = "cloudflared"
      image  = var.cloudflared_image
      cpu    = 0.25
      memory = "0.5Gi"
      args   = ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]
      secret_env = {
        TUNNEL_TOKEN = "tunnel-token"
      }
      probe = { path = "/ready", port = 2000 }
    },
  ]

  tags = merge(local.tags, { component = "console" })
}
