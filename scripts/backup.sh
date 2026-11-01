#!/usr/bin/env bash
# Encrypted PostgreSQL backup with retention.
#   BACKUP_PASSPHRASE=... DATABASE_URL=... scripts/backup.sh            create backup
#   scripts/backup.sh restore <file.dump.enc> <target DATABASE_URL>      restore into an EMPTY database
# Format: pg_dump custom format, AES-256-CBC with PBKDF2 (600k iterations) via openssl.
# Schedule with cron/systemd/K8s CronJob; copy files off-host (object storage with versioning + object lock).
set -euo pipefail
cd "$(dirname "$0")/.."
# load .env without overriding variables already set in the environment
if [ -f .env ]; then while IFS='=' read -r k v; do [[ "$k" =~ ^[A-Z0-9_]+$ ]] && [ -z "${!k:-}" ] && export "$k=$v"; done < .env; fi
DIR="${BACKUP_DIR:-./backups}"; KEEP_DAYS="${BACKUP_RETENTION_DAYS:-14}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required (32+ chars)}"
[ "${#BACKUP_PASSPHRASE}" -ge 32 ] || { echo "BACKUP_PASSPHRASE must be at least 32 characters" >&2; exit 2; }
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_dump || echo /usr/lib/postgresql/16/bin/pg_dump)")}"

if [ "${1:-}" = "restore" ]; then
  FILE="${2:?file}"; TARGET="${3:?target DATABASE_URL}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | "$PG_BIN/pg_restore" --no-owner --exit-on-error -d "$TARGET"
  echo "restored $FILE"; exit 0
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
mkdir -p "$DIR"; chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$DIR/texflow-$STAMP.dump.enc"
"$PG_BIN/pg_dump" --format=custom --no-owner "$DATABASE_URL" | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -out "$OUT"
chmod 600 "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
find "$DIR" -name 'texflow-*.dump.enc*' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
