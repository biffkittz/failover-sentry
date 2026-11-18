# Deploying to Azure and Cloudflare

Everything is Terraform (`infra/`), applied from your machine with your Azure CLI login and a Cloudflare token.
Nothing deploys around Terraform.

- [Prerequisites](#prerequisites)
- [Phase 1: foundation](#phase-1-foundation)
- [Phase 2: images and apps](#phase-2-images-and-apps)
- [Verify](#verify)
- [Operate](#operate)
- [Tear down](#tear-down)
- [Troubleshooting](#troubleshooting)

## Prerequisites

| What | How |
| --- | --- |
| Tools | Terraform ≥ 1.17.1, Azure CLI, Node.js 26 (for local builds), optionally tflint and terraform-docs. |
| Azure | `az login`; **Owner** (or Contributor + Role Based Access Control Administrator) on the subscription: Terraform creates role assignments and one custom role. Access to the state account `demonstration` (see `infra/backend.tf`). |
| Container registry | Nothing to do by default (Terraform creates one). The demo environment instead sets `existing_container_registry` to login-app's `crloginappdemo7fyguj` (resource group `rg-loginapp-demo`): it must exist, and you need to be able to assign roles on it (Owner on the subscription covers it). |
| Temporal Cloud | Create a namespace (e.g. `failover-sentry`), then an API key with access to it (a service account is best). Note the namespace ID (`failover-sentry.a1b2c`). The workers use the namespace endpoint `<namespace>.tmprl.cloud:7233` unless you set `temporal_address`. |
| GitHub OAuth App | GitHub → Settings → Developer settings → OAuth Apps → New. Homepage `https://sentry.biffkittz.com`, callback `https://sentry.biffkittz.com/auth/github/callback`. Note the client ID; generate a client secret. |
| Cloudflare API token | Account permissions: **Cloudflare Tunnel: Edit**, **Workers Scripts: Edit**, **Workers KV Storage: Edit**, **Account API Tokens: Edit** (only with alert emails). Zone permissions on `biffkittz.com`: **DNS: Edit**, **Workers Routes: Edit**, **Zone: Read**. Export it as `CLOUDFLARE_API_TOKEN`. |
| Alert emails (optional) | `biffkittz.com` must be onboarded for Cloudflare Email Sending, and each recipient must be a verified destination address of the account. The login-app project's Terraform already manages both; this project only creates its own Email-Sending-only token. |

> **Bot Fight Mode.** If the zone has Cloudflare Bot Fight Mode on, Cloudflare may challenge server-to-server calls
> through the proxied host names: the regions' replication webhook to `sentry.biffkittz.com` and the worker's
> routing writes to `dr.biffkittz.com`. The sentry still works (a lost webhook is detected by the durable timeout and
> the promotion verified directly), and a challenged edge write fails the step with an explicit "Cloudflare
> challenged the request" message. Turn Bot Fight Mode off for the zone, or, on Pro and above, skip Super Bot Fight
> Mode for those paths. The webhook and routing writes are HMAC-signed either way.

## Phase 1: foundation

```bash
cd infra
export CLOUDFLARE_API_TOKEN=...
terraform init
terraform plan -var-file=environments/demo.tfvars -out=demo.tfplan
terraform apply demo.tfplan
```

This creates the resource groups, Log Analytics, the registry (or, with `existing_container_registry`, AcrPull
grants on that one), Key Vault with generated secrets, the managed identities, the fencing role, the three Container Apps environments, the console's Cloudflare Tunnel and DNS record,
and the edge router Worker (which serves a holding page until the regions exist). No Container App yet:
`image_tag` is unset because no image exists.

## Phase 2: images and apps

Build the images in Azure with ACR Tasks (no local Docker needed), from the repository root:

```bash
TAG=$(git rev-parse --short HEAD)       # or any tag
REGISTRY=$(terraform -chdir=infra output -raw container_registry_name)
az acr build --registry "$REGISTRY" --image failover-sentry/worker:$TAG       --build-arg APP_VERSION=$TAG --file apps/worker/Dockerfile .
az acr build --registry "$REGISTRY" --image failover-sentry/console:$TAG      --build-arg APP_VERSION=$TAG --file apps/console/Dockerfile .
az acr build --registry "$REGISTRY" --image failover-sentry/regional-app:$TAG --build-arg APP_VERSION=$TAG --file apps/regional-app/Dockerfile .
```

Then, in `environments/demo.tfvars`, set `image_tag`, `temporal_namespace`, `github_oauth_client_id`,
`console_allowed_github_users` (and `alert_email_recipients` if you want emails), export the secrets and apply:

```bash
export TF_VAR_temporal_api_key=...
export TF_VAR_github_oauth_client_secret=...
terraform -chdir=infra plan -var-file=environments/demo.tfvars -out=demo.tfplan
terraform -chdir=infra apply demo.tfplan
```

Run the plan once more: it must report **no changes** (idempotency).

## Verify

1. `https://sentry.biffkittz.com` → sign in with GitHub. Within a minute the sentry establishes East US 2 as primary
   (epoch 1) and routes the edge to it (timeline: `PRIMARY_ESTABLISHED`, `EDGE_SYNCED`).
2. `https://dr.biffkittz.com` shows "Served from East US 2"; the response carries `x-sentry-region` and
   `x-sentry-epoch`.
3. Region page → chaos → **Take region down**. After about three probe intervals the sentry fails over to Central US,
   stops East US 2's Container App (check the portal: it is *Stopped*), and `dr.biffkittz.com` serves Central US.
4. **Recover region** on East US 2 → the sentry starts it; it rejoins as a healthy standby.
5. **Emergency failover…** → planned → back to East US 2.

The worker's logs: `az containerapp logs show -g rg-fsentry-demo -n ca-fsentry-demo-worker --follow`. The sentry's
history: Temporal Cloud UI → namespace → `failover-sentry/storefront`.

## Operate

| Task | How |
| --- | --- |
| Deploy new code | Build images with a new tag, set `image_tag`, apply. Workflow code changes must be replay-safe ([WORKFLOWS.md](WORKFLOWS.md#determinism-and-versioning)). |
| Change probe interval or policies | Edit `health_policy` / `failover_policy`, apply. The worker sends the new configuration to the running sentry (`reconfigure` Update), applied between normal-operations cycles. |
| Rotate a generated secret | `terraform apply -replace=random_password.webhook_secret` (or another), then restart the apps (`az containerapp revision restart`) so the Key Vault references refresh at once. |
| Rotate the Temporal API key | Create a new key, `export TF_VAR_temporal_api_key=...`, apply, restart the worker and console. |
| Pause the sentry | Toggle automatic failover off in the console (monitoring continues), or terminate the workflow in Temporal Cloud (the console offers to start it again). |
| Reduce cost | Raise `health_policy.probe_interval_seconds` (Temporal actions), set `log_analytics_daily_quota_gb` lower. |

## Tear down

```bash
terraform -chdir=infra destroy -var-file=environments/demo.tfvars
```

Key Vault is purged on destroy (purge protection is off for this demo). Delete the Temporal Cloud namespace and the
GitHub OAuth App by hand. A shared registry stays, with the images in it; delete them with
`az acr repository delete -n <registry> --repository failover-sentry/worker` (and `console`, `regional-app`).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `MANIFEST_UNKNOWN` on apply | The image tag isn't in the registry: `az acr repository show-tags -n <registry> --repository failover-sentry/worker`. |
| Plan fails reading the registry (`ResourceNotFound`) | `existing_container_registry` names a registry that doesn't exist (any more): check the name and resource group, or whether its owner destroyed it. |
| Console shows "Sentry not running" | The worker can't reach Temporal Cloud (check `TEMPORAL_ADDRESS`, the API key's namespace access) or the workflow was terminated: click **Start the sentry**. |
| Replication always times out | The webhook doesn't arrive: check the console logs for `replication webhook relayed`; Bot Fight Mode (above); the regions' `WEBHOOK_SECRET` vs the console's `WEBHOOK_SIGNING_SECRET`. |
| Fencing fails with 403 | The worker's role assignment hasn't propagated yet, or the custom role isn't assignable to the regional resource group. |
| `stale_epoch` refusals | Expected after a manual change behind the sentry's back; the sentry adopts the higher epoch and retries. |
