from __future__ import annotations

import hashlib
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import FileResponse

from ..api_contract import error_responses
from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import DownloadTicketOut, FileInitIn, FileInitOut, FileOut
from ..services import (
    cleanup_expired,
    file_from_row,
    http_error,
    retain_lightweight_file_aliases,
    touch_file_pushes,
)
from ..utils import (
    from_iso,
    hash_token,
    new_id,
    new_token,
    safe_download_name,
    to_iso,
    utc_now,
)
from .deliveries import mark_undelivered_missed

router = APIRouter(tags=["files"])

_BINARY_SCHEMA = {
    "type": "string",
    "format": "binary",
    "contentMediaType": "application/octet-stream",
    "contentEncoding": "binary",
}


def _owned_file(conn, user_id: str, file_id: str):
    row = conn.execute(
        "SELECT * FROM files WHERE id = ? AND user_id = ?", (file_id, user_id)
    ).fetchone()
    if row is None:
        raise http_error(status.HTTP_404_NOT_FOUND, "file_not_found", "File not found.")
    return row


@router.post(
    "/v1/files/init",
    response_model=FileInitOut,
    status_code=status.HTTP_201_CREATED,
    responses=error_responses(401, 413, 507),
)
def init_file(
    body: FileInitIn,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileInitOut:
    if body.size > settings.max_file_size_bytes:
        raise http_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "file_too_large",
            f"The local mock limit is {settings.max_file_size_bytes} bytes.",
        )
    cleanup = cleanup_expired(database, settings, required_bytes=body.size)
    if cleanup["stored_or_reserved_bytes"] + body.size > settings.storage_budget_bytes:
        raise http_error(
            status.HTTP_507_INSUFFICIENT_STORAGE,
            "storage_pressure",
            "Storage capacity is temporarily unavailable after automatic cleanup.",
        )

    now = utc_now()
    now_iso = to_iso(now)
    ttl = body.expires_in or settings.default_file_ttl_seconds
    expires_at = to_iso(now + timedelta(seconds=ttl))
    alias_expires_at = to_iso(now + timedelta(seconds=settings.file_alias_ttl_seconds))
    ticket_expires_at = to_iso(
        now + timedelta(seconds=settings.upload_ticket_ttl_seconds)
    )
    file_id = new_id("fil")
    object_key = f"{auth.user_id}/{file_id}.bin"
    ticket = new_token("upl")

    with database.connection() as conn:
        conn.execute(
            """
            INSERT INTO files(
                id, user_id, object_key, original_name, content_type,
                expected_size, actual_size, expected_sha256, actual_sha256,
                state, created_at, completed_at, expires_at, deleted_at,
                delete_reason, alias_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, ?)
            """,
            (
                file_id,
                auth.user_id,
                object_key,
                body.filename,
                body.content_type,
                body.size,
                body.sha256.lower() if body.sha256 else None,
                now_iso,
                expires_at,
                alias_expires_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO tickets(token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
            VALUES (?, ?, ?, 'upload', ?, ?, NULL)
            """,
            (hash_token(ticket), auth.user_id, file_id, now_iso, ticket_expires_at),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM files WHERE id = ?", (file_id,)
        ).fetchone()

    upload_url = str(request.url_for("upload_file_bytes", ticket=ticket))
    return FileInitOut(
        file=file_from_row(row),
        upload_url=upload_url,
        upload_expires_at=ticket_expires_at,
        upload_headers={"Content-Type": "application/octet-stream"},
    )


@router.put(
    "/mock-storage/uploads/{ticket}",
    name="upload_file_bytes",
    response_model=FileOut,
    responses={
        status.HTTP_200_OK: {
            "description": "File bytes accepted.",
            "model": FileOut,
        },
        **error_responses(403, 409, 410, 413, 422),
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/octet-stream": {
                    "schema": _BINARY_SCHEMA,
                }
            },
        }
    },
)
async def upload_file_bytes(
    ticket: str,
    request: Request,
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileOut:
    """Local stand-in for a short-lived presigned R2 PUT URL."""

    cleanup_expired(database, settings)
    now = utc_now()
    with database.connection() as conn:
        row = conn.execute(
            """
            SELECT t.*, f.object_key, f.expected_size, f.expected_sha256, f.state,
                   f.expires_at AS file_expires_at
            FROM tickets AS t
            JOIN files AS f ON f.id = t.file_id
            WHERE t.token_hash = ? AND t.purpose = 'upload'
            """,
            (hash_token(ticket),),
        ).fetchone()
        if row is None:
            raise http_error(
                status.HTTP_403_FORBIDDEN,
                "invalid_upload_ticket",
                "The upload ticket is invalid.",
            )
        if from_iso(row["expires_at"]) <= now:
            raise http_error(
                status.HTTP_410_GONE,
                "upload_ticket_expired",
                "The upload ticket has expired.",
            )
        if row["used_at"] is not None:
            raise http_error(
                status.HTTP_403_FORBIDDEN,
                "upload_ticket_used",
                "The upload ticket has already been used.",
            )
        if from_iso(row["file_expires_at"]) <= now or row["state"] == "expired":
            raise http_error(
                status.HTTP_410_GONE,
                "file_expired",
                "The file record has expired.",
            )
        if row["state"] != "pending":
            raise http_error(
                status.HTTP_409_CONFLICT,
                "invalid_file_state",
                "The file is not waiting for an upload.",
            )
        file_id = row["file_id"]
        object_key = row["object_key"]
        expected_size = row["expected_size"]
        expected_sha256 = row["expected_sha256"]

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_body_size = int(content_length)
        except ValueError:
            declared_body_size = -1
        if (
            declared_body_size < 0
            or declared_body_size > settings.max_file_size_bytes
            or declared_body_size > expected_size
        ):
            raise http_error(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                "upload_size_exceeded",
                "The uploaded body exceeds the declared or configured size.",
            )

    destination = settings.storage_dir / object_key
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    digest = hashlib.sha256()
    total = 0
    try:
        with temporary.open("wb") as stream:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total += len(chunk)
                if total > settings.max_file_size_bytes or total > expected_size:
                    raise http_error(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        "upload_size_exceeded",
                        "The uploaded body exceeds the declared or configured size.",
                    )
                digest.update(chunk)
                stream.write(chunk)
        if total != expected_size:
            raise http_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "upload_size_mismatch",
                f"Expected {expected_size} bytes but received {total}.",
            )
        actual_sha256 = digest.hexdigest()
        if expected_sha256 and actual_sha256 != expected_sha256:
            raise http_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "upload_hash_mismatch",
                "The uploaded body does not match the declared SHA-256.",
            )
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    now_iso = to_iso(utc_now())
    with database.connection() as conn:
        conn.execute(
            """
            UPDATE files
            SET actual_size = ?, actual_sha256 = ?, state = 'uploaded'
            WHERE id = ? AND state = 'pending'
            """,
            (total, actual_sha256, file_id),
        )
        conn.execute(
            "UPDATE tickets SET used_at = ? WHERE token_hash = ?",
            (now_iso, hash_token(ticket)),
        )
        touch_file_pushes(conn, [file_id], now_iso)
        conn.commit()
        file_row = conn.execute(
            "SELECT * FROM files WHERE id = ?", (file_id,)
        ).fetchone()
    return file_from_row(file_row)


@router.post(
    "/v1/files/{file_id}/complete",
    response_model=FileOut,
    responses=error_responses(401, 404, 409, 410, 422),
)
def complete_file(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileOut:
    cleanup_expired(database, settings)
    now = to_iso(utc_now())
    with database.connection() as conn:
        row = _owned_file(conn, auth.user_id, file_id)
        if row["state"] == "ready":
            return file_from_row(row)
        if row["state"] == "expired":
            raise http_error(
                status.HTTP_410_GONE,
                "file_expired",
                "The file has expired.",
            )
        if row["state"] == "deleted":
            raise http_error(
                status.HTTP_409_CONFLICT,
                "file_deleted",
                "A deleted file cannot be completed.",
            )
        if row["state"] != "uploaded":
            raise http_error(
                status.HTTP_409_CONFLICT,
                "file_not_uploaded",
                "Upload the file bytes before completing the file.",
            )
        path = settings.storage_dir / row["object_key"]
        if not path.is_file():
            raise http_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "object_missing",
                "The uploaded object bytes are missing.",
            )
        actual_size = path.stat().st_size
        if actual_size != row["expected_size"] or actual_size != row["actual_size"]:
            raise http_error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "file_size_mismatch",
                "Stored size does not match the initialized and uploaded size.",
            )
        if row["expected_sha256"]:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != row["expected_sha256"]:
                raise http_error(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "file_hash_mismatch",
                    "Stored bytes do not match the initialized SHA-256.",
                )
        conn.execute(
            "UPDATE files SET state = 'ready', completed_at = ? WHERE id = ?",
            (now, file_id),
        )
        touch_file_pushes(conn, [file_id], now)
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM files WHERE id = ?", (file_id,)
        ).fetchone()
    return file_from_row(updated)


@router.get(
    "/v1/files/{file_id}",
    response_model=FileOut,
    responses=error_responses(401, 404),
)
def get_file_metadata(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileOut:
    cleanup_expired(database, settings)
    with database.connection() as conn:
        row = _owned_file(conn, auth.user_id, file_id)
    return file_from_row(row)


@router.post(
    "/v1/files/{file_id}/download-ticket",
    response_model=DownloadTicketOut,
    responses=error_responses(401, 404, 409, 410),
)
def create_download_ticket(
    file_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> DownloadTicketOut:
    cleanup_expired(database, settings)
    token = new_token("dwl")
    now = utc_now()
    now_iso = to_iso(now)
    expires_at = to_iso(
        now + timedelta(seconds=settings.download_ticket_ttl_seconds)
    )
    with database.connection() as conn:
        row = _owned_file(conn, auth.user_id, file_id)
        if row["state"] in {"expired", "deleted"}:
            raise http_error(
                status.HTTP_410_GONE,
                "file_expired",
                "The file is no longer available for download.",
            )
        if row["state"] != "ready":
            raise http_error(
                status.HTTP_409_CONFLICT,
                "file_not_ready",
                "The file is not available for download yet.",
            )
        conn.execute(
            """
            INSERT INTO tickets(token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
            VALUES (?, ?, ?, 'download', ?, ?, NULL)
            """,
            (hash_token(token), auth.user_id, file_id, now_iso, expires_at),
        )
        conn.commit()
    return DownloadTicketOut(
        file_id=file_id,
        download_url=str(request.url_for("download_file_bytes", ticket=token)),
        expires_at=expires_at,
    )


@router.get(
    "/mock-storage/downloads/{ticket}",
    name="download_file_bytes",
    response_class=FileResponse,
    responses={
        status.HTTP_200_OK: {
            "description": "File bytes.",
            "headers": {
                "Content-Disposition": {"schema": {"type": "string"}},
                "Content-Length": {"schema": {"type": "integer"}},
                "ETag": {"schema": {"type": "string"}},
            },
            "content": {
                "application/octet-stream": {"schema": _BINARY_SCHEMA}
            },
        },
        **error_responses(403, 410),
    },
)
def download_file_bytes(
    ticket: str,
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
):
    """Local stand-in for a short-lived presigned R2 GET URL.

    Like an object-store signed URL, it is reusable until its expiry.
    """

    cleanup_expired(database, settings)
    now = utc_now()
    with database.connection() as conn:
        row = conn.execute(
            """
            SELECT t.expires_at AS ticket_expires_at, f.*
            FROM tickets AS t
            JOIN files AS f ON f.id = t.file_id
            WHERE t.token_hash = ? AND t.purpose = 'download'
            """,
            (hash_token(ticket),),
        ).fetchone()
    if row is None:
        raise http_error(
            status.HTTP_403_FORBIDDEN,
            "invalid_download_ticket",
            "The download ticket is invalid.",
        )
    if from_iso(row["ticket_expires_at"]) <= now:
        raise http_error(
            status.HTTP_410_GONE,
            "download_ticket_expired",
            "The download ticket has expired.",
        )
    if row["state"] != "ready" or from_iso(row["expires_at"]) <= now:
        raise http_error(
            status.HTTP_410_GONE,
            "file_expired",
            "The file is no longer available.",
        )
    path = settings.storage_dir / row["object_key"]
    if not path.is_file():
        raise http_error(
            status.HTTP_410_GONE,
            "object_missing",
            "The local object bytes are missing.",
        )
    return FileResponse(
        path=Path(path),
        media_type="application/octet-stream",
        filename=safe_download_name(row["original_name"]),
    )


@router.delete(
    "/v1/files/{file_id}",
    response_model=FileOut,
    responses=error_responses(401, 404),
)
def delete_file(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileOut:
    now = to_iso(utc_now())
    with database.connection() as conn:
        row = _owned_file(conn, auth.user_id, file_id)
        if row["state"] != "deleted":
            conn.execute(
                "UPDATE files SET state = 'deleted', deleted_at = ?, delete_reason = 'user_deleted' WHERE id = ?",
                (now, file_id),
            )
            conn.execute("DELETE FROM tickets WHERE file_id = ?", (file_id,))
            touch_file_pushes(conn, [file_id], now)
            retain_lightweight_file_aliases(conn, [file_id], now)
            mark_undelivered_missed(conn, file_id, "user_deleted", now)
            conn.commit()
        updated = conn.execute(
            "SELECT * FROM files WHERE id = ?", (file_id,)
        ).fetchone()
    (settings.storage_dir / row["object_key"]).unlink(missing_ok=True)
    return file_from_row(updated)
