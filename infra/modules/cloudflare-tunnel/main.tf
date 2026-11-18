# Cloudflare Tunnel for the console: cloudflared (a sidecar in the console's Container App) dials out to Cloudflare,
# and Cloudflare sends the console's host name down that connection. The console has no public ingress at all, so
# nothing reaches it except through Cloudflare, and there is no origin certificate to manage.

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.account_id
  name       = var.name
  # Remotely managed: the ingress rules below live in Cloudflare, cloudflared only needs the token.
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        service  = var.origin_service
      },
      # Anything else that reaches the tunnel gets a 404.
      {
        service = "http_status:404"
      },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

resource "cloudflare_dns_record" "this" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "Failover Sentry console through Cloudflare Tunnel (managed by Terraform)"
}
