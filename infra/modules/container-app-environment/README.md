# Module: container-app-environment

A Container Apps environment with the Consumption workload profile only (no fixed cost), sending logs to a Log
Analytics workspace. The root module creates one for the control plane and one per region of the protected
workload. Its `default_domain` output lets the root compute each app's host name before the app exists, which is
how the two regions can name each other as replication peers without a dependency cycle.

<!-- BEGIN_TF_DOCS -->
### Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.17.1 |
| <a name="requirement_azurerm"></a> [azurerm](#requirement\_azurerm) | >= 5.14 |

### Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_azurerm"></a> [azurerm](#provider\_azurerm) | >= 5.14 |

### Resources

| Name | Type |
| ---- | ---- |
| [azurerm_container_app_environment.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app_environment) | resource |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_location"></a> [location](#input\_location) | Azure region of the environment. | `string` | n/a | yes |
| <a name="input_log_analytics_workspace_id"></a> [log\_analytics\_workspace\_id](#input\_log\_analytics\_workspace\_id) | Log Analytics workspace that receives the environment's container logs (may be in another region). | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Environment name (2-60 characters: lower-case letters, digits and hyphens). | `string` | n/a | yes |
| <a name="input_resource_group_name"></a> [resource\_group\_name](#input\_resource\_group\_name) | Resource group that holds the environment. | `string` | n/a | yes |
| <a name="input_tags"></a> [tags](#input\_tags) | Tags for every taggable resource. | `map(string)` | `{}` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_default_domain"></a> [default\_domain](#output\_default\_domain) | Default domain of the environment: an app with external ingress is reachable at <app name>.<default\_domain>. |
| <a name="output_id"></a> [id](#output\_id) | Resource ID of the environment. |
| <a name="output_location"></a> [location](#output\_location) | Azure region of the environment. |
<!-- END_TF_DOCS -->
