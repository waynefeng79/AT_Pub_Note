from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis import Redis

from app.cache.redis import RedisClient
from app.core.config import Settings, get_settings
from app.core.security import decode_token
from app.db.session import Database, DbConnection
from app.repositories.users import UserRepository

bearer = HTTPBearer(auto_error=False)


def get_db_pool() -> Database:
    from app.main import app

    return app.state.db


def get_redis_client() -> Redis:
    from app.main import app

    return app.state.redis.client


def get_conn(db: Annotated[Database, Depends(get_db_pool)]) -> Iterator[DbConnection]:
    with db.connection() as conn:
        yield conn


def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    token = credentials.credentials if credentials else request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    payload = decode_token(token, settings.jwt_secret_key)
    if not payload or not payload.get("sub"):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    return {"id": user_id, "email": payload.get("email")}


def current_db_user(
    token_user: Annotated[dict, Depends(current_user)],
    conn: Annotated[DbConnection, Depends(get_conn)],
) -> dict:
    user = UserRepository(conn).get_by_id(token_user["id"])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user
