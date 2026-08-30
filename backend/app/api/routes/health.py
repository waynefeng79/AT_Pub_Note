from fastapi import APIRouter, Response, status

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


def readiness(app) -> dict:
    db_ok = False
    redis_ok = False
    controller = getattr(app.state, "database_power", None)
    database_state = controller.reported_state() if controller else "unmanaged"
    if database_state not in {"stopped", "starting", "stopping", "unavailable"}:
        try:
            with app.state.db.connection() as conn:
                db_ok = bool(conn.execute("SELECT 1 AS ok").fetchone()["ok"])
        except Exception:
            db_ok = False
    try:
        redis_ok = bool(app.state.redis.client.ping())
    except Exception:
        redis_ok = False
    return {
        "status": "ready" if db_ok and redis_ok else "degraded",
        "database": db_ok,
        "database_state": database_state,
        "redis": redis_ok,
    }


@router.get("/ready")
def ready(response: Response) -> dict:
    from app.main import app

    payload = readiness(app)
    if payload["status"] == "degraded":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return payload
