# syntax=docker/dockerfile:1
# Failover Sentry worker. Build from the repository root (npm workspaces):
#   docker build -f apps/worker/Dockerfile -t failover-sentry/worker .
#
# glibc-based image on purpose: Temporal's native core (Rust) ships prebuilt for glibc, not musl (Alpine).
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

# npm ci needs every workspace manifest to honour the lockfile, even when installing one workspace.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/regional-app/package.json apps/regional-app/
COPY apps/edge-router/package.json apps/edge-router/
COPY apps/worker/package.json apps/worker/
COPY apps/console/server/package.json apps/console/server/
COPY apps/console/web/package.json apps/console/web/

FROM manifests AS build
RUN npm ci --no-audit --no-fund --include-workspace-root \
      --workspace @failover-sentry/contracts --workspace @failover-sentry/worker
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/worker apps/worker
# Compiles TypeScript and prebundles the workflow code (dist/workflow-bundle.js), so startup doesn't run webpack.
RUN npm run build -w @failover-sentry/contracts && npm run build -w @failover-sentry/worker

FROM manifests AS prod-deps
RUN npm ci --no-audit --no-fund --omit=dev --workspace @failover-sentry/worker && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} HEALTH_PORT=8081
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/worker/dist/main.js"]
