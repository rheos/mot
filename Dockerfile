# M.O.T. on Coolify (Dockerfile build pack). Replaced Nixpacks on 2026-10-18: Coolify's
# Nixpacks 1.41.0 builds from a January 2025 nixpkgs snapshot with no Node 24. Keep the
# major here in step with .nvmrc.
#
# Same shape as the Nixpacks image it replaces: root user, app in /app, full node_modules
# (next start needs no standalone output; see next.config.mjs), data on the /data/mot bind
# mount that Coolify attaches at run time.

FROM node:24-bookworm-slim AS build
# better-sqlite3 11.x has no prebuilt binary for Node 24, so npm compiles it with node-gyp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# devDependencies included: next build needs typescript, tailwind and postcss.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# basePath is baked in at build time. Coolify passes build-time env vars as build args.
ARG NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
RUN npm run build

FROM node:24-bookworm-slim
# curl: Coolify's health check runs inside the container (GET /mot/api/status).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ARG NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "start", "--", "-H", "0.0.0.0", "-p", "3100"]
