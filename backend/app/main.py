import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.cache.redis import RedisClient
from app.core.config import get_settings
from app.db.session import Database
from app.services.activity import realtime_active_user_log_loop
from app.services.journey_planner import build_timetable_index, planner_index_cache
from app.repositories.gtfs import GtfsRepository

logger = logging.getLogger("uvicorn.error")


def warm_journey_index(database: Database, journey_planner_enabled: bool, access_radius_m: int) -> None:
    if not journey_planner_enabled:
        return
    try:
        with database.connection() as conn:
            repo = GtfsRepository(conn)
            feed = repo.active_feed()
            if not feed:
                logger.info("journey_index_warm_skipped reason=no_active_feed")
                return
            feed_version = str(feed["feed_version"])
            planner_index_cache.get(
                feed_version,
                lambda: build_timetable_index(repo, feed_version, access_radius_m),
            )
    except Exception:
        # Do not make the whole application unavailable if a GTFS import is still in progress.
        # The journey endpoint will retry the same cache build once a feed is available.
        logger.exception("journey_index_warm_failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.db = Database(settings)
    app.state.db.open()
    app.state.redis = RedisClient(settings)
    warm_journey_index(app.state.db, settings.journey_planner_enabled, settings.journey_access_radius_m)
    active_user_log_task = asyncio.create_task(realtime_active_user_log_loop(app.state.redis.client, logger))
    try:
        yield
    finally:
        active_user_log_task.cancel()
        with suppress(asyncio.CancelledError):
            await active_user_log_task
        app.state.redis.close()
        app.state.db.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    return app


app = create_app()
