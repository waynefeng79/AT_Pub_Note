from typing import Annotated
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response
from app.api.deps import current_user, get_conn
from app.db.session import DbConnection
from app.models import DeparturesRequest
from app.repositories.gtfs import GtfsRepository
from app.utils.time import seconds_from_gtfs_time

router = APIRouter()
GTFS_SERVICE_TIMEZONE = ZoneInfo("Pacific/Auckland")
NEXT_DEPARTURES_LOOKBACK_SECONDS = 2 * 60 * 60


def _active_version(repo: GtfsRepository) -> str:
    feed = repo.active_feed()
    if not feed:
        raise HTTPException(status_code=503, detail="No active GTFS feed has been imported")
    return feed["feed_version"]


def _service_date(body: DeparturesRequest) -> date:
    if body.service_date.service_date:
        try:
            return date.fromisoformat(body.service_date.service_date)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="service_date must use YYYY-MM-DD") from exc
    return datetime.now(GTFS_SERVICE_TIMEZONE).date()


def _default_from_seconds(body: DeparturesRequest, service_date: date, now: datetime | None = None) -> int:
    if body.time_window.from_time:
        return seconds_from_gtfs_time(body.time_window.from_time, 0)
    current = now.astimezone(GTFS_SERVICE_TIMEZONE) if now else datetime.now(GTFS_SERVICE_TIMEZONE)
    if service_date != current.date():
        return 0
    return current.hour * 3600 + current.minute * 60 + current.second


def _next_from_seconds(body: DeparturesRequest, service_date: date) -> int:
    if body.time_window.from_time:
        return _default_from_seconds(body, service_date)
    return max(0, _default_from_seconds(body, service_date) - NEXT_DEPARTURES_LOOKBACK_SECONDS)


@router.post("/departures")
def departures(body: DeparturesRequest, user: Annotated[dict, Depends(current_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    repo = GtfsRepository(conn)
    feed_version = _active_version(repo)
    service_date = _service_date(body)
    items = repo.departures(
        feed_version,
        body.stop_filter.stop_ids,
        body.stop_filter.route_ids,
        body.stop_filter.direction_ids,
        service_date,
        _default_from_seconds(body, service_date),
        seconds_from_gtfs_time(body.time_window.to_time, 47 * 3600 + 59 * 60 + 59),
        body.time_window.max_results,
    )
    return {"feed_version": feed_version, "service_date": service_date.isoformat(), "items": items}


@router.post("/next-departures")
def next_departures(body: DeparturesRequest, user: Annotated[dict, Depends(current_user)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    repo = GtfsRepository(conn)
    feed_version = _active_version(repo)
    service_date = _service_date(body)
    items = repo.departures(
        feed_version,
        body.stop_filter.stop_ids,
        body.stop_filter.route_ids,
        body.stop_filter.direction_ids,
        service_date,
        _next_from_seconds(body, service_date),
        seconds_from_gtfs_time(body.time_window.to_time, 47 * 3600 + 59 * 60 + 59),
        body.time_window.max_results,
    )
    return {"feed_version": feed_version, "service_date": service_date.isoformat(), "items": items}
