# Security

What Phoebe protects, from whom, and how. A short threat model for a small,
public, account-free app on one server. Last reviewed: October 22, 2026.

## What's worth protecting

1. **Visitors' locations.** Tonight's rounded coordinates and city names, and
   Ask Phoebe's questions (which can name a place). Phoebe has no accounts, so
   this is the only personal data it touches.
2. **The bill.** Prepaid Claude credits and the AWS account (about $11–12 a
   month by design).
3. **Availability.** One small EC2 server (t4g.micro, 1 GB) serves the API.
4. **The server and its data.** The Postgres database and its daily backups.
5. **The path to production.** The GitHub repo, CI and the AWS role that
   deploys every merge to `main`.
6. **Secrets.** Django's secret key, the database password, the Claude API
   key, and the admin login.

## Who might attack, realistically

- **Automated scanners and bots** probing every public IP and hostname
  (the most likely by far).
- **Someone scripting the API**, especially Ask Phoebe, to run up costs or
  knock the server over.
- **Prompt injection** typed into Ask Phoebe.
- **A compromised dependency** (npm, PyPI, a GitHub Action, a base image).
- **Mistakes by the maintainer**: a leaked key, a wrong setting, a bad deploy.

Out of scope: targeted, well-funded attackers, and AWS or GitHub themselves.

## Threats and what stops them

| Threat | Mitigations | What's left (accepted) |
|---|---|---|
| **Running up the Claude bill** | Per-IP limits on Ask (5 a minute, 20 a day) on top of the API-wide 60 a minute; a $0.15 daily budget counted exactly in Postgres; a $5 monthly limit in the Claude Console on $5 of prepaid credits with auto-reload off; question length and response tokens capped | Many IPs together can use up the day's budget; Ask then answers "try again tomorrow" (it fails closed, it never overspends) |
| **Overloading the API** | Rate limits on every endpoint; every input bounded (valid lat/lon, at most 7 days, a cap on computation per request); threaded Gunicorn so slow Claude calls don't block the globe or Tonight; DRF patched for two header/body parsing denial-of-service bugs found by pip-audit (Oct 22) | One small server with no CDN or WAF in front of the API; a large flood would take it down until it stops (AWS Shield Standard only). Limits are counted per Gunicorn worker, so the real limit is about twice the configured one |
| **Leaking where visitors are** | Coordinates rounded to about 1 km in the browser, before anything is sent; the access log never records query strings (a test fails if it does); `Referrer-Policy: same-origin`; Sentry (both halves) strips query strings, request bodies, cookies, headers and stack-frame variables, tested on the real SDK; PostHog gets only five typed, anonymous events with no place, coordinates or question, no IP and no GeoIP lookup, and nothing when the browser sends Global Privacy Control | Open-Meteo receives the rounded coordinates or the typed city name, and the visitor's IP, straight from the browser (to be disclosed on the About page, Nov 3) |
| **Prompt injection** | Every tool Claude can call is read-only and returns public data only; Claude never sees a secret; every time and number in an answer is checked against the tool results before it's shown, and anything unbacked is replaced by the tool data itself; an injection question is part of the scored evaluation | The model could still say something wrong in words; it can't act on anything |
| **Malicious script in the page (XSS)** | React escapes all text; a Content-Security-Policy on the site limits where the page may connect (Phoebe's API, Open-Meteo, Sentry, PostHog only) and blocks plugins, framing and `<base>` rewrites; the API's own CSP allows no inline or outside scripts in the admin and browsable API; violations from real visitors are reported to Sentry | The static site allows inline scripts (`'unsafe-inline'`): Next.js's static export inlines page data whose hashes change every build, and a static host can't add per-request nonces |
| **Taking over the server** | Only ports 80 and 443 open, no SSH (AWS Session Manager instead); IMDSv2 with a hop limit of 1, so containers can't reach the server's AWS role; the app runs as a non-root user; Postgres has no published port; daily automatic security updates with an automatic reboot at 09:30 UTC when one is needed; the database container sees only its own settings | A compromised `web` container holds the database password and the Claude key (it needs both) |
| **Destroying or reading backups** | The server's role can upload and list, never read or delete; bucket versioning keeps any overwritten copy for 7 days; private, encrypted, 30-day expiry; a restore has been tested end to end; alarms fire when a backup fails or none succeeds for 26 hours | Backups live in the same AWS account and region as the server |
| **Guessing the admin login** | A random 24-character admin path; a long random password from a password manager; HTTPS-only, HttpOnly session cookies | No lockout after failed attempts (decided Oct 22: guessing either secret is infeasible; revisit if the logs ever show attempts) |
| **A compromised dependency** | Every dependency pinned exactly (lockfile for npm, `==` for Python, GitHub Actions by commit SHA); Dependabot proposes updates weekly, at least 7 days after a release; `pip-audit` and `npm audit` fail CI on known vulnerabilities; every update is a reviewed PR | A malicious release that nobody has caught within the cooldown |
| **Hijacking the deploy pipeline** | `main` is protected (pull request, both checks green, no bypass, no force pushes); deploys use short-lived OIDC credentials (no AWS keys stored anywhere) for a role that only trusts this repo's `main` and may only push one image repository and run one SSM document on one instance; CI's GitHub token is read-only | The maintainer's GitHub account (2FA on) |
| **Leaked secrets** | Secrets live only in the server's `.env` files (mode 600) and never in the repo or CI; the full git history was scanned (gitleaks) before the repo went public; GitGuardian scans every PR; config errors never echo values; Claude keys expire after 90 days and are rotated before then | A secret pasted into a chat or screenshot (it happened once with a Claude key, Oct 21: revoked and replaced within minutes) |
| **Failing silently** | Sentry on the back end and the front end (including Ask Phoebe's "config" error, for example a revoked key); CloudWatch alarms emailed through SNS for a failed or missing ingest or backup, and for failed EC2 status checks (which also recover or reboot the server); GitHub emails failed deploys | Uptime of the site as a whole isn't measured from outside yet |

## Checklist (brief section 6b), October 22, 2026

| Item | Status |
|---|---|
| MFA on the root account; daily work as an IAM user with MFA | Done |
| Least-privilege roles for the server and for deploys | Done. The Oct 22 review also found two IAM users left over from 2024 coursework (one a full administrator with a console password and no MFA, both with active access keys, unused for over two years, no activity in CloudTrail's 90 days): keys deactivated and the password removed the same day, users to be deleted a week later |
| Only ports 80 and 443; no SSH | Done |
| Postgres never exposed | Done |
| Automatic OS security updates | Done, with automatic reboots at 09:30 UTC |
| Backup bucket private, public access blocked, encrypted | Done, plus versioning |
| No secrets in the repo; secret scanning in CI | Done |
| DEBUG off, secret key, strict hosts, HTTPS with HSTS, CORS for the front end only | Done; HSTS one year on both hostnames, no subdomains or preload |
| Content-Security-Policy, `nosniff`, `Referrer-Policy` | Done on both hostnames |
| Input validation with bounds | Done |
| Rate limits everywhere, strictest on Ask | Done |
| AI tools read-only; capped questions and tokens; spending limit; injection expected | Done |
| Dependabot, pip-audit, npm audit in CI | Done |
| Minimal personal data; analytics without IP addresses | Done |
