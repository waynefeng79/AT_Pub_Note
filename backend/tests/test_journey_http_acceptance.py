from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import current_user, get_conn, get_redis_client
from app.api.routes import geocoding, journeys, static
from app.core.config import Settings, get_settings
from app.services.geocoding import GeocodingProviderError


class RateLimitRedis:
    def incr(self, _key):
        return 1

    def expire(self, _key, _seconds):
        return True


class ActiveFeedRepository:
    def __init__(self, _conn):
        pass

    def active_feed(self):
        return {"feed_version": "feed-acceptance"}


def point(name: str, stop_id: str | None = None):
    return {"name": name, "latitude": -36.85, "longitude": 174.76, "stop_id": stop_id}


def transit_leg(number: int, service_date: str):
    return {
        "type": "transit",
        "route_id": f"R{number}",
        "route_short_name": f"R{number}",
        "route_long_name": f"Route {number}",
        "route_type": 3,
        "trip_id": f"T{number}",
        "direction_id": 0,
        "shape_id": f"shape-{number}",
        "service_date": service_date,
        "from": point(f"Stop {number}", f"S{number}"),
        "to": point(f"Stop {number + 1}", f"S{number + 1}"),
        "scheduled_departure": f"{service_date}T0{number}:00:00+12:00",
        "scheduled_arrival": f"{service_date}T0{number}:20:00+12:00",
    }


def journey_result(transit_count: int, service_date: str = "2026-08-10"):
    if transit_count == 0:
        return {"feed_version": "feed-acceptance", "service_date": service_date, "status": "no_journey", "options": []}
    legs = [transit_leg(number, service_date) for number in range(1, transit_count + 1)]
    return {
        "feed_version": "feed-acceptance",
        "service_date": service_date,
        "status": "ok",
        "options": [{
            "id": f"option-{transit_count}",
            "departure_time": f"{service_date}T01:00:00+12:00",
            "duration_seconds": 1200 * transit_count,
            "transfers": transit_count - 1,
            "legs": legs,
        }],
    }


def journey_client(monkeypatch, result: dict):
    app = FastAPI()
    app.include_router(journeys.router, prefix="/api/journeys/v1")
    app.dependency_overrides[current_user] = lambda: {"id": 7, "email": "rider@example.test"}
    app.dependency_overrides[get_conn] = lambda: object()
    app.dependency_overrides[get_redis_client] = RateLimitRedis
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, journey_planner_enabled=True)
    monkeypatch.setattr(journeys, "GtfsRepository", ActiveFeedRepository)
    monkeypatch.setattr(journeys, "planner_index_cache", SimpleNamespace(get=lambda _version, _builder: object()))
    monkeypatch.setattr(journeys, "JourneyPlanner", lambda _index, _repo, _settings: SimpleNamespace(plan=lambda **_kwargs: result))
    monkeypatch.setattr(
        journeys,
        "enrich_realtime",
        lambda value, _redis: {**value, "realtime_status": "unavailable", "realtime_generated_at": None},
    )
    return TestClient(app)


def request_payload(departure_time="2026-08-10T01:00:00+12:00"):
    return {
        "origin": {**point("Origin"), "confirmed": True},
        "destination": {**point("Destination"), "confirmed": True},
        "departure_time": departure_time,
        "option_limit": 5,
    }


@pytest.mark.parametrize("transit_count", [1, 2, 3])
def test_http_plan_accepts_direct_one_transfer_and_two_transfer_results(monkeypatch, transit_count):
    response = journey_client(monkeypatch, journey_result(transit_count)).post(
        "/api/journeys/v1/plan", json=request_payload()
    )

    assert response.status_code == 200
    body = response.json()
    assert len([leg for leg in body["options"][0]["legs"] if leg["type"] == "transit"]) == transit_count
    assert body["options"][0]["transfers"] == transit_count - 1
    assert body["realtime_status"] == "unavailable"


def test_http_plan_distinguishes_no_result(monkeypatch):
    response = journey_client(monkeypatch, journey_result(0)).post(
        "/api/journeys/v1/plan", json=request_payload()
    )

    assert response.status_code == 200
    assert response.json()["status"] == "no_journey"
    assert response.json()["options"] == []


def test_http_plan_preserves_post_midnight_service_date(monkeypatch):
    response = journey_client(monkeypatch, journey_result(1, "2026-08-10")).post(
        "/api/journeys/v1/plan", json=request_payload("2026-08-11T01:00:00+12:00")
    )

    assert response.status_code == 200
    assert response.json()["options"][0]["legs"][0]["service_date"] == "2026-08-10"


def test_public_geocoder_unavailable_has_a_retryable_http_contract(monkeypatch):
    app = FastAPI()
    app.include_router(geocoding.router, prefix="/api/geocoding/v1")
    app.dependency_overrides[current_user] = lambda: {"id": 7}
    app.dependency_overrides[get_redis_client] = lambda: object()
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, nominatim_contact="ops@example.test")

    class UnavailableService:
        def __init__(self, *_args):
            pass

        def search(self, _query, _limit):
            raise GeocodingProviderError("Nominatim is temporarily unavailable")

    monkeypatch.setattr(geocoding, "GeocodingService", UnavailableService)
    response = TestClient(app).get("/api/geocoding/v1/search?q=Britomart")

    assert response.status_code == 503
    assert response.json()["detail"]["retryable"] is True


def test_expired_planned_feed_has_an_explicit_http_signal(monkeypatch):
    app = FastAPI()
    app.include_router(static.router, prefix="/api/static/v1")
    app.dependency_overrides[get_conn] = lambda: object()

    class ExpiredFeedRepository:
        def __init__(self, _conn):
            pass

        def feed_metadata(self, _feed_version):
            return None

    monkeypatch.setattr(static, "GtfsRepository", ExpiredFeedRepository)
    response = TestClient(app).get("/api/static/v1/feeds/expired/trips/T1/stops")

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown feed version"
