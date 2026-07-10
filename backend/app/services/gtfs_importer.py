import csv
import hashlib
import io
import json
import zipfile
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any, TypeAlias

from psycopg import sql as psql
from psycopg.abc import Query
from psycopg.rows import DictRow

from app.core.config import Settings
from app.db.session import DbConnection
from app.services.http import download_bytes, download_bytes_if_modified
from app.utils.time import seconds_from_gtfs_time

REQUIRED_GTFS_FILES = {"routes.txt", "stops.txt", "trips.txt", "stop_times.txt", "shapes.txt"}
STATIC_IMPORT_LOCK_KEY = 6_284_701_001

RowParams: TypeAlias = tuple[Any, ...]


def _rows(zip_file: zipfile.ZipFile, name: str) -> Iterable[dict[str, str]]:
    with zip_file.open(name) as raw:
        wrapper = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(wrapper)


def _int(value: str | None) -> int | None:
    return int(value) if value not in (None, "") else None


def _float(value: str | None) -> float | None:
    return float(value) if value not in (None, "") else None


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _feed_version(imported_at: datetime, sha: str) -> str:
    return f"{imported_at.strftime('%Y-%m-%dT%H%M%SZ')}-{sha[:8]}"


class StaticImportAlreadyRunning(RuntimeError):
    pass


class GtfsImporter:
    def __init__(self, settings: Settings):
        self.settings = settings

    def load_zip_bytes(self, etag: str | None = None, last_modified: str | None = None) -> tuple[bytes | None, str | None, str | None, str | None]:
        if self.settings.gtfs_static_url:
            if etag or last_modified:
                data, headers = download_bytes_if_modified(self.settings.gtfs_static_url, self.settings, etag, last_modified)
            else:
                data, headers = download_bytes(self.settings.gtfs_static_url, self.settings)
            return data, self.settings.gtfs_static_url, headers.get("etag"), headers.get("last-modified")
        if self.settings.gtfs_static_zip_path:
            path = self.settings.gtfs_static_zip_path
            data = path.read_bytes()
            return data, str(path), None, None
        raise RuntimeError("Set GTFS_STATIC_URL or GTFS_STATIC_ZIP_PATH")

    def import_feed(self, conn: DbConnection) -> str:
        locked = conn.execute("SELECT pg_try_advisory_xact_lock(%s) AS locked", (STATIC_IMPORT_LOCK_KEY,)).fetchone()
        if not locked or not locked["locked"]:
            raise StaticImportAlreadyRunning("Another static GTFS import is already running")

        active_feed = self._active_feed_for_static_url(conn)
        zip_bytes, source_url, etag, last_modified = self.load_zip_bytes(
            active_feed["etag"] if active_feed else None,
            active_feed["last_modified"] if active_feed else None,
        )
        if zip_bytes is None:
            if not active_feed:
                raise RuntimeError("GTFS static feed returned 304 without a cached active feed")
            return active_feed["feed_version"]

        sha = _sha256(zip_bytes)
        imported_at = datetime.now(tz=timezone.utc)
        feed_version = _feed_version(imported_at, sha)

        exists = conn.execute("SELECT 1 FROM gtfs_feed_versions WHERE sha256 = %s", (sha,)).fetchone()
        if exists:
            row = conn.execute("SELECT feed_version FROM gtfs_feed_versions WHERE sha256 = %s ORDER BY imported_at DESC LIMIT 1", (sha,)).fetchone()
            if row is None:
                raise RuntimeError(f"GTFS feed SHA {sha} exists but its feed version could not be loaded")
            existing_feed_version = str(row["feed_version"])
            conn.execute(
                """
                UPDATE gtfs_feed_versions
                SET source_url = COALESCE(%s, source_url),
                    etag = COALESCE(%s, etag),
                    last_modified = COALESCE(%s, last_modified)
                WHERE feed_version = %s
                """,
                (source_url, etag, last_modified, existing_feed_version),
            )
            self._activate_feed(conn, existing_feed_version)
            return existing_feed_version

        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            missing = REQUIRED_GTFS_FILES.difference(set(zf.namelist()))
            if missing:
                raise RuntimeError(f"GTFS zip missing required files: {', '.join(sorted(missing))}")

            conn.execute(
                """
                INSERT INTO gtfs_feed_versions(feed_version, source_url, sha256, etag, last_modified, imported_at, is_active, counts)
                VALUES (%s, %s, %s, %s, %s, %s, false, '{}'::jsonb)
                """,
                (feed_version, source_url, sha, etag, last_modified, imported_at),
            )

            self._import_routes(conn, zf, feed_version)
            self._import_stops(conn, zf, feed_version)
            self._import_trips(conn, zf, feed_version)
            self._import_stop_times(conn, zf, feed_version)
            self._import_shape_points(conn, zf, feed_version)
            self._import_optional_calendar(conn, zf, feed_version)
            self._build_shapes(conn, feed_version)
            self._analyze_imported_tables(conn)
            self._validate_feed(conn, feed_version)

            counts = {
                "routes": self._count(conn, "routes", feed_version),
                "stops": self._count(conn, "stops", feed_version),
                "trips": self._count(conn, "trips", feed_version),
                "shapes": self._count(conn, "shapes", feed_version),
                "stop_times": self._count(conn, "stop_times", feed_version),
            }
            conn.execute("UPDATE gtfs_feed_versions SET counts = %s WHERE feed_version = %s", (json.dumps(counts), feed_version))
            self._activate_feed(conn, feed_version)
        return feed_version

    def _active_feed_for_static_url(self, conn: DbConnection) -> DictRow | None:
        if not self.settings.gtfs_static_url:
            return None
        row = conn.execute(
            """
            SELECT feed_version, etag, last_modified
            FROM gtfs_feed_versions
            WHERE is_active = true AND source_url = %s
            """,
            (self.settings.gtfs_static_url,),
        ).fetchone()
        return row

    def _executemany(self, conn: DbConnection, query: Query, params: list[RowParams]) -> None:
        if not params:
            return
        with conn.cursor() as cur:
            cur.executemany(query, params)

    def _copy_rows(self, conn: DbConnection, query: Query, rows: Iterable[RowParams]) -> None:
        with conn.cursor() as cur:
            with cur.copy(query) as copy:
                for row in rows:
                    copy.write_row(row)

    def _count(self, conn: DbConnection, table: str, feed_version: str) -> int:
        query = psql.SQL("SELECT count(*) AS count FROM {} WHERE feed_version = %s").format(psql.Identifier(table))
        row = conn.execute(query, (feed_version,)).fetchone()
        if row is None:
            raise RuntimeError(f"Could not count imported GTFS table {table}")
        return int(row["count"])

    def _analyze_imported_tables(self, conn: DbConnection) -> None:
        for table in ("routes", "stops", "trips", "stop_times", "shape_points", "shapes", "calendar", "calendar_dates"):
            conn.execute(psql.SQL("ANALYZE {}").format(psql.Identifier(table)))

    def _activate_feed(self, conn: DbConnection, feed_version: str) -> None:
        conn.execute("UPDATE gtfs_feed_versions SET is_active = false WHERE is_active = true")
        conn.execute("UPDATE gtfs_feed_versions SET is_active = true WHERE feed_version = %s", (feed_version,))
        self._delete_old_inactive_feeds(conn)

    def _delete_old_inactive_feeds(self, conn: DbConnection) -> None:
        retain_count = max(0, self.settings.gtfs_retain_inactive_feeds)
        conn.execute(
            """
            DELETE FROM gtfs_feed_versions
            WHERE feed_version IN (
                SELECT feed_version
                FROM gtfs_feed_versions
                WHERE is_active = false
                ORDER BY imported_at DESC, feed_version DESC
                OFFSET %s
            )
            """,
            (retain_count,),
        )

    def _validate_feed(self, conn: DbConnection, feed_version: str) -> None:
        checks: dict[str, Query] = {
            "trips_missing_routes": """
                SELECT count(*) AS count
                FROM trips t
                LEFT JOIN routes r ON r.feed_version = t.feed_version AND r.route_id = t.route_id
                WHERE t.feed_version = %s AND r.route_id IS NULL
            """,
            "trips_missing_services": """
                SELECT count(*) AS count
                FROM trips t
                WHERE t.feed_version = %s
                  AND t.service_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM calendar c
                      WHERE c.feed_version = t.feed_version AND c.service_id = t.service_id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM calendar_dates cd
                      WHERE cd.feed_version = t.feed_version AND cd.service_id = t.service_id
                  )
            """,
            "trips_missing_shapes": """
                SELECT count(*) AS count
                FROM trips t
                LEFT JOIN shapes s
                  ON s.feed_version = t.feed_version
                 AND s.shape_id = t.shape_id
                WHERE t.feed_version = %s
                  AND t.shape_id IS NOT NULL
                  AND s.shape_id IS NULL
            """,
            "stop_times_missing_trips": """
                SELECT count(*) AS count
                FROM stop_times st
                LEFT JOIN trips t ON t.feed_version = st.feed_version AND t.trip_id = st.trip_id
                WHERE st.feed_version = %s AND t.trip_id IS NULL
            """,
            "stop_times_missing_stops": """
                SELECT count(*) AS count
                FROM stop_times st
                LEFT JOIN stops s ON s.feed_version = st.feed_version AND s.stop_id = st.stop_id
                WHERE st.feed_version = %s AND s.stop_id IS NULL
            """,
        }
        failures = []
        for name, query in checks.items():
            row = conn.execute(query, (feed_version,)).fetchone()
            if row is None:
                raise RuntimeError(f"GTFS validation query returned no result for {name}")
            count = int(row["count"])
            if count:
                failures.append(f"{name}={count}")
        if failures:
            raise RuntimeError(f"GTFS feed validation failed: {', '.join(failures)}")

    def _import_routes(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        self._executemany(
            conn,
            """
            INSERT INTO routes(feed_version, route_id, agency_id, route_short_name, route_long_name, route_desc, route_type,
                               route_url, route_color, route_text_color, route_sort_order, contract_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            [
                (
                    feed_version,
                    row["route_id"],
                    row.get("agency_id"),
                    row.get("route_short_name"),
                    row.get("route_long_name"),
                    row.get("route_desc"),
                    _int(row.get("route_type")) or 0,
                    row.get("route_url"),
                    row.get("route_color") or None,
                    row.get("route_text_color") or None,
                    _int(row.get("route_sort_order")),
                    row.get("contract_id"),
                )
                for row in _rows(zf, "routes.txt")
            ],
        )

    def _import_stops(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        conn.execute("DROP TABLE IF EXISTS tmp_gtfs_stops_import")
        conn.execute(
            """
            CREATE TEMP TABLE tmp_gtfs_stops_import (
                feed_version TEXT NOT NULL,
                stop_id TEXT NOT NULL,
                stop_code TEXT,
                stop_name TEXT,
                stop_desc TEXT,
                stop_lat DOUBLE PRECISION NOT NULL,
                stop_lon DOUBLE PRECISION NOT NULL,
                zone_id TEXT,
                location_type INTEGER,
                parent_station TEXT,
                platform_code TEXT,
                wheelchair_boarding INTEGER
            ) ON COMMIT DROP
            """,
        )
        self._copy_rows(
            conn,
            """
            COPY tmp_gtfs_stops_import (
                feed_version, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon, zone_id,
                location_type, parent_station, platform_code, wheelchair_boarding
            ) FROM STDIN
            """,
            (
                (
                    feed_version,
                    row["stop_id"],
                    row.get("stop_code"),
                    row.get("stop_name"),
                    row.get("stop_desc"),
                    float(row["stop_lat"]),
                    float(row["stop_lon"]),
                    row.get("zone_id"),
                    _int(row.get("location_type")) or 0,
                    row.get("parent_station") or None,
                    row.get("platform_code") or None,
                    _int(row.get("wheelchair_boarding")) or 0,
                )
                for row in _rows(zf, "stops.txt")
            ),
        )
        conn.execute(
            """
            INSERT INTO stops(feed_version, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon, zone_id,
                              location_type, parent_station, platform_code, wheelchair_boarding, geom)
            SELECT feed_version, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon, zone_id,
                   location_type, parent_station, platform_code, wheelchair_boarding,
                   ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326)::geography
            FROM tmp_gtfs_stops_import
            """
        )

    def _import_trips(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        self._copy_rows(
            conn,
            """
            COPY trips (
                feed_version, route_id, service_id, trip_id, trip_headsign, direction_id, block_id,
                shape_id, wheelchair_accessible, bikes_allowed
            ) FROM STDIN
            """,
            (
                (
                    feed_version,
                    row["route_id"],
                    row.get("service_id"),
                    row["trip_id"],
                    row.get("trip_headsign"),
                    _int(row.get("direction_id")),
                    row.get("block_id"),
                    row.get("shape_id") or None,
                    _int(row.get("wheelchair_accessible")),
                    _int(row.get("bikes_allowed")),
                )
                for row in _rows(zf, "trips.txt")
            ),
        )

    def _import_stop_times(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        def rows() -> Iterable[RowParams]:
            for row in _rows(zf, "stop_times.txt"):
                arrival = row.get("arrival_time") or None
                departure = row.get("departure_time") or arrival
                yield (
                    feed_version,
                    row["trip_id"],
                    arrival,
                    departure,
                    seconds_from_gtfs_time(arrival, 0) if arrival else None,
                    seconds_from_gtfs_time(departure, 0) if departure else None,
                    row["stop_id"],
                    int(row["stop_sequence"]),
                    _int(row.get("pickup_type")),
                    _int(row.get("drop_off_type")),
                )

        self._copy_rows(
            conn,
            """
            COPY stop_times (
                feed_version, trip_id, arrival_time, departure_time, arrival_seconds, departure_seconds,
                stop_id, stop_sequence, pickup_type, drop_off_type
            ) FROM STDIN
            """,
            rows(),
        )

    def _import_shape_points(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        self._copy_rows(
            conn,
            """
            COPY shape_points (
                feed_version, shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled
            ) FROM STDIN
            """,
            (
                (
                    feed_version,
                    row["shape_id"],
                    float(row["shape_pt_lat"]),
                    float(row["shape_pt_lon"]),
                    int(row["shape_pt_sequence"]),
                    _float(row.get("shape_dist_traveled")),
                )
                for row in _rows(zf, "shapes.txt")
            ),
        )

    def _build_shapes(self, conn: DbConnection, feed_version: str) -> None:
        conn.execute(
            """
            INSERT INTO shapes(feed_version, shape_id, point_count, geom)
            SELECT feed_version, shape_id, count(*)::int,
                   ST_MakeLine(ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326) ORDER BY shape_pt_sequence)::geography
            FROM shape_points
            WHERE feed_version = %s
            GROUP BY feed_version, shape_id
            HAVING count(*) >= 2
            """,
            (feed_version,),
        )

    def _import_optional_calendar(self, conn: DbConnection, zf: zipfile.ZipFile, feed_version: str) -> None:
        if "calendar.txt" in zf.namelist():
            self._executemany(
                conn,
                """
                INSERT INTO calendar(feed_version, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    (
                        feed_version,
                        row["service_id"],
                        _int(row.get("monday")),
                        _int(row.get("tuesday")),
                        _int(row.get("wednesday")),
                        _int(row.get("thursday")),
                        _int(row.get("friday")),
                        _int(row.get("saturday")),
                        _int(row.get("sunday")),
                        row.get("start_date"),
                        row.get("end_date"),
                    )
                    for row in _rows(zf, "calendar.txt")
                ],
            )
        if "calendar_dates.txt" in zf.namelist():
            self._executemany(
                conn,
                "INSERT INTO calendar_dates(feed_version, service_id, date, exception_type) VALUES (%s,%s,%s,%s)",
                [(feed_version, row["service_id"], row["date"], _int(row.get("exception_type"))) for row in _rows(zf, "calendar_dates.txt")],
            )
