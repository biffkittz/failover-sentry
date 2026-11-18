variable "name" {
  description = "Container App name (2-32 characters: lower-case letters, digits and hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}[a-z0-9]$", var.name))
    error_message = "Container App names are 2-32 lower-case letters, digits and hyphens, starting with a letter."
  }
}

variable "resource_group_name" {
  description = "Resource group that holds the app."
  type        = string
}

variable "container_app_environment_id" {
  description = "Environment the app runs in."
  type        = string
}

variable "identity_id" {
  description = "Resource ID of the user-assigned identity the app runs as (image pulls, Key Vault references, Azure APIs)."
  type        = string
}

variable "registry_server" {
  description = "Login server of the registry the images come from (pulled with the app's identity)."
  type        = string
}

variable "containers" {
  description = "The main container first, then any sidecars. env: plain variables; secret_env: variable name to a key of var.secrets; probe: HTTP liveness and readiness path and port."
  type = list(object({
    name       = string
    image      = string
    cpu        = number
    memory     = string
    args       = optional(list(string))
    command    = optional(list(string))
    env        = optional(map(string), {})
    secret_env = optional(map(string), {})
    probe = optional(object({
      path = string
      port = number
    }))
  }))

  validation {
    condition     = length(var.containers) > 0
    error_message = "At least one container is required."
  }
}

variable "secrets" {
  description = "Container App secrets: secret name to the versionless Key Vault secret ID it references."
  type        = map(string)
  default     = {}
}

variable "ingress" {
  description = "Ingress, or null for none (the console has none: Cloudflare Tunnel reaches it from inside)."
  type = object({
    external    = bool
    target_port = number
  })
  default = null
}

variable "min_replicas" {
  description = "Minimum replicas."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum replicas."
  type        = number
  default     = 1

  validation {
    condition     = var.max_replicas >= 1 && var.max_replicas <= 10
    error_message = "max_replicas must be between 1 and 10."
  }
}

variable "tags" {
  description = "Tags for the app."
  type        = map(string)
  default     = {}
}
