# Auckland Transport Public Note

Full-stack Auckland public transport web app built from the project specification in `docs/project_spec.md`.

The implementation keeps the API contract split from the spec:

- public, cacheable static GTFS endpoints under `/api/static/v1`
- authenticated discovery, timetable, realtime, and app preference endpoints
- JWT bearer auth with PBKDF2 password hashing
- PostgreSQL/PostGIS stores imported static GTFS routes, stops, trips, stop times, and shapes
- Redis stores realtime vehicle, trip update, alert snapshots, pub/sub events, and privacy-safe spatial cache entries
- Alembic owns database schema migrations through the Docker migration target
- static GTFS imports download `GTFS_STATIC_URL` or use `GTFS_STATIC_ZIP_PATH`
- realtime polling downloads `GTFS_REALTIME_URL` or uses `REALTIME_RAW_PATH`
- realtime input can be JSON or GTFS-RT protobuf (`REALTIME_FEED_FORMAT=auto|json|protobuf`)
- React + Vite + TypeScript frontend with MapLibre route display

## Quick Start

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Start infrastructure:

```bash
docker compose up -d postgres redis
```

Apply database migrations:

```bash
docker compose run --rm migrate
```

Import static GTFS into PostGIS:

```bash
python -m app.workers.static_import
```

Load one realtime snapshot into Redis:

```bash
python -m app.workers.realtime_poll
```

Run the API:

```bash
uvicorn app.main:app --reload --port 8000
```

Full stack with background workers:

```bash
docker compose up --build
```

The backend container runs `WEB_CONCURRENCY` Uvicorn workers, defaulting to `2`.
For a 2 vCPU EC2 instance, start with `WEB_CONCURRENCY=2`; reduce to `1` if
memory is tight or increase only after checking database pool pressure.

The full stack starts the one-shot `migrate` service first. API and worker
containers wait for it to complete, so runtime code does not create or alter
tables during request handling or polling loops.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend expects the backend at `http://localhost:8000` unless `VITE_API_BASE_URL` is set.

## Realtime Feed Format

The backend accepts either the Auckland JSON wrapper used by `data/RealTimeRaw.json` or a binary GTFS-RT protobuf `FeedMessage`.

Set:

```bash
GTFS_REALTIME_URL=https://api.at.govt.nz/realtime/legacy/
REALTIME_FEED_FORMAT=protobuf
```

`REALTIME_FEED_FORMAT=auto` treats `.pb`, `.pbf`, `.bin`, and `.gtfsrt` files as protobuf and other files as JSON.

## Static Feed Updates

Set `GTFS_STATIC_URL` to a remote `gtfs.zip` URL. The static worker downloads the zip, validates required GTFS files, imports the feed into PostgreSQL/PostGIS in a transaction, builds line geometries in `shapes`, and marks the feed active only after the import succeeds.

```bash
GTFS_STATIC_URL=https://gtfs.at.govt.nz/gtfs.zip
python -m app.workers.static_import
```

## Database Migrations

Schema changes are versioned with Alembic under `backend/migrations`. The
backend Dockerfile has a dedicated `migration` target that runs:

```bash
alembic upgrade head
```

For local Docker workflows, run migrations explicitly with:

```bash
docker compose run --rm migrate
```

The initial migration is idempotent so it can baseline an existing local
PostGIS volume created before migrations were introduced.

## Useful Endpoints

- `GET /health`
- `GET /ready`
- `GET /api/static/v1/feed`
- `POST /api/auth/v1/register`
- `POST /api/auth/v1/login`
- `GET /api/static/v1/feeds/{feed_version}/routes`
- `GET /api/static/v1/feeds/{feed_version}/routes/{route_id}/shapes`
- `POST /api/discovery/v1/nearby-stops`
- `POST /api/timetable/v1/next-departures`
- `POST /api/realtime/v1/vehicles`

## Testing

```bash
cd backend
pytest
```

```bash
cd frontend
npm run typecheck
```

### Backend Stress Test

The k6 stress test exercises the current authenticated backend workflow:
static GTFS route browsing, realtime snapshots, nearby stops, routes on stops,
next departures, and vehicles for departure trips.

Install k6, then run against local Docker/API:

```bash
k6 run -e USER_EMAIL=you@example.com -e USER_PASSWORD=yourpassword backend/tests/stress.js
```

Run against the deployed backend:

```bash
k6 run -e BASE_URL=https://api.yuyuw.xyz -e USER_EMAIL=you@example.com -e USER_PASSWORD=yourpassword backend/tests/stress.js
```

Useful overrides:

- `USER_TOKEN`: use an existing bearer token instead of email/password login
- `BASE_URL`: backend origin, default `http://localhost:8000`
- `VUS`: virtual users, default `20`
- `ROUTE_ID`, `STOP_ID`: pin the test to known GTFS entities
- `LAT`, `LON`, `RADIUS_M`: nearby stop search location and radius
- `RAMP_UP`, `HOLD`, `RAMP_DOWN`: k6 stage durations

## Data Credits & Licensing

This project utilizes map data, public transport schedules, and real-time feeds from third-party open data providers under their respective licenses.

### Map Data
* **Source:** [OpenStreetMap](https://www.openstreetmap.org/)
* **Copyright Notice:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
* **License:** [Open Database License (ODbL 1.0)](https://opendatacommons.org/licenses/odbl/1-0/)

### Public Transport Data
* **Source:** [Auckland Transport GTFS & GTFS-RT](https://at.govt.nz/about-us/at-data-sources/general-transit-feed-specification)
* **Creator / Attribution Party:** Auckland Transport (AT)
* **Copyright Notice:** © Auckland Transport
* **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)

---

### Disclaimer & Notice
* **Accuracy:** Transport schedule and real-time transit data are provided "as is" without warranty of any kind, express or implied. Auckland Transport does not guarantee the timeliness, accuracy, or completeness of the data.
* **Affiliation:** This project is independently developed and operated. It is not affiliated with, endorsed by, or officially associated with Auckland Transport.
