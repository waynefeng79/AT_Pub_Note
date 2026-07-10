from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from app.api.deps import current_user, get_conn
from app.core.config import Settings, get_settings
from app.db.session import DbConnection
from app.core.security import create_token, hash_password, verify_password
from app.models import AuthRequest
from app.repositories.users import UserRepository

router = APIRouter()


def _auth_payload(user: dict, settings: Settings, response: Response) -> dict:
    token = create_token({"sub": str(user["id"]), "email": user["email"]}, settings.jwt_secret_key, settings.jwt_expire_minutes)
    cookie_samesite = settings.session_cookie_samesite.lower()
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.jwt_expire_minutes * 60,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=cookie_samesite,
        path="/",
    )
    return {"access_token": token, "token_type": "bearer", "user": {"id": user["id"], "email": user["email"]}}


@router.post("/register")
def register(body: AuthRequest, settings: Annotated[Settings, Depends(get_settings)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    user = UserRepository(conn).create_user(body.email, hash_password(body.password))
    if not user:
        raise HTTPException(status_code=409, detail="Email already registered")
    conn.commit()
    return _auth_payload(user, settings, response)


@router.post("/login")
def login(body: AuthRequest, settings: Annotated[Settings, Depends(get_settings)], conn: Annotated[DbConnection, Depends(get_conn)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    user = UserRepository(conn).get_by_email(body.email)
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return _auth_payload(user, settings, response)


@router.post("/logout", status_code=204)
def logout(settings: Annotated[Settings, Depends(get_settings)], response: Response) -> Response:
    cookie_samesite = settings.session_cookie_samesite.lower()
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=cookie_samesite,
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/me")
def me(user: Annotated[dict, Depends(current_user)], response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"id": user["id"], "email": user["email"]}
