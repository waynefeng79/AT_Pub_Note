import json
from datetime import date

from psycopg import sql as psql

from app.db.session import DbConnection


def _route(row: dict) -> dict:
    return {
        "route_id": row["route_id"],
        "route_short_name": row.get("route_short_name") or row["route_id"],
        "route_long_name": row.get("route_long_name") or row.get("route_short_name") or row["route_id"],
        "route_type": row["route_type"],
        "route_color": row.get("route_color") or {2: "2E7D32", 3: "0072CE", 4: "008C95"}.get(row["route_type"], "0072CE"),
        "route_text_color": row.get("route_text_color") or "FFFFFF",
        "route_sort_order": row.get("route_sort_order"),
    }


class GtfsRepository:
    def __init__(self, conn: DbConnection):
        self.conn = conn

    def active_feed(self) -> dict | None:
        row = self.conn.execute(
            "SELECT feed_version, source_url, sha256, etag, last_modified, imported_at, counts FROM gtfs_feed_versions WHERE is_active = true"
        ).fetchone()
        return dict(row) if row else None

    def feed_metadata(self, feed_version: str) -> dict | None:
        row = self.conn.execute(
            "SELECT feed_version, source_url, sha256, etag, last_modified, imported_at, counts FROM gtfs_feed_versions WHERE feed_version = %s",
            (feed_version,),
        ).fetchone()
        return dict(row) if row else None

    def route_list(self, feed_version: str, search: str | None, route_types: list[int], limit: int, offset: int) -> dict:
        where = [psql.SQL("feed_version = %s")]
        params: list = [feed_version]
        search_text = search.strip() if search else ""
        if search_text:
            where.append(
                psql.SQL(
                    """
                    to_tsvector('simple', coalesce(route_short_name, '') || ' ' || coalesce(route_long_name, ''))
                    @@ plainto_tsquery('simple', %s)
                    """
                )
            )
            params.append(search_text)
        if route_types:
            where.append(psql.SQL("route_type = ANY(%s)"))
            params.append(route_types)
        where_sql = psql.SQL(" AND ").join(where)
        count_query = psql.SQL("SELECT count(*) AS count FROM routes WHERE {}").format(where_sql)
        total_row = self.conn.execute(count_query, params).fetchone()
        if total_row is None:
            raise RuntimeError("Route count query returned no result")
        total = int(total_row["count"])
        rows = self.conn.execute(
            psql.SQL("""
            SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, route_sort_order
            FROM routes
            WHERE {}
            ORDER BY route_sort_order NULLS LAST, route_short_name, route_id
            LIMIT %s OFFSET %s
            """).format(where_sql),
            [*params, limit, offset],
        ).fetchall()
        return {"items": [_route(dict(row)) for row in rows], "total": total}

    def route_detail(self, feed_version: str, route_id: str) -> dict | None:
        row = self.conn.execute(
            """
            SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, route_sort_order
            FROM routes WHERE feed_version = %s AND route_id = %s
            """,
            (feed_version, route_id),
        ).fetchone()
        if not row:
            return None
        directions = self.conn.execute(
            """
            SELECT direction_id, array_agg(DISTINCT trip_headsign) FILTER (WHERE trip_headsign IS NOT NULL) AS headsigns
            FROM trips
            WHERE feed_version = %s AND route_id = %s
            GROUP BY direction_id
            ORDER BY direction_id
            """,
            (feed_version, route_id),
        ).fetchall()
        return {
            "route": _route(dict(row)),
            "directions": [{"direction_id": item["direction_id"], "headsigns": item["headsigns"] or []} for item in directions],
        }

    def route_shapes(self, feed_version: str, route_id: str, direction_id: int | None) -> list[dict]:
        params: list = [feed_version, route_id]
        direction_sql = psql.SQL("")
        if direction_id is not None:
            direction_sql = psql.SQL("AND t.direction_id = %s")
            params.append(direction_id)
        rows = self.conn.execute(
            psql.SQL("""
            WITH reps AS (
                SELECT DISTINCT ON (t.shape_id)
                    t.shape_id, t.direction_id, t.trip_id, t.trip_headsign
                FROM trips t
                WHERE t.feed_version = %s AND t.route_id = %s AND t.shape_id IS NOT NULL {}
                ORDER BY t.shape_id, t.trip_id
            )
            SELECT r.shape_id, r.direction_id, r.trip_id AS representative_trip_id, r.trip_headsign,
                   s.point_count, ST_AsGeoJSON(s.geom::geometry)::json AS geometry
            FROM reps r
            JOIN shapes s ON s.feed_version = %s AND s.shape_id = r.shape_id
            ORDER BY r.direction_id NULLS FIRST, r.shape_id
            """).format(direction_sql),
            [*params, feed_version],
        ).fetchall()
        return [dict(row) for row in rows]

    def trip_shape(self, feed_version: str, trip_id: str) -> dict | None:
        row = self.conn.execute(
            """
            SELECT t.trip_id, t.route_id, t.direction_id, t.shape_id, ST_AsGeoJSON(s.geom::geometry)::json AS geometry
            FROM trips t
            JOIN shapes s ON s.feed_version = t.feed_version AND s.shape_id = t.shape_id
            WHERE t.feed_version = %s AND t.trip_id = %s
            """,
            (feed_version, trip_id),
        ).fetchone()
        return dict(row) if row else None

    def route_ids_for_trip_ids(self, feed_version: str, trip_ids: list[str]) -> dict[str, str]:
        if not trip_ids:
            return {}
        rows = self.conn.execute(
            """
            SELECT trip_id, route_id
            FROM trips
            WHERE feed_version = %s AND trip_id = ANY(%s)
            """,
            (feed_version, trip_ids),
        ).fetchall()
        return {row["trip_id"]: row["route_id"] for row in rows}

    def stop_detail(self, feed_version: str, stop_id: str) -> dict | None:
        row = self.conn.execute(
            """
            SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon, platform_code, parent_station, wheelchair_boarding
            FROM stops WHERE feed_version = %s AND stop_id = %s
            """,
            (feed_version, stop_id),
        ).fetchone()
        return dict(row) if row else None

    def stops_batch(self, feed_version: str, stop_ids: list[str]) -> list[dict]:
        rows = self.conn.execute(
            """
            SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon, platform_code, parent_station, wheelchair_boarding
            FROM stops WHERE feed_version = %s AND stop_id = ANY(%s)
            ORDER BY stop_name
            """,
            (feed_version, stop_ids),
        ).fetchall()
        return [dict(row) for row in rows]

    def trip_stops(self, feed_version: str, trip_id: str) -> dict | None:
        trip = self.conn.execute(
            "SELECT trip_id, route_id, direction_id, trip_headsign FROM trips WHERE feed_version = %s AND trip_id = %s",
            (feed_version, trip_id),
        ).fetchone()
        if not trip:
            return None
        rows = self.conn.execute(
            """
            SELECT st.stop_id, st.stop_sequence, st.arrival_time, st.departure_time,
                   s.stop_name, s.stop_lat, s.stop_lon, s.platform_code
            FROM stop_times st
            JOIN stops s ON s.feed_version = st.feed_version AND s.stop_id = st.stop_id
            WHERE st.feed_version = %s AND st.trip_id = %s
            ORDER BY st.stop_sequence
            """,
            (feed_version, trip_id),
        ).fetchall()
        return {**dict(trip), "representative_trip_id": trip_id, "stops": [dict(row) for row in rows]}

    def route_stops(self, feed_version: str, route_id: str, direction_id: int | None, trip_id: str | None) -> list[dict]:
        if trip_id:
            item = self.trip_stops(feed_version, trip_id)
            return [item] if item and item["route_id"] == route_id else []
        params: list = [feed_version, route_id]
        direction_sql = psql.SQL("")
        if direction_id is not None:
            direction_sql = psql.SQL("AND t.direction_id = %s")
            params.append(direction_id)
        rows = self.conn.execute(
            psql.SQL("""
            WITH reps AS (
                SELECT DISTINCT ON (t.direction_id)
                    t.trip_id, t.route_id, t.direction_id, t.trip_headsign
                FROM trips t
                WHERE t.feed_version = %s
                  AND t.route_id = %s
                  {}
                  AND EXISTS (
                      SELECT 1
                      FROM stop_times st
                      WHERE st.feed_version = t.feed_version
                        AND st.trip_id = t.trip_id
                  )
                ORDER BY t.direction_id, t.trip_id
            )
            SELECT r.trip_id, r.route_id, r.direction_id, r.trip_headsign,
                   st.stop_id, st.stop_sequence, st.arrival_time, st.departure_time,
                   s.stop_name, s.stop_lat, s.stop_lon, s.platform_code
            FROM reps r
            JOIN stop_times st ON st.feed_version = %s AND st.trip_id = r.trip_id
            JOIN stops s ON s.feed_version = st.feed_version AND s.stop_id = st.stop_id
            ORDER BY r.direction_id NULLS FIRST, r.trip_id, st.stop_sequence
            """).format(direction_sql),
            [*params, feed_version],
        ).fetchall()
        directions: dict[str, dict] = {}
        for row in rows:
            item = dict(row)
            key = item["trip_id"]
            direction = directions.setdefault(
                key,
                {
                    "trip_id": item["trip_id"],
                    "route_id": item["route_id"],
                    "direction_id": item["direction_id"],
                    "trip_headsign": item["trip_headsign"],
                    "representative_trip_id": item["trip_id"],
                    "stops": [],
                },
            )
            direction["stops"].append(
                {
                    "stop_id": item["stop_id"],
                    "stop_sequence": item["stop_sequence"],
                    "arrival_time": item["arrival_time"],
                    "departure_time": item["departure_time"],
                    "stop_name": item["stop_name"],
                    "stop_lat": item["stop_lat"],
                    "stop_lon": item["stop_lon"],
                    "platform_code": item["platform_code"],
                }
            )
        return list(directions.values())

    def nearby_stops(self, feed_version: str, lat: float, lon: float, radius_m: int, limit: int) -> list[dict]:
        rows = self.conn.execute(
            """
            SELECT stop_id, stop_name, stop_lat, stop_lon, platform_code,
                   round(ST_Distance(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography))::int AS distance_m
            FROM stops
            WHERE feed_version = %s
              AND location_type = 0
              AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
            ORDER BY distance_m
            LIMIT %s
            """,
            (lon, lat, feed_version, lon, lat, radius_m, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def nearby_routes(self, feed_version: str, lat: float, lon: float, radius_m: int, limit: int, route_types: list[int]) -> list[dict]:
        route_type_sql = psql.SQL("AND r.route_type = ANY(%s)") if route_types else psql.SQL("")
        params: list = [lon, lat, feed_version, lon, lat, radius_m]
        if route_types:
            params.append(route_types)
        params.append(limit)
        rows = self.conn.execute(
            psql.SQL("""
            WITH nearby AS (
                SELECT stop_id, stop_name,
                       round(ST_Distance(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography))::int AS distance_m
                FROM stops
                WHERE feed_version = %s
                  AND location_type = 0
                  AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
            ),
            ranked AS (
                SELECT DISTINCT ON (r.route_id)
                    r.route_id, r.route_short_name, r.route_long_name, r.route_type,
                    n.stop_id AS nearest_stop_id, n.stop_name AS nearest_stop_name, n.distance_m
                FROM nearby n
                JOIN stop_times st ON st.feed_version = %s AND st.stop_id = n.stop_id
                JOIN trips t ON t.feed_version = st.feed_version AND t.trip_id = st.trip_id
                JOIN routes r ON r.feed_version = t.feed_version AND r.route_id = t.route_id
                WHERE true {}
                ORDER BY r.route_id, n.distance_m
            )
            SELECT * FROM ranked ORDER BY distance_m LIMIT %s
            """).format(route_type_sql),
            [*params[:6], feed_version, *params[6:]],
        ).fetchall()
        return [dict(row) for row in rows]

    def routes_on_stops(self, feed_version: str, stop_ids: list[str]) -> list[dict]:
        rows = self.conn.execute(
            """
            SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, r.route_type
            FROM stop_times st
            JOIN trips t ON t.feed_version = st.feed_version AND t.trip_id = st.trip_id
            JOIN routes r ON r.feed_version = t.feed_version AND r.route_id = t.route_id
            WHERE st.feed_version = %s AND st.stop_id = ANY(%s)
            ORDER BY r.route_short_name, r.route_id
            """,
            (feed_version, stop_ids),
        ).fetchall()
        return [dict(row) for row in rows]

    def departures(
        self,
        feed_version: str,
        stop_ids: list[str],
        route_ids: list[str],
        service_date: date,
        from_seconds: int,
        to_seconds: int,
        max_results: int,
    ) -> list[dict]:
        route_sql = psql.SQL("AND t.route_id = ANY(%s)") if route_ids else psql.SQL("")
        weekday_column = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][service_date.weekday()]
        gtfs_date = service_date.strftime("%Y%m%d")
        params: list = [feed_version, gtfs_date, gtfs_date, feed_version, gtfs_date, feed_version, gtfs_date, feed_version, stop_ids, from_seconds, to_seconds]
        if route_ids:
            params.append(route_ids)
        params.append(max_results)
        rows = self.conn.execute(
            psql.SQL("""
            WITH active_services AS (
                SELECT c.feed_version, c.service_id
                FROM calendar c
                WHERE c.feed_version = %s
                  AND c.start_date <= %s
                  AND c.end_date >= %s
                  AND c.{} = 1

                UNION

                SELECT cd.feed_version, cd.service_id
                FROM calendar_dates cd
                WHERE cd.feed_version = %s
                  AND cd.date = %s
                  AND cd.exception_type = 1

                EXCEPT

                SELECT cd.feed_version, cd.service_id
                FROM calendar_dates cd
                WHERE cd.feed_version = %s
                  AND cd.date = %s
                  AND cd.exception_type = 2
            )
            SELECT st.trip_id, t.route_id, st.stop_id, st.stop_sequence, t.direction_id, t.trip_headsign,
                   st.departure_time AS scheduled_departure_time,
                   st.departure_seconds AS scheduled_departure_seconds
            FROM stop_times st
            JOIN trips t ON t.feed_version = st.feed_version AND t.trip_id = st.trip_id
            JOIN active_services active ON active.feed_version = t.feed_version AND active.service_id = t.service_id
            WHERE st.feed_version = %s
              AND st.stop_id = ANY(%s)
              AND st.departure_seconds BETWEEN %s AND %s
              {}
            ORDER BY st.departure_seconds
            LIMIT %s
            """).format(psql.Identifier(weekday_column), route_sql),
            params,
        ).fetchall()
        return [dict(row) for row in rows]
