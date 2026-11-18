output "console_url" {
  description = "The console (GitHub sign-in)."
  value       = "https://${var.console_hostname}"
}

output "edge_url" {
  description = "The protected demo service, through the edge router."
  value       = module.edge_router.url
}

output "resource_group_names" {
  description = "Resource groups: the control plane's and one per protected region."
  value = {
    control  = azurerm_resource_group.control.name
    regional = { for key, group in azurerm_resource_group.regional : key => group.name }
  }
}

output "container_registry_name" {
  description = "Name of the container registry (for az acr build)."
  value       = module.registry.name
}

output "container_registry_login_server" {
  description = "Login server of the container registry."
  value       = module.registry.login_server
}

output "key_vault_name" {
  description = "Name of the Key Vault that holds the secrets."
  value       = module.key_vault.name
}

output "regional_app_urls" {
  description = "Origin URLs of the demo workload in each region (what the edge proxies to and the sentry probes)."
  value       = local.regional_urls
}

output "worker_identity_client_id" {
  description = "Client ID of the worker's managed identity (fences regions through Azure Resource Manager)."
  value       = azurerm_user_assigned_identity.worker.client_id
}

output "tunnel_id" {
  description = "ID of the console's Cloudflare Tunnel."
  value       = module.console_tunnel.tunnel_id
}

output "sentry_config" {
  description = "The sentry's configuration as the worker and the console receive it (SENTRY_CONFIG_JSON)."
  value       = local.sentry_config
}

output "github_oauth_callback_url" {
  description = "Authorization callback URL to enter in the GitHub OAuth App."
  value       = "https://${var.console_hostname}/auth/github/callback"
}

output "image_build_commands" {
  description = "Commands that build and push the three images with ACR Tasks (run from the repository root), for an image tag of your choice."
  value = {
    for key, repository in var.image_repositories :
    key => "az acr build --registry ${module.registry.name} --image ${repository}:<tag> --file ${key == "worker" ? "apps/worker/Dockerfile" : key == "console" ? "apps/console/Dockerfile" : "apps/regional-app/Dockerfile"} --build-arg APP_VERSION=<tag> ."
  }
}

output "next_steps" {
  description = "What to do after this apply."
  value = local.deploy_apps ? join("\n", [
    "Images ${var.image_tag} are deployed.",
    "Console:  https://${var.console_hostname}  (sign in with GitHub)",
    "Service:  https://${var.edge_hostname}",
    "Logs:     az containerapp logs show -g ${azurerm_resource_group.control.name} -n ${local.names.worker_app} --follow",
    ]) : join("\n", [
    "Foundation deployed; the Container Apps come with the second apply.",
    "1. Build and push the images (from the repository root), e.g. with TAG=$(git rev-parse --short HEAD):",
    "     az acr build --registry ${module.registry.name} --image ${var.image_repositories.worker}:$TAG --file apps/worker/Dockerfile .",
    "     az acr build --registry ${module.registry.name} --image ${var.image_repositories.console}:$TAG --file apps/console/Dockerfile .",
    "     az acr build --registry ${module.registry.name} --image ${var.image_repositories.regional}:$TAG --file apps/regional-app/Dockerfile .",
    "2. Set image_tag = \"$TAG\" (plus the Temporal and GitHub settings) and apply again.",
  ])
}

output "key_vault_secret_names" {
  description = "Names of the secrets in Key Vault (optional ones appear once their values are supplied)."
  value       = sort(values(local.key_vault_secret_names))
}
