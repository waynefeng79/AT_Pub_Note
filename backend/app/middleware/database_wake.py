import asyncio

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response


class DatabaseWakeMiddleware(BaseHTTPMiddleware):
    """Wake a managed database resource before requests reach database dependencies."""

    EXEMPT_PATHS = {"/api/health", "/api/ready"}

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method == "OPTIONS" or not request.url.path.startswith("/api/") or request.url.path in self.EXEMPT_PATHS:
            return await call_next(request)

        controller = getattr(request.app.state, "database_power", None)
        if controller is None or await asyncio.to_thread(controller.ensure_available):
            return await call_next(request)

        retry_after = controller.settings.database_power_retry_after_seconds
        return JSONResponse(
            status_code=503,
            content={
                "detail": {
                    "code": "database_starting",
                    "message": "The database service is starting",
                    "retryable": True,
                    "retry_after_seconds": retry_after,
                }
            },
            headers={"Retry-After": str(retry_after)},
        )
