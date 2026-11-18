# Module: container-app

One Container App with a main container and optional sidecars, running as a user-assigned identity: image pulls from
the registry and Key Vault secret references both use it. Optional ingress and per-container HTTP probes. The
`dr-role` and `dr-epoch` tags are ignored because the sentry's worker sets them at runtime.

Used four times: the console (with a `cloudflared` sidecar, no ingress), the worker (no ingress) and the demo
workload in each region (external ingress).

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
| [azurerm_container_app.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app) | resource |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_container_app_environment_id"></a> [container\_app\_environment\_id](#input\_container\_app\_environment\_id) | Environment the app runs in. | `string` | n/a | yes |
| <a name="input_containers"></a> [containers](#input\_containers) | The main container first, then any sidecars. env: plain variables; secret\_env: variable name to a key of var.secrets; probe: HTTP liveness and readiness path and port. | <pre>list(object({<br/>    name       = string<br/>    image      = string<br/>    cpu        = number<br/>    memory     = string<br/>    args       = optional(list(string))<br/>    command    = optional(list(string))<br/>    env        = optional(map(string), {})<br/>    secret_env = optional(map(string), {})<br/>    probe = optional(object({<br/>      path = string<br/>      port = number<br/>    }))<br/>  }))</pre> | n/a | yes |
| <a name="input_identity_id"></a> [identity\_id](#input\_identity\_id) | Resource ID of the user-assigned identity the app runs as (image pulls, Key Vault references, Azure APIs). | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Container App name (2-32 characters: lower-case letters, digits and hyphens). | `string` | n/a | yes |
| <a name="input_registry_server"></a> [registry\_server](#input\_registry\_server) | Login server of the registry the images come from (pulled with the app's identity). | `string` | n/a | yes |
| <a name="input_resource_group_name"></a> [resource\_group\_name](#input\_resource\_group\_name) | Resource group that holds the app. | `string` | n/a | yes |
| <a name="input_ingress"></a> [ingress](#input\_ingress) | Ingress, or null for none (the console has none: Cloudflare Tunnel reaches it from inside). | <pre>object({<br/>    external    = bool<br/>    target_port = number<br/>  })</pre> | `null` | no |
| <a name="input_max_replicas"></a> [max\_replicas](#input\_max\_replicas) | Maximum replicas. | `number` | `1` | no |
| <a name="input_min_replicas"></a> [min\_replicas](#input\_min\_replicas) | Minimum replicas. | `number` | `1` | no |
| <a name="input_secrets"></a> [secrets](#input\_secrets) | Container App secrets: secret name to the versionless Key Vault secret ID it references. | `map(string)` | `{}` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | Tags for the app. | `map(string)` | `{}` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_fqdn"></a> [fqdn](#output\_fqdn) | Host name of the app's ingress, or null without ingress. |
| <a name="output_id"></a> [id](#output\_id) | Resource ID of the Container App. |
| <a name="output_latest_revision_name"></a> [latest\_revision\_name](#output\_latest\_revision\_name) | Name of the latest revision. |
| <a name="output_name"></a> [name](#output\_name) | Name of the Container App. |
<!-- END_TF_DOCS -->
