output "tunnel_id" {
  description = "ID of the tunnel."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "token" {
  description = "Token cloudflared runs the tunnel with (TUNNEL_TOKEN)."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}

output "hostname" {
  description = "Public host name served through the tunnel."
  value       = cloudflare_dns_record.this.name
}
