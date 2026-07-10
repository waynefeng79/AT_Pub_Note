from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from redis import Redis

from app.api.deps import current_user, get_conn, get_redis_client
from app.core.config import Settings, get_settings
from app.db.session import DbConnection
from app.models import NearbyRoutesRequest, NearbyStopsRequest, RoutesOnStopsRequest
from app.repositories.gtfs import GtfsRepository
from app.services.discovery import DiscoveryService

router = APIRouter()


def _active_version(repo: GtfsRepository) -> str:
    feed = repo.active_feed()
    if not feed:
        raise HTTPException(status_code=503, detail="No active GTFS feed has been imported")
    return feed["feed_version"]


@router.post("/nearby-stops")
def nearby_stops(
    body: NearbyStopsRequest,
    user: Annotated[dict, Depends(current_user)],
    conn: Annotated[DbConnection, Depends(get_conn)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    repo = GtfsRepository(conn)
    feed_version = _active_version(repo)
    result = DiscoveryService(repo, redis, settings).nearby_stops(feed_version, body.spatial.lat, body.spatial.lon, body.spatial.radius_m, body.spatial.limit)
    return {"feed_version": feed_version, **result}


@router.post("/nearby-routes")
def nearby_routes(
    body: NearbyRoutesRequest,
    user: Annotated[dict, Depends(current_user)],
    conn: Annotated[DbConnection, Depends(get_conn)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    repo = GtfsRepository(conn)
    feed_version = _active_version(repo)
    result = DiscoveryService(repo, redis, settings).nearby_routes(
        feed_version, body.spatial.lat, body.spatial.lon, body.spatial.radius_m, body.spatial.limit, body.route_filter.route_types
    )
    return {"feed_version": feed_version, **result}


@router.post("/routes-on-stops")
def routes_on_stops(body: RoutesOnStopsRequest, user: Annotated[dict, Depends(current_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    repo = GtfsRepository(conn)
    feed_version = _active_version(repo)
    return {"feed_version": feed_version, "items": repo.routes_on_stops(feed_version, body.stop_filter.stop_ids)}
