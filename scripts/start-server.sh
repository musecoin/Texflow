#!/bin/sh
# Container entrypoint for hosted deployments (Render, Fly, any Docker host).
#   DATABASE_URL      schema-owner connection (e.g. Neon "neondb_owner", unpooled)   [required]
#   APP_DB_PASSWORD   password for the least-privilege runtime role texflow_app       [required]
#   APP_DATABASE_URL  optional; derived from DATABASE_URL + APP_DB_PASSWORD when unset
#   SEED_DEMO=1       load the DEMO organization once (demo servers only)
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
# tolerate values pasted from a .env line: DATABASE_URL="postgresql://..." (prefix, quotes, spaces)
DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^DATABASE_URL[[:space:]]*=[[:space:]]*//' -e 's/^["'"'"']//' -e 's/["'"'"']$//')
export DATABASE_URL
case "$DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo "DATABASE_URL must start with postgresql:// (check the value pasted into Render)" >&2; exit 1 ;; esac
if [ -z "${APP_DATABASE_URL:-}" ]; then
  : "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
  APP_DATABASE_URL=$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    u.username = "texflow_app"; u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
    u.searchParams.delete("channel_binding");
    process.stdout.write(u.toString());')
  export APP_DATABASE_URL
fi
node packages/db/src/migrate.ts
if [ "${SEED_DEMO:-0}" = "1" ]; then ALLOW_DEMO_SEED=1 node packages/db/src/seed.ts; fi
exec node apps/api/src/main.ts
