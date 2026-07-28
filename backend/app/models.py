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


class RealtimeRequest(BaseModel):
    realtime_filter: RealtimeFilter = Field(default_factory=RealtimeFilter)


class BatchStopsRequest(BaseModel):
    stop_filter: StopFilter


class FavouriteRoutesRequest(BaseModel):
    route_ids: list[str]
