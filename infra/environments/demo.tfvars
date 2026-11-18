# Settings for the demo environment. Committed to the repository, so it must never contain secrets.
#
#   terraform plan  -var-file=environments/demo.tfvars -out=demo.tfplan
#   terraform apply demo.tfplan
#
# Supply the secrets through the environment, never through this file:
#   export CLOUDFLARE_API_TOKEN=...                      # Cloudflare provider (see docs/DEPLOYMENT.md for permissions)
#   export TF_VAR_temporal_api_key=...                   # Temporal Cloud API key for the namespace below
#   export TF_VAR_github_oauth_client_secret=...         # the console's GitHub OAuth App
# Every other variable keeps its default from variables.tf.

subscription_id = "3c3f379f-8161-4631-a30c-a3af82622a6a"
project         = "fsentry"
environment     = "demo"

# The sentry's control plane runs in a third region; the protected workload runs in a paired region pair.
control_location       = "westus2"
initial_primary_region = "eastus2"
regions = {
  eastus2 = {
    location     = "eastus2"
    display_name = "East US 2"
  }
  centralus = {
    location     = "centralus"
    display_name = "Central US"
  }
}

dns_zone_name    = "biffkittz.com"
console_hostname = "sentry.biffkittz.com"
edge_hostname    = "dr.biffkittz.com"

# Build the images into login-app's registry instead of creating one (about $5/month saved). login-app's Terraform
# keeps managing it; this configuration only grants AcrPull on it. The images go under failover-sentry/.
existing_container_registry = {
  name                = "crloginappdemo7fyguj"
  resource_group_name = "rg-loginapp-demo"
}

# Image tag to run (the tag pushed with `az acr build`). Leave it commented out for the first apply (no images exist
# yet). Once set, keep it set: removing it again would delete the Container Apps.
image_tag = "9978d37"

# Temporal Cloud namespace (created by hand). The API key comes from TF_VAR_temporal_api_key.
temporal_namespace = "sentry.joqqs"

# The console's GitHub OAuth App (created by hand; callback https://sentry.biffkittz.com/auth/github/callback).
github_oauth_client_id       = "Ov23lim6345uxmNy0Rgp"
console_allowed_github_users = ["biffkittz"]

# Alert emails through Cloudflare Email Service: verified destination addresses of the Cloudflare account.
alert_email_recipients = ["benjamin.e.burner@gmail.com"]
