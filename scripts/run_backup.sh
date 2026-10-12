#!/usr/bin/env bash
# Daily Postgres backup to a private S3 bucket. Runs on the server HOST from root's crontab.
#
# Order matters: dump to a temp file, check the dump is readable, only then upload.
# The server's role can upload but not delete, so a half-written or corrupt object
# uploaded by mistake would stay in the bucket until the 30-day lifecycle rule removes it.
#
# The bucket name is read from /etc/phoebe/backup.env (root-only, on the server),
# so it never appears in the repository.
set -uo pipefail

# Cron's PATH is tiny. The snap-installed AWS CLI lives in /snap/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
export AWS_DEFAULT_REGION=us-east-2

# Work from the repo root no matter where cron starts us.
cd "$(dirname "$0")/.."

LOG_DIR=/var/log/phoebe
LOG_FILE="$LOG_DIR/backup.log"
mkdir -p "$LOG_DIR"

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log()   { echo "$(stamp) $*" >> "$LOG_FILE"; }
fail()  { log "backup FAILED: $*"; exit 1; }

[ -r /etc/phoebe/backup.env ] || fail "cannot read /etc/phoebe/backup.env"
. /etc/phoebe/backup.env
[ -n "${BACKUP_BUCKET:-}" ] || fail "BACKUP_BUCKET is not set in /etc/phoebe/backup.env"

# Temp dir is removed on every exit path, success or failure.
WORK_DIR=$(mktemp -d /var/tmp/phoebe-backup.XXXXXX) || fail "could not create a temp directory"
trap 'rm -rf "$WORK_DIR"' EXIT

NAME="phoebe-$(date -u +%Y%m%dT%H%M%SZ).dump"
FILE="$WORK_DIR/$NAME"
KEY="db/$NAME"
COMPOSE="docker compose -f compose.prod.yaml"

log "backup start"

# 1. Dump. pg_dump runs inside the db container, which already has the database name and
#    user in its environment, so the host never handles the database password.
#    -Fc = custom format: compressed, restorable with pg_restore.
#    -T = no terminal (cron has none).
$COMPOSE exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$FILE" 2>> "$LOG_FILE" || fail "pg_dump exited with $?"

# 2. Check. Not empty, and pg_restore can read the archive's table of contents.
SIZE=$(stat -c %s "$FILE")
[ "$SIZE" -gt 1024 ] || fail "dump is suspiciously small ($SIZE bytes)"
$COMPOSE exec -T db pg_restore --list < "$FILE" > /dev/null 2>> "$LOG_FILE" \
  || fail "pg_restore --list could not read the dump"

# 3. Upload, asking for server-side encryption explicitly (the bucket default also applies).
aws s3 cp "$FILE" "s3://$BACKUP_BUCKET/$KEY" --sse AES256 --only-show-errors \
  >> "$LOG_FILE" 2>&1 || fail "upload to S3 failed (exit $?)"

log "backup ok: $KEY, $SIZE bytes"
