import logging

from app.services.activity import (
    REALTIME_ACTIVE_USERS_KEY,
    mark_realtime_user_active,
    realtime_active_user_count,
    try_log_realtime_active_users,
)


class FakeRedis:
    def __init__(self):
        self.zsets = {}
        self.values = {}
        self.expiry = {}

    def zadd(self, key, values):
        self.zsets.setdefault(key, {}).update(values)

    def expire(self, key, seconds):
        self.expiry[key] = seconds

    def zremrangebyscore(self, key, minimum, maximum):
        zset = self.zsets.setdefault(key, {})
        threshold = float(maximum)
        for member, score in list(zset.items()):
            if score <= threshold:
                zset.pop(member)

    def zcard(self, key):
        return len(self.zsets.get(key, {}))

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.expiry[key] = ex
        return True


def test_realtime_active_user_count_uses_user_id_only_and_prunes_stale_users():
    redis = FakeRedis()

    mark_realtime_user_active(redis, 1, now=100)
    mark_realtime_user_active(redis, 1, now=110)
    mark_realtime_user_active(redis, 2, now=111)
    mark_realtime_user_active(redis, 3, now=20)

    assert realtime_active_user_count(redis, now=111, window_seconds=60) == 2
    assert sorted(redis.zsets[REALTIME_ACTIVE_USERS_KEY]) == ["1", "2"]


def test_realtime_active_user_log_uses_minute_lock():
    redis = FakeRedis()
    logger = logging.getLogger("test.realtime_activity")
    mark_realtime_user_active(redis, 1, now=100)

    assert try_log_realtime_active_users(redis, logger, now=100)
    assert not try_log_realtime_active_users(redis, logger, now=101)
