output "id" {
  description = "Resource ID of the environment."
  value       = azurerm_container_app_environment.this.id
}

output "default_domain" {
  description = "Default domain of the environment: an app with external ingress is reachable at <app name>.<default_domain>."
  value       = azurerm_container_app_environment.this.default_domain
}

output "location" {
  description = "Azure region of the environment."
  value       = azurerm_container_app_environment.this.location
}
