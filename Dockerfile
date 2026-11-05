# syntax=docker/dockerfile:1
#
# One Dockerfile, three images (pick with --target):
#   api  -> the HTTP + Socket.IO server   (node apps/api/dist/server.js)
#           the same image runs the worker (node apps/api/dist/worker.js)
#   web  -> the built React app on nginx, which also proxies /api and /socket.io to the API
#
# Layers are ordered by how often they change: package manifests (rarely) before source (often),
# so a code change reuses the cached `npm ci`.

ARG NODE_IMAGE=node:22.17-alpine

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /app

# Every workspace manifest, so npm can lay out the monorepo before any source arrives.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# ---------------------------------------------------------------------------------------------
# All dependencies, compilers included.
FROM manifests AS dev-deps
# mongodb-memory-server (a test tool) would otherwise download a ~100 MB mongod binary here.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN npm run build -w @vibe/shared

# Server build: shared -> api. Needs no web configuration.
FROM dev-deps AS build-api
COPY apps/api apps/api
RUN npm run build -w @vibe/api

# Web build: type-check and bundle.
FROM dev-deps AS build-web
COPY apps/web apps/web
# Baked into the browser bundle at build time. A *publishable* key: public by design, not a secret.
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_API_URL=""
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}     VITE_API_URL=${VITE_API_URL}
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" || (echo "VITE_CLERK_PUBLISHABLE_KEY build arg is required" && exit 1)
RUN npm run build -w @vibe/web

# ---------------------------------------------------------------------------------------------
# Production dependencies of the API only: no compilers, test tools or web packages.
FROM manifests AS api-deps
RUN npm ci --omit=dev --no-audit --no-fund --workspace @vibe/api --workspace @vibe/shared \
    && npm cache clean --force

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=api-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node apps/api/package.json apps/api/
COPY --from=build-api --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build-api --chown=node:node /app/apps/api/dist apps/api/dist
# Never run as root: a compromised process can't modify the image or bind privileged ports.
USER node
EXPOSE 4000
# Liveness only: readiness (/health/ready) checks Mongo and Redis, and a dependency outage shouldn't
# make the orchestrator kill and restart healthy API processes.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]

# ---------------------------------------------------------------------------------------------
# Unprivileged nginx: runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build-web /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
