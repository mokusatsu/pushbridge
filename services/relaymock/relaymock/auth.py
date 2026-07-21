from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings
from .database import Database
from .utils import from_iso, hash_token, to_iso, utc_now


@dataclass(frozen=True, slots=True)
class AuthContext:
    user_id: str
    handle: str
    device_id: str


bearer_scheme = HTTPBearer(auto_error=False, scheme_name="DeviceBearer")


def get_database(request: Request) -> Database:
    return request.app.state.database


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def _unauthorized(message: str = "A valid bearer token is required.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "unauthorized", "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_auth_context(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ],
    database: Database = Depends(get_database),
) -> AuthContext:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    token = credentials.credentials
    if not token:
        raise _unauthorized()

    now = utc_now()
    with database.connection() as conn:
        row = conn.execute(
            """
            SELECT s.expires_at, s.user_id, s.device_id, u.handle, d.revoked_at,
                   d.last_seen_at
            FROM sessions AS s
            JOIN users AS u ON u.id = s.user_id
            JOIN devices AS d ON d.id = s.device_id
            WHERE s.token_hash = ?
            """,
            (hash_token(token),),
        ).fetchone()
        if row is None or row["revoked_at"] is not None:
            raise _unauthorized()
        if from_iso(row["expires_at"]) <= now:
            raise _unauthorized("The bearer token has expired.")

        # Limit last_seen write amplification while still making the mock useful in UIs.
        if (now - from_iso(row["last_seen_at"])).total_seconds() >= 60:
            conn.execute(
                "UPDATE devices SET last_seen_at = ? WHERE id = ?",
                (to_iso(now), row["device_id"]),
            )
            conn.commit()

    return AuthContext(
        user_id=row["user_id"],
        handle=row["handle"],
        device_id=row["device_id"],
    )


def require_mock_admin(
    x_mock_admin: Annotated[
        str | None,
        Header(
            alias="X-Mock-Admin",
            description="Explicit local-development administration token.",
            min_length=1,
        ),
    ] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.enable_mock_admin:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Not found."},
        )
    if x_mock_admin != settings.mock_admin_token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "invalid_admin_token",
                "message": "Invalid or missing mock admin token.",
            },
        )
