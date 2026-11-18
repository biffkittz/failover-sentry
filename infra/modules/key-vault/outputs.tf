output "id" {
  description = "Resource ID of the vault."
  value       = azurerm_key_vault.this.id
}

output "name" {
  description = "Name of the vault."
  value       = azurerm_key_vault.this.name
}

output "secret_ids" {
  description = "Versionless secret IDs by the keys of secret_names (what Container App Key Vault references use: they follow new versions). Available once read grants have propagated."
  value       = { for key, secret in azurerm_key_vault_secret.this : key => secret.versionless_id }

  depends_on = [time_sleep.reader_rbac]
}
