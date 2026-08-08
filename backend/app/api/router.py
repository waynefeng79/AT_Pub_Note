from fastapi import APIRouter

from app.api.routes import app as app_routes
from app.api.routes import auth, discovery, geocoding, health, journeys, realtime, static, timetable

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router, prefix="/api/auth/v1", tags=["auth"])
api_router.include_router(static.router, prefix="/api/static/v1", tags=["static"])
api_router.include_router(discovery.router, prefix="/api/discovery/v1", tags=["discovery"])
api_router.include_router(geocoding.router, prefix="/api/geocoding/v1", tags=["geocoding"])
api_router.include_router(journeys.router, prefix="/api/journeys/v1", tags=["journeys"])
api_router.include_router(timetable.router, prefix="/api/timetable/v1", tags=["timetable"])
api_router.include_router(realtime.router, prefix="/api/realtime/v1", tags=["realtime"])
api_router.include_router(app_routes.router, prefix="/api/app/v1", tags=["app"])

