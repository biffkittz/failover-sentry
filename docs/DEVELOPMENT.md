# Development

- [Prerequisites](#prerequisites)
- [Run everything with Docker Compose](#run-everything-with-docker-compose)
- [Run pieces from source](#run-pieces-from-source)
- [Checks](#checks)
- [Conventions](#conventions)
- [Repository layout](#repository-layout)

## Prerequisites

- Node.js 26 (`.nvmrc`) and npm 11 (workspaces).
- Docker with Compose (for the full local stack).
- The Temporal CLI (`temporal`) for the workflow tests and for running a dev server outside Docker.
- Terraform 1.17+ (and optionally tflint, terraform-docs, pre-commit) for `infra/`.

```bash
npm ci
npm run build:contracts      # the shared package other packages import
```

## Run everything with Docker Compose

```bash
docker compose up --build
```

| URL | What |
| --- | --- |
| http://localhost:8080 | The console (sign in as the local operator: `AUTH_MODE=dev`) |
| http://localhost:8233 | Temporal UI (dev server) |
| http://localhost:8787 | The protected service through the local edge router |
| http://localhost:8091, :8092 | The two regions directly |

The local configuration (`config/local.sentry.json`) probes every 5 seconds and uses short timeouts, so a failover
takes about a minute. The local edge router simulates KV propagation (5 s); compute "stop/start" is simulated by the
regions' signed power switch. Workflow code changed? Reset Temporal's state: `docker compose down -v`.

A tour: take East US 2 down from its region page (chaos), watch the automatic failover; recover East US 2; fail back
with **Emergency failover…** while East US 2's replication is *stalled* to see the durable timeout, the stall alert and
the operator decision; abort a failover mid-flight to see compensation.

## Run pieces from source

```bash
temporal server start-dev                                           # terminal 1: Temporal on :7233, UI on :8233

# terminal 2: the two regions and the edge
REGION_ID=eastus2 PORT=8091 PEERS=centralus=http://localhost:8092 ADMIN_SHARED_SECRET=local-region-admin-secret-0123456789 \
  WEBHOOK_URL=http://localhost:8080/api/webhooks/replication WEBHOOK_SECRET=local-webhook-secret-0123456789 \
  npm run dev -w @failover-sentry/regional-app
# ...and the same for centralus on 8092 with PEERS=eastus2=http://localhost:8091
ORIGINS='{"eastus2":"http://localhost:8091","centralus":"http://localhost:8092"}' ADMIN_SECRET=local-edge-admin-secret-0123456789 \
  npm start -w @failover-sentry/edge-router

# terminal 3: the worker (needs a config whose URLs point at localhost)
SENTRY_CONFIG_FILE=./my-local.sentry.json REGION_ADMIN_SECRET=... EDGE_ADMIN_SECRET=... npm run dev -w @failover-sentry/worker

# terminal 4: the console's server and the Vue dev server (proxies /api and /auth to :8080)
NODE_ENV=development AUTH_MODE=dev PUBLIC_URL=http://localhost:5173 SESSION_SECRET=$(openssl rand -hex 32) \
  SENTRY_CONFIG_FILE=./my-local.sentry.json WEBHOOK_SIGNING_SECRET=... REGION_ADMIN_SECRET=... \
  npm run dev -w @failover-sentry/console-server
npm run dev -w @failover-sentry/console-web                         # http://localhost:5173
```

## Checks

```bash
npm run typecheck      # tsc / vue-tsc, strict, every package
npm run lint           # ESLint (typescript-eslint; eslint-plugin-vue's recommended rules for the Vue app)
npm test               # Vitest in every package; the worker's workflow tests start a Temporal dev server
npm run test:e2e -w @failover-sentry/console-web   # Playwright + axe accessibility checks (mocked API)
```

The workflow tests use the Temporal CLI from `TEMPORAL_CLI_PATH` or `PATH`; the SDK never downloads a server. Unit
tests use Vitest (Jest's API, native to Vite) with Vue Test Utils and jsdom.

Terraform: see [infra/README.md](../infra/README.md#checks). Pre-commit runs the Terraform checks, ESLint and the
type checks: `pipx install pre-commit && pre-commit install`.

## Conventions

- **TypeScript everywhere**, strict, ESM, `verbatimModuleSyntax`. Shared types and Temporal message definitions live
  in `packages/contracts`, so the worker, the console and the Vue app can't drift apart.
- **Workflow code is deterministic**: no I/O, timers, randomness or Node.js modules in `apps/worker/src/workflows`
  (ESLint enforces it); decisions are pure functions in `apps/worker/src/domain` with their own tests.
- **Vue**: Composition API with `<script setup lang="ts">`, type-based `defineProps`/`defineEmits`, kebab-case files
  and PascalCase components, presentational components separate from containers (views and `*-panel` components),
  Pinia setup stores by domain, TanStack Query for request/response data, Server-Sent Events into the sentry store,
  scoped styles with BEM class names and CSS custom properties (light and dark themes), no `v-html`.
- **Security**: sessions only in `HttpOnly` cookies; signed service-to-service calls; no secret in a tfvars file or a
  log line.
- **Docs**: when behavior, commands or configuration change, update the matching doc in the same change.

## Repository layout

```
packages/contracts      Shared types, Temporal definitions, config schema (zod), HMAC signing
apps/worker             Temporal worker: workflows (sentry, monitors), activities, adapters (regions, edge, Azure, email)
apps/console/server     Fastify BFF: GitHub OAuth, SSE state stream, Updates, chaos, webhook gateway; serves the SPA
apps/console/web        Vue 3 + Vite + Pinia + Vue Router + TanStack Query + VeeValidate
apps/regional-app       The protected demo workload (simulated database, chaos, replication webhook)
apps/edge-router        Cloudflare Worker (plain JS, deployed by Terraform) + a Node.js shim for local runs
infra                   Terraform for Azure and Cloudflare (modules, tests, environments)
config                  Local configuration for Docker Compose
docs                    Architecture, workflows, deployment, development
```
