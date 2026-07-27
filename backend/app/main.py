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

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.db = Database(settings)
    app.state.db.open()
    app.state.redis = RedisClient(settings)
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
