import json

import httpx
import pytest

from app.core.config import Settings
from app.models import PlaceCandidate
from app.services.geocoding import (
    GeocodingPolicyError,
    GeocodingService,
    NominatimProvider,
    acquire_public_permit,
    canonical_search_key,
)


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.ttls = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, ttl, value):
        self.values[key] = value
        self.ttls[key] = ttl

    def set(self, key, value, nx=False, px=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        self.ttls[key] = px
        return True


class FakeProvider:
    def __init__(self, candidates=None, reverse_candidate=None):
        self.candidates = candidates or []
        self.reverse_candidate = reverse_candidate
        self.search_calls = []
        self.reverse_calls = []

    def search(self, query, limit):
        self.search_calls.append((query, limit))
        return self.candidates[:limit]

    def reverse(self, lat, lon):
        self.reverse_calls.append((lat, lon))
        return self.reverse_candidate


def candidate(name="Britomart"):
    return PlaceCandidate(
        id="nominatim:node:1",
        name=name,
        display_name=f"{name}, Auckland, New Zealand",
        secondary_text="Auckland, New Zealand",
        latitude=-36.844,
        longitude=174.768,
        category="railway",
        type="station",
        attribution="© OpenStreetMap contributors",
    )


def settings(**values):
    return Settings(_env_file=None, nominatim_contact="ops@example.test", **values)


def test_nominatim_search_normalises_multiple_candidates_and_headers():
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "place_id": 10,
                    "osm_type": "node",
                    "osm_id": 20,
                    "name": "Victoria Park",
                    "display_name": "Victoria Park, Auckland Central, Auckland, New Zealand",
                    "lat": "-36.849",
                    "lon": "174.750",
                    "category": "leisure",
                    "type": "park",
                },
                {
                    "place_id": 11,
                    "osm_type": "way",
                    "osm_id": 21,
                    "display_name": "Victoria Park Market, Freemans Bay, Auckland, New Zealand",
                    "lat": "-36.848",
                    "lon": "174.748",
                    "category": "shop",
                    "type": "mall",
                },
            ],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    provider = NominatimProvider(settings(nominatim_base_url="https://nominatim.test"), client)

    items = provider.search("Victoria Park", 8)

    assert [item.id for item in items] == ["nominatim:node:20", "nominatim:way:21"]
    assert items[0].secondary_text.startswith("Auckland Central")
    assert requests[0].url.params["countrycodes"] == "nz"
    assert requests[0].url.params["bounded"] == "1"
    assert "ops@example.test" in requests[0].headers["user-agent"]


def test_service_cache_hit_avoids_provider_and_public_permit():
    config = settings()
    redis = FakeRedis()
    key = canonical_search_key("Britomart", 5, config)
    redis.values[key] = json.dumps([candidate().model_dump()])
    provider = FakeProvider([candidate("Should not run")])

    items, cache = GeocodingService(provider, redis, config).search("Britomart", 5)

    assert cache == "hit"
    assert items[0].name == "Britomart"
    assert provider.search_calls == []


def test_waiting_request_rechecks_cache_after_public_permit():
    config = settings()
    redis = FakeRedis()
    key = canonical_search_key("Britomart", 5, config)
    provider = FakeProvider([candidate("Duplicate upstream call")])
    service = GeocodingService(provider, redis, config)
    service._permit = lambda: redis.values.__setitem__(key, json.dumps([candidate().model_dump()]))

    items, cache = service.search("Britomart", 5)

    assert cache == "hit"
    assert items[0].name == "Britomart"
    assert provider.search_calls == []


def test_public_permit_rejects_a_second_request_inside_interval():
    redis = FakeRedis()
    acquire_public_permit(redis, 0)

    times = iter([0.0, 1.0])
    with pytest.raises(GeocodingPolicyError):
        acquire_public_permit(redis, 0.1, monotonic=lambda: next(times), sleep=lambda _: None)


def test_private_policy_profile_skips_public_permit_and_preserves_contract():
    config = settings(nominatim_public_policy=False, nominatim_base_url="https://private-nominatim.test")
    redis = FakeRedis()
    redis.values["geocoding:nominatim:public-permit"] = "busy"
    provider = FakeProvider([candidate()])

    items, cache = GeocodingService(provider, redis, config).search("Britomart", 5)

    assert cache == "miss"
    assert items[0].model_dump()["id"] == "nominatim:node:1"
    assert provider.search_calls == [("Britomart", 5)]


def test_reverse_no_match_is_cached_without_invalidating_coordinates():
    config = settings(nominatim_public_policy=False)
    redis = FakeRedis()
    provider = FakeProvider(reverse_candidate=None)
    service = GeocodingService(provider, redis, config)

    first, first_cache = service.reverse(-36.85, 174.76)
    second, second_cache = service.reverse(-36.85, 174.76)

    assert first is None and second is None
    assert first_cache == "miss" and second_cache == "hit"
    assert provider.reverse_calls == [(-36.85, 174.76)]
