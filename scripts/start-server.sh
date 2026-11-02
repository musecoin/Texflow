#!/bin/sh
# Container entrypoint for hosted deployments (Render, Fly, any Docker host).
#   DATABASE_URL      schema-owner connection (e.g. Neon "neondb_owner", unpooled)   [required]
#   APP_DB_PASSWORD   password for the least-privilege runtime role texflow_app       [required]
#   APP_DATABASE_URL  optional; derived from DATABASE_URL + APP_DB_PASSWORD when unset
#   SEED_DEMO=1       load the DEMO organization once (demo servers only)
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
if [ -z "${APP_DATABASE_URL:-}" ]; then
  : "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
  URLS=$(node scripts/derive-db-urls.mjs)
  DATABASE_URL=$(printf '%s\n' "$URLS" | sed -n 1p)
  APP_DATABASE_URL=$(printf '%s\n' "$URLS" | sed -n 2p)
  export DATABASE_URL APP_DATABASE_URL
fi
node packages/db/src/migrate.ts
if [ "${SEED_DEMO:-0}" = "1" ]; then ALLOW_DEMO_SEED=1 node packages/db/src/seed.ts; fi
exec node apps/api/src/main.ts
