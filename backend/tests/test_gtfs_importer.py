
import pytest

from app.services.gtfs_importer import GtfsImporter


class FakeSettings:
    def __init__(self, retain_inactive_feeds=2):
        self.gtfs_retain_inactive_feeds = retain_inactive_feeds


class FakeResult:
    def __init__(self, count):
        self.count = count

    def fetchone(self):
        return {"count": self.count}


class FakeConnection:
    def __init__(self, counts):
        self.counts = counts
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        count = self.counts[len(self.calls) - 1]
        return FakeResult(count)


def test_validate_feed_accepts_consistent_relationships():
    conn = FakeConnection([0, 0, 0, 0, 0])

    GtfsImporter.__new__(GtfsImporter)._validate_feed(conn, "feed-1")

    assert len(conn.calls) == 5
    missing_shapes_sql = conn.calls[2][0]
    assert "LEFT JOIN shapes s" in missing_shapes_sql
    assert "FROM shape_points" not in missing_shapes_sql


def test_validate_feed_rejects_missing_relationships():
    conn = FakeConnection([0, 2, 0, 3, 0])

    with pytest.raises(RuntimeError) as exc_info:
        GtfsImporter.__new__(GtfsImporter)._validate_feed(conn, "feed-1")

    assert "trips_missing_services=2" in str(exc_info.value)
    assert "stop_times_missing_trips=3" in str(exc_info.value)


def test_delete_old_inactive_feeds_uses_retention_setting():
    conn = FakeConnection([0])
    importer = GtfsImporter.__new__(GtfsImporter)
    importer.settings = FakeSettings(retain_inactive_feeds=3)

    importer._delete_old_inactive_feeds(conn)

    sql, params = conn.calls[0]
    assert "DELETE FROM gtfs_feed_versions" in sql
    assert "WHERE is_active = false" in sql
    assert params == (3,)


def test_activate_feed_deletes_old_inactive_feeds_after_activation():
    conn = FakeConnection([0, 0, 0])
    importer = GtfsImporter.__new__(GtfsImporter)
    importer.settings = FakeSettings(retain_inactive_feeds=1)

    importer._activate_feed(conn, "feed-2")

    assert conn.calls[0] == ("UPDATE gtfs_feed_versions SET is_active = false WHERE is_active = true", None)
    assert conn.calls[1] == ("UPDATE gtfs_feed_versions SET is_active = true WHERE feed_version = %s", ("feed-2",))
    assert conn.calls[2][1] == (1,)
