# syntax=docker/dockerfile:1.7
# TEXFLOW API + web (single image). Node runs TypeScript directly (type stripping, Node >= 22.18).
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN node apps/web/build.mjs && node_modules/.bin/tsc -p tsconfig.json

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
RUN apk add --no-cache tini && addgroup -S texflow && adduser -S texflow -G texflow
COPY --from=build --chown=texflow:texflow /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=texflow:texflow /app/node_modules ./node_modules
COPY --from=build --chown=texflow:texflow /app/packages ./packages
COPY --from=build --chown=texflow:texflow /app/apps/api ./apps/api
COPY --from=build --chown=texflow:texflow /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=texflow:texflow /app/scripts ./scripts
USER texflow
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "scripts/start-server.sh"]
