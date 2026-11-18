# syntax=docker/dockerfile:1
# Local stand-in for the Cloudflare Worker (docker compose only; in Azure + Cloudflare the same worker.js runs on
# Cloudflare's edge). No dependencies: it runs src/worker.js on Node.js with an in-memory KV.
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY apps/edge-router/package.json ./package.json
COPY apps/edge-router/src ./src
USER node
EXPOSE 8787
CMD ["node", "src/local-server.js"]
