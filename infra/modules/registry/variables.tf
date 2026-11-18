variable "name" {
  description = "Globally unique registry name: 5-50 alphanumeric characters."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.name))
    error_message = "Registry names are 5-50 alphanumeric characters."
  }
}

variable "location" {
  description = "Azure region of the registry."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group that holds the registry."
  type        = string
}

variable "sku" {
  description = "Registry SKU. Basic (about $5/month) has no network rules; Premium adds them and geo-replication."
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
