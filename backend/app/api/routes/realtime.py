import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse
from redis import Redis

from app.api.deps import current_user, get_redis_client
from app.models import RealtimeRequest
from app.services.realtime import RealtimeService

router = APIRouter()


def matches_refresh(payload: dict, route_ids: list[str], trip_ids: list[str], event_types: list[str]) -> bool:
    return not (
        (event_types and not set(payload.get("event_types", [])).intersection(event_types))
        or (route_ids and not set(payload.get("route_ids", [])).intersection(route_ids))
        or (trip_ids and not set(payload.get("trip_ids", [])).intersection(trip_ids))
    )


@router.post("/vehicles")
def vehicles(body: RealtimeRequest, user: Annotated[dict, Depends(current_user)], redis: Annotated[Redis, Depends(get_redis_client)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return RealtimeService(redis).snapshot("vehicles", body.realtime_filter)


@router.post("/trip-updates")
def trip_updates(body: RealtimeRequest, user: Annotated[dict, Depends(current_user)], redis: Annotated[Redis, Depends(get_redis_client)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return RealtimeService(redis).snapshot("trip_updates", body.realtime_filter)


@router.post("/alerts")
def alerts(body: RealtimeRequest, user: Annotated[dict, Depends(current_user)], redis: Annotated[Redis, Depends(get_redis_client)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return RealtimeService(redis).snapshot("alerts", body.realtime_filter)


@router.get("/stream")
def stream(
    user: Annotated[dict, Depends(current_user)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    route_id: Annotated[list[str], Query()] = [],
    trip_id: Annotated[list[str], Query()] = [],
    event_type: Annotated[list[str], Query()] = [],
):
    def events():
        pubsub = redis.pubsub()
        pubsub.subscribe("gtfsrt:channel")
        try:
            yield ": connected\n\n"
            while True:
                message = pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
                if message is None:
                    yield ": heartbeat\n\n"
                    continue
                payload = json.loads(message["data"])
                if not matches_refresh(payload, route_id, trip_id, event_type):
                    continue
                yield f"event: realtime_refresh\ndata: {json.dumps(payload)}\n\n"
        finally:
            pubsub.close()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
