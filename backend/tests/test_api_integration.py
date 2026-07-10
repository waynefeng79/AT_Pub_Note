import os

import pytest
from fastapi.testclient import TestClient

from app.main import app

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_DB_INTEGRATION_TESTS") != "1",
    reason="Requires running PostgreSQL/PostGIS and Redis; set RUN_DB_INTEGRATION_TESTS=1 after importing GTFS.",
)


def test_static_feed_has_cache_headers_with_real_services():
    with TestClient(app) as client:
        response = client.get("/api/static/v1/feed")
        assert response.status_code == 200
        assert response.headers["cache-control"].startswith("public, max-age=60")
        assert response.headers["etag"]
        assert response.headers["x-gtfs-feed-version"] == response.json()["feed_version"]

