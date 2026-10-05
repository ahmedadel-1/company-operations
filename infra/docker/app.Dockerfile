# Production images for the API, worker, web app and the one-shot migration job (DEPLOYMENT §5).
# Uses the Dockerfile frontend built into BuildKit (Docker Engine 23+); a `# syntax=` directive would pull
# an unpinned frontend image at build time.
# Build from the repository root, one target per image:
#   docker build -f infra/docker/app.Dockerfile --target api     -t ops-api:<tag> .
#   docker build -f infra/docker/app.Dockerfile --target worker  -t ops-worker:<tag> .
#   docker build -f infra/docker/app.Dockerfile --target web     -t ops-web:<tag> .
#   docker build -f infra/docker/app.Dockerfile --target migrate -t ops-migrate:<tag> .
# `bash scripts/release/build-images.sh <tag>` builds all four with the same tag.

# Digest-pinned base (DEPENDENCIES §6). Bump tag and digest together.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ---------------------------------------------------------------------------------------------------
# Build stage: full workspace install from the frozen lockfile, compile everything, then cut
# production-only bundles. Nothing from this stage reaches a runtime image except the bundles.
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
# pnpm is installed with npm (no Corepack, DEPLOYMENT §2) at the exact version pinned in package.json
# `packageManager`. Its install script must run: it moves pnpm's native binary (the integrity-checked
# optional dependency @pnpm/exe.linux-x64) into place. Without it `pnpm` is a shebang-less shell stub that
# turbo cannot spawn (ENOEXEC). No other package runs scripts here.
RUN npm install --global pnpm@12.8.1 && pnpm --version
WORKDIR /repo

# Manifests first so the dependency layer is cached across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY apps/migrate/package.json apps/migrate/
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/i18n/package.json packages/i18n/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/validation/package.json packages/validation/
# Frozen lockfile, reviewed build scripts only (pnpm-workspace.yaml `allowBuilds`, `strictDepBuilds`).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY . .
RUN pnpm turbo run build --filter=@company-ops/api --filter=@company-ops/worker --filter=@company-ops/web \
    --filter=@company-ops/db

# Production bundles: only runtime dependencies, workspace packages reduced to their `files`.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@company-ops/api deploy --prod --legacy --store-dir /pnpm/store /out/api \
 && pnpm --filter=@company-ops/worker deploy --prod --legacy --store-dir /pnpm/store /out/worker \
 && pnpm --filter=@company-ops/migrate deploy --prod --legacy --store-dir /pnpm/store /out/migrate \
 && mkdir -p /out/web/apps/web/.next \
 && cp -R apps/web/.next/standalone/. /out/web/ \
 && cp -R apps/web/.next/static /out/web/apps/web/.next/static \
 && cp -R apps/web/public /out/web/apps/web/public

# pnpm links the optional peers of @prisma/client (the Prisma CLI with its engines, Studio and embedded
# PGlite, and TypeScript) into the API and worker bundles. The runtime needs only the generated client and
# the pg driver adapter; the CLI belongs to the migrate image. Remove them, then prove the runtime still
# resolves every import.
RUN set -eu; \
    for bundle in /out/api /out/worker; do \
      cd "$bundle/node_modules/.pnpm"; \
      rm -rf prisma@* @prisma+studio-core@* @prisma+dev@* @prisma+engines@* @prisma+engines-version@* \
        @prisma+fetch-engine@* @prisma+get-platform@* @electric-sql+pglite* typescript@*; \
      find "$bundle/node_modules" -xtype l -delete; \
      cd "$bundle"; \
      node --input-type=module -e "await import('@company-ops/core'); await import('@company-ops/config');"; \
    done

# ---------------------------------------------------------------------------------------------------
# Runtime base: no package manager, no build tools, non-root, production mode.
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
# Debian security updates published after the pinned base digest are applied at build time (the release
# SBOM records the resulting package versions). npm, npx, corepack and yarn ship with the base image but
# are never used at runtime; removing them also removes their bundled dependencies from the
# vulnerability surface.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
USER node
STOPSIGNAL SIGTERM

# ---------------------------------------------------------------------------------------------------
FROM runtime AS api
COPY --from=build --chown=root:root /out/api /app
COPY --chown=root:root --chmod=0755 infra/docker/bin/ops-bootstrap infra/docker/bin/ops-activity-rebuild /usr/local/bin/
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------------
FROM runtime AS worker
COPY --from=build --chown=root:root /out/worker /app
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_OPS_PORT||4001)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------------
FROM runtime AS web
COPY --from=build --chown=root:root /out/web /app
WORKDIR /app/apps/web
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------------------------------
# One-shot: `prisma migrate deploy` as ops_migrator (DATABASE_MIGRATION_URL or DATABASE_MIGRATION_URL_FILE).
FROM runtime AS migrate
COPY --from=build --chown=root:root /out/migrate /app
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
