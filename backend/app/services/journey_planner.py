from __future__ import annotations

import bisect
import hashlib
import logging
import math
import sys
import threading
import time
from collections import OrderedDict, defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.core.config import Settings
from app.repositories.gtfs import GtfsRepository

logger = logging.getLogger("uvicorn.error")


def _deep_size(value: object, seen: set[int] | None = None) -> int:
    tracked = seen if seen is not None else set()
    identity = id(value)
    if identity in tracked:
        return 0
    tracked.add(identity)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        return size + sum(_deep_size(key, tracked) + _deep_size(item, tracked) for key, item in value.items())
    if isinstance(value, (tuple, list, set, frozenset)):
        return size + sum(_deep_size(item, tracked) for item in value)
    if hasattr(value, "__dict__"):
        size += _deep_size(vars(value), tracked)
    slots = getattr(type(value), "__slots__", ())
    if isinstance(slots, str):
        slots = (slots,)
    for slot in slots:
        if slot not in {"__dict__", "__weakref__"}:
            size += _deep_size(getattr(value, slot), tracked)
    return size


@dataclass(frozen=True, slots=True)
class PlannerStop:
    stop_id: str
    name: str
    lat: float
    lon: float
    parent_station: str | None = None
    platform_code: str | None = None

    def payload(self) -> dict[str, Any]:
        return {"stop_id": self.stop_id, "name": self.name, "latitude": self.lat, "longitude": self.lon, "platform_code": self.platform_code}


@dataclass(frozen=True, slots=True)
class PlannerStopTime:
    stop_id: str
    stop_sequence: int
    arrival_seconds: int
    departure_seconds: int
    pickup_type: int | None = None
    drop_off_type: int | None = None


@dataclass(frozen=True, slots=True)
class PlannerTrip:
    trip_id: str
    route_id: str
    service_id: str | None
    direction_id: int | None
    headsign: str | None
    shape_id: str | None
    route_short_name: str
    route_long_name: str
    route_type: int
    route_color: str | None
    route_text_color: str | None
    stop_times: tuple[PlannerStopTime, ...]


@dataclass(frozen=True, slots=True)
class RoutePattern:
    route_id: str
    direction_id: int | None
    stop_ids: tuple[str, ...]
    trip_indices: tuple[int, ...]
    departure_times: tuple[tuple[int, ...], ...]
    departure_trip_indices: tuple[tuple[int, ...], ...]


@dataclass(frozen=True, slots=True)
class ServiceRule:
    service_id: str
    weekdays: tuple[bool, bool, bool, bool, bool, bool, bool]
    start_date: date
    end_date: date


@dataclass(frozen=True, slots=True)
class TimetableIndex:
    feed_version: str
    stops: dict[str, PlannerStop]
    trips: tuple[PlannerTrip, ...]
    station_stops: dict[str, tuple[str, ...]]
    service_rules: dict[str, ServiceRule]
    service_exceptions: dict[tuple[str, date], int]
    spatial_cells: dict[tuple[int, int], tuple[str, ...]] | None = None
    patterns: tuple[RoutePattern, ...] = ()
    stop_patterns: dict[str, tuple[tuple[int, int], ...]] | None = None
    transfer_stops: dict[str, tuple[str, ...]] | None = None

    def service_active(self, service_id: str | None, service_date: date) -> bool:
        if not service_id:
            return True
        exception = self.service_exceptions.get((service_id, service_date))
        if exception == 1:
            return True
        if exception == 2:
            return False
        rule = self.service_rules.get(service_id)
        return bool(rule and rule.start_date <= service_date <= rule.end_date and rule.weekdays[service_date.weekday()])


def _gtfs_date(value: str | None, fallback: date) -> date:
    return datetime.strptime(value, "%Y%m%d").date() if value else fallback


def build_timetable_index(repo: GtfsRepository, feed_version: str, transfer_radius_m: int = 1000) -> TimetableIndex:
    stops = {
        str(row["stop_id"]): PlannerStop(str(row["stop_id"]), row.get("stop_name") or str(row["stop_id"]), float(row["stop_lat"]), float(row["stop_lon"]), row.get("parent_station"), row.get("platform_code"))
        for row in repo.planner_stops(feed_version)
    }
    trips: list[PlannerTrip] = []

    def append_trip(rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        first = rows[0]
        trip = PlannerTrip(
            str(first["trip_id"]), str(first["route_id"]), first.get("service_id"), first.get("direction_id"), first.get("trip_headsign"), first.get("shape_id"),
            first.get("route_short_name") or str(first["route_id"]), first.get("route_long_name") or first.get("route_short_name") or str(first["route_id"]),
            int(first.get("route_type") or 3), first.get("route_color"), first.get("route_text_color"),
            tuple(PlannerStopTime(str(row["stop_id"]), int(row["stop_sequence"]), int(row["arrival_seconds"]), int(row["departure_seconds"]), row.get("pickup_type"), row.get("drop_off_type")) for row in rows),
        )
        trips.append(trip)

    current_trip_id: str | None = None
    trip_rows: list[dict[str, Any]] = []
    for row in repo.iter_planner_trip_times(feed_version):
        trip_id = str(row["trip_id"])
        if current_trip_id is not None and trip_id != current_trip_id:
            append_trip(trip_rows)
            trip_rows = []
        trip_rows.append(row)
        current_trip_id = trip_id
    append_trip(trip_rows)
    station_stops: dict[str, list[str]] = defaultdict(list)
    for stop in stops.values():
        station_stops[stop.parent_station or stop.stop_id].append(stop.stop_id)
    calendars = repo.planner_calendars(feed_version)
    rules = {
        str(row["service_id"]): ServiceRule(str(row["service_id"]), tuple(bool(row.get(day)) for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")), _gtfs_date(row.get("start_date"), date.min), _gtfs_date(row.get("end_date"), date.max))
        for row in calendars["calendar"]
    }
    exceptions = {(str(row["service_id"]), _gtfs_date(row.get("date"), date.min)): int(row.get("exception_type") or 0) for row in calendars["calendar_dates"]}
    spatial_cells: dict[tuple[int, int], list[str]] = defaultdict(list)
    for stop in stops.values():
        spatial_cells[_spatial_cell(stop.lat, stop.lon)].append(stop.stop_id)
    frozen_cells = {key: tuple(value) for key, value in spatial_cells.items()}
    grouped_patterns: OrderedDict[tuple[object, ...], list[int]] = OrderedDict()
    for trip_index, trip in enumerate(trips):
        stop_pattern = tuple((item.stop_id, item.pickup_type, item.drop_off_type) for item in trip.stop_times)
        grouped_patterns.setdefault((trip.route_id, trip.direction_id, stop_pattern), []).append(trip_index)
    patterns: list[RoutePattern] = []
    stop_patterns: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for pattern_id, ((route_id, direction_id, _), trip_indices) in enumerate(grouped_patterns.items()):
        first_trip = trips[trip_indices[0]]
        departure_times: list[tuple[int, ...]] = []
        departure_trip_indices: list[tuple[int, ...]] = []
        for position, stop_time in enumerate(first_trip.stop_times):
            departures = sorted(
                (trips[trip_index].stop_times[position].departure_seconds, trip_index)
                for trip_index in trip_indices
                if trips[trip_index].stop_times[position].pickup_type != 1
            )
            departure_times.append(tuple(item[0] for item in departures))
            departure_trip_indices.append(tuple(item[1] for item in departures))
            stop_patterns[stop_time.stop_id].append((pattern_id, position))
        patterns.append(RoutePattern(route_id, direction_id, tuple(item.stop_id for item in first_trip.stop_times), tuple(trip_indices), tuple(departure_times), tuple(departure_trip_indices)))
    transfer_stops = _build_transfer_links(stops, {key: tuple(value) for key, value in station_stops.items()}, frozen_cells, transfer_radius_m)
    return TimetableIndex(feed_version, stops, tuple(trips), {key: tuple(value) for key, value in station_stops.items()}, rules, exceptions, frozen_cells, tuple(patterns), {key: tuple(value) for key, value in stop_patterns.items()}, transfer_stops)


class TimetableIndexCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._items: dict[str, TimetableIndex] = {}

    def get(self, feed_version: str, builder: Callable[[], TimetableIndex]) -> TimetableIndex:
        with self._lock:
            cached = self._items.get(feed_version)
            if cached is not None:
                return cached
            started = time.perf_counter()
            built = builder()
            if built.feed_version != feed_version:
                raise RuntimeError("Planner index builder returned the wrong feed version")
            self._items = {feed_version: built}
        logger.info("journey_index_built feed_version=%s stops=%s trips=%s estimated_bytes=%s elapsed_ms=%s", feed_version, len(built.stops), len(built.trips), _deep_size(built), round((time.perf_counter() - started) * 1000))
        return built

planner_index_cache = TimetableIndexCache()


@dataclass(frozen=True)
class TripInstance:
    trip_index: int
    service_date: date
    offset_seconds: int


@dataclass(frozen=True)
class Boarding:
    departure_seconds: int
    instance: TripInstance
    position: int


@dataclass(frozen=True)
class Segment:
    instance: TripInstance
    board_position: int
    alight_position: int
    departure_seconds: int
    arrival_seconds: int


@dataclass(frozen=True)
class JourneyLabel:
    arrival_seconds: int
    chain: tuple[Segment, ...]
    source_distance: int
    transfer_distance: float = 0
    in_vehicle_seconds: int = 0


def _instant(anchor_date: date, seconds: int, timezone: ZoneInfo) -> str:
    return (datetime.combine(anchor_date, datetime_time.min, tzinfo=timezone) + timedelta(seconds=seconds)).isoformat()


def _walking_seconds(distance_m: float, speed_mps: float) -> int:
    """Round walking time up so a stop is not treated as reachable too early."""
    return math.ceil(max(0.0, distance_m) / speed_mps)


_SPATIAL_CELL_DEGREES = 0.01


def _spatial_cell(lat: float, lon: float) -> tuple[int, int]:
    return (math.floor(lat / _SPATIAL_CELL_DEGREES), math.floor(lon / _SPATIAL_CELL_DEGREES))


def _distance_m(left: PlannerStop, right: PlannerStop) -> float:
    latitude = math.radians(right.lat - left.lat)
    longitude = math.radians(right.lon - left.lon)
    a = math.sin(latitude / 2) ** 2 + math.cos(math.radians(left.lat)) * math.cos(math.radians(right.lat)) * math.sin(longitude / 2) ** 2
    return 12_742_000 * math.asin(math.sqrt(a))


def _nearby_stop_ids(stop: PlannerStop, stops: dict[str, PlannerStop], cells: dict[tuple[int, int], tuple[str, ...]], radius_m: int) -> tuple[str, ...]:
    latitude_delta = radius_m / 111_320
    longitude_delta = radius_m / max(1, 111_320 * abs(math.cos(math.radians(stop.lat))))
    latitude_cells = math.ceil(latitude_delta / _SPATIAL_CELL_DEGREES)
    longitude_cells = math.ceil(longitude_delta / _SPATIAL_CELL_DEGREES)
    cell_lat, cell_lon = _spatial_cell(stop.lat, stop.lon)
    return tuple(
        candidate_id
        for lat_index in range(cell_lat - latitude_cells, cell_lat + latitude_cells + 1)
        for lon_index in range(cell_lon - longitude_cells, cell_lon + longitude_cells + 1)
        for candidate_id in cells.get((lat_index, lon_index), ())
        if _distance_m(stop, stops[candidate_id]) <= radius_m
    )


def _build_transfer_links(
    stops: dict[str, PlannerStop],
    station_stops: dict[str, tuple[str, ...]],
    cells: dict[tuple[int, int], tuple[str, ...]],
    radius_m: int,
) -> dict[str, tuple[str, ...]]:
    return {
        stop.stop_id: tuple(sorted(set(station_stops.get(stop.parent_station or stop.stop_id, (stop.stop_id,))) | set(_nearby_stop_ids(stop, stops, cells, radius_m))))
        for stop in stops.values()
    }


class JourneyPlanner:
    def __init__(self, index: TimetableIndex, repo: GtfsRepository, settings: Settings):
        self.index = index
        self.repo = repo
        self.settings = settings
        self.timezone = ZoneInfo(settings.journey_timezone)
        self._transfer_cache: dict[str, tuple[str, ...]] = {}

    def _local_departure(self, departure: datetime) -> datetime:
        return departure.replace(tzinfo=self.timezone) if departure.tzinfo is None else departure.astimezone(self.timezone)

    def _nearby(self, lat: float, lon: float) -> dict[str, int]:
        return {str(row["stop_id"]): int(row.get("distance_m") or 0) for row in self.repo.nearby_stops(self.index.feed_version, lat, lon, self.settings.journey_access_radius_m, self.settings.journey_max_access_stops) if str(row["stop_id"]) in self.index.stops}

    def _transfer_stops(self, stop_id: str) -> tuple[str, ...]:
        if self.index.transfer_stops is not None:
            return self.index.transfer_stops.get(stop_id, (stop_id,))
        cached = self._transfer_cache.get(stop_id)
        if cached is not None:
            return cached
        stop = self.index.stops[stop_id]
        nearby = set(self.index.station_stops.get(stop.parent_station or stop.stop_id, (stop_id,)))
        cells = self.index.spatial_cells
        if not cells:
            candidates = self.index.stops.values()
        else:
            candidates = (self.index.stops[candidate_id] for candidate_id in _nearby_stop_ids(stop, self.index.stops, cells, self.settings.journey_access_radius_m))
        for candidate in candidates:
            if _distance_m(stop, candidate) <= self.settings.journey_access_radius_m:
                nearby.add(candidate.stop_id)
        result = tuple(sorted(nearby))
        self._transfer_cache[stop_id] = result
        return result

    def _next_active_boarding(
        self,
        pattern_id: int,
        position: int,
        earliest: int,
        anchor_date: date,
        horizon: int,
        exclude: TripInstance | None = None,
    ) -> Boarding | None:
        pattern = self.index.patterns[pattern_id]
        times = pattern.departure_times[position]
        trip_indices = pattern.departure_trip_indices[position]
        best: Boarding | None = None
        for delta in (-1, 0, 1):
            offset = delta * 86400
            start = bisect.bisect_left(times, earliest - offset)
            for index in range(start, len(times)):
                departure = times[index] + offset
                if departure > horizon:
                    break
                trip_index = trip_indices[index]
                trip = self.index.trips[trip_index]
                service_date = anchor_date + timedelta(days=delta)
                instance = TripInstance(trip_index, service_date, offset)
                if exclude == instance or not self.index.service_active(trip.service_id, service_date):
                    continue
                candidate = Boarding(departure, instance, position)
                if best is None or candidate.departure_seconds < best.departure_seconds:
                    best = candidate
                break
        return best

    def _chain_signature(self, chain: tuple[Segment, ...]) -> tuple[str, ...]:
        return tuple(
            f"{self.index.trips[item.instance.trip_index].route_id}:{self.index.trips[item.instance.trip_index].trip_id}:{item.board_position}:{item.alight_position}:{item.instance.service_date}"
            for item in chain
        )

    def _route_chain_signature(self, chain: tuple[Segment, ...]) -> tuple[str, ...]:
        return tuple(self.index.trips[item.instance.trip_index].route_id for item in chain)

    def _transfer_distance(self, chain: tuple[Segment, ...]) -> float:
        return sum(
            _distance_m(
                self.index.stops[self.index.trips[previous.instance.trip_index].stop_times[previous.alight_position].stop_id],
                self.index.stops[self.index.trips[current.instance.trip_index].stop_times[current.board_position].stop_id],
            )
            for previous, current in zip(chain, chain[1:])
        )

    def _candidate_rank(self, chain: tuple[Segment, ...], source_distance: int, destination_distance: int) -> tuple[float, float, int, tuple[str, ...]]:
        duration = sum(segment.arrival_seconds - segment.departure_seconds for segment in chain)
        stop_distance = source_distance + destination_distance + self._transfer_distance(chain)
        generalized_seconds = duration + stop_distance / self.settings.journey_walking_speed_mps
        return (generalized_seconds, stop_distance, duration, self._chain_signature(chain))

    def _label_cost(self, label: JourneyLabel) -> float:
        return label.in_vehicle_seconds + (label.source_distance + label.transfer_distance) / self.settings.journey_walking_speed_mps

    def _leg(self, segment: Segment, anchor_date: date) -> dict[str, Any]:
        trip = self.index.trips[segment.instance.trip_index]
        board = self.index.stops[trip.stop_times[segment.board_position].stop_id]
        alight = self.index.stops[trip.stop_times[segment.alight_position].stop_id]
        return {
            "type": "transit", "route_id": trip.route_id, "route_short_name": trip.route_short_name, "route_long_name": trip.route_long_name,
            "route_type": trip.route_type, "route_color": trip.route_color, "route_text_color": trip.route_text_color, "trip_id": trip.trip_id,
            "direction_id": trip.direction_id, "shape_id": trip.shape_id, "headsign": trip.headsign, "service_date": segment.instance.service_date.isoformat(),
            "from": board.payload(), "to": alight.payload(), "scheduled_departure": _instant(anchor_date, segment.departure_seconds, self.timezone),
            "scheduled_arrival": _instant(anchor_date, segment.arrival_seconds, self.timezone),
        }

    def plan(self, *, origin_name: str, origin_lat: float, origin_lon: float, destination_name: str, destination_lat: float, destination_lon: float, departure: datetime, option_limit: int) -> dict[str, Any]:
        started = time.perf_counter()
        local_departure = self._local_departure(departure)
        anchor_date = local_departure.date()
        requested_seconds = local_departure.hour * 3600 + local_departure.minute * 60 + local_departure.second
        origin = self._nearby(origin_lat, origin_lon)
        destination = self._nearby(destination_lat, destination_lon)
        if not origin or not destination:
            return {"feed_version": self.index.feed_version, "service_date": anchor_date.isoformat(), "status": "no_journey", "options": []}
        horizon = requested_seconds + self.settings.journey_search_horizon_seconds
        patterns_by_stop = self.index.stop_patterns or {}
        frontier = {
            stop_id: JourneyLabel(
                requested_seconds + _walking_seconds(distance, self.settings.journey_walking_speed_mps),
                (),
                distance,
            )
            for stop_id, distance in origin.items()
        }
        best_arrivals: dict[str, int] = {stop_id: label.arrival_seconds for stop_id, label in frontier.items()}
        unique: dict[tuple[str, ...], tuple[tuple[Segment, ...], int, int]] = {}

        # RAPTOR rounds: one route-pattern scan per marked pattern, then static transfers.
        for round_number in range(self.settings.journey_max_transfers + 1):
            marked_patterns = {
                pattern_id
                for stop_id in frontier
                for pattern_id, _ in patterns_by_stop.get(stop_id, ())
            }
            reached: dict[str, JourneyLabel] = {}
            for pattern_id in marked_patterns:
                pattern = self.index.patterns[pattern_id]
                current_boarding: Boarding | None = None
                current_label: JourneyLabel | None = None
                for position, stop_id in enumerate(pattern.stop_ids):
                    label = frontier.get(stop_id)
                    if label is not None:
                        if label.chain and self.index.trips[label.chain[-1].instance.trip_index].route_id == pattern.route_id:
                            continue
                        earliest = label.arrival_seconds if round_number == 0 else label.arrival_seconds + self.settings.journey_transfer_buffer_seconds
                        exclude = label.chain[-1].instance if label.chain else None
                        candidate = self._next_active_boarding(pattern_id, position, earliest, anchor_date, horizon, exclude)
                        if candidate is not None:
                            if current_boarding is None or current_label is None:
                                current_boarding = candidate
                                current_label = label
                            else:
                                current_trip = self.index.trips[current_boarding.instance.trip_index]
                                current_cost = self._label_cost(current_label) + max(0, current_trip.stop_times[position].arrival_seconds + current_boarding.instance.offset_seconds - current_boarding.departure_seconds)
                                if self._label_cost(label) < current_cost:
                                    current_boarding = candidate
                                    current_label = label
                    if current_boarding is None or current_label is None:
                        continue
                    trip = self.index.trips[current_boarding.instance.trip_index]
                    stop_time = trip.stop_times[position]
                    arrival = stop_time.arrival_seconds + current_boarding.instance.offset_seconds
                    if position <= current_boarding.position or stop_time.drop_off_type == 1 or arrival < current_boarding.departure_seconds:
                        continue
                    segment = Segment(current_boarding.instance, current_boarding.position, position, current_boarding.departure_seconds, arrival)
                    chain = (*current_label.chain, segment)
                    next_label = JourneyLabel(
                        arrival,
                        chain,
                        current_label.source_distance,
                        current_label.transfer_distance,
                        current_label.in_vehicle_seconds + arrival - current_boarding.departure_seconds,
                    )
                    if stop_id in destination:
                        signature = self._route_chain_signature(chain)
                        candidate = (chain, current_label.source_distance, destination[stop_id])
                        existing = unique.get(signature)
                        if existing is None or self._candidate_rank(*candidate) < self._candidate_rank(*existing):
                            unique[signature] = candidate
                    if arrival < best_arrivals.get(stop_id, float("inf")):
                        best_arrivals[stop_id] = arrival
                        reached[stop_id] = next_label
            next_frontier: dict[str, JourneyLabel] = {}
            for stop_id, label in reached.items():
                for transfer_stop in self._transfer_stops(stop_id):
                    if transfer_stop not in self.index.stops:
                        continue
                    transfer_distance = label.transfer_distance + _distance_m(self.index.stops[stop_id], self.index.stops[transfer_stop])
                    transfer_walk_seconds = _walking_seconds(
                        _distance_m(self.index.stops[stop_id], self.index.stops[transfer_stop]),
                        self.settings.journey_walking_speed_mps,
                    )
                    transfer_label = JourneyLabel(
                        label.arrival_seconds + transfer_walk_seconds,
                        label.chain,
                        label.source_distance,
                        transfer_distance,
                        label.in_vehicle_seconds,
                    )
                    existing = next_frontier.get(transfer_stop)
                    if existing is None or (
                        self._label_cost(transfer_label),
                        transfer_label.transfer_distance,
                        transfer_label.source_distance,
                        transfer_label.arrival_seconds,
                        self._chain_signature(transfer_label.chain),
                    ) < (
                        self._label_cost(existing),
                        existing.transfer_distance,
                        existing.source_distance,
                        existing.arrival_seconds,
                        self._chain_signature(existing.chain),
                    ):
                        next_frontier[transfer_stop] = transfer_label
                next_frontier.setdefault(stop_id, label)
            frontier = next_frontier
            if not frontier:
                break
        options: list[dict[str, Any]] = []
        for signature, (chain, source_distance, destination_distance) in unique.items():
            legs = [self._leg(segment, anchor_date) for segment in chain]
            duration = sum(segment.arrival_seconds - segment.departure_seconds for segment in chain)
            stop_distance = source_distance + destination_distance + self._transfer_distance(chain)
            generalized_seconds = duration + stop_distance / self.settings.journey_walking_speed_mps
            options.append({"id": hashlib.sha1("|".join(signature).encode("utf-8")).hexdigest()[:16], "departure_time": _instant(anchor_date, chain[0].departure_seconds, self.timezone), "duration_seconds": duration, "transfers": len(chain) - 1, "legs": legs, "_generalized_seconds": generalized_seconds, "_stop_distance": stop_distance, "_signature": signature})
        options.sort(key=lambda item: (item["transfers"], item["_generalized_seconds"], item["_stop_distance"], item["duration_seconds"], item["_signature"]))
        options = options[:min(option_limit, self.settings.journey_max_options)]
        for option in options:
            option.pop("_stop_distance", None)
            option.pop("_generalized_seconds", None)
            option.pop("_signature", None)
        logger.info("journey_plan_completed feed_version=%s options=%s elapsed_ms=%s", self.index.feed_version, len(options), round((time.perf_counter() - started) * 1000))
        return {"feed_version": self.index.feed_version, "service_date": anchor_date.isoformat(), "status": "ok" if options else "no_journey", "options": options}
