variable "account_id" {
  description = "Cloudflare account that owns the token."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a Cloudflare account ID: 32 lower-case hexadecimal characters."
  }
}

variable "token_name" {
  description = "Name the Cloudflare dashboard lists the token under."
  type        = string
}

variable "permission_groups" {
  description = "Cloudflare's catalogue of API token permission groups (the cloudflare_account_api_token_permission_groups_list data source's result)."
  type = list(object({
    id            = string
    name          = string
    is_selectable = optional(bool)
    scopes        = optional(list(string), [])
  }))
}

variable "preferred_permission_groups" {
  description = "Names of permission groups that allow sending email, narrowest first."
  type        = list(string)

  validation {
    condition     = length(var.preferred_permission_groups) > 0
    error_message = "preferred_permission_groups must name at least one permission group."
  }
}
