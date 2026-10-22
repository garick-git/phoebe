# Phoebe operations notes

How production is set up and kept running: the back end's shell access, deploys, scheduled jobs, backups and restore procedure, and the front end's hosting on AWS Amplify. Local development is in the [README](../README.md).

Nothing secret belongs in this file. It never contains the bucket name, the AWS account ID, the admin path, or any value from a `.env` file.

## Production layout

- **One AWS EC2 server** (t4g.micro, Arm, 1 GB RAM plus a 2 GB swap file) in us-east-2, running Ubuntu Server 24.04 LTS with automatic security updates.
- **Docker Compose** (`compose.prod.yaml`) runs three containers:
  - `caddy`: the only container with published ports (80 and 443). It gets and renews the Let's Encrypt certificate and redirects HTTP to HTTPS. It also compresses every response (`encode zstd gzip` in the `Caddyfile`), which shrinks the globe's elements response from about 5 MB to about 1 MB.
  - `web`: Django served by Gunicorn (2 worker processes × 4 threads, so a slow Ask Phoebe question doesn't block other requests; settings in `gunicorn.conf.py`, which Gunicorn reads from `/app` on its own). The access log leaves out the query string and the Referer, so visitors' coordinates (`?lat=&lon=` on the passes endpoint) are never logged; `satellites/tests/test_logging.py` guards this. Each line ends with the request time in ms. Static files are served by WhiteNoise and collected when the image is built.
  - `db`: PostgreSQL 18. Its data is in the named volume `postgres_data` and it is reachable only inside the Docker network.
- **Deploys:** automatic on every merge to `main` (see Deploy an update). The server builds nothing and has no copy of the repo.
- **Public API:** https://phoebe-api.garickm.com/api/satellites/
- **Front end:** https://phoebe.garickm.com (AWS Amplify, see below)
- **Firewall (security group):** inbound 80 and 443 only. There is no SSH port and no key pair; shell access is through AWS Systems Manager Session Manager.
- **Server role:** Session Manager access, an inline policy allowing upload (`s3:PutObject`) and list (`s3:ListBucket`) on the backup bucket only (no read or delete), and `phoebe-ecr-pull`, which can pull from the `phoebe-web` image repository but not push. Instance metadata requires IMDSv2 with a hop limit of 1, so only the host (not the containers) can use the role.

## Open a shell on the server

1. In the AWS console: EC2 → Instances → tick the Phoebe server → **Connect** → the **SSM Session Manager** card (not the default card, which needs port 22) → Connect.
2. Type `bash`, then `cd ~/phoebe`. A new session starts in another folder.
3. Server commands need `sudo` and `-f compose.prod.yaml`. Docker runs behind `sudo`, and the login user is not in the `docker` group on purpose.

Idle sessions time out. The containers and cron jobs keep running.

## Files that live only on the server

| File | Holds | Notes |
|---|---|---|
| `~/phoebe/.env` | Django and Postgres settings: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=False`, `DJANGO_ALLOWED_HOSTS`, `DJANGO_HSTS_SECONDS`, `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_ADMIN_PATH`, `DJANGO_CORS_ALLOWED_ORIGINS`, `POSTGRES_*`, `ANTHROPIC_API_KEY` (Ask Phoebe; optionally `ASK_PHOEBE_MODEL` and `ASK_PHOEBE_DAILY_BUDGET_USD`), `SENTRY_DSN` (error tracking; unset = off) | Mode 600. Secrets were generated on the server with `openssl rand`. Read single lines with `grep '^NAME=' .env`; never print the whole file. |
| `/etc/phoebe/backup.env` | `BACKUP_BUCKET` | Root-owned, mode 600. Keeps the bucket name (which contains the account ID) out of the repo. |
| Root's crontab | The two daily jobs below | View with `sudo crontab -l`. |

If the server is ever rebuilt, all three must be created again.

The only other files in `~/phoebe` are `compose.prod.yaml`, the `Caddyfile` and `scripts/`. Every deploy copies them out of the deployed image, so never edit them on the server: change them in the repo, and the next deploy installs them.

## Deploy an update

Deploys are automatic. Merging a pull request into `main` runs `.github/workflows/deploy.yml`, unless the merge only changes `frontend/**`, `amplify.yml` or `customHttp.yml` (Amplify deploys those):

1. GitHub Actions signs in to AWS with **OIDC** as the role `phoebe-github-deploy`. No AWS keys are stored anywhere; the role trusts only this repository's `main` branch.
2. It builds the image on an ARM runner (the server is ARM) and smoke-tests it: `test_ephemeris.py` runs inside the image, and Gunicorn must report `workers = 2` (proof that it read `gunicorn.conf.py`).
3. It pushes the image to the private ECR repository `phoebe-web`, tagged with the full commit SHA. Tags are immutable, and ECR keeps the newest 5 images.
4. It runs the SSM command document `phoebe-deploy` on the server with that SHA. The document accepts nothing but a 40-character SHA, pulls the image, logs out of ECR, and runs the `scripts/deploy.sh` inside that image.
5. `scripts/deploy.sh` (as root, in `~/phoebe`):
   - unpacks the image's `compose.prod.yaml`, `Caddyfile` and `scripts/` into a temporary folder;
   - **migrates before switching:** a throw-away container from the new image runs `migrate` while the old container keeps serving;
   - only then installs those files in `~/phoebe`, so a failed migration leaves the server exactly as it was;
   - tags the running image `phoebe-web:previous`, tags the new one `phoebe-web:live`, and recreates only `web` (Postgres and Caddy keep running);
   - checks that `web` runs the new image, that the API answers over HTTPS, and that Gunicorn booted 2 workers;
   - restarts Caddy only if the `Caddyfile` changed, and removes images nothing uses.
6. The workflow prints the server's output and checks the API from outside.

`web` is down for a few seconds while the new container starts (one container, no blue/green switch).

**Watch a deploy:** GitHub → Actions → Deploy. The step "Deploy on the server" shows the server's output, ending in `deploy ok: <sha>`. The logs are public: the account ID and the instance ID are Actions secrets (`AWS_ACCOUNT_ID`, `PHOEBE_INSTANCE_ID`), so they show as `***`, and nothing prints the registry address.

**Migrations must be additive** (for example a new nullable column), because the old code keeps running against the new schema until the switch. Starting the new code first would query columns that don't exist yet. Removing or renaming a column takes two deploys: stop using it first, remove it later.

**Redeploy** the latest `main`: Actions → Deploy → Run workflow. A run for a commit whose image is already in ECR reuses it, and if that image is already running, nothing restarts. "Re-run failed jobs" on a failed run works the same way.

**Roll back** to the image that ran before the last deploy (on the server, from `~/phoebe`):

```
sudo docker tag phoebe-web:previous phoebe-web:live
sudo docker compose -f compose.prod.yaml up -d --no-deps --force-recreate web
```

- Safe only if the newer deploy's migrations were additive. The server files (compose file, `Caddyfile`, scripts) stay at the newer version.
- Keep `--force-recreate`: Compose doesn't reliably notice that a tag now points to a different image.
- After a rollback, `live` and `previous` are the same image. The next deploy (a fix merged to `main`, or Run workflow) moves forward again.

**Other changes:**

- **Only the server's `.env` changed:** `sudo docker compose -f compose.prod.yaml up -d --no-deps --force-recreate web`. A container reads its environment only when it is created.
- **The `db` or `caddy` service changed in `compose.prod.yaml`** (for example a new image version): the deploy installs the file but recreates only `web`. Afterwards run `sudo docker compose -f compose.prod.yaml up -d <service>` (for Postgres, take a backup first).
- **The SSM document:** AWS runs its own stored copy; `deploy/ssm-phoebe-deploy.yaml` is the reviewed copy. After changing it in a PR, upload the file to CloudShell (Actions → Upload file) and run `aws ssm update-document --region us-east-2 --name phoebe-deploy --content file://ssm-phoebe-deploy.yaml --document-format YAML --document-version '$LATEST'`, then `aws ssm update-document-default-version --region us-east-2 --name phoebe-deploy --document-version <the new version>`.
- **A rebuilt server:** create the server-only files above, copy `compose.prod.yaml` and the `Caddyfile` from the repo into `~/phoebe`, start `sudo docker compose -f compose.prod.yaml up -d db caddy`, restore the database, then Run workflow.

**AWS pieces (us-east-2):**

| Piece | What it is |
|---|---|
| ECR repository `phoebe-web` | Private image registry; immutable tags, scan on push, AES-256, lifecycle rule keeps the newest 5 images |
| IAM OIDC provider `token.actions.githubusercontent.com` | Lets AWS trust GitHub's signed tokens (audience `sts.amazonaws.com`) |
| IAM role `phoebe-github-deploy` | Trust policy: `StringEquals` on `sub` = `repo:garick-git@132175845/phoebe@1402337069:ref:refs/heads/main` (GitHub's format with the owner's and repository's permanent IDs, so a reused name can't match). Inline policy `phoebe-github-deploy-permissions`: ECR login, push to `phoebe-web` only (no delete), `ssm:SendCommand` for `phoebe-deploy` on the Phoebe server only, read command results |
| Server role inline policy `phoebe-ecr-pull` | ECR login and pull from `phoebe-web` only |
| SSM document `phoebe-deploy` | The deploy entry point described above |

**If the OIDC step fails** with `Not authorized to perform sts:AssumeRoleWithWebIdentity`, CloudTrail's event history shows the subject GitHub actually sent (`userIdentity.userName`) for each refused attempt; compare it with the trust policy. In CloudShell: `aws cloudtrail lookup-events --region us-east-2 --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity --max-results 5`. Events can take 5 to 15 minutes to appear.

**Production check:** `sudo docker compose -f compose.prod.yaml exec web python manage.py check --deploy` should report 3 intentional warnings (W005, W008, W021), with 1 check silenced (`mail.E001`, because Phoebe sends no email).

## Scheduled jobs

Root's crontab on the host (times are UTC):

```
0 8 * * * /home/ssm-user/phoebe/scripts/run_ingest.sh
30 8 * * * /home/ssm-user/phoebe/scripts/run_backup.sh
```

- **`run_ingest.sh`** runs `ingest_satellites` inside the running `web` container, which downloads CelesTrak's active-satellites feed and upserts it. It logs to `/var/log/phoebe/ingest.log`.
- **`run_backup.sh`** dumps the database and uploads the dump to S3 (see Backups below). It logs to `/var/log/phoebe/backup.log`.

The scripts come from the deployed image: `deploy.sh` copies them into `~/phoebe/scripts/`, so a script change ships with the next deploy. Both scripts run on the host, not in a container: the backup needs the instance role's credentials, which containers can't reach. Both set their own `PATH` (cron's is minimal and lacks `/snap/bin`, where the AWS CLI lives), use `docker compose exec -T` (cron has no terminal), write `ok` or `FAILED` lines with UTC timestamps, and exit non-zero on failure. Each run also publishes `IngestSucceeded` or `BackupSucceeded` (1 or 0) to CloudWatch for the alarms below (`scripts/report_metric.sh`); a failed publish is logged as `metric … NOT sent` and doesn't change the job's result.

### Alarms

Every alarm emails through the SNS topic `phoebe-alerts` (us-east-2; the subscription is confirmed by email). Application errors (including Ask Phoebe's `config` failure, an expired or revoked Claude key) go to Sentry instead, which emails on every new issue.

| Alarm | Fires when | Why |
|---|---|---|
| `phoebe-ingest-failed` | `Phoebe/IngestSucceeded` minimum < 1 in an hour (missing data = OK) | A run failed (CelesTrak down or refusing, the container stopped) |
| `phoebe-ingest-stale` | no `IngestSucceeded` of 1 for 26 hours (missing data = breaching) | The job didn't run at all (cron, the server, or the metric call broken) |
| `phoebe-backup-failed` | `Phoebe/BackupSucceeded` minimum < 1 in an hour | A backup failed |
| `phoebe-backup-stale` | no `BackupSucceeded` of 1 for 26 hours | No backup in over a day |
| `phoebe-server-system-check` | EC2 `StatusCheckFailed_System` for 2 minutes | AWS's hardware or network under the server failed; the alarm also **recovers** the instance onto healthy hardware |
| `phoebe-server-instance-check` | EC2 `StatusCheckFailed_Instance` for 3 minutes | The server itself is unreachable (kernel, memory, network config); the alarm also **reboots** it |

The server's role may only publish into the `Phoebe` namespace (inline policy `phoebe-put-metrics`; `PutMetricData` can't be limited to a resource, so the namespace condition does it). Cost: $0 within CloudWatch's always-free tier (10 custom metrics, 10 alarms); about $1.20 a month without it. **Test an alarm** without waiting for a failure (from `~/phoebe` on the server; publishes a real 0):

```
aws cloudwatch put-metric-data --region us-east-2 --namespace Phoebe --metric-name BackupSucceeded --value 0
```

`phoebe-backup-failed` emails within a few minutes and returns to OK (with a second email) about an hour later, once that hour's 0 has aged out.

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

## Front-end hosting (AWS Amplify)

- **What:** the Next.js app in `frontend/` is a static export, hosted by **AWS Amplify Hosting** (us-east-2) on its CDN. There is no Next.js server and no compute charge.
- **Build:** `amplify.yml` at the repo root (monorepo, `appRoot: frontend`): Node from `frontend/.nvmrc`, `npm ci`, `npm run build`, publish `frontend/out/`. A push to `main` triggers a build.
- **Headers:** `customHttp.yml` at the repo root (HSTS, nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`, `Content-Security-Policy`). `next.config.ts` `headers()` does not apply to a static export. **A new outside host the browser talks to must be added to the CSP's `connect-src`**, or the browser blocks it; Playwright can't see these headers (it serves `out/` without them), so check the live site's console after a change.
- **Monitoring (build-time environment variables, Amplify console only):** `NEXT_PUBLIC_SENTRY_DSN` (the `phoebe-web` project's DSN) and `NEXT_PUBLIC_POSTHOG_KEY` (PostHog's public project key). Both are public by design (they end up in the JavaScript); without them the build sends nothing. Changing either needs a new build (they're baked in).
- **Console settings that are not in the repo:**
  - Platform **`WEB`** with framework **`Next.js - SSG`**. Amplify auto-detects Next.js as SSR (`WEB_COMPUTE`), and the deploy then fails with `Can't find required-server-files.json in build output directory`. Fix from CloudShell:
    ```
    aws amplify update-app --app-id <app-id> --platform WEB --region us-east-2
    aws amplify update-branch --app-id <app-id> --branch-name main --framework "Next.js - SSG" --region us-east-2
    ```
  - Environment variables: `AMPLIFY_MONOREPO_APP_ROOT=frontend` (must match `appRoot`), `AMPLIFY_DIFF_DEPLOY=true`, `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_POSTHOG_KEY`.
  - **Rewrites and redirects: empty (`[]`).** Unknown URLs then get a real `404` status, but with an empty body, so the browser shows its own error page rather than Phoebe's `404.html`. Tested on 2026-10-14:
    - The default rule for new apps (`/<*>` → `/index.html`, `404-200`) turned every unknown URL into the home page with status 200 (a "soft 404"). Removed.
    - A `/<*>` → `/404.html` rule with status `404` (the custom 404 page example in AWS's docs) answered with a `302` redirect to `/404.html`, which then returned `200`. The same happened with `/404/index.html` as the target.
    - Showing Phoebe's own 404 page with a real 404 status is parked for the Nov 2 UX and SEO pass.
  - GitHub access: the Amplify GitHub App for us-east-2 is installed with **Only select repositories → phoebe**.
  - No firewall (WAF): about $20 a month, and a static site has no server-side input for it to filter.
- **Diff deploys:** with `AMPLIFY_DIFF_DEPLOY=true`, a commit that changes nothing under `frontend/` skips the build and deploy. That includes commits that only change `amplify.yml`. To force a full build: set the variable to `false`, choose **Redeploy this version** on the branch, then set it back to `true`.
- **Check after a deploy:** `curl -sI <site>/tonight/` shows `200` and the five headers; `curl -sI <site>/nope-123/` shows `404` with no `location:` line (and no rewrite rules in the console).

## Domains and DNS

Both hostnames are subdomains of garickm.com, whose DNS is managed at Vercel.

| Name | Type | Points to | Purpose |
|---|---|---|---|
| `phoebe-api` | A | The server's Elastic IP | The API. Caddy gets its certificate from Let's Encrypt. |
| `phoebe` | CNAME | The `….cloudfront.net` target shown in Amplify → Custom domains | The front end on Amplify. |
| `_<hash>` (on the root, **not** under `phoebe`) | CNAME | `_<hash>.acm-validations.aws` (from Amplify) | Proves to AWS Certificate Manager that we control the name. **Never delete it:** the free certificate renews about every 13 months only while this record exists. If it's lost, remove the domain in Amplify and add it again. |
| Root (name blank) | CAA | `0 issue "amazon.com"` | Allows Amazon's certificate authority to issue for garickm.com names. Without it, Amplify's certificate can't be issued or renewed. **Keep it.** |

- **CAA records** list which certificate authorities may issue certificates for a domain; a name with no CAA of its own inherits its parent's. Vercel also manages three locked CAA rows on the root (`letsencrypt.org`, `sectigo.com`, `pki.goog`). Never remove Let's Encrypt: Caddy needs it.
- The CAA row has to go on the root, because `phoebe` holds a CNAME, and a CNAME can't share its name with any other record.
- The zone also has a locked wildcard `*` record pointing at Vercel. Explicit records always win over it.
- Amplify's custom-domain settings: domain `garickm.com` with the root **excluded**, only the `phoebe` subdomain mapped to `main`, and an **Amplify managed certificate** (free).
- **Check:** `dig +short phoebe.garickm.com` (CloudFront addresses), `dig +short phoebe-api.garickm.com` (the Elastic IP), `dig +short CAA garickm.com` (four rows, including `amazon.com`).

## Ephemeris excerpt (expires 2031-01-01)

Pass visibility needs where the Sun and Earth are. That comes from `satellites/ephemeris/de421_2026-2031.bsp`, a 551,344-byte excerpt of NASA JPL's DE421 ephemeris covering 2026-01-01 to 2031-01-01, committed with the code (nothing is downloaded at build or run time). `test_ephemeris.py` starts failing a year before it runs out (from 2030-01-01). To cut a new one, on the Mac with the dev stack running:

```
curl -fL -o data/de421.bsp https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp
shasum -a 256 data/de421.bsp   # a20a7139da04cbc462454634918e9a9ca69127044e2cc9d4f9c16e238d2deedc (checked 2026-10-19)
docker compose exec web python -m jplephem excerpt <start yyyy/mm/dd> <end yyyy/mm/dd> data/de421.bsp satellites/ephemeris/de421_<start>-<end>.bsp
```

Then update `EPHEMERIS_PATH` in `satellites/passes.py`, run the tests, remove the old file with `git rm`, and delete `data/de421.bsp`. Keep every body (no `--targets`): skyfield's `apparent()` needs Jupiter and Saturn as well as the Sun and Earth. DE421 itself covers 1899–2053. Never put the file in a folder named `data` (`.gitignore` ignores those at any depth).

## Ask Phoebe (Claude API)

`POST /api/ask/` with `{"question": "..."}` answers with Claude, which calls three read-only tools (`ask/tools.py`): satellite lookup, passes (`find_passes()`), and Open-Meteo's cloud forecast. Code: `ask/service.py` (the tool-use loop and its limits), `ask/claude.py` (the HTTP client, plain httpx), `ask/places.py` (Open-Meteo geocoding and forecast from the server).

**Three spending layers:**
1. **Per IP:** `ask_burst` 5/min and `ask_day` 20/day (DRF throttles in each worker's memory, so up to about 2x and reset on deploy), on top of the API-wide 60/min.
2. **Site-wide per UTC day:** `ASK_PHOEBE_DAILY_BUDGET_USD` (default 0.15), counted exactly in the `ask_dailyusage` table from each reply's token counts at list price (`ask/budget.py`). When it's spent, Ask answers 503 `daily_budget` with `Retry-After` until midnight UTC, without calling Claude.
3. **Anthropic Console:** the key belongs to the **Phoebe** workspace, whose monthly spend limit is the hard stop (the default workspace can't have one). An organization limit is also set under Billing → Spend limits. When it's reached, Ask answers 503 `spend_limit`.

**The key:** only in the server's `.env` (and optionally the Mac's, for local testing). Never in the repo, CI, logs or a chat. Add it without it appearing on screen or in shell history (the leading `\n` matters: if `.env` doesn't end in a newline, the key would be glued onto the previous line, which happened on 2026-10-21), then recreate `web`:

```
read -rs KEY && printf '\nANTHROPIC_API_KEY=%s\n' "$KEY" >> .env && unset KEY
grep -c '^ANTHROPIC_API_KEY=' .env    # 1 (never print the line itself)
sudo docker compose -f compose.prod.yaml up -d --no-deps --force-recreate web
```

To rotate it: create a new key in the Phoebe workspace, replace the line (`sed -i '/^ANTHROPIC_API_KEY=/d' .env`, then the `read` step), recreate `web`, then delete the old key in the Console. **To switch Ask off:** remove the line and recreate `web` (Ask answers 503 `not_configured`).

**Usage:** the admin's **Daily usage** page (read-only), or
`sudo docker compose -f compose.prod.yaml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select * from ask_dailyusage order by day desc limit 7"'`. The Console's usage page is the real bill.

**Errors in the log** carry only the kind, HTTP status and Anthropic's error type, never the question or a place: `busy` (429/529/5xx), `timeout`, `spend_limit`, `config` (logged as an error: a bad key or a request the API rejected). Tests never call the real API (`ask/tests/conftest.py` fails any test that tries).

## Gotchas

- Check which terminal you're in before pasting (Mac versus server prompt).
- `psql` and `git log` open a pager (`(END)` at the bottom). Press `q` to leave it. `docker compose exec -T` avoids it.
- After a reboot, the containers come back on their own (`restart: unless-stopped`, Docker enabled at boot) in under a minute. The Session Manager Connect button can be greyed out for about 30 seconds.
- Unattended upgrades don't reboot the server. If `/var/run/reboot-required` exists, reboot when convenient.
- Never run `docker compose down -v` on the server: it deletes the database volume.
- `compose.prod.yaml` pins `name: phoebe`. Compose names the volumes after the project (`phoebe_postgres_data`), so a different project name would start Postgres on a new, empty volume.
- The AWS CLI opens long output in a pager (`less`); a command pasted while it's open is typed into the pager. Press `q`, and run `export AWS_PAGER=""` at the start of each CloudShell session.
