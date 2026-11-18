variable "account_id" {
  description = "Cloudflare account that owns the tunnel."
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

variable "name" {
  description = "Tunnel name, as listed in the Cloudflare dashboard."
  type        = string
}

variable "hostname" {
  description = "Public host name served through the tunnel, e.g. sentry.biffkittz.com."
  type        = string
}

variable "origin_service" {
  description = "Where cloudflared sends the traffic, from inside the Container App: the console container's port."
  type        = string
  default     = "http://localhost:8080"
}
