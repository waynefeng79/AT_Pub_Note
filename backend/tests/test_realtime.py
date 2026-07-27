from pathlib import Path
import json
from tempfile import gettempdir
from uuid import uuid4

from google.transit import gtfs_realtime_pb2

from app.services.realtime import RealtimeNormalizer
from app.services.realtime import RealtimeService
from app.api.routes.realtime import matches_refresh


def test_protobuf_realtime_feed_normalizes_to_api_shape():
    message_type = getattr(gtfs_realtime_pb2, "FeedMessage")
    message = message_type()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = 1780372941

    vehicle_entity = message.entity.add()
    vehicle_entity.id = "vehicle-entity"
    vehicle_entity.vehicle.trip.trip_id = "trip-1"
    vehicle_entity.vehicle.trip.route_id = "NX1-203"
    vehicle_entity.vehicle.trip.direction_id = 1
    vehicle_entity.vehicle.trip.schedule_relationship = gtfs_realtime_pb2.TripDescriptor.ADDED
    vehicle_entity.vehicle.vehicle.id = "bus-123"
    vehicle_entity.vehicle.position.latitude = -36.8485
    vehicle_entity.vehicle.position.longitude = 174.7633
    vehicle_entity.vehicle.position.bearing = 120
    vehicle_entity.vehicle.timestamp = 1780372940

    update_entity = message.entity.add()
    update_entity.id = "trip-update-entity"
    update_entity.trip_update.trip.trip_id = "trip-1"
    update_entity.trip_update.trip.route_id = "NX1-203"
    update_entity.trip_update.delay = 60
    stop_update = update_entity.trip_update.stop_time_update.add()
    stop_update.stop_sequence = 4
    stop_update.stop_id = "stop-1"
    stop_update.departure.delay = 60
    stop_update.departure.time = 1780373000

    alert_entity = message.entity.add()
    alert_entity.id = "alert-entity"
    alert_entity.alert.informed_entity.add().route_id = "NX1-203"
    alert_entity.alert.informed_entity.add().trip.trip_id = "trip-1"
    alert_entity.alert.cause = gtfs_realtime_pb2.Alert.CONSTRUCTION
    alert_entity.alert.effect = gtfs_realtime_pb2.Alert.DETOUR
    alert_entity.alert.severity_level = gtfs_realtime_pb2.Alert.WARNING
    header = alert_entity.alert.header_text.translation.add()
    header.text = "Route detour"
    header.language = "en"
    description = alert_entity.alert.description_text.translation.add()
    description.text = "Temporary route in place"
    description.language = "en"

    path = Path(gettempdir()) / f"at_pub_note_{uuid4().hex}.pb"
    path.write_bytes(message.SerializeToString())

    try:
        normalizer = RealtimeNormalizer("protobuf")
        snapshot = normalizer.normalize(normalizer.parse(path.read_bytes(), str(path)))

        assert snapshot["generated_at"] == "2026-06-02T04:02:21+00:00"
        assert snapshot["vehicles"][0]["vehicle_id"] == "bus-123"
        assert snapshot["vehicles"][0]["route_id"] == "NX1-203"
        assert snapshot["vehicles"][0]["schedule_relationship"] == "ADDED"
        assert snapshot["trip_updates"][0]["delay"] == 60
        assert snapshot["trip_updates"][0]["stop_time_updates"][0]["departure"]["time"] == 1780373000
        assert snapshot["alerts"][0]["cause"] == "CONSTRUCTION"
        assert snapshot["alerts"][0]["effect"] == "DETOUR"
        assert snapshot["alerts"][0]["header"] == "Route detour"
        assert snapshot["alerts"][0]["trip_ids"] == ["trip-1"]
    finally:
        path.unlink(missing_ok=True)


def test_http_content_type_selects_protobuf_without_file_extension():
    message_type = getattr(gtfs_realtime_pb2, "FeedMessage")
    message = message_type()
    message.header.gtfs_realtime_version = "2.0"

    parsed = RealtimeNormalizer("auto").parse(
        message.SerializeToString(),
        "https://api.at.govt.nz/realtime/legacy",
        "application/x-protobuf; charset=binary",
    )

    assert parsed["response"]["header"]["gtfs_realtime_version"] == "2.0"


def test_json_vehicle_schedule_relationship_numbers_are_normalized():
    raw = {
        "response": {
            "header": {"timestamp": 1780372941},
            "entity": [
                {
                    "id": "vehicle-entity",
                    "vehicle": {
                        "trip": {
                            "trip_id": "1306-94102-55800-2-b8089d6a",
                            "start_time": "15:30:00",
                            "start_date": "20260602",
                            "schedule_relationship": 0,
                            "route_id": "941-203",
                            "direction_id": 1,
                        },
                        "position": {
                            "latitude": -36.7799653,
                            "longitude": 174.7475262,
                            "bearing": "274",
                            "speed": 9,
                        },
                        "timestamp": 1780372565,
                        "vehicle": {"id": "22850", "label": "RT1397", "license_plate": "LMW308"},
                        "occupancy_status": 3,
                    },
                }
            ],
        }
    }

    snapshot = RealtimeNormalizer("json").normalize(raw)

    assert snapshot["vehicles"][0]["schedule_relationship"] == "SCHEDULED"
    assert snapshot["vehicles"][0]["route_id"] == "941-203"
    assert snapshot["vehicles"][0]["direction_id"] == 1


class FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.calls = []

    def delete(self, *keys):
        self.calls.append(("delete", keys))
        for key in keys:
            self.redis.values.pop(key, None)
            self.redis.hashes.pop(key, None)
            self.redis.sets.pop(key, None)

    def hset(self, key, field, value):
        self.calls.append(("hset", key, field, value))
        self.redis.hashes.setdefault(key, {})[field] = value

    def sadd(self, key, *values):
        self.calls.append(("sadd", key, values))
        self.redis.sets.setdefault(key, set()).update(values)

    def set(self, key, value):
        self.calls.append(("set", key, value))
        self.redis.values[key] = value

    def publish(self, channel, payload):
        self.calls.append(("publish", channel, payload))

    def execute(self):
        self.calls.append(("execute",))


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.hashes = {}
        self.sets = {}
        self.last_pipeline = None
        self.hvals_calls = []

    def pipeline(self):
        self.last_pipeline = FakePipeline(self)
        return self.last_pipeline

    def get(self, key):
        return self.values.get(key)

    def hvals(self, key):
        self.hvals_calls.append(key)
        return list(self.hashes.get(key, {}).values())

    def hmget(self, key, fields):
        return [self.hashes.get(key, {}).get(field) for field in fields]

    def smembers(self, key):
        return set(self.sets.get(key, set()))


def test_realtime_snapshot_stores_and_returns_feed_version():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [{"vehicle_id": "bus-1", "route_id": "NX1"}],
        "trip_updates": [{"trip_id": "trip-1", "route_id": "NX1", "stop_time_updates": []}],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    result = service.snapshot("trip_updates", type("Filters", (), {"route_ids": [], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []})())

    assert result["feed_version"] == "feed-1"
    assert result["generated_at"] == "2026-06-02T04:02:21+00:00"
    assert result["items"][0]["trip_id"] == "trip-1"


def test_realtime_snapshot_publish_payload_includes_route_and_trip_scope():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [{"vehicle_id": "bus-1", "route_id": "NX1", "trip_id": "trip-1"}],
        "trip_updates": [{"trip_id": "trip-2", "route_id": "NX2", "stop_time_updates": []}],
        "alerts": [{"alert_id": "alert-1", "route_ids": ["NX3"]}],
    }

    RealtimeService(redis).store_snapshot(snapshot, "feed-1")

    publish_call = next(call for call in redis.last_pipeline.calls if call[0] == "publish")
    payload = json.loads(publish_call[2])
    assert payload["feed_version"] == "feed-1"
    assert payload["route_ids"] == ["NX1", "NX2", "NX3"]
    assert payload["trip_ids"] == ["trip-1", "trip-2"]


def test_trip_scoped_alert_is_returned_for_its_route():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [],
        "trip_updates": [{"trip_id": "trip-1", "route_id": "NX1", "stop_time_updates": []}],
        "alerts": [{"alert_id": "alert-1", "route_ids": [], "trip_ids": ["trip-1"], "stop_ids": []}],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    result = service.snapshot(
        "alerts",
        type(
            "Filters",
            (),
            {"route_ids": ["NX1"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert result["items"][0]["alert_id"] == "alert-1"
    assert result["items"][0]["route_ids"] == ["NX1"]


def test_trip_scoped_alert_can_use_static_trip_route_mapping():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [],
        "trip_updates": [],
        "alerts": [{"alert_id": "alert-1", "route_ids": [], "trip_ids": ["trip-1"], "stop_ids": []}],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1", {"trip-1": "NX1"})
    result = service.snapshot(
        "alerts",
        type(
            "Filters",
            (),
            {"route_ids": ["NX1"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert result["items"][0]["alert_id"] == "alert-1"
    assert result["items"][0]["route_ids"] == ["NX1"]


def test_duplicate_alert_content_is_collapsed_for_route_display():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [],
        "trip_updates": [],
        "alerts": [
            {
                "alert_id": "alert-1",
                "route_ids": [],
                "trip_ids": ["trip-1"],
                "stop_ids": [],
                "cause": "UNKNOWN_CAUSE",
                "effect": "SIGNIFICANT_DELAYS",
                "severity_level": "WARNING",
                "header": "Eastern Line delays",
                "description": "Expect delays due to an earlier incident.",
            },
            {
                "alert_id": "alert-2",
                "route_ids": [],
                "trip_ids": ["trip-2"],
                "stop_ids": [],
                "cause": "UNKNOWN_CAUSE",
                "effect": "SIGNIFICANT_DELAYS",
                "severity_level": "WARNING",
                "header": "Eastern Line delays",
                "description": "Expect delays due to an earlier incident.",
            },
        ],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1", {"trip-1": "EAST", "trip-2": "EAST"})
    result = service.snapshot(
        "alerts",
        type(
            "Filters",
            (),
            {"route_ids": ["EAST"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert len(result["items"]) == 1
    assert result["items"][0]["route_ids"] == ["EAST"]
    assert result["items"][0]["trip_ids"] == ["trip-1", "trip-2"]
    assert result["items"][0]["source_alert_ids"] == ["alert-1", "alert-2"]


def test_realtime_refresh_filters_match_requested_scope():
    payload = {
        "event_types": ["vehicles", "alerts"],
        "route_ids": ["NX1"],
        "trip_ids": ["trip-1"],
    }

    assert matches_refresh(payload, ["NX1"], [], ["vehicles"])
    assert matches_refresh(payload, [], ["trip-1"], [])
    assert not matches_refresh(payload, ["NX2"], [], [])
    assert not matches_refresh(payload, [], ["trip-2"], [])
    assert not matches_refresh(payload, [], [], ["trip_updates"])


def test_realtime_snapshot_filters_by_direction_id():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [
            {"vehicle_id": "bus-1", "route_id": "NX1", "direction_id": 0},
            {"vehicle_id": "bus-2", "route_id": "NX1", "direction_id": 1},
        ],
        "trip_updates": [],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": ["NX1"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": [1]},
        )(),
    )

    assert [item["vehicle_id"] for item in result["items"]] == ["bus-2"]


def test_realtime_snapshot_uses_route_index_for_vehicles():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [
            {"vehicle_id": "bus-1", "route_id": "NX1", "direction_id": 0},
            {"vehicle_id": "bus-2", "route_id": "NX2", "direction_id": 0},
        ],
        "trip_updates": [],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": ["NX1"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert [item["vehicle_id"] for item in result["items"]] == ["bus-1"]
    assert redis.hvals_calls == []


def test_realtime_snapshot_keeps_scheduled_and_extra_service_vehicles():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [
            {
                "vehicle_id": "scheduled",
                "route_id": "EAST",
                "trip_id": "trip-1",
                "schedule_relationship": "SCHEDULED",
            },
            {
                "vehicle_id": "added",
                "route_id": "EAST",
                "trip_id": "trip-2",
                "schedule_relationship": "ADDED",
            },
            {
                "vehicle_id": "replacement",
                "route_id": "EAST",
                "trip_id": "trip-5",
                "schedule_relationship": "REPLACEMENT",
            },
            {
                "vehicle_id": "duplicated",
                "route_id": "EAST",
                "trip_id": "trip-6",
                "schedule_relationship": "DUPLICATED",
            },
            {
                "vehicle_id": "unscheduled",
                "route_id": "EAST",
                "trip_id": "trip-7",
                "schedule_relationship": "UNSCHEDULED",
            },
            {
                "vehicle_id": "canceled",
                "route_id": "EAST",
                "trip_id": "trip-8",
                "schedule_relationship": "CANCELED",
            },
            {
                "vehicle_id": "extra-without-route",
                "trip_id": "trip-9",
                "schedule_relationship": "ADDED",
            },
            {
                "vehicle_id": "scheduled-without-static-trip",
                "route_id": "EAST",
                "trip_id": "trip-3",
                "schedule_relationship": "SCHEDULED",
            },
            {
                "vehicle_id": "wrong-route",
                "route_id": "WEST",
                "trip_id": "trip-4",
                "schedule_relationship": "SCHEDULED",
            },
        ],
        "trip_updates": [],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(
        snapshot,
        "feed-1",
        {"trip-1": "EAST", "trip-4": "EAST"},
    )
    result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": ["EAST"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert sorted(item["vehicle_id"] for item in result["items"]) == [
        "added",
        "duplicated",
        "replacement",
        "scheduled",
        "scheduled-without-static-trip",
    ]


def test_realtime_snapshot_collapses_duplicate_vehicles_for_same_trip():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [
            {
                "vehicle_id": "HE0253",
                "vehicle_label": "HE0253",
                "route_id": "EAST",
                "trip_id": "trip-1",
                "timestamp": 10,
            },
            {
                "vehicle_id": "HE0507",
                "vehicle_label": "HE0507",
                "route_id": "EAST",
                "trip_id": "trip-1",
                "timestamp": 20,
            },
        ],
        "trip_updates": [],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    route_result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": ["EAST"], "trip_ids": [], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )
    trip_result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": [], "trip_ids": ["trip-1"], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert [item["vehicle_label"] for item in route_result["items"]] == ["HE0507"]
    assert [item["vehicle_label"] for item in trip_result["items"]] == ["HE0507"]


def test_realtime_snapshot_uses_trip_hash_for_timetable_vehicle_lookup():
    redis = FakeRedis()
    snapshot = {
        "generated_at": "2026-06-02T04:02:21+00:00",
        "vehicles": [
            {"vehicle_id": "bus-1", "route_id": "NX1", "trip_id": "trip-1"},
            {"vehicle_id": "bus-2", "route_id": "NX2", "trip_id": "trip-2"},
        ],
        "trip_updates": [
            {"trip_id": "trip-1", "route_id": "NX1", "stop_time_updates": []},
            {"trip_id": "trip-2", "route_id": "NX2", "stop_time_updates": []},
        ],
        "alerts": [],
    }

    service = RealtimeService(redis)
    service.store_snapshot(snapshot, "feed-1")
    vehicle_result = service.snapshot(
        "vehicles",
        type(
            "Filters",
            (),
            {"route_ids": [], "trip_ids": ["trip-2"], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )
    update_result = service.snapshot(
        "trip_updates",
        type(
            "Filters",
            (),
            {"route_ids": [], "trip_ids": ["trip-2"], "vehicle_ids": [], "stop_ids": [], "direction_ids": []},
        )(),
    )

    assert [item["vehicle_id"] for item in vehicle_result["items"]] == ["bus-2"]
    assert [item["trip_id"] for item in update_result["items"]] == ["trip-2"]
    assert redis.hvals_calls == []
