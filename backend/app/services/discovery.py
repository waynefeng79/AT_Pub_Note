import json
from typing import Any

from redis import Redis

from app.core.config import Settings
from app.repositories.gtfs import GtfsRepository
from app.utils.time import coarse_cell


class DiscoveryService:
    def __init__(self, repo: GtfsRepository, redis: Redis, settings: Settings):
        self.repo = repo
        self.redis = redis
        self.settings = settings

    def nearby_stops(self, feed_version: str, lat: float, lon: float, radius_m: int, limit: int) -> dict:
        cell = coarse_cell(lat, lon, self.settings.spatial_cache_cell_precision)
        key = f"spatial:nearby_stops:{feed_version}:{cell}:{radius_m}:{limit}"
        cached = self._get(key)
        if cached:
            return {"cache": {"status": "hit", "cell": cell}, "items": cached}
        items = self.repo.nearby_stops(feed_version, lat, lon, radius_m, limit)
        self._set(key, items)
        return {"cache": {"status": "miss", "cell": cell}, "items": items}

    def nearby_routes(self, feed_version: str, lat: float, lon: float, radius_m: int, limit: int, route_types: list[int]) -> dict:
        cell = coarse_cell(lat, lon, self.settings.spatial_cache_cell_precision)
        route_hash = "-".join(str(item) for item in sorted(route_types)) or "all"
        key = f"spatial:nearby_routes:{feed_version}:{cell}:{radius_m}:{limit}:{route_hash}"
        cached = self._get(key)
        if cached:
            return {"cache": {"status": "hit", "cell": cell}, "items": cached}
        items = self.repo.nearby_routes(feed_version, lat, lon, radius_m, limit, route_types)
        self._set(key, items)
        return {"cache": {"status": "miss", "cell": cell}, "items": items}

    def _get(self, key: str) -> list[dict[str, Any]] | None:
        if not self.settings.spatial_cache_enabled:
            return None
        try:
            raw = self.redis.get(key)
        except Exception:
            return None
        if not isinstance(raw, (str, bytes, bytearray)):
            return None
        try:
            value = json.loads(raw)
            return value if isinstance(value, list) else None
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            return None

    def _set(self, key: str, value: list[dict[str, Any]]) -> None:
        if not self.settings.spatial_cache_enabled:
            return
        try:
            self.redis.setex(key, self.settings.spatial_cache_ttl_seconds, json.dumps(value))
        except Exception:
            pass
