from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, Query, Response, status

from ..api_contract import (
    error_responses,
    idempotent_replay_headers,
)
from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from .deliveries import ensure_file_deliveries
from ..schemas import PushCreate, PushListOut, PushOut, PushPatch
from ..services import (
    PUSH_WITH_FILE_SELECT,
    cleanup_expired,
    ensure_owned_active_device,
    http_error,
    push_from_row,
)
from ..utils import decode_cursor, encode_cursor, new_id, to_iso, utc_now

router = APIRouter(prefix="/v1/pushes", tags=["pushes"])


def _get_owned_push(
    conn: sqlite3.Connection, user_id: str, push_id: str
) -> sqlite3.Row:
    row = conn.execute(
        PUSH_WITH_FILE_SELECT + " WHERE p.id = ? AND p.user_id = ?",
        (push_id, user_id),
    ).fetchone()
    if row is None:
        raise http_error(status.HTTP_404_NOT_FOUND, "push_not_found", "Push not found.")
    return row


@router.post(
    "",
    response_model=PushOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        status.HTTP_200_OK: {
            "description": "Idempotent replay of an existing push.",
            "headers": idempotent_replay_headers(),
            "model": PushOut,
        },
        status.HTTP_201_CREATED: {"description": "Push created."},
        **error_responses(401, 404, 409, 413),
    },
)
def create_push(
    body: PushCreate,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> PushOut:
    cleanup_expired(database, settings)
    guid = idempotency_key or body.client_guid or new_id("guid")
    if len(guid) > 200:
        raise http_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "idempotency_key_too_long",
            "Idempotency-Key must be 200 characters or fewer.",
        )
    if idempotency_key and body.client_guid and idempotency_key != body.client_guid:
        raise http_error(
            status.HTTP_409_CONFLICT,
            "idempotency_key_mismatch",
            "Idempotency-Key and client_guid must match when both are supplied.",
        )

    now = utc_now()
    now_iso = to_iso(now)
    ttl = body.expires_in or settings.default_push_ttl_seconds
    expires_at = to_iso(now + timedelta(seconds=ttl))
    push_id = new_id("psh")
    payload_data = (
        body.payload.model_dump(mode="json", exclude_none=True)
        if body.payload is not None
        else None
    )
    payload_json = (
        json.dumps(payload_data, ensure_ascii=False, separators=(",", ":"))
        if payload_data is not None
        else None
    )
    payload_size = len((payload_json or body.ciphertext or "").encode("utf-8"))
    if payload_size > settings.max_push_payload_bytes:
        raise http_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "push_payload_too_large",
            f"The local mock push payload limit is {settings.max_push_payload_bytes} bytes.",
        )
    referenced_file_id = body.file_id

    canonical_request = json.dumps(
        {
            "target": body.target.model_dump(mode="json"),
            "type": body.type,
            "file_id": referenced_file_id,
            "payload_version": body.payload_version,
            "key_version": body.key_version,
            "encryption_salt": body.encryption_salt,
            "payload": payload_data,
            "ciphertext": body.ciphertext,
            "nonce": body.nonce,
            "ttl": ttl,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    request_hash = hashlib.sha256(canonical_request).hexdigest()

    with database.connection() as conn:
        existing = conn.execute(
            PUSH_WITH_FILE_SELECT
            + " WHERE p.user_id = ? AND p.client_guid = ?",
            (auth.user_id, guid),
        ).fetchone()
        if existing is not None:
            if existing["request_hash"] != request_hash:
                raise http_error(
                    status.HTTP_409_CONFLICT,
                    "idempotency_conflict",
                    "The Idempotency-Key was already used with a different request.",
                )
            response.status_code = status.HTTP_200_OK
            response.headers["Idempotent-Replayed"] = "true"
            ensure_file_deliveries(conn, existing, now_iso)
            conn.commit()
            return push_from_row(existing, auth.device_id)

        if body.target.kind == "device":
            assert body.target.device_id is not None
            ensure_owned_active_device(conn, auth.user_id, body.target.device_id)

        if body.type == "file":
            assert referenced_file_id is not None
            file_row = conn.execute(
                "SELECT * FROM files WHERE id = ? AND user_id = ?",
                (referenced_file_id, auth.user_id),
            ).fetchone()
            if file_row is None:
                raise http_error(
                    status.HTTP_404_NOT_FOUND,
                    "file_not_found",
                    "The referenced file does not exist for this account.",
                )
            if file_row["state"] != "ready":
                raise http_error(
                    status.HTTP_409_CONFLICT,
                    "file_not_ready",
                    "The referenced file is expired, deleted, or not ready.",
                )
            # File bytes normally disappear after 30 days. Keep the tiny Push/file_ref
            # alias longer so a late device can explain why no bytes are available.
            if body.expires_in is None and file_row["alias_expires_at"]:
                expires_at = file_row["alias_expires_at"]

        try:
            conn.execute(
                """
                INSERT INTO pushes(
                    id, user_id, source_device_id, target_kind, target_device_id,
                    type, file_id, payload_version, key_version, encryption_salt, payload_json, ciphertext, nonce,
                    client_guid, request_hash, pinned, created_at, modified_at, expires_at,
                    expired_at, dismissed_at, deleted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL)
                """,
                (
                    push_id,
                    auth.user_id,
                    auth.device_id,
                    body.target.kind,
                    body.target.device_id,
                    body.type,
                    referenced_file_id,
                    body.payload_version,
                    body.key_version,
                    body.encryption_salt,
                    payload_json,
                    body.ciphertext,
                    body.nonce,
                    guid,
                    request_hash,
                    now_iso,
                    now_iso,
                    expires_at,
                ),
            )
            inserted = conn.execute(
                PUSH_WITH_FILE_SELECT + " WHERE p.id = ?", (push_id,)
            ).fetchone()
            ensure_file_deliveries(conn, inserted, now_iso)
            conn.commit()
        except sqlite3.IntegrityError:
            # Covers a race between two retries using the same idempotency key.
            existing = conn.execute(
                PUSH_WITH_FILE_SELECT
                + " WHERE p.user_id = ? AND p.client_guid = ?",
                (auth.user_id, guid),
            ).fetchone()
            if existing is None:
                raise
            if existing["request_hash"] != request_hash:
                raise http_error(
                    status.HTTP_409_CONFLICT,
                    "idempotency_conflict",
                    "The Idempotency-Key was already used with a different request.",
                )
            response.status_code = status.HTTP_200_OK
            response.headers["Idempotent-Replayed"] = "true"
            ensure_file_deliveries(conn, existing, now_iso)
            conn.commit()
            return push_from_row(existing, auth.device_id)

        row = conn.execute(
            PUSH_WITH_FILE_SELECT + " WHERE p.id = ?", (push_id,)
        ).fetchone()
    return push_from_row(row, auth.device_id)


@router.get(
    "",
    response_model=PushListOut,
    responses=error_responses(400, 401),
)
def list_pushes(
    after: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=100),
    include_deleted: bool = Query(default=True),
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> PushListOut:
    cleanup_expired(database, settings)
    params: list[object] = [auth.user_id]
    clauses = ["p.user_id = ?"]
    if after:
        modified_at, resource_id = decode_cursor(after)
        clauses.append(
            "(p.modified_at > ? OR (p.modified_at = ? AND p.id > ?))"
        )
        params.extend([modified_at, modified_at, resource_id])
    if not include_deleted:
        clauses.append("p.deleted_at IS NULL")

    sql = (
        PUSH_WITH_FILE_SELECT
        + " WHERE "
        + " AND ".join(clauses)
        + " ORDER BY p.modified_at, p.id LIMIT ?"
    )
    params.append(limit + 1)
    with database.connection() as conn:
        rows = conn.execute(sql, params).fetchall()

    has_more = len(rows) > limit
    page = rows[:limit]
    items = [push_from_row(row, auth.device_id) for row in page]
    next_cursor = None
    if page:
        last = page[-1]
        next_cursor = encode_cursor(last["modified_at"], last["id"])
    return PushListOut(items=items, next_cursor=next_cursor, has_more=has_more)


@router.get(
    "/{push_id}",
    response_model=PushOut,
    responses=error_responses(401, 404),
)
def get_push(
    push_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> PushOut:
    cleanup_expired(database, settings)
    with database.connection() as conn:
        row = _get_owned_push(conn, auth.user_id, push_id)
    return push_from_row(row, auth.device_id)


@router.patch(
    "/{push_id}",
    response_model=PushOut,
    responses=error_responses(401, 404, 409),
)
def patch_push(
    push_id: str,
    body: PushPatch,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> PushOut:
    cleanup_expired(database, settings)
    now = utc_now()
    now_iso = to_iso(now)
    with database.connection() as conn:
        row = _get_owned_push(conn, auth.user_id, push_id)
        if row["deleted_at"] is not None:
            raise http_error(
                status.HTTP_409_CONFLICT,
                "push_deleted",
                "A deleted push cannot be modified.",
            )

        dismissed_at = row["dismissed_at"]
        pinned = bool(row["pinned"])
        expires_at = row["expires_at"]
        expired_at = row["expired_at"]

        if row["expired_at"] is not None and body.pinned is True:
            raise http_error(
                status.HTTP_409_CONFLICT,
                "push_expired",
                "An expired push cannot be restored by pinning it.",
            )

        if body.dismissed is not None:
            dismissed_at = now_iso if body.dismissed else None
        if body.pinned is not None:
            pinned = body.pinned
            if pinned:
                expires_at = None
                expired_at = None
            elif expires_at is None:
                expires_at = to_iso(
                    now + timedelta(seconds=settings.default_push_ttl_seconds)
                )

        conn.execute(
            """
            UPDATE pushes
            SET dismissed_at = ?, pinned = ?, expires_at = ?, expired_at = ?, modified_at = ?
            WHERE id = ?
            """,
            (dismissed_at, int(pinned), expires_at, expired_at, now_iso, push_id),
        )
        conn.commit()
        updated = conn.execute(
            PUSH_WITH_FILE_SELECT + " WHERE p.id = ?", (push_id,)
        ).fetchone()
    return push_from_row(updated, auth.device_id)


@router.delete(
    "/{push_id}",
    response_model=PushOut,
    responses=error_responses(401, 404),
)
def delete_push(
    push_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> PushOut:
    now = to_iso(utc_now())
    with database.connection() as conn:
        row = _get_owned_push(conn, auth.user_id, push_id)
        if row["deleted_at"] is None:
            conn.execute(
                """
                UPDATE pushes
                SET deleted_at = ?, modified_at = ?, payload_json = NULL,
                    ciphertext = NULL, nonce = NULL
                WHERE id = ?
                """,
                (now, now, push_id),
            )
            conn.commit()
        updated = conn.execute(
            PUSH_WITH_FILE_SELECT + " WHERE p.id = ?", (push_id,)
        ).fetchone()
    return push_from_row(updated, auth.device_id)
