from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from redis import Redis

from app.api.deps import current_user, get_redis_client
from app.core.config import Settings, get_settings
from app.models import GeocodingReverseResponse, GeocodingSearchResponse
from app.services.geocoding import (
    OSM_ATTRIBUTION,
    GeocodingPolicyError,
    GeocodingProviderError,
    GeocodingService,
    NominatimProvider,
)

router = APIRouter()


def _error(exc: GeocodingProviderError) -> HTTPException:
    status = 429 if isinstance(exc, GeocodingPolicyError) and exc.status_code == 429 else 503
    return HTTPException(
        status_code=status,
        detail={"code": "geocoding_unavailable", "message": str(exc), "retryable": exc.retryable, "retry_after_seconds": 1},
        headers={"Retry-After": "1"} if exc.retryable else None,
    )


@router.get("/search", response_model=GeocodingSearchResponse)
def search(
    q: Annotated[str, Query()],
    user: Annotated[dict, Depends(current_user)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
    limit: Annotated[int | None, Query(ge=1, le=20)] = None,
) -> GeocodingSearchResponse:
    del user
    query = " ".join(q.split())
    if len(query) < settings.geocoding_min_query_length:
        raise HTTPException(status_code=422, detail=f"Search query must contain at least {settings.geocoding_min_query_length} characters")
    effective_limit = min(limit or settings.geocoding_result_limit, settings.geocoding_result_limit)
    try:
        candidates, cache = GeocodingService(NominatimProvider(settings), redis, settings).search(query, effective_limit)
    except GeocodingProviderError as exc:
        raise _error(exc) from exc
    response.headers["Cache-Control"] = "private, max-age=60"
    return GeocodingSearchResponse(query=query, candidates=candidates, attribution=OSM_ATTRIBUTION, cache=cache)


@router.get("/reverse", response_model=GeocodingReverseResponse)
def reverse(
    lat: Annotated[float, Query(ge=-90, le=90)],
    lon: Annotated[float, Query(ge=-180, le=180)],
    user: Annotated[dict, Depends(current_user)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
) -> GeocodingReverseResponse:
    del user
    try:
        candidate, cache = GeocodingService(NominatimProvider(settings), redis, settings).reverse(lat, lon)
    except GeocodingProviderError as exc:
        raise _error(exc) from exc
    response.headers["Cache-Control"] = "private, max-age=60"
    return GeocodingReverseResponse(
        latitude=lat,
        longitude=lon,
        candidate=candidate,
        attribution=OSM_ATTRIBUTION,
        cache=cache,
    )
