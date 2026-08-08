from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AuthRequest(BaseModel):
    email: str
    password: str = Field(min_length=8)


class SpatialQuery(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: int = Field(default=800, ge=1, le=5000)
    limit: int = Field(default=20, ge=1, le=100)


class RouteFilter(BaseModel):
    route_ids: list[str] = []
    route_types: list[int] = []
    search: str | None = None
    direction_id: int | None = None
    include_inactive: bool = False


class StopFilter(BaseModel):
    stop_ids: list[str] = []
    parent_station_ids: list[str] = []
    route_ids: list[str] = []
    direction_ids: list[int] = []


class ServiceDateFilter(BaseModel):
    service_date: str | None = None
    timezone: str = "Pacific/Auckland"


class TimeWindow(BaseModel):
    from_time: str | None = None
    to_time: str | None = None
    max_results: int = Field(default=10, ge=1, le=100)


class RealtimeFilter(BaseModel):
    route_ids: list[str] = []
    trip_ids: list[str] = []
    vehicle_ids: list[str] = []
    stop_ids: list[str] = []
    direction_ids: list[int] = []
    event_types: list[str] = []


class NearbyStopsRequest(BaseModel):
    spatial: SpatialQuery


class NearbyRoutesRequest(BaseModel):
    spatial: SpatialQuery
    route_filter: RouteFilter = Field(default_factory=RouteFilter)


class RoutesOnStopsRequest(BaseModel):
    stop_filter: StopFilter


class DeparturesRequest(BaseModel):
    stop_filter: StopFilter
    service_date: ServiceDateFilter = Field(default_factory=ServiceDateFilter)
    time_window: TimeWindow = Field(default_factory=TimeWindow)
    feed_version: str | None = Field(default=None, min_length=1, max_length=200)


class RealtimeRequest(BaseModel):
    realtime_filter: RealtimeFilter = Field(default_factory=RealtimeFilter)


class BatchStopsRequest(BaseModel):
    stop_filter: StopFilter


class FavouriteRoutesRequest(BaseModel):
    route_ids: list[str]


class PlaceCandidate(BaseModel):
    id: str
    name: str
    display_name: str
    secondary_text: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    category: str
    type: str
    bounding_box: list[float] | None = None
    attribution: str


class GeocodingSearchResponse(BaseModel):
    query: str
    candidates: list[PlaceCandidate]
    attribution: str
    cache: str


class GeocodingReverseResponse(BaseModel):
    latitude: float
    longitude: float
    candidate: PlaceCandidate | None
    attribution: str
    cache: str


class GeocodingErrorPayload(BaseModel):
    code: str
    message: str
    retryable: bool = False
    retry_after_seconds: int | None = None


class JourneyEndpoint(BaseModel):
    place_id: str | None = None
    name: str = Field(min_length=1, max_length=300)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    confirmed: bool = True


class JourneyPlanRequest(BaseModel):
    origin: JourneyEndpoint
    destination: JourneyEndpoint
    departure_time: datetime
    option_limit: int = Field(default=5, ge=1, le=20)


class JourneyPoint(BaseModel):
    name: str
    latitude: float
    longitude: float
    stop_id: str | None = None
    platform_code: str | None = None


class TransitJourneyLeg(BaseModel):
    type: Literal["transit"]
    route_id: str
    route_short_name: str
    route_long_name: str
    route_type: int
    route_color: str | None = None
    route_text_color: str | None = None
    trip_id: str
    direction_id: int | None = None
    shape_id: str | None = None
    headsign: str | None = None
    service_date: str
    from_: JourneyPoint = Field(alias="from")
    to: JourneyPoint
    scheduled_departure: datetime
    scheduled_arrival: datetime
    realtime: dict | None = None
    alerts: list[dict] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class JourneyOption(BaseModel):
    id: str
    departure_time: datetime
    duration_seconds: int = Field(ge=0)
    transfers: int = Field(ge=0, le=2)
    legs: list[TransitJourneyLeg]


class JourneyPlanResponse(BaseModel):
    feed_version: str
    service_date: str
    status: Literal["ok", "no_journey"]
    realtime_status: Literal["current", "unavailable", "mismatched"]
    realtime_generated_at: str | None = None
    options: list[JourneyOption]
