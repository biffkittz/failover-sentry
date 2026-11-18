output "token" {
  description = "The API token (Email Sending only)."
  value       = cloudflare_account_token.this.value
  sensitive   = true
}

output "token_id" {
  description = "ID of the token."
  value       = cloudflare_account_token.this.id
}
