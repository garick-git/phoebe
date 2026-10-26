# Key decisions

These are the decisions behind Phoebe that are worth explaining, picked from the project's full decision log. Each one says what was chosen, why, and what was turned down. Dates are when each was decided (2026). The measured numbers come from the live system or the test suites.

Back to the [README](../README.md).

## Architecture and hosting

### Browser animates, server computes
**Oct 2.** The browser animates satellites with satellite.js, and the back end does the heavy, accuracy-critical work: the data pipeline, pass predictions with visibility, search and Ask Phoebe.
- **Why:** streaming thousands of positions a second from a server is wasteful, and real trackers split the work this way. The browser downloads each satellite's orbital elements once (989 KB compressed for about 16,700 satellites) and can then animate for hours with no more requests.
- **Trade-off:** SGP4 runs in two places, so a committed agreement test keeps them together (see [Agreement test](#agreement-test-python-is-the-reference)).
- **Turned down:** server-computed positions pushed over WebSockets.

### SGP4 in a Web Worker
**Oct 16.** Live motion runs in a Web Worker that downloads and parses the elements, propagates every satellite once a second, and transfers one `Float32Array` back to the page. If the worker is still busy when the next tick comes, that tick is skipped, not queued.
- **Why:** measured first. On the main thread an update took 31 ms on desktop and 135 ms at 4× CPU slowdown, against a 16.7 ms frame budget. With the worker, the page's share is about 1 ms. Transferring the buffer hands its memory over instead of copying it, and skipping ticks lets a slow device fall behind gracefully.
- **Turned down:** a main-thread timer (stutters on phones).

### One server
**Oct 2.** One EC2 server (t4g.micro) runs Docker Compose with Caddy, Gunicorn/Django and PostgreSQL.
- **Why:** about $12 a month instead of $30–50; one container doesn't need a load balancer; Caddy gets and renews HTTPS certificates for free. Postgres is reachable only inside the Docker network, and backups go to S3 daily (a restore was tested end to end).
- **Turned down:** ECS Fargate, an Application Load Balancer and RDS (the path if traffic ever justifies the cost).

### Static export on Amplify, no Next.js server
**Oct 13.** The front end is a Next.js static export, served by AWS Amplify as plain files.
- **Why:** Phoebe needs no Next.js server. Django is the API, the pages call it from the browser, and About is static. It's the cheapest option (no server-side rendering charges), there's one less server to secure, and the CDN serves pages fast. Lighthouse mobile on Tonight: 100 in all four categories.
- **Trade-off:** security headers live in Amplify's custom headers instead of `next.config`, and there's no built-in image optimizer.
- **Turned down:** server-side rendering on Amplify's compute.

### A daily cron job instead of a task queue
**Oct 2 and Oct 12.** The daily ingest and backup are scripts run by the host's cron, calling a Django management command and `pg_dump`.
- **Why:** one daily job doesn't need Celery and Redis. Each job logs `ok` or `FAILED` and publishes a CloudWatch metric that alarms watch (see [Monitoring](#alarms-from-metrics-the-jobs-publish)).
- **Turned down:** Celery + Redis.

### Append-only orbital history with bulk upserts
**Oct 6.** Element sets are never overwritten. They're unique on (satellite, epoch), and the foreign key uses `PROTECT`. The ingest writes in bulk (`bulk_create` with conflict handling) inside one transaction.
- **Why:** it keeps the full history, re-running the ingest is idempotent, and the database refuses to delete a satellite that has history.
- **Turned down:** overwriting the latest element set; `CASCADE` deletes.

### Threaded Gunicorn
**Oct 21.** Gunicorn runs 2 worker processes × 4 threads (`gthread`).
- **Why:** an Ask Phoebe question waits 5–15 s on Claude. With 2 plain sync workers, two questions at once would block the globe and Tonight. Threads share their process's memory, so there's no extra RAM on a 1 GB server. Tested with 16 simultaneous pass searches.
- **Turned down:** a third sync worker (about 150 MB more, still only 3 at once); async workers (a bigger change).

## Pass predictions

### Visibility through the whole pass
**Oct 19.** A pass is visible if, at any moment, the satellite is above 10°, it's sunlit, and the Sun is below −6° for the observer. The API says when it appears and disappears.
- **Why:** measured on a world grid for one week of ISS passes. Of 978 passes with a visible part, only 529 are visible at their peak, so a peak-only check would hide **46%**. Many appear partway through, coming out of Earth's shadow.
- **Turned down:** checking only the peak; checking only rise, peak and set (misses windows inside the pass).

### A two-stage scan with a cap
**Oct 19.** Visibility is sampled every 10 s across all passes in one vectorized call, then every 1 s inside any 10 s gap where the answer changes. Each search is capped at 3,000 coarse samples.
- **Why:** 1-second sampling took 330–720 ms for a week of ISS passes, and the two-stage scan 41–71 ms, accurate to the second (0 mismatches against a 1-second brute force over 463 passes). The cap means no request can trigger a huge computation. Production median: 174 ms.
- **Turned down:** 1-second sampling; one root-finding call per pass (120–390 ms).

### Cross-check with tolerances set first
**Oct 19.** Predictions were compared with Heavens-Above for Chicago, with pass/fail limits written down before looking: times within 60 s, direction within one 16-point compass point, height within 2°.
- **Result:** the same 11 visible passes, and 33 of 33 timed points within 2 s.
- **Why Heavens-Above:** it gives times to the second (NASA's Spot the Station gives minutes). Austin had no visible passes that week, which Heavens-Above also showed.

### Agreement test: Python is the reference
**Oct 20.** pytest writes skyfield's answers (5 orbit types × 5 times) to a committed fixture and fails if they change, and Vitest checks satellite.js against that fixture: within 100 m on the ground, 10 m of altitude and 1 m/s.
- **Why:** the server is the side checked against Heavens-Above, so it's the reference. Each suite stays in its own language and CI job, and a failure tells you which side moved. Measured gap: 26–44 m, explained by UT1−UTC (satellite.js treats UTC as UT1).
- **Turned down:** satellite.js as the reference; running Node from pytest.

## Ask Phoebe

### Tools over Phoebe's own APIs, with plain httpx
**Oct 21.** Claude gets three read-only tools: `get_passes`, satellite lookup and cloud forecast. Each takes a place name, which the server geocodes. Django calls the Claude API with httpx directly, not the Anthropic SDK.
- **Why:** it's one endpoint, and httpx was already a dependency. The SDK measured at 12 new packages and about 64 MB more per worker on a 1 GB server. Writing the loop against the raw JSON also makes the tool-use protocol easy to explain. The loop is capped at 4 rounds, 6 tool calls and 45 s.
- **Turned down:** the `anthropic` SDK.

### Three spending limits
**Oct 21.** Per-IP throttles (5 a minute, 20 a day), a site-wide daily budget in dollars counted exactly in Postgres, and the Claude Console's monthly limit as the hard stop.
- **Why:** per-IP limits stop one person, not 50 visitors. The throttle counts live in each worker's memory, so they're loose; the money guard has to be exact and shared, using atomic `F()` updates. The Console limit catches bugs in Phoebe's own code.
- **Turned down:** per-IP limits plus the Console limit only; a shared cache such as Redis (a new service).

### Verify before showing
**Oct 22.** Before an answer is shown, `verifyAnswer()` checks every clock time, date, weekday, duration, percentage, degree and bare number in it against the tool results. If anything doesn't match, the answer is hidden and the passes are shown straight from the tool data, as the same cards Tonight uses.
- **Why:** no possibly wrong number ever reaches the screen. It runs in the browser because it protects the reader from model mistakes, not from attackers, and it sits next to the cards that replace a failed answer. 10 of 10 deliberately wrong answers were caught.
- **Limits, stated honestly:** claims in words ("every pass is before sunrise", direction words, "two") aren't checked; the cards under the answer show those facts from the data.
- **Turned down:** verifying on the server in Python (a second implementation); showing a failed answer with a warning.

### Evaluation by record and replay
**Oct 22.** A management command asks 20 questions for real, once, on a developer machine and commits every full reply. Vitest re-scores those recordings on every pull request, using the drawer's own `verifyAnswer()` plus checks on the tool, satellite, place and days. CI never calls Claude.
- **Why:** $0 per CI run, deterministic (the gate never flickers), and no real API key in CI. A fingerprint of the prompt, tools and loop limits is stored with each recording, and pytest fails if they change without a new recording.
- **"Correct" means behavior plus faithfulness, not a fixed answer key:** pass times change daily, and orbit accuracy is tested separately.
- **Result:** Sonnet 5.5 19/20 and Opus 5.5 17/20 on the same questions, so **production uses Sonnet**: it gave the better answers at less than half the price. With only one run of 20 each, the gap is a hint, not proof.
- **Turned down:** calling Claude from CI with a secret; an LLM grading the answers.

## Deploys and CI

### OIDC and SSM deploys
**Oct 20.** GitHub Actions signs in to AWS through OIDC as a role that trusts only this repository's `main` branch. It pushes the image to ECR and runs an SSM command document whose only input is a 40-character commit SHA, on the one server.
- **Why:** there are no long-lived AWS keys to leak or rotate, and credentials last at most an hour. Pull requests and forks are refused. There's no SSH port, and the CI role can't run arbitrary root commands. AWS validates the SHA before any shell runs, so there's no command injection. The real steps live in `scripts/deploy.sh` inside each reviewed image.
- **Turned down:** access keys in Actions secrets; `AWS-RunShellScript`; SSH from Actions.

### Migrate before switching
**Oct 15 and Oct 21.** `deploy.sh` runs migrations in a throwaway container from the new image while the old container keeps serving. Only after that succeeds does it install the new server files and switch. The previous image is kept for a one-command rollback.
- **Why:** a failed migration leaves the server exactly as it was. Because old code runs against the new schema for a moment, migrations must be additive.
- **Accepted:** one `web` container is recreated on each deploy, which means about 10 seconds of errors (measured on Oct 26 with a 1-second probe: the proxy answers 502 while the new container starts). Blue/green deploys are parked until traffic justifies them.

### Every merge gated by CI
**Oct 20.** One workflow with two parallel jobs (front end and back end, about 46 s), actions pinned by commit SHA, a least-privilege token, and a ruleset that requires both checks and a pull request, with no force pushes and no bypass. Dependency audits (`npm audit`, `pip-audit`) fail the build on a known vulnerability.
- **Why:** every deploy is gated by the same tests, and a failing test greys out the merge button (demonstrated with a deliberately failing PR).

## Monitoring, privacy and security

### Alarms from metrics the jobs publish
**Oct 22.** The cron scripts publish a success or failure metric to CloudWatch. Six alarms (failed, stale for 26 hours, EC2 status checks) email through SNS.
- **Why:** there's nothing to install or keep running on the 1 GB server, and it fits the always-free tier ($0). A real alarm fired and emailed within minutes during testing.
- **Turned down:** the CloudWatch agent shipping log files; a third-party heartbeat service.

### Privacy by construction
**Oct 2, Oct 19 and Oct 22.**
- Locations are a city or coordinates rounded to 2 decimals (about 1 km), rounded in the browser before they're sent. The server rounds again, and the access log never contains the query string or the Referer (a test guards it).
- Sentry error reports are scrubbed of query strings, request bodies, place names, questions and IP addresses.
- PostHog is used without its SDK: Phoebe's own `track()` sends five typed, anonymous events, so TypeScript rejects an event that tries to carry a place. Autocapture and session replay are off, and Global Privacy Control is respected.
- Tests fail if any of these leaks.
- **Turned down:** exact coordinates; `posthog-js` locked down by configuration (privacy by configuration instead of by construction).

### Threat model in the repo
**Oct 22.** [docs/security.md](security.md) lists what's worth protecting, realistic attackers, 12 threats with their mitigations, and the risks accepted on purpose (for example no admin lockout and per-worker throttles).
