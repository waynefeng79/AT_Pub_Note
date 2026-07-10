from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from app.api.deps import get_conn
from app.db.session import DbConnection
from app.models import BatchStopsRequest
from app.repositories.gtfs import GtfsRepository
from app.services.static_gtfs import StaticGtfsService, response_etag

router = APIRouter()


def _headers(response: Response, feed_version: str, payload: dict, active: bool = False) -> None:
    response.headers["ETag"] = response_etag(payload)
    response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300" if active else "public, max-age=86400, immutable"
    response.headers["X-GTFS-Feed-Version"] = feed_version


def _service(conn: DbConnection) -> StaticGtfsService:
    return StaticGtfsService(GtfsRepository(conn))


@router.get("/feed")
def active_feed(conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    try:
        payload = _service(conn).active_feed_payload()
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    _headers(response, payload["feed_version"], payload, active=True)
    return payload


@router.get("/feeds/{feed_version}")
def feed_metadata(feed_version: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    try:
        payload = _service(conn).metadata(feed_version)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/routes")
def routes(
    feed_version: str,
    conn: Annotated[DbConnection, Depends(get_conn)],
    response: Response,
    search: str | None = None,
    route_type: Annotated[list[int], Query()] = [],
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    repo = GtfsRepository(conn)
    if not repo.feed_metadata(feed_version):
        raise HTTPException(status_code=404, detail="Unknown feed version")
    result = repo.route_list(feed_version, search, route_type, limit, offset)
    payload = {"feed_version": feed_version, "items": result["items"], "page": {"limit": limit, "offset": offset, "total": result["total"]}}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/routes/{route_id}")
def route_detail(feed_version: str, route_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    detail = GtfsRepository(conn).route_detail(feed_version, route_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Route not found")
    payload = {"feed_version": feed_version, **detail}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/routes/{route_id}/shapes")
def route_shapes(feed_version: str, route_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response, direction_id: int | None = None) -> dict:
    payload = {"feed_version": feed_version, "route_id": route_id, "items": GtfsRepository(conn).route_shapes(feed_version, route_id, direction_id)}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/trips/{trip_id}/shape")
def trip_shape(feed_version: str, trip_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    shape = GtfsRepository(conn).trip_shape(feed_version, trip_id)
    if not shape:
        raise HTTPException(status_code=404, detail="Trip shape not found")
    payload = {"feed_version": feed_version, **shape}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/routes/{route_id}/stops")
def route_stops(feed_version: str, route_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response, direction_id: int | None = None, trip_id: str | None = None) -> dict:
    payload = {"feed_version": feed_version, "route_id": route_id, "directions": GtfsRepository(conn).route_stops(feed_version, route_id, direction_id, trip_id)}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/trips/{trip_id}/stops")
def trip_stops(feed_version: str, trip_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    item = GtfsRepository(conn).trip_stops(feed_version, trip_id)
    if not item:
        raise HTTPException(status_code=404, detail="Trip not found")
    payload = {"feed_version": feed_version, **item}
    _headers(response, feed_version, payload)
    return payload


@router.get("/feeds/{feed_version}/stops/{stop_id}")
def stop_detail(feed_version: str, stop_id: str, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    stop = GtfsRepository(conn).stop_detail(feed_version, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    payload = {"feed_version": feed_version, "stop": stop}
    _headers(response, feed_version, payload)
    return payload


@router.post("/feeds/{feed_version}/stops/batch")
def stop_batch(feed_version: str, body: BatchStopsRequest, conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    payload = {"feed_version": feed_version, "items": GtfsRepository(conn).stops_batch(feed_version, body.stop_filter.stop_ids)}
    _headers(response, feed_version, payload)
    return payload
