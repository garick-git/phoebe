# Phoebe operations notes

How the production back end is set up and kept running: shell access, deploys, scheduled jobs, backups and the restore procedure. Local development is in the [README](../README.md).

Nothing secret belongs in this file. It never contains the bucket name, the AWS account ID, the admin path, or any value from a `.env` file.

## Production layout

- **One AWS EC2 server** (t4g.micro, Arm, 1 GB RAM plus a 2 GB swap file) in us-east-2, running Ubuntu Server 24.04 LTS with automatic security updates.
- **Docker Compose** (`compose.prod.yaml`) runs three containers:
  - `caddy`: the only container with published ports (80 and 443). It gets and renews the Let's Encrypt certificate and redirects HTTP to HTTPS.
  - `web`: Django served by Gunicorn (2 workers). Static files are served by WhiteNoise and collected when the image is built.
  - `db`: PostgreSQL 18. Its data is in the named volume `postgres_data` and it is reachable only inside the Docker network.
- **Public API:** https://phoebe-api.garickm.com/api/satellites/
- **Firewall (security group):** inbound 80 and 443 only. There is no SSH port and no key pair; shell access is through AWS Systems Manager Session Manager.
- **Server role:** Session Manager access, plus an inline policy allowing upload (`s3:PutObject`) and list (`s3:ListBucket`) on the backup bucket only. It has no read or delete permission. Instance metadata requires IMDSv2 with a hop limit of 1, so only the host (not the containers) can use the role.

## Open a shell on the server

1. In the AWS console: EC2 → Instances → tick the Phoebe server → **Connect** → the **SSM Session Manager** card (not the default card, which needs port 22) → Connect.
2. Type `bash`, then `cd ~/phoebe`. A new session starts in another folder.
3. Server commands need `sudo` and `-f compose.prod.yaml`. Docker runs behind `sudo`, and the login user is not in the `docker` group on purpose.

Idle sessions time out. The containers and cron jobs keep running.

## Files that live only on the server

| File | Holds | Notes |
|---|---|---|
| `~/phoebe/.env` | Django and Postgres settings: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=False`, `DJANGO_ALLOWED_HOSTS`, `DJANGO_HSTS_SECONDS`, `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_ADMIN_PATH`, `POSTGRES_*` | Mode 600. Secrets were generated on the server with `openssl rand`. Read single lines with `grep '^NAME=' .env`; never print the whole file. |
| `/etc/phoebe/backup.env` | `BACKUP_BUCKET` | Root-owned, mode 600. Keeps the bucket name (which contains the account ID) out of the repo. |
| Root's crontab | The two daily jobs below | View with `sudo crontab -l`. |

If the server is ever rebuilt, all three must be created again.

## Deploy an update

Edit locally, run the tests, commit and push. Then on the server:

```
cd ~/phoebe && git pull
sudo docker compose -f compose.prod.yaml up -d --build --no-deps web
```

That rebuilds and restarts only `web`; Postgres keeps running.

- **`Caddyfile` changed:** also run `sudo docker compose -f compose.prod.yaml restart caddy`. The file is mounted, so Compose doesn't notice the change.
- **Only the server's `.env` changed:** run `sudo docker compose -f compose.prod.yaml up -d --no-deps --force-recreate web`. A container reads its environment only when it is created.
- **Only a script in `scripts/` changed:** `git pull` is enough, because cron runs the file straight from the repo.

**Production check:** `sudo docker compose -f compose.prod.yaml exec web python manage.py check --deploy` should report 3 intentional warnings (W005, W008, W021), with 1 check silenced (`mail.E001`, because Phoebe sends no email).

## Scheduled jobs

Root's crontab on the host (times are UTC):

```
0 8 * * * /home/ssm-user/phoebe/scripts/run_ingest.sh
30 8 * * * /home/ssm-user/phoebe/scripts/run_backup.sh
```

- **`run_ingest.sh`** runs `ingest_satellites` inside the running `web` container, which downloads CelesTrak's active-satellites feed and upserts it. It logs to `/var/log/phoebe/ingest.log`.
- **`run_backup.sh`** dumps the database and uploads the dump to S3 (see Backups below). It logs to `/var/log/phoebe/backup.log`.

Both scripts run on the host, not in a container: the backup needs the instance role's credentials, which containers can't reach. Both set their own `PATH` (cron's is minimal and lacks `/snap/bin`, where the AWS CLI lives), use `docker compose exec -T` (cron has no terminal), write `ok` or `FAILED` lines with UTC timestamps, and exit non-zero on failure.

**Check last night's runs:**

```
sudo tail -n 4 /var/log/phoebe/ingest.log /var/log/phoebe/backup.log
```

Look for `ingest ok` and `backup ok: db/phoebe-<timestamp>.dump, <bytes>`.

**Run a job by hand** (from `~/phoebe`): `sudo scripts/run_backup.sh` is safe at any time. `sudo scripts/run_ingest.sh` counts as a CelesTrak download, so keep it at least 2 hours away from the 08:00 UTC run.

## Backups

- **What:** a daily `pg_dump -Fc` (PostgreSQL custom format, compressed) of the whole database, about 2 to 3 MiB as of October 2026.
- **How:** the dump goes to a temp file. The script checks it (more than 1 KB, and `pg_restore --list` can read it), then uploads it with server-side encryption. Checking before uploading matters because the server can't delete a bad object once it's in the bucket.
- **Where:** a private S3 bucket in us-east-2, at `db/phoebe-<UTC timestamp>.dump`. Block Public Access is on, encryption is SSE-S3, and versioning is off.
- **Retention:** an S3 lifecycle rule deletes each object 30 days after it's created.

**List the backups** (on the server):

```
sudo bash -c '. /etc/phoebe/backup.env; AWS_DEFAULT_REGION=us-east-2 aws s3 ls "s3://$BACKUP_BUCKET/db/" --human-readable'
```

## Restore a backup (tested 2026-10-13)

This restores into a **new, empty scratch database on a laptop**, never into the live database. The server's role can't read backups, so the dump is downloaded with an admin login through the console.

1. **Record the live numbers** (on the server). They are the answer key:
   ```
   sudo docker compose -f compose.prod.yaml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT (SELECT count(*) FROM satellites_satellite) AS satellites, (SELECT count(*) FROM satellites_orbitalelementset) AS element_sets, (SELECT max(epoch) FROM satellites_orbitalelementset) AS newest_epoch;"'
   ```
   Use the newest dump. Only the 08:00 ingest writes to the database, so between a backup and the next morning's ingest the counts should match exactly.
2. **Download the dump:** AWS console (admin user, US East (Ohio)) → S3 → the backup bucket → `db/` → tick the file → Download. Move it into the repo's gitignored `data/` folder. Check that its size in bytes matches the `backup ok` line in `backup.log`.
3. **Create an empty scratch database** in the local `db` container:
   ```
   docker compose up -d db
   docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" phoebe_restore_test'
   ```
   If it already exists, drop it first. Never restore into a database that already holds data.
4. **Restore:**
   ```
   docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d phoebe_restore_test --no-owner --no-privileges --single-transaction' < data/<dump file> && echo "restore ok"
   ```
   - `--no-owner` and `--no-privileges` skip production's table owners and access grants, which may not exist locally.
   - `--single-transaction` makes the restore all or nothing: any error undoes it and stops, instead of pg_restore's default of continuing and reporting "errors ignored".
   - `-T` keeps Docker from attaching a terminal, which can mangle a binary file sent through standard input.
5. **Compare:** run the step 1 query with `-d phoebe_restore_test` (in the local container, with `exec -T`). All three values must match.
6. **Clean up:** drop the scratch database (`dropdb -U "$POSTGRES_USER" phoebe_restore_test`, inside the container) and delete the downloaded dump.

**Result on 2026-10-13:** the dump `phoebe-20261013T083001Z.dump` (2,903,267 bytes) restored with no errors. Satellites (16,702), element sets (48,747) and the newest epoch matched production exactly.

**Not yet rehearsed:** restoring onto a rebuilt server, or replacing the live database. Plan and test that before relying on it.

## Gotchas

- Check which terminal you're in before pasting (Mac versus server prompt).
- `psql` and `git log` open a pager (`(END)` at the bottom). Press `q` to leave it. `docker compose exec -T` avoids it.
- After a reboot, the containers come back on their own (`restart: unless-stopped`, Docker enabled at boot) in under a minute. The Session Manager Connect button can be greyed out for about 30 seconds.
- Unattended upgrades don't reboot the server. If `/var/run/reboot-required` exists, reboot when convenient.
- Never run `docker compose down -v` on the server: it deletes the database volume.
