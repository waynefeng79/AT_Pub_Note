from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.api.routes.timetable import _default_from_seconds, _requested_version, _service_date
from app.models import DeparturesRequest, ServiceDateFilter, StopFilter, TimeWindow


def _request(service_date: str | None = None, from_time: str | None = None, timezone: str = "Pacific/Auckland") -> DeparturesRequest:
    return DeparturesRequest(
        stop_filter=StopFilter(stop_ids=["stop-1"], route_ids=["route-1"]),
        service_date=ServiceDateFilter(service_date=service_date, timezone=timezone),
        time_window=TimeWindow(from_time=from_time, max_results=8),
    )


def test_default_departure_start_uses_current_time_for_today():
    now = datetime(2026, 7, 25, 15, 14, 30, tzinfo=ZoneInfo("Pacific/Auckland"))

    assert _default_from_seconds(_request(), date(2026, 7, 25), now) == 54870


def test_default_departure_start_uses_auckland_feed_timezone():
    now = datetime(2026, 7, 25, 3, 14, 30, tzinfo=ZoneInfo("UTC"))

    assert _default_from_seconds(_request(timezone="UTC"), date(2026, 7, 25), now) == 54870


def test_default_departure_start_keeps_full_day_for_future_dates():
    now = datetime(2026, 7, 25, 15, 14, 30, tzinfo=ZoneInfo("Pacific/Auckland"))

    assert _default_from_seconds(_request("2026-07-26"), date(2026, 7, 26), now) == 0


def test_explicit_departure_start_overrides_current_time():
    now = datetime(2026, 7, 25, 15, 14, 30, tzinfo=ZoneInfo("Pacific/Auckland"))

    assert _default_from_seconds(_request(from_time="08:05:00"), date(2026, 7, 25), now) == 29100


def test_explicit_service_date_does_not_validate_request_timezone():
    assert _service_date(_request("2026-07-25", timezone="Not/AZone")) == date(2026, 7, 25)


class FeedRepository:
    def active_feed(self):
        return {"feed_version": "active-feed"}

    def feed_metadata(self, feed_version: str):
        return {"feed_version": feed_version} if feed_version == "retained-feed" else None


def test_departures_can_be_pinned_to_a_retained_feed_version():
    body = _request()
    body.feed_version = "retained-feed"

    assert _requested_version(FeedRepository(), body) == "retained-feed"


def test_unknown_pinned_departures_feed_returns_not_found():
    body = _request()
    body.feed_version = "expired-feed"

    with pytest.raises(HTTPException) as exc_info:
        _requested_version(FeedRepository(), body)

    assert exc_info.value.status_code == 404
