# Deployment Guide

This guide deploys:

- Frontend on Cloudflare Pages
- A solo option with backend, PostgreSQL/PostGIS, Redis, workers, and Caddy on
  one AWS EC2 instance
- A split option with API, Redis, and realtime polling on one AWS EC2 instance
  and PostgreSQL/PostGIS, migrations, and static GTFS importing on a second
  AWS EC2 instance

Local development still works with the root `docker-compose.yml` defaults.

The solo and split-backend Compose services use `restart: "no"` by default.
In the split database deployment, PostgreSQL and the static importer use
`restart: "always"` so they return automatically when the database host starts.
The one-shot migration service remains `restart: "no"`.

## Domains

Use HTTPS for the browser-to-backend connection.

Recommended:

- Frontend: `https://www.yuyuw.xyz`
- Backend API: `https://api.yuyuw.xyz`

Using the same parent domain for frontend and backend avoids many browser cookie edge cases. Cloudflare Pages' `*.pages.dev` domain also works, but browser third-party-cookie policies can be stricter when API cookies are on a different site.

## AWS Security Groups

For the solo EC2 security group:

- Inbound TCP `80` from the internet for Let's Encrypt HTTP validation
- Inbound TCP `443` from the internet for API HTTPS
- SSH `22` from your IP only
- Do not expose PostgreSQL or Redis publicly

The solo compose file does not publish PostgreSQL or Redis ports. They are
reachable only by other services on the Docker network.

For the split deployment, database EC2 security group:

- Inbound TCP `5432` from the backend EC2 private IP or backend security group
  only
- SSH `22` from your IP only
- No public `5432` access

For the split deployment, backend EC2 security group:

- Inbound TCP `80` from the internet for Let's Encrypt HTTP validation
- Inbound TCP `443` from the internet for API HTTPS
- SSH `22` from your IP only
- Do not expose Redis publicly

## Solo EC2

Install Docker and the Docker Compose plugin.

Point DNS `api.yuyuw.xyz` to the backend EC2 public IP.

Copy the repo to the backend EC2, then create the backend env file:

```bash
cd AT_Pub_Note/deploy/solo
cp .env.solo.example .env
```

Edit `.env`:

```bash
BACKEND_DOMAIN=api.yuyuw.xyz
ACME_EMAIL=<admin-email>
POSTGRES_DB=at_pub_note
POSTGRES_USER=at
POSTGRES_PASSWORD=<strong-db-password>
DATABASE_URL=postgresql://at:<strong-db-password>@postgres:5432/at_pub_note
FRONTEND_ORIGINS=https://www.yuyuw.xyz
JWT_SECRET_KEY=<long-random-secret>
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=none
WEB_CONCURRENCY=2
AT_API_KEY=<your-at-api-key>
```

If frontend and API are same-site subdomains, for example `app.example.com` and `api.example.com`, `SESSION_COOKIE_SAMESITE=lax` is also acceptable. If using `*.pages.dev` to call `api.example.com`, keep `SESSION_COOKIE_SAMESITE=none`.

The solo compose builds a local `at-pub-note-postgis:16` image from the
official multi-architecture `postgres:16-bookworm` base and installs PostGIS
packages inside it. This is intentional for AWS Graviton instances such as
`t4g.small`: the upstream `postgis/postgis:16-3.4` image may resolve to
`linux/amd64`, which causes this error on ARM64 hosts:

```text
image with reference docker.io/postgis/postgis:16-3.4 was found but does not match the specified platform: wanted linux/arm64, actual: linux/amd64
```

Start all backend-side services, including PostGIS and Redis:

```bash
docker compose -f docker-compose.solo.yml up -d --build
```

Check status and logs:

```bash
docker compose -f docker-compose.solo.yml ps
docker compose -f docker-compose.solo.yml logs -f backend realtime-worker static-worker caddy postgres
```

Test the backend:

```bash
curl https://api.yuyuw.xyz/api/static/v1/feed
```

The first static import can take time because the worker imports the GTFS zip into PostGIS.

## Split EC2

Clone the repository on both instances. The database instance builds the
static GTFS importer from the backend source, so it needs the full checkout.

On the database EC2, create `.env` next to `docker-compose.db.yml`, set the
database password consistently in `POSTGRES_PASSWORD` and `DATABASE_URL`, and
set the static-feed configuration (`GTFS_STATIC_URL` and `AT_API_KEY`). Then
start PostgreSQL, migrations, and the static importer:

```bash
cd AT_Pub_Note/deploy/db
cp .env.db.example .env
docker compose -f docker-compose.db.yml up -d --build
```

The static importer runs beside PostGIS and writes directly to the local
database. It does not run on the API instance.

On the backend EC2, use the existing split backend deployment files:

```text
deploy/backend/Caddyfile
deploy/backend/docker-compose.backend.yml
deploy/backend/.env.backend.example
```

Create `.env` next to `docker-compose.backend.yml`, then set `DATABASE_URL` to
the database EC2 private address:

```text
DATABASE_URL=postgresql://at:<db-password>@<db-private-ip>:5432/at_pub_note
```

Start the split backend services:

```bash
cd AT_Pub_Note/deploy/backend
cp .env.backend.example .env
docker compose -f docker-compose.backend.yml up -d --build
```

The split backend compose runs the API, Redis, Caddy, and realtime worker. It
does not run migrations or the static GTFS importer.

### On-demand split database

The split backend can start and stop its database instance based on real user
activity. This mode does not apply to the solo deployment. The common power
controller loads its infrastructure implementation from a configurable class,
keeping provider operations outside the controller.

Set the following in `deploy/backend/.env`:

```text
DATABASE_POWER_CONTROL_ENABLED=true
DATABASE_POWER_BACKEND_CLASS=app.services.ec2_database_power:EC2DatabasePowerBackend
DATABASE_POWER_INSTANCE_ID=i-replace-with-database-instance-id
AWS_REGION=ap-southeast-6
DATABASE_IDLE_SECONDS=2700
DATABASE_MIN_UP_SECONDS=900
DATABASE_POWER_CHECK_SECONDS=15
DATABASE_POWER_RETRY_AFTER_SECONDS=5
```

`backend/app/services/ec2_database_power.py` contains the EC2-specific backend.
It uses the standard boto3 credential chain, so no access key is stored in the
Compose environment. Attach an IAM role to the backend host with a policy such
as the following. `DescribeInstances` requires a wildcard resource, while the
mutating actions are restricted to the configured database instance:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances"],
      "Resource": "arn:aws:ec2:<region>:<account-id>:instance/<database-instance-id>"
    }
  ]
}
```

When the backend runs in a container, ensure the host's instance metadata is
reachable from containers. Keep `DATABASE_URL` pointed at the database host's
stable private address or private DNS record.

Before enabling power control, run the database Compose deployment at least
once so the containers exist with their restart policies and migrations have
completed:

```bash
cd AT_Pub_Note/deploy/db
docker compose -f docker-compose.db.yml up -d --build
```

PostgreSQL and `static-worker` then restart with Docker whenever the host starts.
The backend pauses realtime polling while the database is asleep. A browser
receiving `database_starting` waits and retries for up to five minutes.

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

Restart backend after changing origins.

Solo:

```bash
docker compose -f docker-compose.solo.yml up -d backend
```

Split:

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

Solo EC2:

```bash
git pull
cd deploy/solo
docker compose -f docker-compose.solo.yml up -d --build
```

Split backend EC2:

```bash
git pull
cd deploy/backend
docker compose -f docker-compose.backend.yml up -d --build
```

Cloudflare Pages:

- Push frontend changes to the connected branch, or trigger a redeploy in Cloudflare.

Database and static GTFS:

- For solo deployments, schema migrations and static GTFS importing run with
  the solo compose stack.
- For split deployments, both run with the database compose stack.
- Usually no redeploy is required unless changing database infrastructure.
- If a separate database EC2 image definition changes, rebuild it on the
  database EC2:

```bash
cd AT_Pub_Note/deploy/db
docker compose -f docker-compose.db.yml up -d --build
```
