from datetime import datetime
from zoneinfo import ZoneInfo

from app.core.config import Settings
from app.services.journey_planner import JourneyPlanner, PlannerStop, PlannerStopTime, PlannerTrip, RoutePattern, TimetableIndex, TimetableIndexCache


def seconds(value: str) -> int:
    hour, minute = (int(part) for part in value.split(":"))
    return hour * 3600 + minute * 60


def trip(trip_id, route_id, stop_ids, times):
    return PlannerTrip(trip_id, route_id, None, 0, stop_ids[-1], f"shape-{trip_id}", route_id, f"Route {route_id}", 3, "0072CE", "FFFFFF", tuple(PlannerStopTime(stop_id, index + 1, seconds(value), seconds(value)) for index, (stop_id, value) in enumerate(zip(stop_ids, times, strict=True))))


def index_for(*trips, coordinates=None, feed_version="feed-1"):
    stop_ids = sorted({time.stop_id for item in trips for time in item.stop_times})
    stops = {
        stop_id: PlannerStop(
            stop_id,
            stop_id,
            (coordinates or {}).get(stop_id, (0, float(index)))[0],
            (coordinates or {}).get(stop_id, (0, float(index)))[1],
            "station-b" if stop_id in {"B", "X"} else None,
        )
        for index, stop_id in enumerate(stop_ids)
    }
    patterns = []
    stop_patterns = {}
    for trip_index, item in enumerate(trips):
        pattern_id = len(patterns)
        patterns.append(RoutePattern(
            item.route_id,
            item.direction_id,
            tuple(stop_time.stop_id for stop_time in item.stop_times),
            (trip_index,),
            tuple((stop_time.departure_seconds,) if stop_time.pickup_type != 1 else () for stop_time in item.stop_times),
            tuple((trip_index,) if stop_time.pickup_type != 1 else () for stop_time in item.stop_times),
        ))
        for position, stop_time in enumerate(item.stop_times):
            stop_patterns.setdefault(stop_time.stop_id, []).append((pattern_id, position))
    return TimetableIndex(
        feed_version, stops, tuple(trips), {"station-b": ("B", "X")}, {}, {},
        patterns=tuple(patterns), stop_patterns={key: tuple(value) for key, value in stop_patterns.items()},
    )


class FakeRepo:
    def nearby_stops(self, feed_version, _lat, lon, _radius, _limit):
        return [{"stop_id": "A" if lon < 2 else "D", "distance_m": 10}]


class DestinationDistanceRepo:
    def nearby_stops(self, feed_version, _lat, lon, _radius, _limit):
        return [{"stop_id": "A", "distance_m": 10}] if lon < 2 else [
            {"stop_id": "D", "distance_m": 500},
            {"stop_id": "E", "distance_m": 50},
        ]


def plan(index):
    return JourneyPlanner(index, FakeRepo(), Settings(_env_file=None)).plan(origin_name="Origin", origin_lat=0, origin_lon=0, destination_name="Destination", destination_lat=0, destination_lon=3, departure=datetime(2026, 8, 10, 8, tzinfo=ZoneInfo("Pacific/Auckland")), option_limit=5)


def test_direct_one_and_two_transfer_chains_use_in_vehicle_duration_only():
    result = plan(index_for(trip("direct", "D", ("A", "D"), ("08:05", "08:25")), trip("one-a", "A", ("A", "B"), ("08:06", "08:12")), trip("one-b", "B", ("B", "D"), ("08:15", "08:25")), trip("two-a", "X", ("A", "B"), ("08:07", "08:10")), trip("two-b", "Y", ("B", "C"), ("08:13", "08:17")), trip("two-c", "Z", ("C", "D"), ("08:20", "08:26"))))
    assert {item["transfers"] for item in result["options"]} == {0, 1, 2}
    assert all(
        item["duration_seconds"] == sum(
            datetime.fromisoformat(leg["scheduled_arrival"]).timestamp() - datetime.fromisoformat(leg["scheduled_departure"]).timestamp()
            for leg in item["legs"]
        )
        for item in result["options"]
    )
    assert all("walking_seconds" not in item and "arrival_time" not in item for item in result["options"])


def test_later_leg_must_be_running_after_first_arrival_and_transfer_buffer():
    result = plan(index_for(trip("first", "A", ("A", "B"), ("08:05", "08:15")), trip("missed", "B", ("B", "D"), ("08:16", "08:25"))))
    assert result["status"] == "no_journey"


def test_parent_station_transfer_is_allowed_and_duplicate_chains_are_removed():
    result = plan(index_for(
        trip("first", "A", ("A", "B"), ("08:05", "08:10")),
        trip("second", "B", ("X", "D"), ("08:13", "08:20")),
        coordinates={"B": (0, 0.001), "X": (0, 0.001)},
    ))
    assert result["options"][0]["transfers"] == 1
    assert [leg["route_id"] for leg in result["options"][0]["legs"]] == ["A", "B"]


def test_same_route_is_not_used_as_a_transfer():
    result = plan(index_for(
        trip("first", "R", ("A", "B"), ("08:05", "08:10")),
        trip("second", "R", ("X", "D"), ("08:13", "08:20")),
    ))

    assert not any([leg["route_id"] for leg in option["legs"]] == ["R", "R"] for option in result["options"])


def test_nearby_stop_transfer_uses_the_configured_access_radius():
    index = index_for(
        trip("first", "A", ("A", "B"), ("08:05", "08:10")),
        trip("second", "B", ("C", "D"), ("08:18", "08:25")),
        coordinates={"A": (0, 0), "B": (0, 0.001), "C": (0, 0.004), "D": (0, 1)},
    )
    result = plan(index)

    assert result["options"][0]["transfers"] == 1
    assert [leg["from"]["stop_id"] for leg in result["options"][0]["legs"]] == ["A", "C"]


def test_same_route_chain_uses_the_closest_transfer_stops_before_duration():
    index = index_for(
        trip("near", "70", ("A", "B"), ("08:05", "08:10")),
        trip("far", "70", ("A", "X"), ("08:05", "08:09")),
        trip("second", "74", ("C", "D"), ("08:13", "08:20")),
        coordinates={"A": (0, 0), "B": (0, 0.001), "C": (0, 0.0011), "X": (0, 0.007), "D": (0, 1)},
    )
    result = plan(index)

    option = next(item for item in result["options"] if [leg["route_id"] for leg in item["legs"]] == ["70", "74"])
    assert option["legs"][0]["to"]["stop_id"] == "B"


def test_combined_walking_and_vehicle_cost_ranks_options():
    index = index_for(
        trip("shorter", "D", ("A", "D"), ("08:05", "08:10")),
        trip("closest", "E", ("A", "E"), ("08:06", "08:20")),
    )
    result = JourneyPlanner(index, DestinationDistanceRepo(), Settings(_env_file=None)).plan(origin_name="Origin", origin_lat=0, origin_lon=0, destination_name="Destination", destination_lat=0, destination_lon=3, departure=datetime(2026, 8, 10, 8, tzinfo=ZoneInfo("Pacific/Auckland")), option_limit=5)

    assert result["options"][0]["legs"][-1]["to"]["stop_id"] == "D"


def test_index_cache_replaces_old_feed():
    cache = TimetableIndexCache()
    first = index_for(trip("first", "A", ("A", "D"), ("08:05", "08:25")))
    second = index_for(trip("second", "B", ("A", "D"), ("08:05", "08:25")), feed_version="feed-2")
    replacement = index_for(trip("replacement", "C", ("A", "D"), ("08:05", "08:25")))

    assert cache.get("feed-1", lambda: first) is first
    assert cache.get("feed-2", lambda: second) is second
    assert cache.get("feed-1", lambda: replacement) is replacement
