# infra/: Terraform for Azure and Cloudflare

Provisions the Failover Sentry and the cheap demo workload it protects:

| Where | What | Approx. cost |
| --- | --- | --- |
| Azure, control region (`westus2`) | Resource group, Log Analytics (daily cap), Container Registry (Basic), Key Vault, three managed identities, a Container Apps environment with the **worker** and the **console** (with a `cloudflared` sidecar) | ACR ~$5/month; Container Apps consumption ~$5–15/month; Key Vault and logs cents |
| Azure, each protected region (`eastus2`, `centralus`) | Resource group, Container Apps environment, the **demo workload** (one replica, simulated database) | ~$2–5/month each (mostly idle) |
| Cloudflare | Tunnel + proxied DNS for `sentry.biffkittz.com`; edge router Worker + KV + custom domain `dr.biffkittz.com`; an Email-Sending-only API token | Free plan limits |
| Temporal Cloud | Your namespace (created by hand); the sentry uses roughly 0.3–0.5 M actions/month at the default 30 s probe interval | Usage-based |

Architecture, decisions and the deployment walkthrough: [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md),
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

## Layout

| File / module | Purpose |
| --- | --- |
| `backend.tf` | Remote state in Azure Storage (`rg-terraform-state/demonstration/terraform/temporal-node.terraform.tfstate`), locked by blob lease. |
| `providers.tf` | Terraform and provider versions (azurerm, cloudflare, random, time) and provider configuration. |
| `main.tf` | Naming, tags, resource groups, identities, the fencing role, secrets, and the module wiring. |
| `variables.tf` / `outputs.tf` | Inputs (with types, descriptions, validation) and outputs. |
| `environments/demo.tfvars` | The demo environment's settings. Never secrets. |
| `modules/registry` | Container Registry and AcrPull grants. |
| `modules/key-vault` | Key Vault (RBAC), secrets, per-secret read grants. |
| `modules/container-app-environment` | A Consumption-only Container Apps environment (used 3×). |
| `modules/container-app` | One Container App with sidecars, Key Vault references and probes (used 4×). |
| `modules/cloudflare-tunnel` | The console's tunnel, its ingress rules and DNS record. |
| `modules/edge-router` | The edge router Worker, its KV namespace and custom domain. |
| `modules/alert-email-token` | A Cloudflare API token limited to Email Sending. |
| `tests/` | `terraform test` suites with mocked providers (no credentials needed). |

## Usage

```bash
cd infra
az login && az account set --subscription <subscription>
export CLOUDFLARE_API_TOKEN=...            # permissions: see ../docs/DEPLOYMENT.md
terraform init
terraform plan  -var-file=environments/demo.tfvars -out=demo.tfplan
terraform apply demo.tfplan
```

Deployment is two-phase, because the Container Apps need images that only exist after the registry does:

1. **Foundation** (`image_tag` unset): resource groups, registry, Key Vault and generated secrets, identities and
   roles, Container Apps environments, the Cloudflare tunnel, edge router and DNS.
2. Build and push the three images with `az acr build` (`terraform output next_steps` prints the commands).
3. **Apps**: set `image_tag`, `temporal_namespace`, `github_oauth_client_id`, `console_allowed_github_users`
   (and the secrets `TF_VAR_temporal_api_key`, `TF_VAR_github_oauth_client_secret`), then plan and apply again.

A second plan right after an apply must show no changes. Nothing here runs scripts at apply time, names are
deterministic, and the only `ignore_changes` cover runtime state the sentry owns (the `dr-role`/`dr-epoch` tags it
writes on the regional apps) or Azure-generated values.

## Checks

```bash
terraform init -backend=false     # also installs the modules the tests use
terraform fmt -recursive && terraform validate
terraform test                    # mocked providers, a few seconds
tflint --init && tflint --recursive
terraform-docs .                  # regenerates the reference sections below and in each module
```

Pre-commit (`../.pre-commit-config.yaml`) and CI (`../.github/workflows/ci.yml`) run the same checks.

<!-- BEGIN_TF_DOCS -->
### Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.17.1, < 2.0.0 |
| <a name="requirement_azurerm"></a> [azurerm](#requirement\_azurerm) | ~> 5.14 |
| <a name="requirement_cloudflare"></a> [cloudflare](#requirement\_cloudflare) | ~> 5.29 |
| <a name="requirement_random"></a> [random](#requirement\_random) | ~> 3.9 |
| <a name="requirement_time"></a> [time](#requirement\_time) | ~> 0.14 |

### Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_azurerm"></a> [azurerm](#provider\_azurerm) | 5.14.0 |
| <a name="provider_cloudflare"></a> [cloudflare](#provider\_cloudflare) | 5.29.0 |
| <a name="provider_random"></a> [random](#provider\_random) | 3.9.1 |

### Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_alert_email_token"></a> [alert\_email\_token](#module\_alert\_email\_token) | ./modules/alert-email-token | n/a |
| <a name="module_console_app"></a> [console\_app](#module\_console\_app) | ./modules/container-app | n/a |
| <a name="module_console_tunnel"></a> [console\_tunnel](#module\_console\_tunnel) | ./modules/cloudflare-tunnel | n/a |
| <a name="module_control_environment"></a> [control\_environment](#module\_control\_environment) | ./modules/container-app-environment | n/a |
| <a name="module_edge_router"></a> [edge\_router](#module\_edge\_router) | ./modules/edge-router | n/a |
| <a name="module_key_vault"></a> [key\_vault](#module\_key\_vault) | ./modules/key-vault | n/a |
| <a name="module_regional_app"></a> [regional\_app](#module\_regional\_app) | ./modules/container-app | n/a |
| <a name="module_regional_environment"></a> [regional\_environment](#module\_regional\_environment) | ./modules/container-app-environment | n/a |
| <a name="module_registry"></a> [registry](#module\_registry) | ./modules/registry | n/a |
| <a name="module_worker_app"></a> [worker\_app](#module\_worker\_app) | ./modules/container-app | n/a |

### Resources

| Name | Type |
| ---- | ---- |
| [azurerm_log_analytics_workspace.this](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/log_analytics_workspace) | resource |
| [azurerm_resource_group.control](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/resource_group) | resource |
| [azurerm_resource_group.regional](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/resource_group) | resource |
| [azurerm_role_assignment.worker_fencing](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment) | resource |
| [azurerm_role_assignment.worker_tags](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_assignment) | resource |
| [azurerm_role_definition.fencing](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/role_definition) | resource |
| [azurerm_user_assigned_identity.console](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity) | resource |
| [azurerm_user_assigned_identity.regional](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity) | resource |
| [azurerm_user_assigned_identity.worker](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/user_assigned_identity) | resource |
| [random_password.edge_admin_secret](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password) | resource |
| [random_password.region_admin_secret](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password) | resource |
| [random_password.session_secret](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password) | resource |
| [random_password.webhook_secret](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password) | resource |
| [azurerm_client_config.current](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/data-sources/client_config) | data source |
| [cloudflare_account_api_token_permission_groups_list.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/account_api_token_permission_groups_list) | data source |
| [cloudflare_zone.this](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/data-sources/zone) | data source |

### Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_subscription_id"></a> [subscription\_id](#input\_subscription\_id) | Azure subscription to deploy into. | `string` | n/a | yes |
| <a name="input_alert_email_recipients"></a> [alert\_email\_recipients](#input\_alert\_email\_recipients) | Addresses that receive the sentry's alert emails. Each must already be a verified destination address of the Cloudflare account. Empty: alerts are only shown in the console and logged. | `list(string)` | `[]` | no |
| <a name="input_alert_email_sender_username"></a> [alert\_email\_sender\_username](#input\_alert\_email\_sender\_username) | Local part of the alert sender address, in dns\_zone\_name (which must be onboarded for Email Sending). | `string` | `"sentry-alerts"` | no |
| <a name="input_alert_min_severity"></a> [alert\_min\_severity](#input\_alert\_min\_severity) | Least severe alert that is emailed: info, warning or critical. | `string` | `"warning"` | no |
| <a name="input_cloudflare_email_sending_permission_groups"></a> [cloudflare\_email\_sending\_permission\_groups](#input\_cloudflare\_email\_sending\_permission\_groups) | Names of Cloudflare API token permission groups that allow sending email, narrowest first. Change only if Cloudflare renames them. | `list(string)` | <pre>[<br/>  "Email Sending Send",<br/>  "Email Sending Write"<br/>]</pre> | no |
| <a name="input_cloudflared_image"></a> [cloudflared\_image](#input\_cloudflared\_image) | cloudflared image for the console's tunnel sidecar, pinned by digest. | `string` | `"cloudflare/cloudflared:2026.11.1@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d"` | no |
| <a name="input_console_allowed_github_users"></a> [console\_allowed\_github\_users](#input\_console\_allowed\_github\_users) | GitHub logins allowed to sign in to the console (case-insensitive). Every allowed user is an operator. | `list(string)` | `[]` | no |
| <a name="input_console_hostname"></a> [console\_hostname](#input\_console\_hostname) | Host name of the console (served through Cloudflare Tunnel). | `string` | `"sentry.biffkittz.com"` | no |
| <a name="input_container_registry_sku"></a> [container\_registry\_sku](#input\_container\_registry\_sku) | Azure Container Registry SKU. | `string` | `"Basic"` | no |
| <a name="input_container_sizes"></a> [container\_sizes](#input\_container\_sizes) | CPU (cores) and memory of each container. Container Apps accepts 0.25-core steps with twice the memory in GiB per core; the console's total includes its cloudflared sidecar (0.25 cores, 0.5Gi). | <pre>object({<br/>    worker_cpu      = optional(number, 0.5)<br/>    worker_memory   = optional(string, "1Gi")<br/>    console_cpu     = optional(number, 0.5)<br/>    console_memory  = optional(string, "1Gi")<br/>    regional_cpu    = optional(number, 0.25)<br/>    regional_memory = optional(string, "0.5Gi")<br/>  })</pre> | `{}` | no |
| <a name="input_control_location"></a> [control\_location](#input\_control\_location) | Region of the sentry's control plane (worker, console, registry, Key Vault, logs). A third region, separate from the protected regions, so an outage in either of those doesn't take the sentry down with it. | `string` | `"westus2"` | no |
| <a name="input_dns_zone_name"></a> [dns\_zone\_name](#input\_dns\_zone\_name) | Cloudflare zone that holds both host names. | `string` | `"biffkittz.com"` | no |
| <a name="input_edge_hostname"></a> [edge\_hostname](#input\_edge\_hostname) | Host name of the protected demo service (the edge router Worker). A first-level subdomain, so the zone's Universal SSL certificate covers it. | `string` | `"dr.biffkittz.com"` | no |
| <a name="input_edge_kv_cache_ttl_seconds"></a> [edge\_kv\_cache\_ttl\_seconds](#input\_edge\_kv\_cache\_ttl\_seconds) | Seconds a Cloudflare location may cache the edge routing (minimum 30). Bounds how long a routing change takes to propagate. | `number` | `30` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | Environment name used in resource names and tags. | `string` | `"demo"` | no |
| <a name="input_failover_policy"></a> [failover\_policy](#input\_failover\_policy) | How the sentry fails over: automatic or not, cooldown, the replication webhook's durable timeout, stall escalation, edge propagation, stabilization, and whether a forced failover stops the old primary's compute. | <pre>object({<br/>    auto_failover_enabled                = optional(bool, true)<br/>    cooldown_seconds                     = optional(number, 600)<br/>    replication_timeout_seconds          = optional(number, 120)<br/>    stall_escalation_seconds             = optional(number, 600)<br/>    edge_propagation_timeout_seconds     = optional(number, 180)<br/>    stabilization_seconds                = optional(number, 90)<br/>    stabilization_probe_interval_seconds = optional(number, 10)<br/>    stabilization_failure_threshold      = optional(number, 3)<br/>    fence_compute_on_forced_failover     = optional(bool, true)<br/>  })</pre> | `{}` | no |
| <a name="input_github_oauth_client_id"></a> [github\_oauth\_client\_id](#input\_github\_oauth\_client\_id) | Client ID of the console's GitHub OAuth App (callback URL https://<console\_hostname>/auth/github/callback). Required once image\_tag is set. | `string` | `null` | no |
| <a name="input_github_oauth_client_secret"></a> [github\_oauth\_client\_secret](#input\_github\_oauth\_client\_secret) | Client secret of the console's GitHub OAuth App. Supply as TF\_VAR\_github\_oauth\_client\_secret; it goes to Key Vault. | `string` | `null` | no |
| <a name="input_health_policy"></a> [health\_policy](#input\_health\_policy) | How the region monitors probe and judge health. Each probe interval costs about two Temporal Cloud actions per region. | <pre>object({<br/>    probe_interval_seconds = optional(number, 30)<br/>    probe_timeout_ms       = optional(number, 5000)<br/>    failure_threshold      = optional(number, 3)<br/>    degraded_latency_ms    = optional(number, 1500)<br/>    window_size            = optional(number, 10)<br/>    report_every_probes    = optional(number, 10)<br/>  })</pre> | `{}` | no |
| <a name="input_image_repositories"></a> [image\_repositories](#input\_image\_repositories) | Repository names in the registry for the three images. | <pre>object({<br/>    worker   = optional(string, "failover-sentry/worker")<br/>    console  = optional(string, "failover-sentry/console")<br/>    regional = optional(string, "failover-sentry/regional-app")<br/>  })</pre> | `{}` | no |
| <a name="input_image_tag"></a> [image\_tag](#input\_image\_tag) | Tag of the images to run (e.g. the short commit SHA pushed with `az acr build`). Null on the first apply, before any image exists: the Container Apps are then not created. Once set, keep it set. | `string` | `null` | no |
| <a name="input_initial_primary_region"></a> [initial\_primary\_region](#input\_initial\_primary\_region) | The region that starts as primary the first time the sentry runs (afterwards, the sentry decides). | `string` | `"eastus2"` | no |
| <a name="input_key_vault_additional_administrators"></a> [key\_vault\_additional\_administrators](#input\_key\_vault\_additional\_administrators) | Object IDs of other principals that run Terraform (a CI identity, say); they get Key Vault Secrets Officer too. | `list(string)` | `[]` | no |
| <a name="input_log_analytics_daily_quota_gb"></a> [log\_analytics\_daily\_quota\_gb](#input\_log\_analytics\_daily\_quota\_gb) | Daily ingestion cap in GB, a cost guard (-1 for none). | `number` | `0.5` | no |
| <a name="input_log_analytics_retention_days"></a> [log\_analytics\_retention\_days](#input\_log\_analytics\_retention\_days) | Days Log Analytics keeps logs (30 is included in the price). | `number` | `30` | no |
| <a name="input_name_suffix"></a> [name\_suffix](#input\_name\_suffix) | Suffix that makes the registry and Key Vault names globally unique. Null derives a stable one from the subscription and name; never change it once deployed (it renames, and so replaces, both). | `string` | `null` | no |
| <a name="input_project"></a> [project](#input\_project) | Short project name used in resource names and the required `project` tag. | `string` | `"fsentry"` | no |
| <a name="input_rbac_propagation_wait"></a> [rbac\_propagation\_wait](#input\_rbac\_propagation\_wait) | Wait after creating role assignments before relying on them. | `string` | `"90s"` | no |
| <a name="input_regions"></a> [regions](#input\_regions) | Regions of the protected workload, keyed by region ID (lower-case letters, digits, hyphens). Each gets its own resource group, Container Apps environment and copy of the demo workload. | <pre>map(object({<br/>    location     = string<br/>    display_name = string<br/>  }))</pre> | <pre>{<br/>  "centralus": {<br/>    "display_name": "Central US",<br/>    "location": "centralus"<br/>  },<br/>  "eastus2": {<br/>    "display_name": "East US 2",<br/>    "location": "eastus2"<br/>  }<br/>}</pre> | no |
| <a name="input_service_name"></a> [service\_name](#input\_service\_name) | Name of the protected service; the sentry's workflow ID is failover-sentry/<service\_name>. | `string` | `"storefront"` | no |
| <a name="input_tags"></a> [tags](#input\_tags) | Extra tags for every taggable resource (project, environment and managed\_by are always set). | `map(string)` | `{}` | no |
| <a name="input_temporal_address"></a> [temporal\_address](#input\_temporal\_address) | Temporal Cloud gRPC endpoint. Null uses the namespace endpoint <namespace>.tmprl.cloud:7233. | `string` | `null` | no |
| <a name="input_temporal_api_key"></a> [temporal\_api\_key](#input\_temporal\_api\_key) | Temporal Cloud API key for the namespace (worker and console). Supply as TF\_VAR\_temporal\_api\_key; it goes to Key Vault. | `string` | `null` | no |
| <a name="input_temporal_namespace"></a> [temporal\_namespace](#input\_temporal\_namespace) | Temporal Cloud namespace, e.g. failover-sentry.a1b2c (created by hand in Temporal Cloud). Required once image\_tag is set. | `string` | `null` | no |
| <a name="input_temporal_task_queue"></a> [temporal\_task\_queue](#input\_temporal\_task\_queue) | Task queue of the sentry's worker. | `string` | `"failover-sentry"` | no |

### Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_console_url"></a> [console\_url](#output\_console\_url) | The console (GitHub sign-in). |
| <a name="output_container_registry_login_server"></a> [container\_registry\_login\_server](#output\_container\_registry\_login\_server) | Login server of the container registry. |
| <a name="output_container_registry_name"></a> [container\_registry\_name](#output\_container\_registry\_name) | Name of the container registry (for az acr build). |
| <a name="output_edge_url"></a> [edge\_url](#output\_edge\_url) | The protected demo service, through the edge router. |
| <a name="output_github_oauth_callback_url"></a> [github\_oauth\_callback\_url](#output\_github\_oauth\_callback\_url) | Authorization callback URL to enter in the GitHub OAuth App. |
| <a name="output_image_build_commands"></a> [image\_build\_commands](#output\_image\_build\_commands) | Commands that build and push the three images with ACR Tasks (run from the repository root), for an image tag of your choice. |
| <a name="output_key_vault_name"></a> [key\_vault\_name](#output\_key\_vault\_name) | Name of the Key Vault that holds the secrets. |
| <a name="output_key_vault_secret_names"></a> [key\_vault\_secret\_names](#output\_key\_vault\_secret\_names) | Names of the secrets in Key Vault (optional ones appear once their values are supplied). |
| <a name="output_next_steps"></a> [next\_steps](#output\_next\_steps) | What to do after this apply. |
| <a name="output_regional_app_urls"></a> [regional\_app\_urls](#output\_regional\_app\_urls) | Origin URLs of the demo workload in each region (what the edge proxies to and the sentry probes). |
| <a name="output_resource_group_names"></a> [resource\_group\_names](#output\_resource\_group\_names) | Resource groups: the control plane's and one per protected region. |
| <a name="output_sentry_config"></a> [sentry\_config](#output\_sentry\_config) | The sentry's configuration as the worker and the console receive it (SENTRY\_CONFIG\_JSON). |
| <a name="output_tunnel_id"></a> [tunnel\_id](#output\_tunnel\_id) | ID of the console's Cloudflare Tunnel. |
| <a name="output_worker_identity_client_id"></a> [worker\_identity\_client\_id](#output\_worker\_identity\_client\_id) | Client ID of the worker's managed identity (fences regions through Azure Resource Manager). |
<!-- END_TF_DOCS -->
