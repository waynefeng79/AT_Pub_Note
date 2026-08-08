from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections.abc import Callable
from typing import Protocol

import httpx
from redis import Redis
from redis.exceptions import RedisError

from app.core.config import Settings
from app.models import PlaceCandidate

OSM_ATTRIBUTION = "© OpenStreetMap contributors"
PUBLIC_PERMIT_KEY = "geocoding:nominatim:public-permit"
logger = logging.getLogger("uvicorn.error")


class GeocodingProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = True, status_code: int | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


class GeocodingPolicyError(GeocodingProviderError):
    pass


class GeocoderProvider(Protocol):
    def search(self, query: str, limit: int) -> list[PlaceCandidate]: ...

    def reverse(self, lat: float, lon: float) -> PlaceCandidate | None: ...


def _normalise_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _secondary_text(name: str, display_name: str) -> str:
    parts = [part.strip() for part in display_name.split(",")]
    if parts and parts[0].casefold() == name.casefold():
        parts = parts[1:]
    return ", ".join(parts[:4])


def _candidate(item: dict) -> PlaceCandidate:
    display_name = _normalise_space(str(item.get("display_name") or ""))
    name = _normalise_space(str(item.get("name") or display_name.split(",", 1)[0] or "Selected location"))
    osm_type = str(item.get("osm_type") or "place")
    object_id = str(item.get("osm_id") or item.get("place_id") or hashlib.sha1(display_name.encode("utf-8")).hexdigest()[:16])
    raw_bbox = item.get("boundingbox")
    bbox = [float(value) for value in raw_bbox] if isinstance(raw_bbox, list) and len(raw_bbox) == 4 else None
    return PlaceCandidate(
        id=f"nominatim:{osm_type}:{object_id}",
        name=name,
        display_name=display_name or name,
        secondary_text=_secondary_text(name, display_name),
        latitude=float(item["lat"]),
        longitude=float(item["lon"]),
        category=str(item.get("category") or item.get("class") or "place"),
        type=str(item.get("type") or "place"),
        bounding_box=bbox,
        attribution=str(item.get("licence") or OSM_ATTRIBUTION),
    )


class NominatimProvider:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self.settings = settings
        self.client = client

    @property
    def headers(self) -> dict[str, str]:
        return {
            "User-Agent": self.settings.nominatim_identification,
            "Accept-Language": self.settings.nominatim_language,
            "Accept": "application/json",
        }

    def _get(self, path: str, params: dict[str, str | int]) -> object:
        url = f"{self.settings.nominatim_base_url.rstrip('/')}/{path.lstrip('/')}"
        started = time.perf_counter()
        try:
            if self.client is not None:
                response = self.client.get(url, params=params, headers=self.headers)
            else:
                with httpx.Client(timeout=self.settings.nominatim_timeout_seconds, follow_redirects=True) as client:
                    response = client.get(url, params=params, headers=self.headers)
            response.raise_for_status()
            logger.info(
                "geocoder_upstream operation=%s status=%s elapsed_ms=%s",
                path,
                response.status_code,
                round((time.perf_counter() - started) * 1000),
            )
            return response.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            logger.warning(
                "geocoder_upstream operation=%s status=%s elapsed_ms=%s",
                path,
                status,
                round((time.perf_counter() - started) * 1000),
            )
            raise GeocodingProviderError(
                f"Nominatim returned HTTP {status}",
                retryable=status == 429 or status >= 500,
                status_code=status,
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "geocoder_upstream operation=%s status=unavailable elapsed_ms=%s",
                path,
                round((time.perf_counter() - started) * 1000),
            )
            raise GeocodingProviderError("Nominatim is temporarily unavailable", retryable=True) from exc

    def search(self, query: str, limit: int) -> list[PlaceCandidate]:
        payload = self._get(
            "search",
            {
                "q": query,
                "format": "jsonv2",
                "addressdetails": 1,
                "limit": limit,
                "countrycodes": self.settings.nominatim_country_codes,
                "viewbox": self.settings.nominatim_viewbox,
                "bounded": int(self.settings.nominatim_bounded),
                "accept-language": self.settings.nominatim_language,
            },
        )
        if not isinstance(payload, list):
            raise GeocodingProviderError("Nominatim returned an invalid search response", retryable=True)
        return [_candidate(item) for item in payload if isinstance(item, dict) and item.get("lat") is not None and item.get("lon") is not None]

    def reverse(self, lat: float, lon: float) -> PlaceCandidate | None:
        payload = self._get(
            "reverse",
            {
                "lat": str(lat),
                "lon": str(lon),
                "format": "jsonv2",
                "addressdetails": 1,
                "zoom": 18,
                "accept-language": self.settings.nominatim_language,
            },
        )
        if isinstance(payload, dict) and payload.get("error"):
            return None
        if not isinstance(payload, dict) or payload.get("lat") is None or payload.get("lon") is None:
            return None
        return _candidate(payload)


def canonical_search_key(query: str, limit: int, settings: Settings) -> str:
    normalised = _normalise_space(query).casefold()
    raw = f"search|{normalised}|{limit}|{settings.nominatim_language}|{settings.nominatim_country_codes}|{settings.nominatim_viewbox}"
    return f"geocoding:v1:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def canonical_reverse_key(lat: float, lon: float, settings: Settings) -> str:
    raw = f"reverse|{lat:.5f}|{lon:.5f}|{settings.nominatim_language}"
    return f"geocoding:v1:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def acquire_public_permit(
    redis: Redis,
    wait_seconds: float,
    *,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    started = monotonic()
    last_now = started
    deadline = started + wait_seconds
    while True:
        try:
            if redis.set(PUBLIC_PERMIT_KEY, str(time.time()), nx=True, px=1000):
                logger.info("geocoder_permit status=acquired wait_ms=%s", round((last_now - started) * 1000))
                return
        except RedisError as exc:
            raise GeocodingPolicyError("Geocoding policy limiter is unavailable", retryable=True) from exc
        last_now = monotonic()
        remaining = deadline - last_now
        if remaining <= 0:
            logger.warning("geocoder_permit status=timeout wait_ms=%s", round((last_now - started) * 1000))
            raise GeocodingPolicyError("Geocoding is busy; retry shortly", retryable=True, status_code=429)
        sleep(min(0.05, remaining))


class GeocodingService:
    def __init__(self, provider: GeocoderProvider, redis: Redis, settings: Settings):
        self.provider = provider
        self.redis = redis
        self.settings = settings

    def _cached(self, key: str) -> object | None:
        try:
            raw = self.redis.get(key)
        except RedisError:
            return None
        return json.loads(raw) if raw else None

    def _store(self, key: str, value: object, ttl: int) -> None:
        try:
            self.redis.setex(key, ttl, json.dumps(value))
        except RedisError:
            pass

    def _permit(self) -> None:
        if self.settings.nominatim_public_policy:
            acquire_public_permit(self.redis, self.settings.geocoding_rate_wait_seconds)

    def search(self, query: str, limit: int) -> tuple[list[PlaceCandidate], str]:
        key = canonical_search_key(query, limit, self.settings)
        cached = self._cached(key)
        if isinstance(cached, list):
            logger.info("geocoder_request operation=search cache=hit result_count=%s", len(cached))
            return [PlaceCandidate.model_validate(item) for item in cached], "hit"
        self._permit()
        cached = self._cached(key)
        if isinstance(cached, list):
            logger.info("geocoder_request operation=search cache=hit_after_permit result_count=%s", len(cached))
            return [PlaceCandidate.model_validate(item) for item in cached], "hit"
        candidates = self.provider.search(_normalise_space(query), limit)
        ttl = self.settings.geocoding_cache_ttl_seconds if candidates else self.settings.geocoding_negative_cache_ttl_seconds
        self._store(key, [item.model_dump() for item in candidates], ttl)
        logger.info("geocoder_request operation=search cache=miss result_count=%s", len(candidates))
        return candidates, "miss"

    def reverse(self, lat: float, lon: float) -> tuple[PlaceCandidate | None, str]:
        key = canonical_reverse_key(lat, lon, self.settings)
        cached = self._cached(key)
        if cached == {"candidate": None}:
            logger.info("geocoder_request operation=reverse cache=hit result_count=0")
            return None, "hit"
        if isinstance(cached, dict) and isinstance(cached.get("candidate"), dict):
            logger.info("geocoder_request operation=reverse cache=hit result_count=1")
            return PlaceCandidate.model_validate(cached["candidate"]), "hit"
        self._permit()
        cached = self._cached(key)
        if cached == {"candidate": None}:
            logger.info("geocoder_request operation=reverse cache=hit_after_permit result_count=0")
            return None, "hit"
        if isinstance(cached, dict) and isinstance(cached.get("candidate"), dict):
            logger.info("geocoder_request operation=reverse cache=hit_after_permit result_count=1")
            return PlaceCandidate.model_validate(cached["candidate"]), "hit"
        candidate = self.provider.reverse(lat, lon)
        self._store(key, {"candidate": candidate.model_dump() if candidate else None}, self.settings.geocoding_reverse_cache_ttl_seconds)
        logger.info("geocoder_request operation=reverse cache=miss result_count=%s", 1 if candidate else 0)
        return candidate, "miss"
