# An account-owned Cloudflare API token that can send email through Cloudflare Email Service and nothing else, for the
# sentry's alert emails. Account-owned, so it belongs to no person's login. Rotate it by replacing this resource.
#
# The sending domain must already be onboarded for Email Sending, and the recipients must be verified destination
# addresses of the account (in this setup, the login-app project's Terraform owns both).

locals {
  permission_groups = {
    for group in var.permission_groups : group.name => group...
    if group.is_selectable != false
  }

  # The narrowest of preferred_permission_groups the account offers, or null.
  permission_group = try([
    for name in var.preferred_permission_groups : local.permission_groups[name][0]
    if contains(keys(local.permission_groups), name)
  ][0], null)
}

resource "cloudflare_account_token" "this" {
  account_id = var.account_id
  name       = var.token_name
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = try(local.permission_group.id, "") }]
    resources         = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = "*" })
  }]

  lifecycle {
    precondition {
      condition     = local.permission_group != null
      error_message = "The Cloudflare account offers none of: ${join(", ", var.preferred_permission_groups)}. Is Email Sending enabled on the account?"
    }
  }
}
