# Phoebe

Satellite skywatching app: live 3D globe of active satellites, visible-pass predictions with cloud forecasts, and an AI assistant. Next.js, Django, PostgreSQL, AWS.

> Work in progress. Screenshots, an architecture diagram and the key design decisions come later. Server operations (deploy, scheduled jobs, backups, restore) are in [docs/operations.md](docs/operations.md).

## Run the back end locally

**You need:** Git and Docker Desktop (with Docker Compose v2). Python is optional, because everything runs in containers.

1. **Clone and create your settings file.** `.env` holds secrets and is gitignored. Never commit it.
   ```
   git clone <repo-url> phoebe && cd phoebe
   cp .env.example .env
   ```
   In `.env`, replace both `change-me` values (`DJANGO_SECRET_KEY` and `POSTGRES_PASSWORD`) with random strings, for example from `openssl rand -hex 32`. The app refuses to start if a required secret is missing.

2. **Start the stack** (Postgres 18 and Django's development server). Leave this running in its own terminal tab; its logs stream there.
   ```
   docker compose up --build
   ```
   Use `--build` the first time and after `requirements.txt` or the `Dockerfile` changes; otherwise plain `docker compose up`.

3. **Create the tables and an admin login** (in a second tab):
   ```
   docker compose exec web python manage.py migrate
   docker compose exec web python manage.py createsuperuser
   ```

4. **Load satellite data** from CelesTrak's active-satellites feed:
   ```
   docker compose exec web python manage.py ingest_satellites
   ```
   CelesTrak asks for no more than a few downloads a day. For repeated local runs, keep a saved copy of the feed (OMM JSON) in `data/` (gitignored) and load that instead:
   ```
   docker compose exec web python manage.py ingest_satellites --file data/active.json
   ```

5. **Try it:**
   - Admin: http://127.0.0.1:8000/admin/
   - Search: http://127.0.0.1:8000/api/satellites/?search=ISS
   - Detail: http://127.0.0.1:8000/api/satellites/25544/
   - Current position: http://127.0.0.1:8000/api/satellites/25544/position/
   - Upcoming passes over a place (rise, peak and set above 10°, plus whether each pass is visible: satellite sunlit and Sun below −6°, with when it appears, its highest visible point and when it disappears, or why not; `lat` and `lon` required and rounded to 2 decimals, `days` 1–7, default 7): http://127.0.0.1:8000/api/satellites/25544/passes/?lat=30.27&lon=-97.74&days=7
   - Globe data (newest orbital elements for every current satellite, one unpaginated list): http://127.0.0.1:8000/api/satellites/elements/

   The API is read-only and rate limited (60 requests a minute per client), locally too.

## Run the front end locally

**You need:** Node 24 (the version is pinned in `frontend/.nvmrc`; with nvm, run `nvm use` in `frontend/`).

```
cd frontend
nvm use
npm ci
npm run dev
```

The app runs at http://localhost:3000. Other commands: `npm run build` (static export into `frontend/out/`), `npm run lint`.

The front end is a Next.js static export: `next build` writes plain HTML, CSS and JavaScript, and no Next.js server runs in production. Everything dynamic comes from the Django API, called from the browser.

## Tests

```
docker compose exec web pytest -v
```

pytest-django creates a separate test database for each run, so tests never touch your local data. A `No directory at: /app/staticfiles/` warning is expected locally and harmless (the dev bind mount hides the image's collected static files).

## Notes

- Never run `docker compose down -v`: `-v` deletes the database volume.
- If `docker compose exec` says `service "web" is not running`, start the stack first (step 2).
- The production server uses `compose.prod.yaml` (Caddy, Gunicorn, Postgres), not `compose.yaml`. See [docs/operations.md](docs/operations.md).
- The front end is hosted on AWS Amplify; see [docs/operations.md](docs/operations.md#front-end-hosting-aws-amplify).

## Data sources

Orbital data from [CelesTrak](https://celestrak.org/).
