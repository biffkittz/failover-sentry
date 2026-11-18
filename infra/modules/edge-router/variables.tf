variable "account_id" {
  description = "Cloudflare account that owns the Worker and its KV namespace."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a Cloudflare account ID: 32 lower-case hexadecimal characters."
  }
}

variable "zone_id" {
  description = "Cloudflare zone of the host name."
  type        = string
}

variable "script_name" {
  description = "Worker script name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", var.script_name))
    error_message = "Worker names are lower-case letters, digits and hyphens."
  }
}

variable "script_content" {
  description = "The Worker's ES module source (apps/edge-router/src/worker.js)."
  type        = string
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date."
  type        = string
  default     = "2026-11-01"
}

variable "hostname" {
  description = "Public host name of the protected service, e.g. dr.biffkittz.com."
  type        = string
}

variable "origins" {
  description = "Region ID to the origin base URL the Worker proxies to (the regional Container Apps' host names)."
  type        = map(string)

  validation {
    condition     = length(var.origins) >= 2 && alltrue([for url in values(var.origins) : startswith(url, "https://")])
    error_message = "origins needs at least two regions, each an https:// URL."
  }
}

variable "admin_secret" {
  description = "HMAC secret the sentry signs routing writes with (also in Key Vault for the worker)."
  type        = string
  sensitive   = true
}

variable "service_name" {
  description = "Name of the protected service, shown on the holding page."
  type        = string
}

variable "kv_cache_ttl_seconds" {
  description = "Seconds an edge location may cache the routing (Cloudflare's minimum is 30). Lower means faster propagation, more KV reads."
  type        = number
  default     = 30

  validation {
    condition     = var.kv_cache_ttl_seconds >= 30
    error_message = "Workers KV's minimum cache TTL is 30 seconds."
  }
}
