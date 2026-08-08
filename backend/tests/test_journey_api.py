import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response

from app.api.routes.journeys import enrich_realtime, plan
from app.core.config import Settings
from app.models import JourneyEndpoint, JourneyPlanRequest, JourneyPlanResponse


def point(stop_id, name):
    return {"stop_id": stop_id, "name": name, "latitude": -36.8, "longitude": 174.7}


def transit_leg(index, shape_id="shape-1"):
    return {
        "type": "transit",
        "route_id": f"R{index}",
        "route_short_name": f"R{index}",
        "route_long_name": f"Route {index}",
        "route_type": 3,
        "route_color": "0072CE",
        "route_text_color": "FFFFFF",
        "trip_id": f"T{index}",
        "direction_id": 0,
        "shape_id": shape_id,
        "headsign": "City",
        "service_date": "2026-08-10",
        "from": point(f"S{index}", f"Stop {index}"),
        "to": point(f"S{index + 1}", f"Stop {index + 1}"),
        "scheduled_departure": f"2026-08-10T08:{index}0:00+12:00",
        "scheduled_arrival": f"2026-08-10T08:{index}5:00+12:00",
    }


def result_fixture(feed_version="feed-1"):
    legs = [transit_leg(1), transit_leg(2, shape_id=None), transit_leg(3)]
    return {
        "feed_version": feed_version,
        "service_date": "2026-08-10",
        "status": "ok",
        "options": [
            {
                "id": "option-1",
                "departure_time": "2026-08-10T08:00:00+12:00",
                "duration_seconds": 2700,
                "transfers": 2,
                "legs": legs,
            }
        ],
    }


class FakeRealtimeRedis:
    def __init__(self, feed_version="feed-1"):
        self.values = {"gtfsrt:feed_version": feed_version, "gtfsrt:generated_at": "2026-08-10T08:00:00Z"}
        self.hashes = {
            "gtfsrt:trip_updates": {
                "T1": json.dumps({"trip_id": "T1", "route_id": "R1", "delay": 60}),
            },
            "gtfsrt:alerts": {
                "A1": json.dumps({"alert_id": "A1", "route_ids": ["R1"], "header": "Delay"}),
            },
        }
        self.sets = {"gtfsrt:alert_ids_by_route:R1": {"A1"}}

    def get(self, key):
        return self.values.get(key)

    def hmget(self, key, item_ids):
        return [self.hashes.get(key, {}).get(item_id) for item_id in item_ids]

    def smembers(self, key):
        return self.sets.get(key, set())

    def hvals(self, key):
        return list(self.hashes.get(key, {}).values())


def test_response_serializes_three_transit_legs_and_missing_shape():
    enriched = {**result_fixture(), "realtime_status": "unavailable", "realtime_generated_at": None}

    response = JourneyPlanResponse.model_validate(enriched)
    payload = response.model_dump(by_alias=True, mode="json")

    assert payload["options"][0]["transfers"] == 2
    assert [leg["trip_id"] for leg in payload["options"][0]["legs"]] == ["T1", "T2", "T3"]
    assert payload["options"][0]["legs"][1]["shape_id"] is None
    assert payload["options"][0]["legs"][0]["from"]["stop_id"] == "S1"


def test_realtime_enrichment_requires_matching_feed_version():
    current = enrich_realtime(result_fixture(), FakeRealtimeRedis("feed-1"))
    mismatched = enrich_realtime(result_fixture(), FakeRealtimeRedis("feed-2"))

    first_leg = current["options"][0]["legs"][0]
    assert current["realtime_status"] == "current"
    assert first_leg["realtime"]["delay"] == 60
    assert first_leg["alerts"][0]["alert_id"] == "A1"
    assert mismatched["realtime_status"] == "mismatched"
    assert mismatched["options"][0]["legs"][0]["realtime"] is None


def test_unconfirmed_endpoint_is_rejected_before_planning():
    body = JourneyPlanRequest(
        origin=JourneyEndpoint(name="Origin", latitude=-36.8, longitude=174.7, confirmed=False),
        destination=JourneyEndpoint(name="Destination", latitude=-36.9, longitude=174.8, confirmed=True),
        departure_time=datetime.fromisoformat("2026-08-10T08:00:00+12:00"),
    )

    with pytest.raises(HTTPException) as exc_info:
        plan(
            body=body,
            user={"id": 1},
            conn=SimpleNamespace(),
            redis=SimpleNamespace(),
            settings=Settings(_env_file=None),
            response=Response(),
        )

    assert exc_info.value.status_code == 422
