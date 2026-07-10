from contextlib import contextmanager
from types import SimpleNamespace

from app.api.routes.health import readiness


class FakeConnection:
    def execute(self, query):
        return self

    def fetchone(self):
        return {"ok": 1}


class FakeDatabase:
    def __init__(self, error=None):
        self.error = error

    @contextmanager
    def connection(self):
        if self.error:
            raise self.error
        yield FakeConnection()


class FakeRedis:
    def __init__(self, error=None):
        self.error = error

    def ping(self):
        if self.error:
            raise self.error
        return True


def fake_app(db_error=None, redis_error=None):
    return SimpleNamespace(
        state=SimpleNamespace(
            db=FakeDatabase(db_error),
            redis=SimpleNamespace(client=FakeRedis(redis_error)),
        )
    )


def test_readiness_reports_healthy_dependencies():
    assert readiness(fake_app()) == {"status": "ready", "database": True, "redis": True}


def test_readiness_reports_each_failed_dependency_without_raising():
    assert readiness(fake_app(db_error=RuntimeError("db down"))) == {
        "status": "degraded",
        "database": False,
        "redis": True,
    }
    assert readiness(fake_app(redis_error=RuntimeError("redis down"))) == {
        "status": "degraded",
        "database": True,
        "redis": False,
    }
