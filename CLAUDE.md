# Failover Sentry (temporal-node-workers-demo)

A multi-region disaster-recovery orchestrator: Temporal workflows (TypeScript SDK) on Temporal Cloud, a Vue 3 console
at https://sentry.biffkittz.com, a demo workload in two Azure regions, and a Cloudflare Worker edge router at
https://dr.biffkittz.com. See `README.md` and `docs/` (ARCHITECTURE, WORKFLOWS, DEPLOYMENT, DEVELOPMENT).

## Ground rules

- The original requirements are in `prompts` (the user's file: read it when a decision depends on intent, don't edit
  it).
- Commit or push only when asked; branch first when on `main`.
- **Never run `terraform apply` or create Azure/Cloudflare resources without the user's go-ahead.** They cost money
  and touch biffkittz.com. `terraform init -backend=false`, `validate`, `test` and read-only `az` commands are fine.
- Terraform providers: azurerm, cloudflare, random, time only (approved). Anything else, including azapi or external
  modules, needs the user's approval and a comment explaining why.
- Use the Linux `az` inside WSL.

## Check loop

```bash
npm ci && npm run build:contracts
npm run typecheck && npm run lint && npm test           # the worker's workflow tests need the Temporal CLI
npm run test:e2e -w @failover-sentry/console-web        # Playwright (mocked API)
cd infra && terraform init -backend=false && terraform fmt -recursive && terraform validate && terraform test
terraform-docs .                                        # after changing Terraform variables/outputs/resources
docker compose up --build                               # the whole system locally
```

## Things that will bite

- **Workflow determinism.** Code under `apps/worker/src/workflows` must stay replayable: no I/O, `setTimeout`,
  randomness or Node.js modules (ESLint enforces it). Changing the order or kind of activities/timers/children of a
  running workflow needs `patched()`; locally, `docker compose down -v` resets Temporal instead.
- **Contracts first.** Types, signal/query/update definitions and the config schema live in `packages/contracts`; it
  must be built (`npm run build:contracts`) before other packages type-check or test.
- **The edge Worker is plain JavaScript** (`apps/edge-router/src/worker.js`, JSDoc-checked) because Terraform uploads
  that file as is. Keep its signature check in step with `packages/contracts/src/signing.ts` (a test signs with one
  and verifies with the other).
- **Epochs only go up.** Every authority change (failover, revert, re-establishing a primary) increments the epoch;
  databases and the edge refuse older ones. Don't add a path that writes routing or promotes without an epoch.
- **Regional apps run exactly one replica** (in-memory simulated database) and their liveness probe is `/livez`,
  which chaos never touches; probing `/healthz` would let the platform "heal" chaos by restarting.
- **Two-phase deploy.** Container Apps exist only when `image_tag` is set and the images are in ACR. Once set, keep it
  set, or the apps are destroyed.
- **The registry is login-app's** (`crloginappdemo7fyguj` via `existing_container_registry` in `demo.tfvars`). This
  configuration only reads it and grants AcrPull on it; login-app's Terraform owns it, so destroying that project
  deletes these images and grants.
- **The worker image needs `ca-certificates`.** Temporal's native core trusts the OS CA store, which `node:*-slim`
  lacks; without it, connecting to Temporal Cloud fails with `NativeCertsNotFound`. Compose never shows this (its
  Temporal is plain text); CI's image job checks it.
- **Authorization belongs to routes, not URL prefixes.** Fastify decodes percent-escapes before matching, so a
  `request.url.startsWith('/internal/')` check is bypassed by `/%69nternal/...`. Register guards in the plugin scope
  of the routes they protect (regional admin API), or check `request.routeOptions.url` (console CSRF).
- **Cancelling a child that continued as new.** A child's cancellation targets the run the parent started; the
  sentry cancels its monitors by workflow ID first (`stopMonitors`), or it would wait for them forever.
- **Bot Fight Mode** on the zone can challenge the webhook and edge writes (docs/DEPLOYMENT.md).
- **Secrets** live in Key Vault (per-secret RBAC) and, marked sensitive, in the remote state; never in tfvars, logs or
  `localStorage`.
