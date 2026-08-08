import os
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.routes.journeys import enrich_realtime
from app.core.config import get_settings
from app.repositories.gtfs import GtfsRepository
from app.services.geocoding import GeocodingPolicyError, PUBLIC_PERMIT_KEY, acquire_public_permit
from app.services.journey_planner import JourneyPlanner, build_timetable_index
from app.services.realtime import RealtimeService

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION_TESTS") != "1",
    reason="Requires running PostgreSQL/PostGIS and Redis; set RUN_DB_INTEGRATION_TESTS=1 after importing GTFS.",
)


def test_static_feed_has_cache_headers_with_real_services():
    with TestClient(app) as client:
        response = client.get("/api/static/v1/feed")
        assert response.status_code == 200
        assert response.headers["cache-control"].startswith("public, max-age=60")
        assert response.headers["etag"]
        assert response.headers["x-gtfs-feed-version"] == response.json()["feed_version"]


def test_real_redis_enforces_the_shared_public_geocoder_permit():
    with TestClient(app):
        redis = app.state.redis.client
        redis.delete(PUBLIC_PERMIT_KEY)
        acquire_public_permit(redis, 0)
        with pytest.raises(GeocodingPolicyError):
            acquire_public_permit(redis, 0)
        redis.delete(PUBLIC_PERMIT_KEY)


def test_real_postgis_route_chain_planner_returns_a_feed_pinned_result():
    with TestClient(app):
        with app.state.db.connection() as conn:
            repo = GtfsRepository(conn)
            feed = repo.active_feed()
            assert feed is not None
            feed_version = str(feed["feed_version"])
            index = build_timetable_index(repo, feed_version)
            service_date = datetime.now(ZoneInfo("Pacific/Auckland")).date()
            selected_trip = next(
                trip
                for trip in index.trips
                if len(trip.stop_times) >= 2 and index.service_active(trip.service_id, service_date)
            )
            origin = index.stops[selected_trip.stop_times[0].stop_id]
            destination = index.stops[selected_trip.stop_times[-1].stop_id]
            departure_seconds = max(0, selected_trip.stop_times[0].departure_seconds - 60)
            departure = datetime.combine(service_date, time.min, ZoneInfo("Pacific/Auckland")) + timedelta(seconds=departure_seconds)
            result = JourneyPlanner(index, repo, get_settings()).plan(
                origin_name=origin.name, origin_lat=origin.lat, origin_lon=origin.lon,
                destination_name=destination.name, destination_lat=destination.lat, destination_lon=destination.lon,
                departure=departure, option_limit=5,
            )
            assert result["feed_version"] == feed_version
            assert result["status"] == "ok"
            assert result["options"]


def test_real_redis_realtime_enrichment_and_version_mismatch_are_controlled():
    result = {
        "feed_version": "feed-integration",
        "service_date": "2026-08-08",
        "status": "ok",
        "options": [{"legs": [{"type": "transit", "trip_id": "trip-integration", "route_id": "route-integration"}]}],
    }
    with TestClient(app):
        redis = app.state.redis.client
        service = RealtimeService(redis)
        service.store_snapshot({
            "generated_at": "2026-08-08T00:00:00Z",
            "vehicles": [],
            "trip_updates": [{"trip_id": "trip-integration", "route_id": "route-integration", "delay": 60, "stop_time_updates": []}],
            "alerts": [{"alert_id": "alert-integration", "route_ids": ["route-integration"], "stop_ids": [], "header": "Test", "description": None, "cause": None, "effect": None, "severity_level": None}],
        }, "feed-integration")
        current = enrich_realtime(result, redis)
        assert current["realtime_status"] == "current"
        assert current["options"][0]["legs"][0]["realtime"]["delay"] == 60
        service.store_snapshot({"generated_at": "2026-08-08T00:01:00Z", "vehicles": [], "trip_updates": [], "alerts": []}, "new-feed")
        mismatched = enrich_realtime(result, redis)
        assert mismatched["realtime_status"] == "mismatched"
        assert mismatched["options"][0]["legs"][0]["realtime"] is None

