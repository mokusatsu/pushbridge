from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status

from ..api_contract import error_responses, token_response_headers
from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import DeviceOut, DevicePatch, LinkDeviceIn, LinkDeviceOut
from ..services import device_from_row, http_error
from ..utils import expires_iso, hash_token, new_id, new_token, to_iso, utc_now

router = APIRouter(prefix="/v1/devices", tags=["devices"])


@router.get("", response_model=list[DeviceOut], responses=error_responses(401))
def list_devices(
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> list[DeviceOut]:
    with database.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM devices WHERE user_id = ? ORDER BY created_at, id",
            (auth.user_id,),
        ).fetchall()
    return [DeviceOut(**device_from_row(row, auth.device_id)) for row in rows]


@router.get(
    "/me",
    response_model=DeviceOut,
    responses=error_responses(401, 404),
)
def get_current_device(
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> DeviceOut:
    with database.connection() as conn:
        row = conn.execute(
            "SELECT * FROM devices WHERE id = ? AND user_id = ?",
            (auth.device_id, auth.user_id),
        ).fetchone()
    if row is None:
        raise http_error(404, "device_not_found", "Device not found.")
    return DeviceOut(**device_from_row(row, auth.device_id))


@router.post(
    "/link",
    response_model=LinkDeviceOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        status.HTTP_201_CREATED: {
            "description": "Device linked and device-scoped token issued.",
            "headers": token_response_headers(),
        },
        **error_responses(401, 409),
    },
)
def link_device(
    body: LinkDeviceIn,
    response: Response,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> LinkDeviceOut:
    """Mock an already-approved device link and return a device-scoped token."""

    device_id = new_id("dev")
    token = new_token("rly")
    now = to_iso(utc_now())
    expires_at = expires_iso(settings.access_token_ttl_seconds)
    with database.connection() as conn:
        active_count = conn.execute(
            "SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL",
            (auth.user_id,),
        ).fetchone()["n"]
        if active_count >= settings.max_devices:
            raise http_error(
                status.HTTP_409_CONFLICT,
                "device_limit_reached",
                f"The account is limited to {settings.max_devices} active devices.",
            )
        conn.execute(
            """
            INSERT INTO devices(
                id, user_id, kind, name, public_key, created_at, last_seen_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (device_id, auth.user_id, body.kind, body.name, body.public_key, now, now),
        )
        conn.execute(
            """
            INSERT INTO sessions(token_hash, user_id, device_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (hash_token(token), auth.user_id, device_id, now, expires_at),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM devices WHERE id = ?", (device_id,)
        ).fetchone()
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return LinkDeviceOut(
        device=DeviceOut(**device_from_row(row, auth.device_id)),
        access_token=token,
        expires_at=expires_at,
    )


@router.patch(
    "/{device_id}",
    response_model=DeviceOut,
    responses=error_responses(401, 404),
)
def rename_device(
    device_id: str,
    body: DevicePatch,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> DeviceOut:
    with database.connection() as conn:
        result = conn.execute(
            "UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            (body.name, device_id, auth.user_id),
        )
        if result.rowcount == 0:
            raise http_error(
                status.HTTP_404_NOT_FOUND,
                "device_not_found",
                "The device does not exist or has been revoked.",
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM devices WHERE id = ?", (device_id,)
        ).fetchone()
    return DeviceOut(**device_from_row(row, auth.device_id))


@router.delete(
    "/{device_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=error_responses(401, 404, 409),
)
def revoke_device(
    device_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> None:
    now = to_iso(utc_now())
    with database.connection() as conn:
        row = conn.execute(
            "SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            (device_id, auth.user_id),
        ).fetchone()
        if row is None:
            raise http_error(
                status.HTTP_404_NOT_FOUND,
                "device_not_found",
                "The device does not exist or has already been revoked.",
            )
        active_count = conn.execute(
            "SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL",
            (auth.user_id,),
        ).fetchone()["n"]
        if active_count <= 1:
            raise http_error(
                status.HTTP_409_CONFLICT,
                "last_device",
                "The last active device cannot be revoked in this mock.",
            )
        conn.execute(
            "UPDATE devices SET revoked_at = ? WHERE id = ?", (now, device_id)
        )
        conn.execute("DELETE FROM sessions WHERE device_id = ?", (device_id,))
        conn.execute(
            """
            UPDATE web_push_subscriptions
            SET revoked_at = ?
            WHERE device_id = ? AND revoked_at IS NULL
            """,
            (now, device_id),
        )
        conn.commit()
