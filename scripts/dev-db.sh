#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for development/tests when Docker is not available.
# With Docker: `docker compose up -d postgres` instead.
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
if [ "$(id -u)" = "0" ]; then DEF=/var/lib/texflow-pg; else DEF="$HOME/.texflow-pg"; fi
DATA="${PGDATA_DIR:-$DEF}"
PORT="${PGPORT:-5432}"
SUPERPASS="${PG_SUPERUSER_PASSWORD:-postgres_dev_only}"
run() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown postgres "$DATA"
      echo "$SUPERPASS" > /tmp/.texflow_pwfile; chmod 644 /tmp/.texflow_pwfile
      run "$PGBIN/initdb -D $DATA -U postgres --auth=scram-sha-256 --pwfile=/tmp/.texflow_pwfile --locale=C.UTF-8 >/dev/null"
      rm -f /tmp/.texflow_pwfile
    fi
    run "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/server.log -w start" ;;
  stop) run "$PGBIN/pg_ctl -D $DATA -w stop" ;;
  *) echo "usage: dev-db.sh start|stop"; exit 2 ;;
esac
