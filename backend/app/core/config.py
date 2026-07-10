from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Auckland Transport Public Note API"
    environment: str = "development"

    database_url: str = "postgresql://at:at@127.0.0.1:5432/at_pub_note"
    redis_url: str = "redis://127.0.0.1:6379/0"

    jwt_secret_key: str = "dev-secret-change-me"
    jwt_expire_minutes: int = 1440
    session_cookie_name: str = "at_public_note_session"
    session_cookie_secure: bool = False
    session_cookie_samesite: str = "lax"
    frontend_origins: str = "http://localhost:5173"

    gtfs_static_url: str | None = None
    gtfs_static_zip_path: Path | None = Path("../data/gtfs.zip")
    gtfs_static_poll_seconds: int = 3600
    gtfs_retain_inactive_feeds: int = 2

    gtfs_realtime_url: str | None = None
    realtime_raw_path: Path | None = Path("../data/RealTimeRaw.json")
    realtime_feed_format: str = "auto"
    gtfs_realtime_poll_seconds: int = 30
    gtfs_realtime_lock_ttl_seconds: int = 600

    at_api_key: str | None = None
    at_api_key_header: str = "Ocp-Apim-Subscription-Key"

    spatial_cache_enabled: bool = True
    spatial_cache_ttl_seconds: int = 900
    spatial_cache_cell_precision: int = 2

    cloudflare_zone_id: str | None = None
    cloudflare_api_token: str | None = None

    model_config = SettingsConfigDict(env_file="../.env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
