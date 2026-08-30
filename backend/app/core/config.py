from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Auckland Transport Public Note API"
    environment: str = "development"

    database_url: str = "postgresql://at:at@127.0.0.1:5432/at_pub_note"
    redis_url: str = "redis://127.0.0.1:6379/0"
    database_power_control_enabled: bool = False
    database_power_backend_class: str | None = None
    database_idle_seconds: int = Field(default=2700, ge=300)
    database_min_up_seconds: int = Field(default=900, ge=60)
    database_power_check_seconds: int = Field(default=15, ge=5, le=300)
    database_power_retry_after_seconds: int = Field(default=5, ge=1, le=60)

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

    journey_planner_enabled: bool = True
    nominatim_base_url: str = "https://nominatim.openstreetmap.org"
    nominatim_public_policy: bool = True
    nominatim_user_agent: str = "AT-Public-Note/1.0"
    nominatim_contact: str = ""
    nominatim_country_codes: str = "nz"
    nominatim_viewbox: str = "174.15,-37.25,175.35,-36.35"
    nominatim_bounded: bool = True
    nominatim_language: str = "en"
    nominatim_timeout_seconds: float = Field(default=8.0, gt=0, le=60)
    geocoding_min_query_length: int = Field(default=3, ge=1, le=20)
    geocoding_result_limit: int = Field(default=8, ge=1, le=20)
    geocoding_cache_ttl_seconds: int = Field(default=86400, ge=60)
    geocoding_negative_cache_ttl_seconds: int = Field(default=900, ge=30)
    geocoding_reverse_cache_ttl_seconds: int = Field(default=86400, ge=60)
    geocoding_rate_wait_seconds: float = Field(default=2.5, ge=0, le=30)

    journey_timezone: str = "Pacific/Auckland"
    journey_access_radius_m: int = Field(default=1000, ge=100, le=5000)
    journey_walking_speed_mps: float = Field(default=1.2, gt=0, le=3)
    journey_transfer_buffer_seconds: int = Field(default=120, ge=0, le=1800)
    journey_max_transfers: int = Field(default=2, ge=0, le=2)
    journey_max_options: int = Field(default=5, ge=1, le=20)
    journey_max_access_stops: int = Field(default=12, ge=1, le=100)
    journey_search_horizon_seconds: int = Field(default=21600, ge=1800, le=172800)
    journey_requests_per_minute: int = Field(default=30, ge=1, le=600)

    cloudflare_zone_id: str | None = None
    cloudflare_api_token: str | None = None

    model_config = SettingsConfigDict(env_file="../.env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]

    @property
    def nominatim_identification(self) -> str:
        return f"{self.nominatim_user_agent} ({self.nominatim_contact})" if self.nominatim_contact else self.nominatim_user_agent

    @model_validator(mode="after")
    def validate_production_settings(self):
        if self.environment.lower() == "production" and self.nominatim_public_policy and not self.nominatim_contact.strip():
            raise ValueError("NOMINATIM_CONTACT is required in production when public Nominatim policy is enabled")
        if self.database_power_control_enabled:
            backend_class = (self.database_power_backend_class or "").strip()
            if not backend_class:
                raise ValueError("DATABASE_POWER_BACKEND_CLASS is required when database power control is enabled")
            module_name, separator, class_name = backend_class.partition(":")
            if not separator or not module_name or not class_name:
                raise ValueError("DATABASE_POWER_BACKEND_CLASS must use module:Class format")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
