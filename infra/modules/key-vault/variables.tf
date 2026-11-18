variable "name" {
  description = "Globally unique vault name: 3-24 characters, letters, digits and hyphens."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.name))
    error_message = "Key Vault names are 3-24 letters, digits and hyphens, starting with a letter."
  }
}

variable "location" {
  description = "Azure region of the vault."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group that holds the vault."
  type        = string
}

variable "tenant_id" {
  description = "Microsoft Entra tenant of the vault."
  type        = string
}

variable "administrator_principal_id" {
  description = "Object ID of the principal running Terraform; it gets Key Vault Secrets Officer to write the secrets."
  type        = string
}

variable "additional_administrator_principal_ids" {
  description = "Other principals that run Terraform against this vault (a CI identity, say)."
  type        = list(string)
  default     = []
}

variable "secret_names" {
  description = "Secrets to create: map of a static key (used by secret_values and secret_readers) to the Key Vault secret name."
  type        = map(string)
}

variable "secret_values" {
  description = "Secret values, by the keys of secret_names."
  type        = map(string)
  sensitive   = true
}

variable "secret_readers" {
  description = "Read grants: map of a static label to { secret = <key of secret_names>, principal_id = <managed identity principal> }."
  type = map(object({
    secret       = string
    principal_id = string
  }))
  default = {}
}

variable "purge_protection_enabled" {
  description = "Purge protection. Off by default for this demo, so `terraform destroy` really removes the vault."
  type        = bool
  default     = false
}

variable "soft_delete_retention_days" {
  description = "Days a deleted vault or secret stays recoverable (7-90)."
  type        = number
  default     = 7

  validation {
    condition     = var.soft_delete_retention_days >= 7 && var.soft_delete_retention_days <= 90
    error_message = "soft_delete_retention_days must be between 7 and 90."
  }
}

variable "rbac_propagation_wait" {
  description = "How long to wait after creating role assignments before relying on them, e.g. \"90s\"."
  type        = string
  default     = "90s"
}

variable "tags" {
  description = "Tags for every taggable resource."
  type        = map(string)
  default     = {}
}
