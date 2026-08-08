from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from redis import Redis
from redis.exceptions import RedisError

from app.api.deps import current_user, get_conn, get_redis_client
from app.core.config import Settings, get_settings
from app.db.session import DbConnection
from app.models import JourneyPlanRequest, JourneyPlanResponse, RealtimeFilter
from app.repositories.gtfs import GtfsRepository
from app.services.journey_planner import JourneyPlanner, build_timetable_index, planner_index_cache
from app.services.realtime import RealtimeService

router = APIRouter()


def _limit_user(redis: Redis, user_id: int, settings: Settings) -> None:
    key = f"journey:rate:{user_id}"
    try:
        count = int(redis.incr(key))
        if count == 1:
            redis.expire(key, 60)
    except RedisError:
        return
    if count > settings.journey_requests_per_minute:
        raise HTTPException(status_code=429, detail="Journey planning rate limit exceeded", headers={"Retry-After": "60"})


def enrich_realtime(result: dict, redis: Redis) -> dict:
    trip_ids = sorted(
        {
            leg["trip_id"]
            for option in result.get("options", [])
            for leg in option.get("legs", [])
            if leg.get("type") == "transit"
        }
    )
    route_ids = sorted(
        {
            leg["route_id"]
            for option in result.get("options", [])
            for leg in option.get("legs", [])
            if leg.get("type") == "transit"
        }
    )
    if not trip_ids and not route_ids:
        return {**result, "realtime_status": "unavailable", "realtime_generated_at": None}
    try:
        service = RealtimeService(redis)
        updates = service.snapshot("trip_updates", RealtimeFilter(trip_ids=trip_ids))
        alerts = service.snapshot("alerts", RealtimeFilter(route_ids=route_ids))
    except (RedisError, ValueError, TypeError):
        return {**result, "realtime_status": "unavailable", "realtime_generated_at": None}
    realtime_version = updates.get("feed_version") or alerts.get("feed_version")
    if not realtime_version:
        status = "unavailable"
    elif realtime_version != result["feed_version"]:
        status = "mismatched"
    else:
        status = "current"
    update_by_trip = {item.get("trip_id"): item for item in updates.get("items", [])} if status == "current" else {}
    alert_items = alerts.get("items", []) if status == "current" else []
    for option in result.get("options", []):
        for leg in option.get("legs", []):
            if leg.get("type") != "transit":
                continue
            leg["realtime"] = update_by_trip.get(leg["trip_id"])
            leg["alerts"] = [item for item in alert_items if leg["route_id"] in (item.get("route_ids") or [])]
    return {
        **result,
        "realtime_status": status,
        "realtime_generated_at": updates.get("generated_at") or alerts.get("generated_at"),
    }


@router.post("/plan", response_model=JourneyPlanResponse)
def plan(
    body: JourneyPlanRequest,
    user: Annotated[dict, Depends(current_user)],
    conn: Annotated[DbConnection, Depends(get_conn)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
) -> JourneyPlanResponse:
    if not settings.journey_planner_enabled:
        raise HTTPException(status_code=404, detail="Journey planner is disabled")
    if not body.origin.confirmed or not body.destination.confirmed:
        raise HTTPException(status_code=422, detail="Origin and destination must be confirmed")
    _limit_user(redis, user["id"], settings)
    repo = GtfsRepository(conn)
    feed = repo.active_feed()
    if not feed:
        raise HTTPException(status_code=503, detail="No active GTFS feed has been imported")
    feed_version = str(feed["feed_version"])
    try:
        index = planner_index_cache.get(feed_version, lambda: build_timetable_index(repo, feed_version, settings.journey_access_radius_m))
        result = JourneyPlanner(index, repo, settings).plan(
            origin_name=body.origin.name,
            origin_lat=body.origin.latitude,
            origin_lon=body.origin.longitude,
            destination_name=body.destination.name,
            destination_lat=body.destination.latitude,
            destination_lon=body.destination.longitude,
            departure=body.departure_time,
            option_limit=min(body.option_limit, settings.journey_max_options),
        )
    except (KeyError, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail="Journey planner is temporarily unavailable") from exc
    response.headers["Cache-Control"] = "no-store"
    return JourneyPlanResponse.model_validate(enrich_realtime(result, redis))
