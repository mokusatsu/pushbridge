from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Response, status

from ..api_contract import error_responses, token_response_headers
from ..auth import get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import BootstrapIn, BootstrapOut, DeviceOut, UserOut
from ..services import device_from_row, http_error
from ..utils import expires_iso, hash_token, new_id, new_token, to_iso, utc_now

router = APIRouter(prefix="/v1/auth", tags=["authentication"])


@router.post(
    "/bootstrap",
    response_model=BootstrapOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a local mock account and its first device",
    responses={
        status.HTTP_201_CREATED: {
            "description": "Local account and first device created.",
            "headers": token_response_headers(),
        },
        **error_responses(409),
    },
)
def bootstrap(
    body: BootstrapIn,
    response: Response,
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> BootstrapOut:
    """Development-only bootstrap endpoint.

    Production should replace this with passkeys/OAuth and an approved device-link flow.
    """

    user_id = new_id("usr")
    device_id = new_id("dev")
    token = new_token("rly")
    now = to_iso(utc_now())
    token_expires_at = expires_iso(settings.access_token_ttl_seconds)

    try:
        with database.connection() as conn:
            conn.execute(
                "INSERT INTO users(id, handle, created_at) VALUES (?, ?, ?)",
                (user_id, body.handle, now),
            )
            conn.execute(
                """
                INSERT INTO devices(
                    id, user_id, kind, name, public_key, created_at, last_seen_at, revoked_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    device_id,
                    user_id,
                    body.device_kind,
                    body.device_name,
                    body.public_key,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO sessions(token_hash, user_id, device_id, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (hash_token(token), user_id, device_id, now, token_expires_at),
            )
            conn.commit()
            user_row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            device_row = conn.execute(
                "SELECT * FROM devices WHERE id = ?", (device_id,)
            ).fetchone()
    except sqlite3.IntegrityError as exc:
        raise http_error(
            status.HTTP_409_CONFLICT,
            "handle_exists",
            "That handle already exists in this local mock database.",
        ) from exc

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return BootstrapOut(
        user=UserOut(**dict(user_row)),
        device=DeviceOut(**device_from_row(device_row, device_id)),
        access_token=token,
        expires_at=token_expires_at,
    )
