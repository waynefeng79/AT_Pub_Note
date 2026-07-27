from app.core.config import Settings
from app.workers import realtime_poll


class FakeRedis:
    def set(self, *args, **kwargs):
        return True

    def eval(self, *args):
        return 1


class FakeRedisClient:
    instances = []

    def __init__(self, settings):
        self.settings = settings
        self.client = FakeRedis()
        self.closed = False
        FakeRedisClient.instances.append(self)

    def close(self):
        self.closed = True


class FakeDatabase:
    instances = []

    def __init__(self, settings):
        self.settings = settings
        self.open_count = 0
        self.close_count = 0
        FakeDatabase.instances.append(self)

    def open(self):
        self.open_count += 1

    def close(self):
        self.close_count += 1


def test_poll_once_reuses_one_database_pool(monkeypatch):
    FakeDatabase.instances = []
    FakeRedisClient.instances = []
    seen = {}

    def poll_snapshot(settings, redis, db):
        seen["settings"] = settings
        seen["redis"] = redis
        seen["db"] = db
        return {"ok": True}

    monkeypatch.setattr(realtime_poll, "get_settings", lambda: Settings(_env_file=None))
    monkeypatch.setattr(realtime_poll, "RedisClient", FakeRedisClient)
    monkeypatch.setattr(realtime_poll, "Database", FakeDatabase)
    monkeypatch.setattr(realtime_poll, "_poll_snapshot", poll_snapshot)

    result = realtime_poll.poll_once()

    assert result == {"ok": True}
    assert len(FakeDatabase.instances) == 1
    assert FakeDatabase.instances[0].open_count == 1
    assert FakeDatabase.instances[0].close_count == 1
    assert seen["db"] is FakeDatabase.instances[0]
    assert seen["redis"] is FakeRedisClient.instances[0].client
    assert FakeRedisClient.instances[0].closed
