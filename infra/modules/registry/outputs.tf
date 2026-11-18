output "id" {
  description = "Resource ID of the registry."
  value       = local.registry.id
}

output "name" {
  description = "Name of the registry (for az acr commands)."
  value       = local.registry.name
}

output "login_server" {
  description = "Registry host name, e.g. crfsentrydemo1a2b3c.azurecr.io. Available once AcrPull assignments have propagated."
  value       = local.registry.login_server

  depends_on = [time_sleep.acr_pull_propagation]
}
