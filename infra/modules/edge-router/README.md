# Module: edge-router

The protected service's edge: a Cloudflare Worker (from `apps/edge-router/src/worker.js`) on a Workers custom domain,
with a KV namespace for the routing. The Worker proxies to the active region, shows a holding page during failovers,
and accepts routing writes only when they are signed and newer (epoch, version) than what it holds.

Terraform owns the code and bindings, never the routing value: the sentry writes that at runtime.

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
| [cloudflare_workers_custom_domain.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_custom_domain) | resource |
| [cloudflare_workers_kv_namespace.routing](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_kv_namespace) | resource |
| [cloudflare_workers_script.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script) | resource |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_account_id"></a> [account\_id](#input\_account\_id) | Cloudflare account that owns the Worker and its KV namespace. | `string` | n/a | yes |
| <a name="input_admin_secret"></a> [admin\_secret](#input\_admin\_secret) | HMAC secret the sentry signs routing writes with (also in Key Vault for the worker). | `string` | n/a | yes |
| <a name="input_hostname"></a> [hostname](#input\_hostname) | Public host name of the protected service, e.g. dr.biffkittz.com. | `string` | n/a | yes |
| <a name="input_origins"></a> [origins](#input\_origins) | Region ID to the origin base URL the Worker proxies to (the regional Container Apps' host names). | `map(string)` | n/a | yes |
| <a name="input_script_content"></a> [script\_content](#input\_script\_content) | The Worker's ES module source (apps/edge-router/src/worker.js). | `string` | n/a | yes |
| <a name="input_script_name"></a> [script\_name](#input\_script\_name) | Worker script name. | `string` | n/a | yes |
| <a name="input_service_name"></a> [service\_name](#input\_service\_name) | Name of the protected service, shown on the holding page. | `string` | n/a | yes |
| <a name="input_zone_id"></a> [zone\_id](#input\_zone\_id) | Cloudflare zone of the host name. | `string` | n/a | yes |
| <a name="input_compatibility_date"></a> [compatibility\_date](#input\_compatibility\_date) | Workers runtime compatibility date. | `string` | `"2026-11-01"` | no |
| <a name="input_kv_cache_ttl_seconds"></a> [kv\_cache\_ttl\_seconds](#input\_kv\_cache\_ttl\_seconds) | Seconds an edge location may cache the routing (Cloudflare's minimum is 30). Lower means faster propagation, more KV reads. | `number` | `30` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_kv_namespace_id"></a> [kv\_namespace\_id](#output\_kv\_namespace\_id) | ID of the KV namespace that holds the routing. |
| <a name="output_script_name"></a> [script\_name](#output\_script\_name) | Name of the Worker script. |
| <a name="output_url"></a> [url](#output\_url) | Public URL of the protected service. |
<!-- END_TF_DOCS -->
