from contextlib import contextmanager

from app.workers import static_import


class FakeConnection:
    def __init__(self, events: list[str]):
        self.events = events

    def commit(self):
        self.events.append("commit")


class FakeDatabase:
    def __init__(self, settings, events: list[str]):
        self.events = events
        self.conn = FakeConnection(events)

    def open(self):
        self.events.append("open")

    def close(self):
        self.events.append("close")

    @contextmanager
    def connection(self):
        yield self.conn


class FakeImporter:
    def __init__(self, settings, events: list[str]):
        self.events = events

    def import_feed(self, conn):
        self.events.append("import")
        return "feed-1"


def test_run_once_imports_and_commits(monkeypatch):
    events: list[str] = []
    settings = object()
    monkeypatch.setattr(static_import, "get_settings", lambda: settings)
    monkeypatch.setattr(static_import, "Database", lambda value: FakeDatabase(value, events))
    monkeypatch.setattr(static_import, "GtfsImporter", lambda value: FakeImporter(value, events))

    result = static_import.run_once()

    assert result == "feed-1"
    assert events == ["open", "import", "commit", "close"]
