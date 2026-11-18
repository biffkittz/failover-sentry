# Module: key-vault

Key Vault (RBAC mode) with the sentry's secrets and per-secret read grants. The principal running Terraform gets
Key Vault Secrets Officer to write them; each container identity gets Key Vault Secrets User on exactly the secrets
it uses. Waits for role propagation before secrets are written and before their IDs are handed out.

<!-- BEGIN_TF_DOCS -->
### Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.17.1 |
| <a name="requirement_azurerm"></a> [azurerm](#requirement\_azurerm) | >= 5.14 |
| <a name="requirement_time"></a> [time](#requirement\_time) | >= 0.14 |

### Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_azurerm"></a> [azurerm](#provider\_azurerm) | >= 5.14 |
| <a name="provider_time"></a> [time](#provider\_time) | >= 0.14 |

### Resources

| Name | Type |
| ---- | ---- |
| [azurerm_key_vault.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault) | resource |
| [azurerm_key_vault_secret.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/key_vault_secret) | resource |
| [azurerm_role_assignment.administrator](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment) | resource |
| [azurerm_role_assignment.secret_reader](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment) | resource |
| [time_sleep.administrator_rbac](https://registry.terraform.io/providers/hashicorp/time/latest/docs/resources/sleep) | resource |
| [time_sleep.reader_rbac](https://registry.terraform.io/providers/hashicorp/time/latest/docs/resources/sleep) | resource |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_administrator_principal_id"></a> [administrator\_principal\_id](#input\_administrator\_principal\_id) | Object ID of the principal running Terraform; it gets Key Vault Secrets Officer to write the secrets. | `string` | n/a | yes |
| <a name="input_location"></a> [location](#input\_location) | Azure region of the vault. | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Globally unique vault name: 3-24 characters, letters, digits and hyphens. | `string` | n/a | yes |
| <a name="input_resource_group_name"></a> [resource\_group\_name](#input\_resource\_group\_name) | Resource group that holds the vault. | `string` | n/a | yes |
| <a name="input_secret_names"></a> [secret\_names](#input\_secret\_names) | Secrets to create: map of a static key (used by secret\_values and secret\_readers) to the Key Vault secret name. | `map(string)` | n/a | yes |
| <a name="input_secret_values"></a> [secret\_values](#input\_secret\_values) | Secret values, by the keys of secret\_names. | `map(string)` | n/a | yes |
| <a name="input_tenant_id"></a> [tenant\_id](#input\_tenant\_id) | Microsoft Entra tenant of the vault. | `string` | n/a | yes |
| <a name="input_additional_administrator_principal_ids"></a> [additional\_administrator\_principal\_ids](#input\_additional\_administrator\_principal\_ids) | Other principals that run Terraform against this vault (a CI identity, say). | `list(string)` | `[]` | no |
| <a name="input_purge_protection_enabled"></a> [purge\_protection\_enabled](#input\_purge\_protection\_enabled) | Purge protection. Off by default for this demo, so `terraform destroy` really removes the vault. | `bool` | `false` | no |
| <a name="input_rbac_propagation_wait"></a> [rbac\_propagation\_wait](#input\_rbac\_propagation\_wait) | How long to wait after creating role assignments before relying on them, e.g. "90s". | `string` | `"90s"` | no |
| <a name="input_secret_readers"></a> [secret\_readers](#input\_secret\_readers) | Read grants: map of a static label to { secret = <key of secret\_names>, principal\_id = <managed identity principal> }. | <pre>map(object({<br/>    secret       = string<br/>    principal_id = string<br/>  }))</pre> | `{}` | no |
| <a name="input_soft_delete_retention_days"></a> [soft\_delete\_retention\_days](#input\_soft\_delete\_retention\_days) | Days a deleted vault or secret stays recoverable (7-90). | `number` | `7` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | Tags for every taggable resource. | `map(string)` | `{}` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_id"></a> [id](#output\_id) | Resource ID of the vault. |
| <a name="output_name"></a> [name](#output\_name) | Name of the vault. |
| <a name="output_secret_ids"></a> [secret\_ids](#output\_secret\_ids) | Versionless secret IDs by the keys of secret\_names (what Container App Key Vault references use: they follow new versions). Available once read grants have propagated. |
<!-- END_TF_DOCS -->
