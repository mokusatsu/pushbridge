from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings
from .database import Database
from .openapi import install_custom_openapi
from .routers import (
    auth_routes,
    devices,
    deliveries,
    files,
    mock_admin,
    pushes,
    subscriptions,
    system,
)
from .services import cleanup_expired
from .utils import new_id


async def _cleanup_loop(app: FastAPI) -> None:
    settings: Settings = app.state.settings
    while True:
        await asyncio.sleep(settings.cleanup_interval_seconds)
        await asyncio.to_thread(cleanup_expired, app.state.database, settings)


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", new_id("req"))


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        resolved.storage_dir.mkdir(parents=True, exist_ok=True)
        database = Database(resolved.database_path)
        database.initialize()
        app.state.settings = resolved
        app.state.database = database
        cleanup_task = None
        if resolved.cleanup_interval_seconds > 0:
            cleanup_task = asyncio.create_task(_cleanup_loop(app))
        try:
            yield
        finally:
            if cleanup_task is not None:
                cleanup_task.cancel()
                with suppress(asyncio.CancelledError):
                    await cleanup_task

    app = FastAPI(
        title=resolved.app_name,
        version=resolved.app_version,
        description=(
            "Local mock for a Pushbullet-like device relay API. "
            "It deliberately uses development-only authentication and local storage."
        ),
        servers=[{"url": "http://127.0.0.1:8000", "description": "Local Uvicorn"}],
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[
            "Idempotent-Replayed",
            "X-Request-ID",
            "Cache-Control",
            "Pragma",
        ],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        supplied = request.headers.get("X-Request-ID", "")
        request_id = (
            supplied
            if supplied.startswith("req_") and 4 < len(supplied) <= 200
            else new_id("req")
        )
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        request_id = _request_id(request)
        if isinstance(exc.detail, dict):
            code = str(exc.detail.get("code", "http_error"))
            message = str(exc.detail.get("message", "The request failed."))
        else:
            code = "not_found" if exc.status_code == 404 else "http_error"
            message = str(exc.detail)
        headers = dict(exc.headers or {})
        headers["X-Request-ID"] = request_id
        return JSONResponse(
            status_code=exc.status_code,
            headers=headers,
            content={
                "detail": {
                    "code": code,
                    "message": message,
                    "request_id": request_id,
                }
            },
        )

    @app.exception_handler(Exception)
    async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
        request_id = _request_id(request)
        return JSONResponse(
            status_code=500,
            headers={"X-Request-ID": request_id},
            content={
                "detail": {
                    "code": "internal_error",
                    "message": "The local mock encountered an unexpected error.",
                    "request_id": request_id,
                }
            },
        )

    @app.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"status": "ok", "version": resolved.app_version}

    app.include_router(system.router)
    app.include_router(auth_routes.router)
    app.include_router(devices.router)
    app.include_router(pushes.router)
    app.include_router(files.router)
    app.include_router(deliveries.router)
    app.include_router(subscriptions.router)
    if resolved.enable_mock_admin:
        app.include_router(mock_admin.router)

    install_custom_openapi(app)
    return app


app = create_app()
