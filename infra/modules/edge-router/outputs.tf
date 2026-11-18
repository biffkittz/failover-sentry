output "url" {
  description = "Public URL of the protected service."
  value       = "https://${cloudflare_workers_custom_domain.this.hostname}"
}

output "kv_namespace_id" {
  description = "ID of the KV namespace that holds the routing."
  value       = cloudflare_workers_kv_namespace.routing.id
}

output "script_name" {
  description = "Name of the Worker script."
  value       = cloudflare_workers_script.this.script_name
}
