# One Container App: a main container plus optional sidecars, a user-assigned identity (created before the app, so it
# can hold AcrPull and Key Vault grants before the first image pull and secret lookup), Key Vault secret references,
# and optional ingress.

locals {
  # Every env var that refers to a secret must name one of var.secrets.
  secret_names = toset(keys(var.secrets))
}

resource "azurerm_container_app" "this" {
  name                         = var.name
  container_app_environment_id = var.container_app_environment_id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  max_inactive_revisions       = 3

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.registry_server
    identity = var.identity_id
  }

  # Key Vault references: the platform reads each secret with the app's identity. The IDs carry no version, so a
  # new secret version reaches the app within about 30 minutes, or at once on a restart.
  dynamic "secret" {
    for_each = var.secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identity_id
    }
  }

  dynamic "ingress" {
    for_each = var.ingress == null ? [] : [var.ingress]
    content {
      external_enabled           = ingress.value.external
      target_port                = ingress.value.target_port
      transport                  = "auto"
      allow_insecure_connections = false

      traffic_weight {
        latest_revision = true
        percentage      = 100
      }
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    dynamic "container" {
      for_each = var.containers
      content {
        name    = container.value.name
        image   = container.value.image
        cpu     = container.value.cpu
        memory  = container.value.memory
        args    = container.value.args
        command = container.value.command

        dynamic "env" {
          for_each = container.value.env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = container.value.secret_env
          content {
            name        = env.key
            secret_name = env.value
          }
        }

        dynamic "liveness_probe" {
          for_each = container.value.probe == null ? [] : [container.value.probe]
          content {
            transport               = "HTTP"
            path                    = liveness_probe.value.path
            port                    = liveness_probe.value.port
            initial_delay           = 10
            interval_seconds        = 15
            failure_count_threshold = 4
          }
        }

        dynamic "readiness_probe" {
          for_each = container.value.probe == null ? [] : [container.value.probe]
          content {
            transport               = "HTTP"
            path                    = readiness_probe.value.path
            port                    = readiness_probe.value.port
            interval_seconds        = 10
            failure_count_threshold = 3
          }
        }
      }
    }
  }

  tags = var.tags

  lifecycle {
    # The sentry's worker tags each regional app with its DR role and epoch after every failover (Azure Resource
    # Manager tags API, merge semantics). Those two keys are runtime state, not configuration.
    ignore_changes = [tags["dr-role"], tags["dr-epoch"]]

    precondition {
      condition = alltrue(flatten([
        for container in var.containers : [for secret in values(container.secret_env) : contains(local.secret_names, secret)]
      ]))
      error_message = "Every secret_env entry must name a secret in var.secrets."
    }
  }
}
