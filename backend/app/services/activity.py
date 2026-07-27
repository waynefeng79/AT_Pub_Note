from __future__ import annotations

import asyncio
import logging
import time

from redis import Redis
from redis.exceptions import RedisError

REALTIME_ACTIVE_USERS_KEY = "app:activity:realtime_active_users"
REALTIME_ACTIVE_USERS_LOG_LOCK_KEY = "app:activity:realtime_active_users:log_lock"
REALTIME_ACTIVE_WINDOW_SECONDS = 60
REALTIME_ACTIVE_LOG_SECONDS = 60


def mark_realtime_user_active(
    redis: Redis,
    user_id: int,
    *,
    now: float | None = None,
    window_seconds: int = REALTIME_ACTIVE_WINDOW_SECONDS,
) -> None:
    timestamp = int(now if now is not None else time.time())
    try:
        redis.zadd(REALTIME_ACTIVE_USERS_KEY, {str(user_id): timestamp})
        redis.expire(REALTIME_ACTIVE_USERS_KEY, window_seconds * 3)
    except RedisError:
        return


def realtime_active_user_count(
    redis: Redis,
    *,
    now: float | None = None,
    window_seconds: int = REALTIME_ACTIVE_WINDOW_SECONDS,
) -> int:
    timestamp = int(now if now is not None else time.time())
    redis.zremrangebyscore(REALTIME_ACTIVE_USERS_KEY, "-inf", timestamp - window_seconds)
    return int(redis.zcard(REALTIME_ACTIVE_USERS_KEY))


def try_log_realtime_active_users(
    redis: Redis,
    logger: logging.Logger,
    *,
    now: float | None = None,
    window_seconds: int = REALTIME_ACTIVE_WINDOW_SECONDS,
    log_seconds: int = REALTIME_ACTIVE_LOG_SECONDS,
) -> bool:
    timestamp = int(now if now is not None else time.time())
    locked = redis.set(REALTIME_ACTIVE_USERS_LOG_LOCK_KEY, str(timestamp), nx=True, ex=log_seconds)
    if not locked:
        return False

    count = realtime_active_user_count(redis, now=timestamp, window_seconds=window_seconds)
    logger.info("Realtime active users count=%s window_seconds=%s", count, window_seconds)
    return True


async def realtime_active_user_log_loop(
    redis: Redis,
    logger: logging.Logger,
    *,
    window_seconds: int = REALTIME_ACTIVE_WINDOW_SECONDS,
    log_seconds: int = REALTIME_ACTIVE_LOG_SECONDS,
) -> None:
    while True:
        try:
            try_log_realtime_active_users(
                redis,
                logger,
                window_seconds=window_seconds,
                log_seconds=log_seconds,
            )
        except RedisError:
            logger.exception("Could not log realtime active user count")
        await asyncio.sleep(log_seconds)
