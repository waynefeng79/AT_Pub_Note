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
    def __init__(self):
        self.sql = None
        self.params = None
        self.executions = []

    def execute(self, sql, params=None):
        self.sql = sql.as_string(None) if hasattr(sql, "as_string") else sql
        self.params = params
        self.executions.append((self.sql, params))
        if "count(*) AS count FROM routes" in self.sql:
            return FakeResult(row={"count": 0})
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


def test_route_ids_for_trip_ids_uses_active_feed_scope():
    conn = FakeConnection()

    rows = GtfsRepository(conn).route_ids_for_trip_ids("feed-1", ["trip-1", "trip-2"])

    assert rows == {}
    assert "FROM trips" in conn.sql
    assert "feed_version = %s" in conn.sql
    assert "trip_id = ANY(%s)" in conn.sql
    assert conn.params == ("feed-1", ["trip-1", "trip-2"])
