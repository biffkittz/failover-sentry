# syntax=docker/dockerfile:1
# The console: Fastify server (API, GitHub sign-in, webhook gateway) serving the built Vue app. Build from the
# repository root:
#   docker build -f apps/console/Dockerfile -t failover-sentry/console .
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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
      --workspace @failover-sentry/contracts --workspace @failover-sentry/console-server --workspace @failover-sentry/console-web
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/console/server apps/console/server
COPY apps/console/web apps/console/web
RUN npm run build -w @failover-sentry/contracts \
 && npm run build -w @failover-sentry/console-web \
 && npm run build -w @failover-sentry/console-server

FROM manifests AS prod-deps
RUN npm ci --no-audit --no-fund --omit=dev --workspace @failover-sentry/console-server && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/apps/console/server/package.json ./apps/console/server/package.json
COPY --from=build /repo/apps/console/server/dist ./apps/console/server/dist
COPY --from=build /repo/apps/console/web/dist ./apps/console/web/dist
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} PORT=8080 WEB_DIST_DIR=/app/apps/console/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/console/server/dist/main.js"]
