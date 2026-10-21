#!/usr/bin/env bash
# Deploy one image of the Django app to this server.
#
# Run as root by the SSM document phoebe-deploy (deploy/ssm-phoebe-deploy.yaml),
# from ~/phoebe, right after it pulled the image from ECR:
#     bash deploy.sh <registry>/phoebe-web:<40-character commit SHA>
# The document copies this file out of that same image, so every deploy runs the
# deploy steps of the commit being deployed.
#
# The output ends up in the public GitHub Actions log, so it never prints the image
# reference (the registry address contains the AWS account ID), only the SHA.
set -euo pipefail

IMAGE="$1"
SHA="${IMAGE##*:}"
COMPOSE=(docker compose -f compose.prod.yaml)
HEALTH_URL=https://phoebe-api.garickm.com/api/satellites/25544/

log()  { echo "$(date -u +%H:%M:%SZ) $*"; }
fail() { log "deploy FAILED: $*"; exit 1; }
trap 'log "deploy FAILED at line $LINENO of deploy.sh"' ERR

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the image tag is not a commit SHA"
[ -f .env ] || fail "no .env in $(pwd); run from ~/phoebe"

log "deploy $SHA"

# 1. Unpack the new image's server files (compose file, Caddyfile, cron scripts)
#    into a temporary folder. They replace the live ones only after the migration
#    succeeds, so a failed deploy leaves the server exactly as it was.
STAGE=$(mktemp -d /var/tmp/phoebe-deploy.XXXXXX)
cid=""
cleanup() {
  [ -z "$cid" ] || docker rm "$cid" > /dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT
cid=$(docker create "$IMAGE")
docker cp "$cid:/app/compose.prod.yaml" "$STAGE/compose.prod.yaml"
docker cp "$cid:/app/Caddyfile" "$STAGE/Caddyfile"
docker cp "$cid:/app/scripts" "$STAGE/scripts"
docker rm "$cid" > /dev/null
cid=""

# 2. Migrate before switching: a throw-away container from the NEW image, started
#    with the NEW compose file, applies any migrations while the old container
#    keeps serving. Migrations must be additive (the old code has to keep working
#    with the new schema). --project-directory keeps .env and the project name.
log "migrate"
PHOEBE_WEB_IMAGE="$IMAGE" docker compose --project-directory "$PWD" -f "$STAGE/compose.prod.yaml" \
  run --rm --no-deps -T web python manage.py migrate --noinput

# 3. Install the new server files. cp writes into the existing Caddyfile (same
#    inode), which Caddy's single-file mount needs.
caddyfile_changed=false
cmp -s "$STAGE/Caddyfile" Caddyfile || caddyfile_changed=true
cp "$STAGE/compose.prod.yaml" compose.prod.yaml
cp "$STAGE/Caddyfile" Caddyfile
mkdir -p scripts
cp "$STAGE"/scripts/* scripts/
chmod 755 scripts/*.sh
log "server files updated from the image"

# 4. Switch: keep what's live as phoebe-web:previous (a one-command rollback, see
#    docs/operations.md), point phoebe-web:live at the new image, and recreate only
#    web (Postgres and Caddy keep running). Compose doesn't reliably notice that a
#    tag now points to a different image, so compare image IDs and force the
#    recreate; redeploying the commit that's already running restarts nothing.
new_id=$(docker image inspect -f '{{.Id}}' "$IMAGE")
live_id=$(docker image inspect -f '{{.Id}}' phoebe-web:live 2>/dev/null || true)
if [ -n "$live_id" ] && [ "$live_id" != "$new_id" ]; then
  docker tag phoebe-web:live phoebe-web:previous
elif [ -z "$live_id" ] && docker image inspect phoebe-web:latest > /dev/null 2>&1; then
  # First automatic deploy: the image the old routine built on the server.
  docker tag phoebe-web:latest phoebe-web:previous
  docker rmi phoebe-web:latest > /dev/null
fi
docker tag "$IMAGE" phoebe-web:live
web=$("${COMPOSE[@]}" ps -q web)
running_id=""
[ -z "$web" ] || running_id=$(docker inspect -f '{{.Image}}' "$web")
if [ "$running_id" = "$new_id" ]; then
  log "web already runs this image"
  "${COMPOSE[@]}" up -d --no-deps web # no change; starts it if it was stopped
else
  log "switch web"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate web
fi

# 5. Check: web runs the new image, the API answers through Caddy over HTTPS, and
#    Gunicorn read gunicorn.conf.py (two workers booted, not the default one).
web=$("${COMPOSE[@]}" ps -q web)
[ "$(docker inspect -f '{{.Image}}' "$web")" = "$new_id" ] || fail "web is not running the new image"
curl -fsS -o /dev/null --retry 10 --retry-delay 2 --retry-all-errors --max-time 10 "$HEALTH_URL" \
  || fail "the API did not answer"
started=$(docker inspect -f '{{.State.StartedAt}}' "$web")
workers=$(docker logs --since "$started" "$web" 2>&1 | grep -c "Booting worker" || true)
[ "$workers" -ge 2 ] || fail "expected 2 Gunicorn workers, saw $workers (was gunicorn.conf.py read?)"

# 6. Caddy reads its Caddyfile only at start, and Compose can't see a change to a
#    mounted file, so restart Caddy only if this deploy changed it.
if [ "$caddyfile_changed" = true ]; then
  log "Caddyfile changed: restart caddy"
  "${COMPOSE[@]}" restart caddy
  curl -fsS -o /dev/null --retry 10 --retry-delay 2 --retry-all-errors --max-time 10 "$HEALTH_URL" \
    || fail "the API did not answer after restarting Caddy"
fi

# 7. Tidy: drop the ECR names (live and previous keep their images), including
#    any left by an earlier failed deploy, then delete images with no name left.
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '/phoebe-web:[0-9a-f]{40}$' \
  | xargs -r docker rmi > /dev/null 2>&1 || true
docker image prune -f > /dev/null
log "deploy ok: $SHA"
