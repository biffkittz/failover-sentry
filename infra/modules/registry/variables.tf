variable "existing" {
  description = "An existing registry to use instead of creating one: its name and resource group, in the provider's subscription. Its owner keeps managing it; this module only grants AcrPull on it. Null creates a registry from name, location and sku."
  type = object({
    name                = string
    resource_group_name = string
  })
  default = null
}

variable "name" {
  description = "Globally unique name of the registry to create: 5-50 alphanumeric characters. Unused with existing."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.name))
    error_message = "Registry names are 5-50 alphanumeric characters."
  }
}

variable "location" {
  description = "Azure region of the registry to create. Unused with existing."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group of the registry to create. Unused with existing."
  type        = string
}

variable "sku" {
  description = "SKU of the registry to create. Basic (about $5/month) has no network rules; Premium adds them and geo-replication. Unused with existing."
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "sku must be Basic, Standard or Premium."
  }
}

variable "pull_principal_ids" {
  description = "Principals (managed identities) granted AcrPull, keyed by a static name such as \"worker\"."
  type        = map(string)
  default     = {}
}

variable "rbac_propagation_wait" {
  description = "How long to wait after creating role assignments before anything relies on them, e.g. \"60s\"."
  type        = string
  default     = "60s"
}

variable "tags" {
  description = "Tags for every taggable resource."
  type        = map(string)
  default     = {}
}
