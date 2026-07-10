from __future__ import annotations

from redis import Redis

from app.core.config import Settings


class RedisClient:
    def __init__(self, settings: Settings):
        self.client: Redis = Redis.from_url(settings.redis_url, decode_responses=True)

    def ping(self) -> bool:
        return bool(self.client.ping())

    def close(self) -> None:
        self.client.close()
