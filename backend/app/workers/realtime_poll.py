import argparse
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from uuid import uuid4

from redis import Redis

from app.cache.redis import RedisClient
from app.core.config import Settings, get_settings
from app.db.session import Database
from app.repositories.gtfs import GtfsRepository
from app.services.realtime import RealtimeNormalizer, RealtimeService, load_realtime_bytes

logger = logging.getLogger(__name__)
REALTIME_WORKER_LOCK_KEY = "gtfsrt:poller:lock"


class RealtimePollerAlreadyRunning(RuntimeError):
    pass


def _lock_ttl(settings: Settings) -> int:
    return max(settings.gtfs_realtime_lock_ttl_seconds, settings.gtfs_realtime_poll_seconds * 4, 60)


def acquire_worker_lock(redis: Redis, ttl_seconds: int) -> str:
    token = str(uuid4())
    if redis.set(REALTIME_WORKER_LOCK_KEY, token, nx=True, ex=ttl_seconds):
        return token
    raise RealtimePollerAlreadyRunning("Another realtime poll worker is already running")


def refresh_worker_lock(redis: Redis, token: str, ttl_seconds: int) -> None:
    refreshed = redis.eval(
        """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('expire', KEYS[1], ARGV[2])
        end
        return 0
        """,
        1,
        REALTIME_WORKER_LOCK_KEY,
        token,
        str(ttl_seconds),
    )
    if not refreshed:
        raise RealtimePollerAlreadyRunning("Realtime poll worker lock was lost")


def release_worker_lock(redis: Redis, token: str) -> None:
    redis.eval(
        """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        end
        return 0
        """,
        1,
        REALTIME_WORKER_LOCK_KEY,
        token,
    )


@contextmanager
def _worker_lock(redis: Redis, ttl_seconds: int) -> Iterator[str]:
    token = acquire_worker_lock(redis, ttl_seconds)
    try:
        yield token
    finally:
        release_worker_lock(redis, token)


def active_feed_version(settings: Settings) -> str | None:
    db = Database(settings)
    db.open()
    try:
        with db.connection() as conn:
            feed = GtfsRepository(conn).active_feed()
            return feed["feed_version"] if feed else None
    finally:
        db.close()


def _alert_trip_ids(snapshot: dict) -> list[str]:
    return sorted(
        {
            trip_id
            for alert in snapshot.get("alerts", [])
            for trip_id in alert.get("trip_ids") or []
            if trip_id
        }
    )


def _static_trip_routes(settings: Settings, feed_version: str | None, trip_ids: list[str]) -> dict[str, str]:
    if not feed_version or not trip_ids:
        return {}
    db = Database(settings)
    db.open()
    try:
        with db.connection() as conn:
            return GtfsRepository(conn).route_ids_for_trip_ids(feed_version, trip_ids)
    finally:
        db.close()


def _poll_snapshot(settings: Settings, redis: Redis) -> dict:
    feed_version = active_feed_version(settings)
    data, source, content_type = load_realtime_bytes(settings)
    normalizer = RealtimeNormalizer(settings.realtime_feed_format)
    snapshot = normalizer.normalize(normalizer.parse(data, source, content_type))
    static_trip_routes = _static_trip_routes(settings, feed_version, _alert_trip_ids(snapshot))
    RealtimeService(redis).store_snapshot(snapshot, feed_version, static_trip_routes)
    logger.info(
        "Stored realtime snapshot feed_version=%s vehicles=%s trip_updates=%s alerts=%s static_alert_trip_routes=%s",
        feed_version,
        len(snapshot["vehicles"]),
        len(snapshot["trip_updates"]),
        len(snapshot["alerts"]),
        len(static_trip_routes),
    )
    return snapshot


def poll_once() -> dict:
    settings = get_settings()
    redis = RedisClient(settings)
    try:
        with _worker_lock(redis.client, _lock_ttl(settings)):
            return _poll_snapshot(settings, redis.client)
    finally:
        redis.close()


def poll_loop() -> None:
    settings = get_settings()
    redis = RedisClient(settings)
    ttl_seconds = _lock_ttl(settings)
    try:
        with _worker_lock(redis.client, ttl_seconds) as token:
            logger.debug("Acquired realtime poll worker lock")
            while True:
                try:
                    refresh_worker_lock(redis.client, token, ttl_seconds)
                    _poll_snapshot(settings, redis.client)
                    refresh_worker_lock(redis.client, token, ttl_seconds)
                except RealtimePollerAlreadyRunning:
                    logger.exception("Realtime poll worker lock lost")
                    raise
                except Exception:
                    logger.exception("Realtime poll failed; leaving last Redis snapshot intact")
                time.sleep(settings.gtfs_realtime_poll_seconds)
    finally:
        redis.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    if args.loop:
        poll_loop()
    else:
        poll_once()
