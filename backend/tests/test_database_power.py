from contextlib import contextmanager
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.middleware.database_wake import DatabaseWakeMiddleware
from app.services.database_power import (
    DATABASE_LAST_ACTIVITY_KEY,
    DATABASE_READY_SINCE_KEY,
    DatabasePowerController,
    load_power_backend,
)


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.active_users = 0

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = str(value)
        return True

    def get(self, key):
        return self.values.get(key)

    def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)

    def exists(self, key):
        return int(key in self.values)

    def zremrangebyscore(self, *args):
        return 0

    def zcard(self, key):
        return self.active_users


class FakeConnection:
    def execute(self, query, params=None):
        if "pg_try_advisory_lock" in query:
            return SimpleNamespace(fetchone=lambda: {"locked": True})
        if "pg_advisory_unlock" in query:
            return SimpleNamespace(fetchone=lambda: None)
        return SimpleNamespace(fetchone=lambda: {"ok": 1})


class FakeDatabase:
    @contextmanager
    def connection(self):
        yield FakeConnection()


class FakePowerBackend:
    def __init__(self, state="stopped"):
        self.current_state = state
        self.started = 0
        self.stopped = 0

    def state(self):
        return self.current_state

    def start(self):
        self.started += 1
        self.current_state = "starting"

    def stop(self):
        self.stopped += 1
        self.current_state = "stopping"

    def close(self):
        pass


def test_loads_a_configured_backend_class():
    backend = load_power_backend(f"{__name__}:FakePowerBackend")

    assert isinstance(backend, FakePowerBackend)


def settings(**overrides):
    return Settings(
        _env_file=None,
        database_power_control_enabled=True,
        database_power_backend_class="example.module:PowerBackend",
        database_idle_seconds=300,
        database_min_up_seconds=60,
        **overrides,
    )


def test_first_request_starts_a_stopped_resource_only_once():
    redis = FakeRedis()
    power_backend = FakePowerBackend("stopped")
    controller = DatabasePowerController(settings(), redis, FakeDatabase(), power_backend=power_backend, now=lambda: 1000)
    controller.initialize()

    assert controller.ensure_available() is False
    assert controller.ensure_available() is False
    assert power_backend.started == 1
    assert controller.reported_state() == "starting"


def test_running_and_ready_database_allows_the_request():
    controller = DatabasePowerController(settings(), FakeRedis(), FakeDatabase(), power_backend=FakePowerBackend("running"), now=lambda: 1000)

    assert controller.ensure_available() is True
    assert controller.reported_state() == "ready"


def test_idle_database_is_stopped_after_minimum_uptime():
    redis = FakeRedis()
    redis.values[DATABASE_LAST_ACTIVITY_KEY] = "100"
    redis.values[DATABASE_READY_SINCE_KEY] = "100"
    power_backend = FakePowerBackend("running")
    controller = DatabasePowerController(settings(), redis, FakeDatabase(), power_backend=power_backend, now=lambda: 1000)

    controller.reconcile()

    assert power_backend.stopped == 1
    assert controller.reported_state() == "stopping"


def test_active_realtime_user_prevents_idle_stop():
    redis = FakeRedis()
    redis.values[DATABASE_LAST_ACTIVITY_KEY] = "100"
    redis.values[DATABASE_READY_SINCE_KEY] = "100"
    redis.active_users = 1
    power_backend = FakePowerBackend("running")
    controller = DatabasePowerController(settings(), redis, FakeDatabase(), power_backend=power_backend, now=lambda: 1000)

    controller.reconcile()

    assert power_backend.stopped == 0


def test_middleware_returns_retryable_database_starting_contract():
    app = FastAPI()
    app.add_middleware(DatabaseWakeMiddleware)
    app.state.database_power = SimpleNamespace(
        ensure_available=lambda: False,
        settings=SimpleNamespace(database_power_retry_after_seconds=7),
    )

    @app.get("/api/example")
    def example():
        return {"ok": True}

    response = TestClient(app).get("/api/example")

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "7"
    assert response.json()["detail"]["code"] == "database_starting"
