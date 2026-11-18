output "id" {
  description = "Resource ID of the Container App."
  value       = azurerm_container_app.this.id
}

output "name" {
  description = "Name of the Container App."
  value       = azurerm_container_app.this.name
}

output "fqdn" {
  description = "Host name of the app's ingress, or null without ingress."
  value       = try(azurerm_container_app.this.ingress[0].fqdn, null)
}

output "latest_revision_name" {
  description = "Name of the latest revision."
  value       = azurerm_container_app.this.latest_revision_name
}
