from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from redis import Redis

from app.core.config import Settings
from app.services.http import download_bytes

JsonDict = dict[str, Any]
REALTIME_INDEX_KEYS = "gtfsrt:index_keys"


def _translated(value: dict[str, Any] | None) -> str | None:
    if not value:
        return None
    translations = value.get("translation") or []
    return translations[0].get("text") if translations else None


def _snapshot_scope(snapshot: dict) -> dict[str, list[str]]:
    route_ids: set[str] = set()
    trip_ids: set[str] = set()

    for item in snapshot.get("vehicles", []):
        if item.get("route_id"):
            route_ids.add(item["route_id"])
        if item.get("trip_id"):
            trip_ids.add(item["trip_id"])

    for item in snapshot.get("trip_updates", []):
        if item.get("route_id"):
            route_ids.add(item["route_id"])
        if item.get("trip_id"):
            trip_ids.add(item["trip_id"])

    for item in snapshot.get("alerts", []):
        route_ids.update(item.get("route_ids") or [])
        trip_ids.update(item.get("trip_ids") or [])

    return {"route_ids": sorted(route_ids), "trip_ids": sorted(trip_ids)}


def _enrich_alert_routes(snapshot: dict, static_trip_routes: dict[str, str] | None = None) -> None:
    trip_routes = {
        item["trip_id"]: item["route_id"]
        for item in [*snapshot.get("vehicles", []), *snapshot.get("trip_updates", [])]
        if item.get("trip_id") and item.get("route_id")
    }
    trip_routes = {**(static_trip_routes or {}), **trip_routes}
    for alert in snapshot.get("alerts", []):
        route_ids = set(alert.get("route_ids") or [])
        for trip_id in alert.get("trip_ids") or []:
            if trip_routes.get(trip_id):
                route_ids.add(trip_routes[trip_id])
        alert["route_ids"] = sorted(route_ids)


NORMAL_TRIP_RELATIONSHIPS = {None, "", "SCHEDULED"}
EXTRA_SERVICE_TRIP_RELATIONSHIPS = {"ADDED", "REPLACEMENT", "DUPLICATED"}
TRIP_SCHEDULE_RELATIONSHIP_NAMES = {
    0: "SCHEDULED",
    1: "ADDED",
    2: "UNSCHEDULED",
    3: "CANCELED",
    5: "REPLACEMENT",
    6: "DUPLICATED",
}


def _schedule_relationship_name(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return TRIP_SCHEDULE_RELATIONSHIP_NAMES.get(value)
    if isinstance(value, str) and value.isdigit():
        return TRIP_SCHEDULE_RELATIONSHIP_NAMES.get(int(value))
    return str(value)


def _filter_commuter_visible_vehicles(snapshot: dict, static_trip_routes: dict[str, str] | None = None) -> None:
    if static_trip_routes is None:
        return
    vehicles = []

    for vehicle in snapshot.get("vehicles", []):
        trip_id = vehicle.get("trip_id")
        relationship = _schedule_relationship_name(vehicle.get("schedule_relationship"))
        vehicle["schedule_relationship"] = relationship
        route_id = vehicle.get("route_id")
        static_route_id = static_trip_routes.get(trip_id)

        if relationship in EXTRA_SERVICE_TRIP_RELATIONSHIPS:
            if not route_id:
                continue
            if static_route_id and route_id != static_route_id:
                continue
            vehicles.append(vehicle)
            continue

        if relationship not in NORMAL_TRIP_RELATIONSHIPS or not route_id:
            continue
        if static_route_id and route_id != static_route_id:
            continue
        if static_route_id:
            vehicle["route_id"] = static_route_id
        vehicles.append(vehicle)
    snapshot["vehicles"] = vehicles


def _dedupe_alerts(snapshot: dict) -> None:
    deduped: dict[tuple, dict] = {}
    for alert in snapshot.get("alerts", []):
        key = (
            alert.get("header"),
            alert.get("description"),
            alert.get("cause"),
            alert.get("effect"),
            alert.get("severity_level"),
        )
        if key not in deduped:
            deduped[key] = {
                **alert,
                "route_ids": sorted(set(alert.get("route_ids") or [])),
                "trip_ids": sorted(set(alert.get("trip_ids") or [])),
                "stop_ids": sorted(set(alert.get("stop_ids") or [])),
                "source_alert_ids": [alert.get("alert_id")] if alert.get("alert_id") else [],
            }
            continue

        existing = deduped[key]
        existing["route_ids"] = sorted(set(existing.get("route_ids") or []).union(alert.get("route_ids") or []))
        existing["trip_ids"] = sorted(set(existing.get("trip_ids") or []).union(alert.get("trip_ids") or []))
        existing["stop_ids"] = sorted(set(existing.get("stop_ids") or []).union(alert.get("stop_ids") or []))
        if alert.get("alert_id"):
            existing["source_alert_ids"] = sorted(set(existing.get("source_alert_ids") or []).union([alert["alert_id"]]))

    snapshot["alerts"] = list(deduped.values())


def _vehicle_snapshot_key(vehicle: dict) -> str:
    return (
        vehicle.get("trip_id")
        or vehicle.get("vehicle_id")
        or vehicle.get("vehicle_label")
        or vehicle.get("vehicle_license_plate")
        or json.dumps(vehicle, sort_keys=True)
    )


def _dedupe_vehicles(snapshot: dict) -> None:
    deduped: dict[str, dict] = {}
    for vehicle in snapshot.get("vehicles", []):
        key = _vehicle_snapshot_key(vehicle)
        existing = deduped.get(key)
        if existing is None or (vehicle.get("timestamp") or 0) >= (existing.get("timestamp") or 0):
            deduped[key] = vehicle
    snapshot["vehicles"] = list(deduped.values())


def _pb_text(value: Any) -> str | None:
    translations = getattr(value, "translation", [])
    return translations[0].text if translations else None


def _pb_enum_name(message: Any, field_name: str) -> str | None:
    field = message.DESCRIPTOR.fields_by_name.get(field_name)
    if not field:
        return None
    enum_value = field.enum_type.values_by_number.get(getattr(message, field_name))
    return enum_value.name if enum_value else None


def _pb_has(message: Any, field_name: str) -> bool:
    try:
        return message.HasField(field_name)
    except ValueError:
        return False


def _pb_trip(trip: Any) -> JsonDict:
    payload = {
        "trip_id": trip.trip_id or None,
        "start_time": trip.start_time or None,
        "start_date": trip.start_date or None,
        "route_id": trip.route_id or None,
        "direction_id": trip.direction_id if _pb_has(trip, "direction_id") else None,
    }
    schedule_relationship = _pb_enum_name(trip, "schedule_relationship")
    if schedule_relationship:
        payload["schedule_relationship"] = schedule_relationship
    return payload


def _pb_time_event(event: Any) -> JsonDict | None:
    payload: JsonDict = {}
    if _pb_has(event, "delay"):
        payload["delay"] = event.delay
    if _pb_has(event, "time"):
        payload["time"] = event.time
    if _pb_has(event, "uncertainty"):
        payload["uncertainty"] = event.uncertainty
    return payload or None


def _pb_entity(entity: Any) -> JsonDict:
    payload: JsonDict = {"id": entity.id or None, "is_deleted": entity.is_deleted}
    if _pb_has(entity, "vehicle"):
        vehicle = entity.vehicle
        vehicle_ref = vehicle.vehicle if _pb_has(vehicle, "vehicle") else None
        position = vehicle.position if _pb_has(vehicle, "position") else None
        payload["vehicle"] = {
            "trip": _pb_trip(vehicle.trip) if _pb_has(vehicle, "trip") else {},
            "vehicle": {
                "id": vehicle_ref.id or None,
                "label": vehicle_ref.label or None,
                "license_plate": vehicle_ref.license_plate or None,
            } if vehicle_ref else {},
            "position": {
                "latitude": position.latitude if position and _pb_has(position, "latitude") else None,
                "longitude": position.longitude if position and _pb_has(position, "longitude") else None,
                "bearing": position.bearing if position and _pb_has(position, "bearing") else None,
                "speed": position.speed if position and _pb_has(position, "speed") else None,
            },
            "occupancy_status": _pb_enum_name(vehicle, "occupancy_status"),
            "timestamp": vehicle.timestamp if _pb_has(vehicle, "timestamp") else None,
        }
    if _pb_has(entity, "trip_update"):
        update = entity.trip_update
        payload["trip_update"] = {
            "trip": _pb_trip(update.trip) if _pb_has(update, "trip") else {},
            "timestamp": update.timestamp if _pb_has(update, "timestamp") else None,
            "delay": update.delay if _pb_has(update, "delay") else None,
            "stop_time_update": [
                {
                    "stop_sequence": item.stop_sequence if _pb_has(item, "stop_sequence") else None,
                    "stop_id": item.stop_id or None,
                    "arrival": _pb_time_event(item.arrival) if _pb_has(item, "arrival") else None,
                    "departure": _pb_time_event(item.departure) if _pb_has(item, "departure") else None,
                }
                for item in update.stop_time_update
            ],
        }
    if _pb_has(entity, "alert"):
        alert = entity.alert
        informed = []
        for item in alert.informed_entity:
            value: JsonDict = {"route_id": item.route_id or None, "stop_id": item.stop_id or None}
            if _pb_has(item, "trip"):
                value["trip"] = _pb_trip(item.trip)
            informed.append(value)
        payload["alert"] = {
            "informed_entity": informed,
            "cause": _pb_enum_name(alert, "cause"),
            "effect": _pb_enum_name(alert, "effect"),
            "severity_level": _pb_enum_name(alert, "severity_level"),
            "header_text": {"translation": [{"text": _pb_text(alert.header_text)}]} if _pb_has(alert, "header_text") else None,
            "description_text": {"translation": [{"text": _pb_text(alert.description_text)}]} if _pb_has(alert, "description_text") else None,
        }
    return payload


class RealtimeNormalizer:
    def __init__(self, feed_format: str = "auto"):
        self.feed_format = feed_format.lower()

    def parse(self, data: bytes, source_name: str = "feed", content_type: str | None = None) -> dict:
        fmt = self._format(source_name, content_type)
        if fmt == "protobuf":
            return self._parse_protobuf(data)
        return json.loads(data.decode("utf-8-sig"))

    def _format(self, source_name: str, content_type: str | None) -> str:
        if self.feed_format in {"json", "protobuf"}:
            return self.feed_format
        if content_type:
            media_type = content_type.partition(";")[0].strip().lower()
            if media_type in {"application/x-protobuf", "application/protobuf"}:
                return "protobuf"
            return "json"
        if Path(source_name).suffix.lower() in {".pb", ".pbf", ".bin", ".gtfsrt"}:
            return "protobuf"
        return "json"

    def _parse_protobuf(self, data: bytes) -> dict:
        from google.transit import gtfs_realtime_pb2

        feed_message_type = getattr(gtfs_realtime_pb2, "FeedMessage")
        message = feed_message_type()
        message.ParseFromString(data)
        return {
            "status": "OK",
            "response": {
                "header": {
                    "timestamp": message.header.timestamp if _pb_has(message.header, "timestamp") else None,
                    "gtfs_realtime_version": message.header.gtfs_realtime_version,
                    "incrementality": _pb_enum_name(message.header, "incrementality"),
                },
                "entity": [_pb_entity(entity) for entity in message.entity],
            },
            "error": None,
        }

    def normalize(self, raw: dict) -> dict:
        entities = raw.get("response", {}).get("entity", [])
        generated_at = self.generated_at(raw)
        return {
            "generated_at": generated_at,
            "vehicles": self._vehicles(entities),
            "trip_updates": self._trip_updates(entities),
            "alerts": self._alerts(entities),
        }

    def generated_at(self, raw: dict) -> str:
        timestamp = raw.get("response", {}).get("header", {}).get("timestamp")
        if timestamp:
            return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).isoformat()
        return datetime.now(tz=timezone.utc).isoformat()

    def _vehicles(self, entities: list[dict]) -> list[dict]:
        items = []
        for entity in entities:
            vehicle = entity.get("vehicle")
            if not vehicle:
                continue
            trip = vehicle.get("trip") or {}
            position = vehicle.get("position") or {}
            items.append(
                {
                    "vehicle_id": (vehicle.get("vehicle") or {}).get("id") or entity.get("id"),
                    "vehicle_label": (vehicle.get("vehicle") or {}).get("label"),
                    "vehicle_license_plate": (vehicle.get("vehicle") or {}).get("license_plate"),
                    "trip_id": trip.get("trip_id"),
                    "route_id": trip.get("route_id"),
                    "direction_id": trip.get("direction_id"),
                    "schedule_relationship": _schedule_relationship_name(trip.get("schedule_relationship")),
                    "occupancy_status": vehicle.get("occupancy_status"),
                    "position": {
                        "latitude": position.get("latitude"),
                        "longitude": position.get("longitude"),
                        "bearing": position.get("bearing"),
                        "speed": position.get("speed"),
                    },
                    "timestamp": vehicle.get("timestamp"),
                }
            )
        return items

    def _trip_updates(self, entities: list[dict]) -> list[dict]:
        items = []
        for entity in entities:
            update = entity.get("trip_update")
            if not update:
                continue
            trip = update.get("trip") or {}
            updates = update.get("stop_time_update") or []
            if isinstance(updates, dict):
                updates = [updates]
            items.append(
                {
                    "trip_id": trip.get("trip_id"),
                    "route_id": trip.get("route_id"),
                    "direction_id": trip.get("direction_id"),
                    "schedule_relationship": _schedule_relationship_name(trip.get("schedule_relationship")),
                    "delay": update.get("delay"),
                    "stop_time_updates": [
                        {
                            "stop_id": item.get("stop_id"),
                            "stop_sequence": item.get("stop_sequence"),
                            "arrival": item.get("arrival"),
                            "departure": item.get("departure"),
                        }
                        for item in updates
                    ],
                }
            )
        return items

    def _alerts(self, entities: list[dict]) -> list[dict]:
        items = []
        for entity in entities:
            alert = entity.get("alert")
            if not alert:
                continue
            route_ids: set[str] = set()
            stop_ids: set[str] = set()
            trip_ids: set[str] = set()
            for informed in alert.get("informed_entity") or []:
                if informed.get("route_id"):
                    route_ids.add(informed["route_id"])
                if informed.get("stop_id"):
                    stop_ids.add(informed["stop_id"])
                if isinstance(informed.get("trip"), dict):
                    if informed["trip"].get("trip_id"):
                        trip_ids.add(informed["trip"]["trip_id"])
                    if informed["trip"].get("route_id"):
                        route_ids.add(informed["trip"]["route_id"])
            items.append(
                {
                    "alert_id": entity.get("id"),
                    "route_ids": sorted(route_ids),
                    "trip_ids": sorted(trip_ids),
                    "stop_ids": sorted(stop_ids),
                    "cause": alert.get("cause"),
                    "effect": alert.get("effect"),
                    "severity_level": alert.get("severity_level"),
                    "header": _translated(alert.get("header_text")),
                    "description": _translated(alert.get("description_text")),
                }
            )
        return items


class RealtimeService:
    def __init__(self, redis: Redis):
        self.redis = redis

    def snapshot(self, kind: str, filters) -> dict:
        generated_at = cast(str | None, self.redis.get("gtfsrt:generated_at"))
        feed_version = cast(str | None, self.redis.get("gtfsrt:feed_version"))
        rows = self._candidate_rows(kind, filters)
        return {"feed_version": feed_version, "generated_at": generated_at, "items": self._filter(rows, filters)}

    def store_snapshot(
        self,
        snapshot: dict,
        feed_version: str | None = None,
        static_trip_routes: dict[str, str] | None = None,
    ) -> None:
        _enrich_alert_routes(snapshot, static_trip_routes)
        _filter_commuter_visible_vehicles(snapshot, static_trip_routes)
        _dedupe_alerts(snapshot)
        _dedupe_vehicles(snapshot)
        previous_index_keys = cast(set[str], self.redis.smembers(REALTIME_INDEX_KEYS))
        pipe = self.redis.pipeline()
        pipe.delete(
            "gtfsrt:vehicles",
            "gtfsrt:vehicles_by_trip",
            "gtfsrt:trip_updates",
            "gtfsrt:alerts",
            REALTIME_INDEX_KEYS,
            *previous_index_keys,
        )
        index_keys: set[str] = set()
        for item in snapshot["vehicles"]:
            vehicle_key = item.get("vehicle_id") or item.get("trip_id") or json.dumps(item)
            encoded = json.dumps(item)
            pipe.hset("gtfsrt:vehicles", vehicle_key, encoded)
            if item.get("trip_id"):
                pipe.hset("gtfsrt:vehicles_by_trip", item["trip_id"], encoded)
            if item.get("route_id"):
                key = f"gtfsrt:vehicle_ids_by_route:{item['route_id']}"
                index_keys.add(key)
                pipe.sadd(key, vehicle_key)
        for item in snapshot["trip_updates"]:
            trip_key = item.get("trip_id") or json.dumps(item)
            pipe.hset("gtfsrt:trip_updates", trip_key, json.dumps(item))
            if item.get("route_id"):
                key = f"gtfsrt:trip_update_ids_by_route:{item['route_id']}"
                index_keys.add(key)
                pipe.sadd(key, trip_key)
        for item in snapshot["alerts"]:
            alert_key = item.get("alert_id") or json.dumps(item)
            pipe.hset("gtfsrt:alerts", alert_key, json.dumps(item))
            for route_id in item.get("route_ids") or []:
                key = f"gtfsrt:alert_ids_by_route:{route_id}"
                index_keys.add(key)
                pipe.sadd(key, alert_key)
        if index_keys:
            pipe.sadd(REALTIME_INDEX_KEYS, *sorted(index_keys))
        pipe.set("gtfsrt:generated_at", snapshot["generated_at"])
        if feed_version:
            pipe.set("gtfsrt:feed_version", feed_version)
        else:
            pipe.delete("gtfsrt:feed_version")
        scope = _snapshot_scope(snapshot)
        pipe.publish(
            "gtfsrt:channel",
            json.dumps(
                {
                    "event_types": ["vehicles", "trip_updates", "alerts"],
                    "feed_version": feed_version,
                    "generated_at": snapshot["generated_at"],
                    **scope,
                }
            ),
        )
        pipe.execute()

    def _candidate_rows(self, kind: str, filters) -> list[dict]:
        values = self._candidate_values(kind, filters)
        if values is None:
            return self._all_rows(kind)
        return [json.loads(value) for value in values if value]

    def _candidate_values(self, kind: str, filters) -> list[str | None] | None:
        if kind == "vehicles":
            if filters.vehicle_ids:
                return cast(list[str | None], self.redis.hmget("gtfsrt:vehicles", filters.vehicle_ids))
            if filters.trip_ids:
                return cast(list[str | None], self.redis.hmget("gtfsrt:vehicles_by_trip", filters.trip_ids))
            if filters.route_ids:
                return self._hmget_by_route_sets("gtfsrt:vehicles", "gtfsrt:vehicle_ids_by_route", filters.route_ids)
        if kind == "trip_updates":
            if filters.trip_ids:
                return cast(list[str | None], self.redis.hmget("gtfsrt:trip_updates", filters.trip_ids))
            if filters.route_ids:
                return self._hmget_by_route_sets("gtfsrt:trip_updates", "gtfsrt:trip_update_ids_by_route", filters.route_ids)
        if kind == "alerts" and filters.route_ids:
            return self._hmget_by_route_sets("gtfsrt:alerts", "gtfsrt:alert_ids_by_route", filters.route_ids)
        return None

    def _hmget_by_route_sets(self, hash_key: str, set_prefix: str, route_ids: list[str]) -> list[str | None]:
        item_ids = self._route_index_ids(set_prefix, route_ids)
        if not item_ids:
            return []
        return cast(list[str | None], self.redis.hmget(hash_key, item_ids))

    def _route_index_ids(self, set_prefix: str, route_ids: list[str]) -> list[str]:
        seen: set[str] = set()
        item_ids: list[str] = []
        for route_id in route_ids:
            for item_id in cast(set[str], self.redis.smembers(f"{set_prefix}:{route_id}")):
                if item_id not in seen:
                    seen.add(item_id)
                    item_ids.append(item_id)
        return item_ids

    def _all_rows(self, kind: str) -> list[dict]:
        values = cast(list[str], self.redis.hvals(f"gtfsrt:{kind}"))
        return [json.loads(value) for value in values]

    def _filter(self, items: list[dict], filters) -> list[dict]:
        filtered = []
        for item in items:
            if filters.route_ids and item.get("route_id") not in filters.route_ids and not set(item.get("route_ids", [])).intersection(filters.route_ids):
                continue
            if filters.trip_ids and item.get("trip_id") not in filters.trip_ids and not set(item.get("trip_ids", [])).intersection(filters.trip_ids):
                continue
            if filters.vehicle_ids and item.get("vehicle_id") not in filters.vehicle_ids:
                continue
            if filters.direction_ids and item.get("direction_id") not in filters.direction_ids:
                continue
            if filters.stop_ids and not set(item.get("stop_ids", [])).intersection(filters.stop_ids):
                stop_update_ids = {update.get("stop_id") for update in item.get("stop_time_updates", [])}
                if not stop_update_ids.intersection(filters.stop_ids):
                    continue
            filtered.append(item)
        return filtered


def load_realtime_bytes(settings: Settings) -> tuple[bytes, str, str | None]:
    if settings.gtfs_realtime_url:
        request_headers = {"Accept": "application/x-protobuf"} if settings.realtime_feed_format.lower() == "protobuf" else None
        data, headers = download_bytes(settings.gtfs_realtime_url, settings, request_headers)
        return data, settings.gtfs_realtime_url, headers.get("content-type")
    if settings.realtime_raw_path:
        return settings.realtime_raw_path.read_bytes(), str(settings.realtime_raw_path), None
    raise RuntimeError("Set GTFS_REALTIME_URL or REALTIME_RAW_PATH")
