# ---------------------------------------------------------------------------------------------------------------------
# Subscription, naming and placement
# ---------------------------------------------------------------------------------------------------------------------

variable "subscription_id" {
  description = "Azure subscription to deploy into."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a subscription GUID."
  }
}

variable "project" {
  description = "Short project name used in resource names and the required `project` tag."
  type        = string
  default     = "fsentry"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.project))
    error_message = "project is 2-10 lower-case letters and digits, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "demo"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.environment))
    error_message = "environment is 2-8 lower-case letters and digits, starting with a letter."
  }
}

variable "name_suffix" {
  description = "Suffix that makes the registry and Key Vault names globally unique. Null derives a stable one from the subscription and name; never change it once deployed (it renames, and so replaces, both)."
  type        = string
  default     = null

  validation {
    condition     = var.name_suffix == null || can(regex("^[a-z0-9]{4,8}$", var.name_suffix))
    error_message = "name_suffix is 4-8 lower-case letters and digits."
  }
}

variable "control_location" {
  description = "Region of the sentry's control plane (worker, console, registry, Key Vault, logs). A third region, separate from the protected regions, so an outage in either of those doesn't take the sentry down with it."
  type        = string
  default     = "westus2"
}

variable "regions" {
  description = "Regions of the protected workload, keyed by region ID (lower-case letters, digits, hyphens). Each gets its own resource group, Container Apps environment and copy of the demo workload."
  type = map(object({
    location     = string
    display_name = string
  }))
  default = {
    eastus2 = {
      location     = "eastus2"
      display_name = "East US 2"
    }
    centralus = {
      location     = "centralus"
      display_name = "Central US"
    }
  }

  validation {
    condition     = length(var.regions) >= 2 && alltrue([for key in keys(var.regions) : can(regex("^[a-z0-9][a-z0-9-]{0,12}$", key))])
    error_message = "regions needs at least two entries, keyed by 1-13 lower-case letters, digits or hyphens."
  }
}

variable "initial_primary_region" {
  description = "The region that starts as primary the first time the sentry runs (afterwards, the sentry decides)."
  type        = string
  default     = "eastus2"

  validation {
    condition     = contains(keys(var.regions), var.initial_primary_region)
    error_message = "initial_primary_region must be one of the keys of regions."
  }
}

variable "tags" {
  description = "Extra tags for every taggable resource (project, environment and managed_by are always set)."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------------------------------------------------
# Cloudflare
# ---------------------------------------------------------------------------------------------------------------------

variable "dns_zone_name" {
  description = "Cloudflare zone that holds both host names."
  type        = string
  default     = "biffkittz.com"
}

variable "console_hostname" {
  description = "Host name of the console (served through Cloudflare Tunnel)."
  type        = string
  default     = "sentry.biffkittz.com"

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.console_hostname))
    error_message = "console_hostname must be a lower-case host name."
  }
}

variable "edge_hostname" {
  description = "Host name of the protected demo service (the edge router Worker). A first-level subdomain, so the zone's Universal SSL certificate covers it."
  type        = string
  default     = "dr.biffkittz.com"

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.edge_hostname))
    error_message = "edge_hostname must be a lower-case host name."
  }
}

variable "edge_kv_cache_ttl_seconds" {
  description = "Seconds a Cloudflare location may cache the edge routing (minimum 30). Bounds how long a routing change takes to propagate."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------------------------------------------------
# Images and sizing
# ---------------------------------------------------------------------------------------------------------------------

variable "image_tag" {
  description = "Tag of the images to run (e.g. the short commit SHA pushed with `az acr build`). Null on the first apply, before any image exists: the Container Apps are then not created. Once set, keep it set."
  type        = string
  default     = null

  validation {
    condition     = var.image_tag == null || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid container image tag."
  }

  # Deploying the apps needs everything they connect with. (Only whether the secrets are set is unwrapped from
  # "sensitive", never the secrets.)
  validation {
    condition = var.image_tag == null || (
      var.temporal_namespace != null &&
      nonsensitive(var.temporal_api_key != null) &&
      var.github_oauth_client_id != null &&
      nonsensitive(var.github_oauth_client_secret != null) &&
      length(var.console_allowed_github_users) > 0
    )
    error_message = "Deploying the apps (image_tag set) needs temporal_namespace, temporal_api_key, github_oauth_client_id, github_oauth_client_secret and at least one entry in console_allowed_github_users."
  }
}

variable "image_repositories" {
  description = "Repository names in the registry for the three images."
  type = object({
    worker   = optional(string, "failover-sentry/worker")
    console  = optional(string, "failover-sentry/console")
    regional = optional(string, "failover-sentry/regional-app")
  })
  default = {}
}

variable "cloudflared_image" {
  description = "cloudflared image for the console's tunnel sidecar, pinned by digest."
  type        = string
  default     = "cloudflare/cloudflared:2026.11.1@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d"
}

variable "container_registry_sku" {
  description = "Azure Container Registry SKU."
  type        = string
  default     = "Basic"
}

variable "container_sizes" {
  description = "CPU (cores) and memory of each container. Container Apps accepts 0.25-core steps with twice the memory in GiB per core; the console's total includes its cloudflared sidecar (0.25 cores, 0.5Gi)."
  type = object({
    worker_cpu      = optional(number, 0.5)
    worker_memory   = optional(string, "1Gi")
    console_cpu     = optional(number, 0.5)
    console_memory  = optional(string, "1Gi")
    regional_cpu    = optional(number, 0.25)
    regional_memory = optional(string, "0.5Gi")
  })
  default = {}
}

# ---------------------------------------------------------------------------------------------------------------------
# Temporal Cloud
# ---------------------------------------------------------------------------------------------------------------------

variable "temporal_namespace" {
  description = "Temporal Cloud namespace, e.g. failover-sentry.a1b2c (created by hand in Temporal Cloud). Required once image_tag is set."
  type        = string
  default     = null

  validation {
    condition     = var.temporal_namespace == null || can(regex("^[a-z0-9][a-z0-9._-]{1,62}$", var.temporal_namespace))
    error_message = "temporal_namespace must be a Temporal Cloud namespace ID such as failover-sentry.a1b2c."
  }
}

variable "temporal_address" {
  description = "Temporal Cloud gRPC endpoint. Null uses the namespace endpoint <namespace>.tmprl.cloud:7233."
  type        = string
  default     = null
}

variable "temporal_api_key" {
  description = "Temporal Cloud API key for the namespace (worker and console). Supply as TF_VAR_temporal_api_key; it goes to Key Vault."
  type        = string
  default     = null
  sensitive   = true
}

variable "temporal_task_queue" {
  description = "Task queue of the sentry's worker."
  type        = string
  default     = "failover-sentry"
}

# ---------------------------------------------------------------------------------------------------------------------
# Console sign-in (GitHub OAuth App, created by hand)
# ---------------------------------------------------------------------------------------------------------------------

variable "github_oauth_client_id" {
  description = "Client ID of the console's GitHub OAuth App (callback URL https://<console_hostname>/auth/github/callback). Required once image_tag is set."
  type        = string
  default     = null
}

variable "github_oauth_client_secret" {
  description = "Client secret of the console's GitHub OAuth App. Supply as TF_VAR_github_oauth_client_secret; it goes to Key Vault."
  type        = string
  default     = null
  sensitive   = true
}

variable "console_allowed_github_users" {
  description = "GitHub logins allowed to sign in to the console (case-insensitive). Every allowed user is an operator."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for login in var.console_allowed_github_users : can(regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$", login))])
    error_message = "console_allowed_github_users must be GitHub logins."
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# Alerts (Cloudflare Email Service)
# ---------------------------------------------------------------------------------------------------------------------

variable "alert_email_recipients" {
  description = "Addresses that receive the sentry's alert emails. Each must already be a verified destination address of the Cloudflare account. Empty: alerts are only shown in the console and logged."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.alert_email_recipients : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", address))])
    error_message = "alert_email_recipients must be email addresses."
  }
}

variable "alert_email_sender_username" {
  description = "Local part of the alert sender address, in dns_zone_name (which must be onboarded for Email Sending)."
  type        = string
  default     = "sentry-alerts"
}

variable "alert_min_severity" {
  description = "Least severe alert that is emailed: info, warning or critical."
  type        = string
  default     = "warning"

  validation {
    condition     = contains(["info", "warning", "critical"], var.alert_min_severity)
    error_message = "alert_min_severity must be info, warning or critical."
  }
}

variable "cloudflare_email_sending_permission_groups" {
  description = "Names of Cloudflare API token permission groups that allow sending email, narrowest first. Change only if Cloudflare renames them."
  type        = list(string)
  default     = ["Email Sending Send", "Email Sending Write"]
}

# ---------------------------------------------------------------------------------------------------------------------
# The sentry's policies (rendered into its configuration; the console shows them)
# ---------------------------------------------------------------------------------------------------------------------

variable "service_name" {
  description = "Name of the protected service; the sentry's workflow ID is failover-sentry/<service_name>."
  type        = string
  default     = "storefront"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,40}$", var.service_name))
    error_message = "service_name is 1-41 lower-case letters, digits or hyphens."
  }
}

variable "health_policy" {
  description = "How the region monitors probe and judge health. Each probe interval costs about two Temporal Cloud actions per region."
  type = object({
    probe_interval_seconds = optional(number, 30)
    probe_timeout_ms       = optional(number, 5000)
    failure_threshold      = optional(number, 3)
    degraded_latency_ms    = optional(number, 1500)
    window_size            = optional(number, 10)
    report_every_probes    = optional(number, 10)
  })
  default = {}

  validation {
    condition     = var.health_policy.probe_interval_seconds >= 5 && var.health_policy.failure_threshold >= 1
    error_message = "probe_interval_seconds must be at least 5 and failure_threshold at least 1."
  }
}

variable "failover_policy" {
  description = "How the sentry fails over: automatic or not, cooldown, the replication webhook's durable timeout, stall escalation, edge propagation, stabilization, and whether a forced failover stops the old primary's compute."
  type = object({
    auto_failover_enabled                = optional(bool, true)
    cooldown_seconds                     = optional(number, 600)
    replication_timeout_seconds          = optional(number, 120)
    stall_escalation_seconds             = optional(number, 600)
    edge_propagation_timeout_seconds     = optional(number, 180)
    stabilization_seconds                = optional(number, 90)
    stabilization_probe_interval_seconds = optional(number, 10)
    stabilization_failure_threshold      = optional(number, 3)
    fence_compute_on_forced_failover     = optional(bool, true)
  })
  default = {}
}

# ---------------------------------------------------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------------------------------------------------

variable "key_vault_additional_administrators" {
  description = "Object IDs of other principals that run Terraform (a CI identity, say); they get Key Vault Secrets Officer too."
  type        = list(string)
  default     = []
}

variable "log_analytics_retention_days" {
  description = "Days Log Analytics keeps logs (30 is included in the price)."
  type        = number
  default     = 30
}

variable "log_analytics_daily_quota_gb" {
  description = "Daily ingestion cap in GB, a cost guard (-1 for none)."
  type        = number
  default     = 0.5
}

variable "rbac_propagation_wait" {
  description = "Wait after creating role assignments before relying on them."
  type        = string
  default     = "90s"
}
