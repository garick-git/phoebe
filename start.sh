#!/usr/bin/env bash
# Start Phoebe locally with one command: ./start.sh
#
# 1. Starts Docker Desktop if it isn't running.
# 2. Starts Postgres and Django in the background (compose.yaml).
# 3. Applies any new migrations.
# 4. Downloads fresh satellite data from CelesTrak, but only if the local data is
#    more than 12 hours old (CelesTrak asks for no more than a few downloads a day).
# 5. Installs front-end packages if package-lock.json changed, then runs Next.js
#    and opens http://localhost:3000 once it answers.
#
# Ctrl+C stops Next.js and the containers. The database volume is kept.
# Django's logs: run `docker compose logs -f web` in another tab.
set -euo pipefail

cd "$(dirname "$0")"   # repo root, wherever this is run from

INGEST_MAX_AGE_HOURS=12
FRONTEND_URL="http://localhost:3000"
API_URL="http://127.0.0.1:8000"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$1"; }

# Answers with any HTTP status (even a 404) once a server is listening.
is_up() { [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$1" || true)" != "000" ]; }

opener_pid=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$opener_pid" ] && kill "$opener_pid" 2>/dev/null || true
  say "Stopping the containers (your data is kept)"
  docker compose stop || true
}

# --- 1. Docker -----------------------------------------------------------------
say "Checking Docker"
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -a Docker
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || { warn "Docker didn't start within 2 minutes. Open Docker Desktop and try again."; exit 1; }
fi

[ -f .env ] || { warn "No .env file. Run: cp .env.example .env  (then set the two change-me values)"; exit 1; }

# From here on, stop the containers however the script ends.
trap cleanup EXIT INT TERM

# --- 2. Back end ---------------------------------------------------------------
say "Starting Postgres and Django"
# --wait returns once db is healthy and web is running.
docker compose up -d --build --wait --wait-timeout 180

# --- 3. Migrations ---------------------------------------------------------------
say "Applying migrations"
docker compose exec -T web python manage.py migrate --noinput

# --- 4. Satellite data -------------------------------------------------------------
say "Checking how old the satellite data is"
age_hours=$(docker compose exec -T web python manage.py shell --verbosity 0 -c "
from django.db.models import Max
from django.utils import timezone
from satellites.models import Satellite
t = Satellite.objects.aggregate(m=Max('last_seen_at'))['m']
print(-1 if t is None else int((timezone.now() - t).total_seconds() // 3600))
" | tail -n 1 | tr -d '[:space:]')

if [ "$age_hours" = "-1" ] || [ "$age_hours" -ge "$INGEST_MAX_AGE_HOURS" ]; then
  if [ "$age_hours" = "-1" ]; then echo "No satellite data yet."; else echo "Data is ${age_hours} hours old."; fi
  echo "Downloading fresh data from CelesTrak (takes about a minute)..."
  if ! docker compose exec -T web python manage.py ingest_satellites; then
    if [ "$age_hours" = "-1" ] && [ -f data/active.json ]; then
      warn "CelesTrak download failed. Loading the saved copy in data/active.json instead (it may be old, so positions and pass times will be off)."
      docker compose exec -T web python manage.py ingest_satellites --file data/active.json
    else
      warn "CelesTrak download failed. Carrying on with the data already in the database."
    fi
  fi
else
  echo "Data is ${age_hours} hours old, fresh enough. Skipping the download."
fi

say "Waiting for Django to answer"
for _ in $(seq 1 30); do is_up "$API_URL/" && break; sleep 1; done
is_up "$API_URL/" || { warn "Django isn't answering on $API_URL. Check: docker compose logs web"; exit 1; }
echo "Django is up at $API_URL"

# --- 5. Front end -----------------------------------------------------------------
say "Preparing the front end"
cd frontend

# nvm is a shell function, so a script has to load it before `nvm use`.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
for nvm_sh in "$NVM_DIR/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
  if [ -s "$nvm_sh" ]; then
    set +u; . "$nvm_sh"; nvm use >/dev/null; set -u
    break
  fi
done
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 24 ] || warn "Node 24 is expected (frontend/.nvmrc); you have $(node -v 2>/dev/null || echo none)."

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing packages (npm ci)..."
  npm ci
fi

# Open the browser once Next.js answers (in the background, so dev can run in front).
( for _ in $(seq 1 60); do is_up "$FRONTEND_URL" && { open "$FRONTEND_URL"; exit 0; }; sleep 1; done ) &
opener_pid=$!

say "Starting Next.js at $FRONTEND_URL (Ctrl+C stops everything)"
npm run dev
