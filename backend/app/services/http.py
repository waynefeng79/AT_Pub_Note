import httpx

from app.core.config import Settings


def at_headers(settings: Settings) -> dict[str, str]:
    if not settings.at_api_key:
        return {}
    return {settings.at_api_key_header: settings.at_api_key}


def download_bytes(url: str, settings: Settings, extra_headers: dict[str, str] | None = None) -> tuple[bytes, httpx.Headers]:
    headers = {**at_headers(settings), **(extra_headers or {})}
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        response = client.get(url, headers=headers)
        response.raise_for_status()
        return response.content, response.headers


def conditional_headers(etag: str | None, last_modified: str | None) -> dict[str, str]:
    headers = {}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    return headers


def download_bytes_if_modified(url: str, settings: Settings, etag: str | None = None, last_modified: str | None = None) -> tuple[bytes | None, httpx.Headers]:
    headers = {**at_headers(settings), **conditional_headers(etag, last_modified)}
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        response = client.get(url, headers=headers)
        if response.status_code == 304:
            return None, response.headers
        response.raise_for_status()
        return response.content, response.headers
