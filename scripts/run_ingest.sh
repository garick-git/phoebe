#!/usr/bin/env bash
# Daily CelesTrak ingest. Runs on the server HOST from root's crontab (see README / status notes).
# Calls the Django management command inside the running `web` container and appends
# one timestamped line per run (plus the command's own output) to /var/log/phoebe/ingest.log,
# then reports success (1) or failure (0) to CloudWatch for the alarms (report_metric.sh).
set -uo pipefail

# Cron starts with a very small PATH; set what we need explicitly. The snap-installed
# AWS CLI (for the CloudWatch metric) lives in /snap/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin

# Work from the repo root no matter where cron starts us (scripts/ lives one level below it).
cd "$(dirname "$0")/.."

LOG_DIR=/var/log/phoebe
LOG_FILE="$LOG_DIR/ingest.log"
mkdir -p "$LOG_DIR"

. scripts/report_metric.sh

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo "$(stamp) ingest start" >> "$LOG_FILE"

# -T: no terminal. Cron has none, and exec fails without this flag.
status=0
docker compose -f compose.prod.yaml exec -T web python manage.py ingest_satellites \
  >> "$LOG_FILE" 2>&1 || status=$?

if [ "$status" -eq 0 ]; then
  echo "$(stamp) ingest ok" >> "$LOG_FILE"
  report_metric IngestSucceeded 1
else
  echo "$(stamp) ingest FAILED (exit $status)" >> "$LOG_FILE"
  report_metric IngestSucceeded 0
fi

exit "$status"
