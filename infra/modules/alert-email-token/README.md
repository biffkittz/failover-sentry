# Module: alert-email-token

An account-owned Cloudflare API token limited to Email Sending, for the sentry's alert emails (Cloudflare Email
Service REST API). The sending domain's onboarding and the verified recipient addresses are prerequisites owned
elsewhere (the login-app project manages them for biffkittz.com); this module only issues the token.

<!-- BEGIN_TF_DOCS -->
### Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.17.1 |
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | >= 5.29 |

### Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | >= 5.29 |

### Resources

| Name | Type |
| ---- | ---- |
| [cloudflare_account_token.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/account_token) | resource |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_account_id"></a> [account\_id](#input\_account\_id) | Cloudflare account that owns the token. | `string` | n/a | yes |
| <a name="input_permission_groups"></a> [permission\_groups](#input\_permission\_groups) | Cloudflare's catalogue of API token permission groups (the cloudflare\_account\_api\_token\_permission\_groups\_list data source's result). | <pre>list(object({<br/>    id            = string<br/>    name          = string<br/>    is_selectable = optional(bool)<br/>    scopes        = optional(list(string), [])<br/>  }))</pre> | n/a | yes |
| <a name="input_preferred_permission_groups"></a> [preferred\_permission\_groups](#input\_preferred\_permission\_groups) | Names of permission groups that allow sending email, narrowest first. | `list(string)` | n/a | yes |
| <a name="input_token_name"></a> [token\_name](#input\_token\_name) | Name the Cloudflare dashboard lists the token under. | `string` | n/a | yes |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_token"></a> [token](#output\_token) | The API token (Email Sending only). |
| <a name="output_token_id"></a> [token\_id](#output\_token\_id) | ID of the token. |
<!-- END_TF_DOCS -->
