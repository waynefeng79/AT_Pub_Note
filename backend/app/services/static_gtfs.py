import hashlib
import json
from datetime import datetime

from app.repositories.gtfs import GtfsRepository


def _json_safe(value):
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return value


def response_etag(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=_json_safe).encode("utf-8")
    return f'"{hashlib.sha256(encoded).hexdigest()}"'


class StaticGtfsService:
    def __init__(self, repo: GtfsRepository):
        self.repo = repo

    def active_feed_payload(self) -> dict:
        feed = self.repo.active_feed()
        if not feed:
            raise LookupError("No active GTFS feed has been imported")
        version = feed["feed_version"]
        return {
            "feed_version": version,
            "sha256": feed["sha256"],
            "imported_at": feed["imported_at"].isoformat().replace("+00:00", "Z"),
            "urls": {
                "routes": f"/api/static/v1/feeds/{version}/routes",
                "metadata": f"/api/static/v1/feeds/{version}",
            },
        }

    def metadata(self, feed_version: str) -> dict:
        feed = self.repo.feed_metadata(feed_version)
        if not feed:
            raise LookupError("Unknown feed version")
        return {
            "feed_version": feed["feed_version"],
            "source_url": feed["source_url"],
            "sha256": feed["sha256"],
            "etag": feed["etag"],
            "last_modified": feed["last_modified"],
            "imported_at": feed["imported_at"].isoformat().replace("+00:00", "Z"),
            "counts": feed["counts"],
        }

    def assert_feed(self, feed_version: str) -> None:
        if not self.repo.feed_metadata(feed_version):
            raise LookupError("Unknown feed version")

