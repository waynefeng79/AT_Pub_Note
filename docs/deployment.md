# Deployment Guide

This guide deploys:

- Frontend on Cloudflare Pages
- Backend, realtime worker, static worker, Redis, and HTTPS reverse proxy on one AWS EC2 instance
- PostgreSQL/PostGIS on a second AWS EC2 instance

Local development still works with the root `docker-compose.yml` defaults.

## Domains

Use HTTPS for the browser-to-backend connection.

Recommended:

- Frontend: `https://www.yuyuw.xyz`
- Backend API: `https://api.yuyuw.xyz`

Using the same parent domain for frontend and backend avoids many browser cookie edge cases. Cloudflare Pages' `*.pages.dev` domain also works, but browser third-party-cookie policies can be stricter when API cookies are on a different site.

## AWS Security Groups

Database EC2 security group:

- Inbound TCP `5432` from the backend EC2 private IP or backend security group only
- SSH `22` from your IP only
- No public `5432` access

Backend EC2 security group:

- Inbound TCP `80` from the internet for Let's Encrypt HTTP validation
- Inbound TCP `443` from the internet for API HTTPS
- SSH `22` from your IP only
- Do not expose Redis publicly

## Database EC2

Install Docker and Docker Compose plugin.

Copy these files to the database EC2:

```text
deploy/db/Dockerfile.postgis
deploy/db/docker-compose.db.yml
deploy/db/.env.db.example
```

Create `.env` next to `docker-compose.db.yml`:

```bash
cp .env.db.example .env
```

Edit `.env` and set a strong `POSTGRES_PASSWORD`.

The database compose builds a local `at-pub-note-postgis:16` image from the
official multi-architecture `postgres:16-bookworm` base and installs PostGIS
packages inside it. This is intentional for AWS Graviton instances such as
`t4g.small`: the upstream `postgis/postgis:16-3.4` image may resolve to
`linux/amd64`, which causes this error on ARM64 hosts:

```text
image with reference docker.io/postgis/postgis:16-3.4 was found but does not match the specified platform: wanted linux/arm64, actual: linux/amd64
```

Start the database:

```bash
docker compose -f docker-compose.db.yml up -d --build
```

Check health:

```bash
docker compose -f docker-compose.db.yml ps
```

## Backend EC2

Point DNS `api.yuyuw.xyz` to the backend EC2 public IP.

Copy the repo to the backend EC2, then create the backend env file:

```bash
cd AT_Pub_Note/deploy/backend
cp .env.backend.example .env
```

Edit `.env`:

```bash
BACKEND_DOMAIN=api.yuyuw.xyz
ACME_EMAIL=<admin-email>
DATABASE_URL=postgresql://at:<db-password>@<db-private-ip>:5432/at_pub_note
FRONTEND_ORIGINS=https://www.yuyuw.xyz
JWT_SECRET_KEY=<long-random-secret>
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=none
AT_API_KEY=<your-at-api-key>
```

If frontend and API are same-site subdomains, for example `app.example.com` and `api.example.com`, `SESSION_COOKIE_SAMESITE=lax` is also acceptable. If using `*.pages.dev` to call `api.example.com`, keep `SESSION_COOKIE_SAMESITE=none`.

Start backend services:

```bash
docker compose -f docker-compose.backend.yml up -d --build
```

Check status and logs:

```bash
docker compose -f docker-compose.backend.yml ps
docker compose -f docker-compose.backend.yml logs -f backend realtime-worker static-worker caddy
```

Test the backend:

```bash
curl https://api.yuyuw.xyz/api/static/v1/feed
```

The first static import can take time because the worker imports the GTFS zip into PostGIS.

## Cloudflare Pages Frontend

Create a Cloudflare Pages project from the repo.

Build settings:

```text
Root directory: frontend
Build command: npm ci && npm run build
Build output directory: dist
```

Environment variables:

```text
VITE_API_BASE_URL=https://api.yuyuw.xyz
VITE_MAP_STYLE_URL=
```

Deploy. Then add the resulting Cloudflare Pages origin or custom domain to backend `FRONTEND_ORIGINS`, for example:

```text
FRONTEND_ORIGINS=https://www.yuyuw.xyz,https://yuyuw.xyz
```

Restart backend after changing origins:

```bash
docker compose -f docker-compose.backend.yml up -d backend
```

Configure Cloudflare cache rules after the Pages deployment is live. The short
version is:

- Cache frontend hashed assets for a long time.
- Keep `index.html` and app shell responses revalidatable so new deployments appear quickly.
- Cache only public static GTFS API `GET` responses under `/api/static/*`.
- Bypass auth, app, discovery, timetable, realtime, and SSE endpoints.

See [Cloudflare Cache Rules](cloudflare-cache.md) for the concrete dashboard
rules and optional Pages `_headers` configuration.

## Local Development

Local usage remains:

```bash
docker compose up -d --build
```

The root compose file defaults to:

- Backend: `http://localhost:8000`
- Frontend: `http://localhost:8080`
- Postgres service: `postgres`
- Redis service: `redis`
- Cookie `SameSite=lax`
- Cookie `Secure=false`

For local Vite development:

```bash
cd frontend
npm run dev
```

Keep `VITE_API_BASE_URL` empty when the frontend is served behind the local nginx proxy, or set it to `http://localhost:8000` when running Vite directly.

## Updating Production

Backend EC2:

```bash
git pull
cd deploy/backend
docker compose -f docker-compose.backend.yml up -d --build
```

Cloudflare Pages:

- Push frontend changes to the connected branch, or trigger a redeploy in Cloudflare.

Database EC2:

- Usually no redeploy is required unless changing database infrastructure.
- If the database image definition changes, rebuild it on the database EC2:

```bash
cd AT_Pub_Note/deploy/db
docker compose -f docker-compose.db.yml up -d --build
```
