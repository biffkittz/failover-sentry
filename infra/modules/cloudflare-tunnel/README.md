# Module: cloudflare-tunnel

A remotely managed Cloudflare Tunnel that publishes one host name (the console) to a service inside a Container App,
plus the proxied CNAME to it. The console runs `cloudflared` as a sidecar with the token from the `token` output
(stored in Key Vault), so the console needs no public ingress, no origin certificate and no zone-wide settings
(Authenticated Origin Pulls, Origin Rules) that other projects on the zone might own.

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
| [cloudflare_dns_record.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared_config.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_tunnel_cloudflared_config) | resource |
| [cloudflare_zero_trust_tunnel_cloudflared_token.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zero_trust_tunnel_cloudflared_token) | data source |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_account_id"></a> [account\_id](#input\_account\_id) | Cloudflare account that owns the tunnel. | `string` | n/a | yes |
| <a name="input_hostname"></a> [hostname](#input\_hostname) | Public host name served through the tunnel, e.g. sentry.biffkittz.com. | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Tunnel name, as listed in the Cloudflare dashboard. | `string` | n/a | yes |
| <a name="input_zone_id"></a> [zone\_id](#input\_zone\_id) | Cloudflare zone of the host name. | `string` | n/a | yes |
| <a name="input_origin_service"></a> [origin\_service](#input\_origin\_service) | Where cloudflared sends the traffic, from inside the Container App: the console container's port. | `string` | `"http://localhost:8080"` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_hostname"></a> [hostname](#output\_hostname) | Public host name served through the tunnel. |
| <a name="output_token"></a> [token](#output\_token) | Token cloudflared runs the tunnel with (TUNNEL\_TOKEN). |
| <a name="output_tunnel_id"></a> [tunnel\_id](#output\_tunnel\_id) | ID of the tunnel. |
<!-- END_TF_DOCS -->
