"""Create the initial application and GTFS schema.

Revision ID: 20260725_0001
Revises:
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260725_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_favourite_routes (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, route_id)
);

CREATE TABLE IF NOT EXISTS gtfs_feed_versions (
    feed_version TEXT PRIMARY KEY,
    source_url TEXT,
    sha256 TEXT NOT NULL,
    etag TEXT,
    last_modified TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active BOOLEAN NOT NULL DEFAULT false,
    counts JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_feed
    ON gtfs_feed_versions (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS routes (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    agency_id TEXT,
    route_short_name TEXT,
    route_long_name TEXT,
    route_desc TEXT,
    route_type INTEGER NOT NULL,
    route_url TEXT,
    route_color TEXT,
    route_text_color TEXT,
    route_sort_order INTEGER,
    contract_id TEXT,
    PRIMARY KEY (feed_version, route_id)
);

CREATE INDEX IF NOT EXISTS idx_routes_search ON routes
    USING gin (to_tsvector('simple', coalesce(route_short_name, '') || ' ' || coalesce(route_long_name, '')));
CREATE INDEX IF NOT EXISTS idx_routes_type ON routes(feed_version, route_type);

CREATE TABLE IF NOT EXISTS stops (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    stop_id TEXT NOT NULL,
    stop_code TEXT,
    stop_name TEXT,
    stop_desc TEXT,
    stop_lat DOUBLE PRECISION NOT NULL,
    stop_lon DOUBLE PRECISION NOT NULL,
    zone_id TEXT,
    location_type INTEGER DEFAULT 0,
    parent_station TEXT,
    platform_code TEXT,
    wheelchair_boarding INTEGER DEFAULT 0,
    geom GEOGRAPHY(Point, 4326) NOT NULL,
    PRIMARY KEY (feed_version, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_stops_geom ON stops USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(feed_version, parent_station);

CREATE TABLE IF NOT EXISTS trips (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    service_id TEXT,
    trip_id TEXT NOT NULL,
    trip_headsign TEXT,
    direction_id INTEGER,
    block_id TEXT,
    shape_id TEXT,
    wheelchair_accessible INTEGER,
    bikes_allowed INTEGER,
    PRIMARY KEY (feed_version, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(feed_version, route_id);
CREATE INDEX IF NOT EXISTS idx_trips_shape ON trips(feed_version, shape_id);
CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(feed_version, service_id, trip_id);

CREATE TABLE IF NOT EXISTS stop_times (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    trip_id TEXT NOT NULL,
    arrival_time TEXT,
    departure_time TEXT,
    arrival_seconds INTEGER,
    departure_seconds INTEGER,
    stop_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    pickup_type INTEGER,
    drop_off_type INTEGER,
    PRIMARY KEY (feed_version, trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop
    ON stop_times(feed_version, stop_id, departure_seconds);
CREATE INDEX IF NOT EXISTS idx_stop_times_trip
    ON stop_times(feed_version, trip_id, stop_sequence);

CREATE TABLE IF NOT EXISTS shape_points (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    shape_id TEXT NOT NULL,
    shape_pt_lat DOUBLE PRECISION NOT NULL,
    shape_pt_lon DOUBLE PRECISION NOT NULL,
    shape_pt_sequence INTEGER NOT NULL,
    shape_dist_traveled DOUBLE PRECISION,
    PRIMARY KEY (feed_version, shape_id, shape_pt_sequence)
);

CREATE INDEX IF NOT EXISTS idx_shape_points_shape
    ON shape_points(feed_version, shape_id, shape_pt_sequence);

CREATE TABLE IF NOT EXISTS shapes (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    shape_id TEXT NOT NULL,
    point_count INTEGER NOT NULL,
    geom GEOGRAPHY(LineString, 4326) NOT NULL,
    PRIMARY KEY (feed_version, shape_id)
);

CREATE INDEX IF NOT EXISTS idx_shapes_geom ON shapes USING gist (geom);

CREATE TABLE IF NOT EXISTS calendar (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    monday INTEGER,
    tuesday INTEGER,
    wednesday INTEGER,
    thursday INTEGER,
    friday INTEGER,
    saturday INTEGER,
    sunday INTEGER,
    start_date TEXT,
    end_date TEXT,
    PRIMARY KEY (feed_version, service_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_service_window
    ON calendar(feed_version, start_date, end_date, service_id);

CREATE TABLE IF NOT EXISTS calendar_dates (
    feed_version TEXT NOT NULL REFERENCES gtfs_feed_versions(feed_version) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    date TEXT NOT NULL,
    exception_type INTEGER,
    PRIMARY KEY (feed_version, service_id, date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_dates_date_exception
    ON calendar_dates(feed_version, date, exception_type, service_id);
"""


def upgrade() -> None:
    # IF NOT EXISTS makes this baseline safe for databases created by the
    # pre-Alembic runtime initializer.
    op.execute(SCHEMA_SQL)


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS calendar_dates CASCADE;
        DROP TABLE IF EXISTS calendar CASCADE;
        DROP TABLE IF EXISTS shapes CASCADE;
        DROP TABLE IF EXISTS shape_points CASCADE;
        DROP TABLE IF EXISTS stop_times CASCADE;
        DROP TABLE IF EXISTS trips CASCADE;
        DROP TABLE IF EXISTS stops CASCADE;
        DROP TABLE IF EXISTS routes CASCADE;
        DROP TABLE IF EXISTS gtfs_feed_versions CASCADE;
        DROP TABLE IF EXISTS user_favourite_routes CASCADE;
        DROP TABLE IF EXISTS users CASCADE;
        """
    )
