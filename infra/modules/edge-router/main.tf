# The edge router: a Cloudflare Worker on the protected service's host name that proxies each request to the region
# the sentry made active. The routing lives in Workers KV, so the data path keeps working while the control plane
# (the sentry) is down, and the Worker refuses routing writes that carry an older (epoch, version) than it holds.
#
# Terraform deploys the Worker's code (apps/edge-router/src/worker.js) and bindings. It never manages the routing
# value itself: the sentry writes it at runtime, so a plan never fights the sentry.

resource "cloudflare_workers_kv_namespace" "routing" {
  account_id = var.account_id
  title      = "${var.script_name}-routing"
}

resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.script_name
  content            = var.script_content
  main_module        = "worker.js"
  compatibility_date = var.compatibility_date

  bindings = [
    {
      type         = "kv_namespace"
      name         = "ROUTING"
      namespace_id = cloudflare_workers_kv_namespace.routing.id
    },
    {
      type = "plain_text"
      name = "ORIGINS"
      text = jsonencode(var.origins)
    },
    {
      type = "plain_text"
      name = "SERVICE_NAME"
      text = var.service_name
    },
    {
      type = "plain_text"
      name = "KV_CACHE_TTL"
      text = tostring(var.kv_cache_ttl_seconds)
    },
    {
      type = "secret_text"
      name = "ADMIN_SECRET"
      text = var.admin_secret
    },
  ]

  observability = {
    enabled = true
  }
}

# A Workers custom domain: Cloudflare creates the DNS record and the edge certificate for the host name itself.
resource "cloudflare_workers_custom_domain" "this" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.hostname
  service    = cloudflare_workers_script.this.script_name
}
