from fastapi import Response
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request

from app.api import deps
from app.api.routes.auth import _auth_payload, logout
from app.core.config import Settings


class FakeUserRepository:
    calls = 0

    def __init__(self, conn):
        self.conn = conn

    def get_by_id(self, user_id: int):
        FakeUserRepository.calls += 1
        return {"id": user_id, "email": "commuter@example.com"}


def settings() -> Settings:
    return Settings(
        _env_file=None,
        jwt_secret_key="test-secret",
        session_cookie_name="test_session",
    )


def request_with_cookie(cookie: str) -> Request:
    return Request({"type": "http", "headers": [(b"cookie", cookie.encode("ascii"))]})


def test_auth_payload_sets_httponly_session_cookie():
    response = Response()

    payload = _auth_payload({"id": 7, "email": "commuter@example.com"}, settings(), response)

    cookie = response.headers["set-cookie"].lower()
    assert payload["token_type"] == "bearer"
    assert "test_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie


def test_current_user_accepts_session_cookie(monkeypatch):
    FakeUserRepository.calls = 0
    response = Response()
    payload = _auth_payload({"id": 7, "email": "commuter@example.com"}, settings(), response)
    request = request_with_cookie(f"test_session={payload['access_token']}")
    monkeypatch.setattr(deps, "UserRepository", FakeUserRepository)

    user = deps.current_user(request, None, settings())

    assert user == {"id": 7, "email": "commuter@example.com"}
    assert FakeUserRepository.calls == 0


def test_current_user_keeps_bearer_compatibility(monkeypatch):
    FakeUserRepository.calls = 0
    response = Response()
    payload = _auth_payload({"id": 7, "email": "commuter@example.com"}, settings(), response)
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=payload["access_token"])
    monkeypatch.setattr(deps, "UserRepository", FakeUserRepository)

    user = deps.current_user(request_with_cookie(""), credentials, settings())

    assert user["id"] == 7
    assert FakeUserRepository.calls == 0


def test_current_db_user_validates_against_repository(monkeypatch):
    FakeUserRepository.calls = 0
    monkeypatch.setattr(deps, "UserRepository", FakeUserRepository)

    user = deps.current_db_user({"id": 7, "email": "commuter@example.com"}, object())

    assert user == {"id": 7, "email": "commuter@example.com"}
    assert FakeUserRepository.calls == 1


def test_logout_expires_session_cookie():
    response = Response()

    logout(settings(), response)

    cookie = response.headers["set-cookie"].lower()
    assert "test_session=" in cookie
    assert "max-age=0" in cookie
