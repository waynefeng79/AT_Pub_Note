from __future__ import annotations

import asyncio
import importlib
import logging
import threading
import time
from typing import Callable, Protocol, cast

from redis import Redis
from redis.exceptions import RedisError

from app.core.config import Settings
from app.db.session import Database
from app.services.activity import realtime_active_user_count
from app.services.gtfs_importer import STATIC_IMPORT_LOCK_KEY

logger = logging.getLogger("uvicorn.error")

DATABASE_STATE_KEY = "system:database:state"
DATABASE_START_LOCK_KEY = "system:database:start_lock"
DATABASE_STOP_LOCK_KEY = "system:database:stop_lock"
DATABASE_LAST_ACTIVITY_KEY = "system:database:last_user_activity"
DATABASE_READY_SINCE_KEY = "system:database:ready_since"
DATABASE_WAKE_REQUESTED_KEY = "system:database:wake_requested"

READY_STATE_TTL_SECONDS = 60
POWER_LOCK_TTL_SECONDS = 120


def _decode(value: bytes | str | None) -> str | None:
    if value is None:
        return None
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


class DatabasePowerBackend(Protocol):
    def state(self) -> str: ...

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def close(self) -> None: ...


def load_power_backend(class_path: str) -> DatabasePowerBackend:
    module_name, separator, class_name = class_path.partition(":")
    if not separator or not module_name or not class_name:
        raise ValueError("Database power backend class must use module:Class format")
    backend_type = getattr(importlib.import_module(module_name), class_name)
    backend = backend_type()
    if not all(callable(getattr(backend, method, None)) for method in ("state", "start", "stop", "close")):
        raise TypeError("Configured database power backend does not implement the required lifecycle methods")
    return cast(DatabasePowerBackend, backend)


class DatabasePowerController:
    def __init__(
        self,
        settings: Settings,
        redis: Redis,
        database: Database,
        *,
        power_backend: DatabasePowerBackend | None = None,
        now: Callable[[], float] = time.time,
        on_ready: Callable[[], None] | None = None,
    ):
        self.settings = settings
        self.redis = redis
        self.database = database
        self._power_backend = power_backend
        self._now = now
        self._on_ready = on_ready
        self._ready_notified = False
        self._ready_notify_lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.settings.database_power_control_enabled

    @property
    def power_backend(self) -> DatabasePowerBackend:
        if self._power_backend is None:
            self._power_backend = load_power_backend(self.settings.database_power_backend_class or "")
        return self._power_backend

    def close(self) -> None:
        if self._power_backend is not None:
            self._power_backend.close()

    def initialize(self) -> None:
        if self.enabled:
            self.redis.set(DATABASE_LAST_ACTIVITY_KEY, str(int(self._now())), nx=True)

    def reported_state(self) -> str:
        if not self.enabled:
            return "unmanaged"
        try:
            return _decode(self.redis.get(DATABASE_STATE_KEY)) or "unknown"
        except RedisError:
            return "unknown"

    def mark_user_activity(self) -> None:
        if self.enabled:
            self.redis.set(DATABASE_LAST_ACTIVITY_KEY, str(int(self._now())))

    def _set_state(self, state: str, *, ttl: int | None = None) -> None:
        self.redis.set(DATABASE_STATE_KEY, state, ex=ttl)
        if state == "ready":
            self.redis.set(DATABASE_READY_SINCE_KEY, str(int(self._now())), nx=True)
            self.redis.delete(DATABASE_WAKE_REQUESTED_KEY)
        elif state in {"stopped", "stopping"}:
            self.redis.delete(DATABASE_READY_SINCE_KEY)
            self._ready_notified = False

    def _notify_ready(self) -> None:
        if self._on_ready is None:
            return
        with self._ready_notify_lock:
            if self._ready_notified:
                return
            self._ready_notified = True
        try:
            self._on_ready()
        except Exception:
            logger.exception("database_power_ready_callback_failed")

    def _database_ready(self) -> bool:
        try:
            with self.database.connection() as conn:
                row = conn.execute("SELECT 1 AS ok").fetchone()
                return bool(row and row["ok"])
        except Exception:
            return False

    def ensure_available(self) -> bool:
        """Record activity, request one wake-up, and report whether database work may proceed."""
        if not self.enabled:
            return True
        self.mark_user_activity()
        self.redis.set(
            DATABASE_WAKE_REQUESTED_KEY,
            str(int(self._now())),
            ex=max(self.settings.database_idle_seconds, self.settings.database_min_up_seconds),
        )
        cached = self.reported_state()
        if cached == "ready":
            self.redis.delete(DATABASE_WAKE_REQUESTED_KEY)
            self._notify_ready()
            return True
        if cached in {"starting", "stopping", "unavailable"}:
            return False

        try:
            resource_state = self.power_backend.state()
            if resource_state == "running" and self._database_ready():
                self._set_state("ready", ttl=READY_STATE_TTL_SECONDS)
                self._notify_ready()
                return True
            if resource_state == "stopped":
                locked = self.redis.set(DATABASE_START_LOCK_KEY, str(int(self._now())), nx=True, ex=POWER_LOCK_TTL_SECONDS)
                if locked:
                    self.power_backend.start()
                    logger.info("database_power_start_requested")
            self._set_state("starting", ttl=READY_STATE_TTL_SECONDS)
        except Exception:
            logger.exception("database_power_availability_check_failed")
            self._set_state("unavailable", ttl=self.settings.database_power_retry_after_seconds)
        return False

    def _static_import_idle(self) -> bool:
        try:
            with self.database.connection() as conn:
                row = conn.execute("SELECT pg_try_advisory_lock(%s) AS locked", (STATIC_IMPORT_LOCK_KEY,)).fetchone()
                locked = bool(row and row["locked"])
                if locked:
                    conn.execute("SELECT pg_advisory_unlock(%s)", (STATIC_IMPORT_LOCK_KEY,))
                return locked
        except Exception:
            return False

    def _idle_for_seconds(self) -> float:
        value = _decode(self.redis.get(DATABASE_LAST_ACTIVITY_KEY))
        return 0 if value is None else max(0, self._now() - float(value))

    def _ready_for_seconds(self) -> float:
        value = _decode(self.redis.get(DATABASE_READY_SINCE_KEY))
        return 0 if value is None else max(0, self._now() - float(value))

    def reconcile(self) -> None:
        if not self.enabled:
            return
        try:
            resource_state = self.power_backend.state()
            if resource_state == "stopped":
                self._set_state("stopped")
                if self.redis.exists(DATABASE_WAKE_REQUESTED_KEY):
                    self.ensure_available()
                return
            if resource_state in {"starting", "stopping"}:
                self._set_state(resource_state, ttl=READY_STATE_TTL_SECONDS)
                return
            if resource_state != "running" or not self._database_ready():
                self._set_state("starting", ttl=READY_STATE_TTL_SECONDS)
                return

            self._set_state("ready", ttl=READY_STATE_TTL_SECONDS)
            self._notify_ready()
            if self._idle_for_seconds() < self.settings.database_idle_seconds:
                return
            if self._ready_for_seconds() < self.settings.database_min_up_seconds:
                return
            if realtime_active_user_count(self.redis) > 0 or not self._static_import_idle():
                return
            locked = self.redis.set(DATABASE_STOP_LOCK_KEY, str(int(self._now())), nx=True, ex=POWER_LOCK_TTL_SECONDS)
            if not locked:
                return
            if self._idle_for_seconds() < self.settings.database_idle_seconds or realtime_active_user_count(self.redis) > 0:
                return
            self._set_state("stopping", ttl=READY_STATE_TTL_SECONDS)
            self.power_backend.stop()
            logger.info("database_power_stop_requested")
        except RedisError:
            logger.exception("database_power_reconcile_redis_failed")
        except Exception:
            logger.exception("database_power_reconcile_failed")


async def database_power_control_loop(controller: DatabasePowerController) -> None:
    while True:
        await asyncio.to_thread(controller.reconcile)
        await asyncio.sleep(controller.settings.database_power_check_seconds)


def database_worker_may_poll(settings: Settings, redis: Redis) -> bool:
    if not settings.database_power_control_enabled:
        return True
    try:
        return _decode(redis.get(DATABASE_STATE_KEY)) == "ready"
    except RedisError:
        return False
