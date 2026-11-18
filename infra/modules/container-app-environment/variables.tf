variable "name" {
  description = "Environment name (2-60 characters: lower-case letters, digits and hyphens)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,58}[a-z0-9]$", var.name))
    error_message = "Environment names are 2-60 lower-case letters, digits and hyphens."
  }
}

variable "location" {
  description = "Azure region of the environment."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group that holds the environment."
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace that receives the environment's container logs (may be in another region)."
  type        = string
}

variable "tags" {
  description = "Tags for every taggable resource."
  type        = map(string)
  default     = {}
}
