from datetime import date

from app.repositories.gtfs import GtfsRepository


class FakeResult:
    def __init__(self, rows=None, row=None):
        self.rows = rows or []
        self.row = row

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, rows=None):
        self.sql = None
        self.params = None
        self.executions = []
        self.rows = rows or []

    def execute(self, sql, params=None):
        self.sql = sql.as_string(None) if hasattr(sql, "as_string") else sql
        self.params = params
        self.executions.append((self.sql, params))
        if "count(*) AS count FROM routes" in self.sql:
            return FakeResult(row={"count": 0})
        if "JOIN stop_times st ON st.feed_version = %s AND st.trip_id = r.trip_id" in self.sql:
            return FakeResult(rows=self.rows)
        return FakeResult()


def test_route_list_uses_full_text_search_index_expression():
    conn = FakeConnection()

    rows = GtfsRepository(conn).route_list("feed-1", "eastern line", [], 50, 0)

    assert rows == {"items": [], "total": 0}
    assert "to_tsvector('simple'" in conn.sql
    assert "@@ plainto_tsquery('simple', %s)" in conn.sql
    assert "ILIKE" not in conn.sql
    assert conn.params == ["feed-1", "eastern line", 50, 0]


def test_departures_filters_by_service_calendar():
    conn = FakeConnection()

    rows = GtfsRepository(conn).departures(
        "feed-1",
        ["stop-1"],
        ["route-1"],
        [],
        date(2026, 7, 10),
        8 * 3600,
        10 * 3600,
        20,
    )

    assert rows == []
    assert "WITH active_services AS" in conn.sql
    assert "JOIN active_services active" in conn.sql
    assert "FROM calendar_dates cd" in conn.sql
    assert "FROM calendar c" in conn.sql
    assert "t.direction_id = ANY" not in conn.sql
    assert 'c."friday" = 1' in conn.sql
    assert "cd.exception_type = 1" in conn.sql
    assert "cd.exception_type = 2" in conn.sql
    assert conn.params == [
        "feed-1",
        "20260710",
        "20260710",
        "feed-1",
        "20260710",
        "feed-1",
        "20260710",
        "feed-1",
        ["stop-1"],
        28800,
        36000,
        ["route-1"],
        20,
    ]


def test_route_stops_only_selects_trips_with_stop_times():
    conn = FakeConnection()

    rows = GtfsRepository(conn).route_stops("feed-1", "route-1", None, None)

    assert rows == []
    assert "EXISTS" in conn.sql
    assert "FROM stop_times st" in conn.sql
    assert "st.trip_id = t.trip_id" in conn.sql
    assert "JOIN stop_times st ON st.feed_version = %s AND st.trip_id = r.trip_id" in conn.sql
    assert len(conn.executions) == 1


def test_route_stops_groups_representative_stops_from_single_query():
    conn = FakeConnection(
        rows=[
            {
                "trip_id": "trip-0",
                "route_id": "route-1",
                "direction_id": 0,
                "trip_headsign": "Inbound",
                "stop_id": "stop-1",
                "stop_sequence": 1,
                "arrival_time": "08:00:00",
                "departure_time": "08:00:00",
                "stop_name": "First",
                "stop_lat": -36.8,
                "stop_lon": 174.7,
                "platform_code": "A",
            },
            {
                "trip_id": "trip-0",
                "route_id": "route-1",
                "direction_id": 0,
                "trip_headsign": "Inbound",
                "stop_id": "stop-2",
                "stop_sequence": 2,
                "arrival_time": "08:05:00",
                "departure_time": "08:05:00",
                "stop_name": "Second",
                "stop_lat": -36.81,
                "stop_lon": 174.71,
                "platform_code": "B",
            },
            {
                "trip_id": "trip-1",
                "route_id": "route-1",
                "direction_id": 1,
                "trip_headsign": "Outbound",
                "stop_id": "stop-3",
                "stop_sequence": 1,
                "arrival_time": "09:00:00",
                "departure_time": "09:00:00",
                "stop_name": "Third",
                "stop_lat": -36.82,
                "stop_lon": 174.72,
                "platform_code": "C",
            },
        ]
    )

    rows = GtfsRepository(conn).route_stops("feed-1", "route-1", None, None)

    assert len(rows) == 2
    assert rows[0]["representative_trip_id"] == "trip-0"
    assert rows[0]["direction_id"] == 0
    assert [stop["stop_id"] for stop in rows[0]["stops"]] == ["stop-1", "stop-2"]
    assert rows[1]["representative_trip_id"] == "trip-1"
    assert rows[1]["direction_id"] == 1
    assert [stop["stop_id"] for stop in rows[1]["stops"]] == ["stop-3"]
    assert len(conn.executions) == 1


def test_route_ids_for_trip_ids_uses_active_feed_scope():
    conn = FakeConnection()

    rows = GtfsRepository(conn).route_ids_for_trip_ids("feed-1", ["trip-1", "trip-2"])

    assert rows == {}
    assert "FROM trips" in conn.sql
    assert "feed_version = %s" in conn.sql
    assert "trip_id = ANY(%s)" in conn.sql
    assert conn.params == ("feed-1", ["trip-1", "trip-2"])
def test_planner_trip_times_are_ordered_and_feed_scoped():
    conn = FakeConnection()

    rows = GtfsRepository(conn).planner_trip_times("feed-9")

    assert rows == []
    assert "JOIN stop_times st" in conn.sql
    assert "st.arrival_seconds IS NOT NULL" in conn.sql
    assert "ORDER BY t.route_id" in conn.sql
    assert conn.params == ("feed-9",)
