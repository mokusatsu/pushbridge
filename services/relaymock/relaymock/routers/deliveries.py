from __future__ import annotations

import sqlite3
from datetime import timedelta

from fastapi import APIRouter, Depends, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ..api_contract import error_responses
from ..auth import AuthContext, get_auth_context, get_database
from ..database import Database
from ..schemas import FileDeliveryEventIn, FileDeliveryOut
from ..services import http_error
from ..utils import from_iso, hash_token, new_id, to_iso, utc_now

router = APIRouter(tags=["file deliveries"])
delivery_bearer = HTTPBearer(auto_error=False, scheme_name="DeliveryBearer")


def _out(row: sqlite3.Row) -> FileDeliveryOut:
    return FileDeliveryOut(
        id=row["id"],
        push_id=row["push_id"],
        file_id=row["file_id"],
        destination_device_id=row["destination_device_id"],
        state=row["state"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        notified_at=row["notified_at"],
        fetching_at=row["fetching_at"],
        cached_at=row["cached_at"],
        failed_at=row["failed_at"],
        missed_at=row["missed_at"],
        failure_code=row["failure_code"],
        attempt_count=row["attempt_count"],
    )


def ensure_file_deliveries(conn: sqlite3.Connection, push: sqlite3.Row, now: str) -> None:
    if push["type"] != "file" or not push["file_id"]:
        return
    if push["target_kind"] == "device":
        devices = conn.execute(
            "SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            (push["target_device_id"], push["user_id"]),
        ).fetchall()
    elif push["target_kind"] == "all_devices":
        devices = conn.execute(
            "SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id",
            (push["user_id"],),
        ).fetchall()
    else:
        devices = conn.execute(
            "SELECT id FROM devices WHERE user_id = ? AND id != ? AND revoked_at IS NULL ORDER BY id",
            (push["user_id"], push["source_device_id"]),
        ).fetchall()
    for device in devices:
        conn.execute(
            """
            INSERT OR IGNORE INTO file_deliveries(
                id, user_id, push_id, file_id, destination_device_id, state,
                created_at, updated_at, attempt_count
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)
            """,
            (new_id("fdl"), push["user_id"], push["id"], push["file_id"], device["id"], now, now),
        )


def issue_delivery_token(conn: sqlite3.Connection, delivery_id: str, token: str) -> bool:
    now = utc_now()
    result = conn.execute(
        """
        UPDATE file_deliveries
        SET ack_token_hash = ?, ack_token_expires_at = ?,
            state = CASE WHEN state = 'pending' THEN 'notified' ELSE state END,
            notified_at = COALESCE(notified_at, ?), updated_at = ?,
            attempt_count = attempt_count + 1
        WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')
        """,
        (hash_token(token), to_iso(now + timedelta(days=1)), to_iso(now), to_iso(now), delivery_id),
    )
    return result.rowcount == 1


def mark_undelivered_missed(conn: sqlite3.Connection, file_id: str, reason: str, now: str) -> None:
    conn.execute(
        """
        UPDATE file_deliveries
        SET state = 'missed', updated_at = ?, missed_at = ?, failure_code = ?
        WHERE file_id = ? AND state != 'cached'
        """,
        (now, now, reason, file_id),
    )


@router.get(
    "/v1/files/{file_id}/deliveries",
    response_model=list[FileDeliveryOut],
    responses=error_responses(401, 404),
)
def list_file_deliveries(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> list[FileDeliveryOut]:
    with database.connection() as conn:
        owned = conn.execute(
            "SELECT id FROM files WHERE id = ? AND user_id = ?", (file_id, auth.user_id)
        ).fetchone()
        if owned is None:
            raise http_error(status.HTTP_404_NOT_FOUND, "file_not_found", "File not found.")
        rows = conn.execute(
            "SELECT * FROM file_deliveries WHERE file_id = ? AND user_id = ? ORDER BY destination_device_id, id",
            (file_id, auth.user_id),
        ).fetchall()
    return [_out(row) for row in rows]


@router.post(
    "/v1/file-deliveries/{delivery_id}/events",
    response_model=FileDeliveryOut,
    responses=error_responses(401, 403, 409, 410),
)
def acknowledge_file_delivery(
    delivery_id: str,
    body: FileDeliveryEventIn,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(delivery_bearer),
    database: Database = Depends(get_database),
) -> FileDeliveryOut:
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise http_error(status.HTTP_401_UNAUTHORIZED, "delivery_token_required", "A delivery acknowledgement token is required.")
    with database.connection() as conn:
        row = conn.execute(
            "SELECT * FROM file_deliveries WHERE id = ? AND ack_token_hash = ?",
            (delivery_id, hash_token(credentials.credentials)),
        ).fetchone()
        if row is None:
            raise http_error(status.HTTP_403_FORBIDDEN, "invalid_delivery_token", "The delivery acknowledgement token is invalid.")
        now = utc_now()
        if row["ack_token_expires_at"] is None or from_iso(row["ack_token_expires_at"]) <= now:
            raise http_error(status.HTTP_410_GONE, "delivery_token_expired", "The delivery acknowledgement token has expired.")
        if row["state"] == "cached":
            response.headers["Idempotent-Replayed"] = "true"
            return _out(row)
        if row["state"] == "missed":
            raise http_error(status.HTTP_409_CONFLICT, "delivery_missed", "A missed delivery cannot be acknowledged.")
        timestamp = to_iso(now)
        failure_code = body.failure_code if body.state == "failed_retryable" else None
        conn.execute(
            """
            UPDATE file_deliveries SET state = ?, updated_at = ?,
                fetching_at = CASE WHEN ? = 'fetching' THEN COALESCE(fetching_at, ?) ELSE fetching_at END,
                cached_at = CASE WHEN ? = 'cached' THEN COALESCE(cached_at, ?) ELSE cached_at END,
                failed_at = CASE WHEN ? = 'failed_retryable' THEN ? ELSE failed_at END,
                failure_code = CASE WHEN ? = 'failed_retryable' THEN ? WHEN ? = 'cached' THEN NULL ELSE failure_code END
            WHERE id = ?
            """,
            (body.state, timestamp, body.state, timestamp, body.state, timestamp,
             body.state, timestamp, body.state, failure_code, body.state, delivery_id),
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM file_deliveries WHERE id = ?", (delivery_id,)).fetchone()
    return _out(updated)
