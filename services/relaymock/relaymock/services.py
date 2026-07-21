from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import Settings
from .database import Database
from .schemas import FileOut, FileRef, PushOut
from .utils import to_iso, utc_now


PUSH_WITH_FILE_SELECT = """
SELECT
    p.*,
    f.state AS file_ref_state,
    COALESCE(f.actual_size, f.expected_size) AS file_ref_size,
    f.expires_at AS file_ref_expires_at
    , f.deleted_at AS file_ref_deleted_at
    , f.delete_reason AS file_ref_delete_reason
    , f.alias_expires_at AS file_ref_alias_expires_at
FROM pushes AS p
LEFT JOIN files AS f ON f.id = p.file_id
"""


def http_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def device_from_row(
    row: sqlite3.Row, current_device_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "kind": row["kind"],
        "name": row["name"],
        "public_key": row["public_key"],
        "created_at": row["created_at"],
        "last_seen_at": row["last_seen_at"],
        "revoked_at": row["revoked_at"],
        "is_current": row["id"] == current_device_id,
    }


def push_from_row(row: sqlite3.Row, current_device_id: str) -> PushOut:
    if row["deleted_at"] is not None:
        push_status = "deleted"
    elif row["expired_at"] is not None:
        push_status = "expired"
    elif row["dismissed_at"] is not None:
        push_status = "dismissed"
    else:
        push_status = "active"

    is_for_current = (
        row["target_kind"] == "all_devices"
        or (
            row["target_kind"] == "all_other_devices"
            and row["source_device_id"] != current_device_id
        )
        or (
            row["target_kind"] == "device"
            and row["target_device_id"] == current_device_id
        )
    )
    payload = (
        json.loads(row["payload_json"])
        if row["payload_json"] is not None
        else None
    )
    file_ref = None
    row_keys = set(row.keys())
    if (
        row["file_id"] is not None
        and "file_ref_state" in row_keys
        and row["file_ref_state"] is not None
    ):
        file_ref = FileRef(
            id=row["file_id"],
            state=row["file_ref_state"],
            size=row["file_ref_size"],
            expires_at=row["file_ref_expires_at"],
            deleted_at=row["file_ref_deleted_at"],
            delete_reason=row["file_ref_delete_reason"],
            alias_expires_at=row["file_ref_alias_expires_at"],
        )

    return PushOut(
        id=row["id"],
        user_id=row["user_id"],
        source_device_id=row["source_device_id"],
        target={
            "kind": row["target_kind"],
            "device_id": row["target_device_id"],
        },
        type=row["type"],
        file_id=row["file_id"],
        file_ref=file_ref,
        payload_version=row["payload_version"],
        payload=payload,
        ciphertext=row["ciphertext"],
        nonce=row["nonce"],
        client_guid=row["client_guid"],
        pinned=bool(row["pinned"]),
        status=push_status,
        created_at=row["created_at"],
        modified_at=row["modified_at"],
        expires_at=row["expires_at"],
        expired_at=row["expired_at"],
        dismissed_at=row["dismissed_at"],
        deleted_at=row["deleted_at"],
        is_for_current_device=is_for_current,
    )


def file_from_row(row: sqlite3.Row) -> FileOut:
    return FileOut(
        id=row["id"],
        original_name=row["original_name"],
        content_type=row["content_type"],
        expected_size=row["expected_size"],
        actual_size=row["actual_size"],
        expected_sha256=row["expected_sha256"],
        actual_sha256=row["actual_sha256"],
        state=row["state"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
        expires_at=row["expires_at"],
        deleted_at=row["deleted_at"],
        delete_reason=row["delete_reason"],
        alias_expires_at=row["alias_expires_at"],
    )


def ensure_owned_active_device(
    conn: sqlite3.Connection, user_id: str, device_id: str
) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        (device_id, user_id),
    ).fetchone()
    if row is None:
        raise http_error(
            404,
            "device_not_found",
            "The target device does not exist or has been revoked.",
        )
    return row


def touch_file_pushes(
    conn: sqlite3.Connection, file_ids: list[str] | tuple[str, ...], modified_at: str
) -> None:
    """Make file state changes visible through the push cursor stream."""

    if not file_ids:
        return
    conn.executemany(
        """
        UPDATE pushes
        SET modified_at = ?
        WHERE file_id = ? AND deleted_at IS NULL
        """,
        [(modified_at, file_id) for file_id in file_ids],
    )


def retain_lightweight_file_aliases(
    conn: sqlite3.Connection,
    file_ids: list[str] | tuple[str, ...],
    modified_at: str,
) -> None:
    """Drop the heavy/encrypted payload while retaining the file reference alias."""

    if not file_ids:
        return
    conn.executemany(
        """
        UPDATE pushes
        SET payload_json = NULL, ciphertext = NULL, nonce = NULL, modified_at = ?
        WHERE file_id = ? AND deleted_at IS NULL
        """,
        [(modified_at, file_id) for file_id in file_ids],
    )


def cleanup_expired(
    database: Database, settings: Settings, required_bytes: int = 0
) -> dict[str, int]:
    """Expire logical records and remove expired object bytes.

    File state changes also touch referencing pushes so polling clients receive a
    new cursor item containing an updated non-secret ``file_ref``.
    """

    now = utc_now()
    now_iso = to_iso(now)
    removed_objects = 0
    expired_pushes = 0
    expired_files = 0
    purged_tombstones = 0
    purged_file_aliases = 0
    pressure_evicted_files = 0
    pressure_evicted_bytes = 0

    object_keys_to_delete: set[str] = set()
    with database.connection() as conn:
        due_pushes = conn.execute(
            """
            SELECT id, type FROM pushes
            WHERE expires_at IS NOT NULL
              AND expires_at <= ?
              AND expired_at IS NULL
              AND deleted_at IS NULL
              AND pinned = 0
            """,
            (now_iso,),
        ).fetchall()
        if due_pushes:
            file_alias_ids = [row["id"] for row in due_pushes if row["type"] == "file"]
            content_ids = [row["id"] for row in due_pushes if row["type"] != "file"]
            ids = file_alias_ids + content_ids
            if content_ids:
                conn.executemany(
                    """
                    UPDATE pushes
                    SET expired_at = ?, modified_at = ?, payload_json = NULL,
                        ciphertext = NULL, nonce = NULL
                    WHERE id = ?
                    """,
                    [(now_iso, now_iso, item_id) for item_id in content_ids],
                )
            if file_alias_ids:
                conn.executemany(
                    """
                    UPDATE pushes
                    SET deleted_at = ?, modified_at = ?, payload_json = NULL,
                        ciphertext = NULL, nonce = NULL
                    WHERE id = ?
                    """,
                    [(now_iso, now_iso, item_id) for item_id in file_alias_ids],
                )
            expired_pushes = len(ids)

        due_files = conn.execute(
            """
            SELECT id, object_key FROM files
            WHERE expires_at <= ? AND state NOT IN ('expired', 'deleted')
            """,
            (now_iso,),
        ).fetchall()
        if due_files:
            file_ids = [row["id"] for row in due_files]
            object_keys_to_delete.update(row["object_key"] for row in due_files)
            conn.executemany(
                "UPDATE files SET state = 'expired', deleted_at = ?, delete_reason = 'retention_expired' WHERE id = ?",
                [(now_iso, file_id) for file_id in file_ids],
            )
            touch_file_pushes(conn, file_ids, now_iso)
            retain_lightweight_file_aliases(conn, file_ids, now_iso)
            expired_files = len(file_ids)

        # Retry disk deletion for records already marked expired/deleted.
        stale_files = conn.execute(
            "SELECT object_key FROM files WHERE state IN ('expired', 'deleted')"
        ).fetchall()
        object_keys_to_delete.update(row["object_key"] for row in stale_files)

        # Local stand-in for the Cloudflare storage-pressure task. Pending upload
        # sizes are reservations; ready sizes are actual occupied bytes.
        usage = conn.execute(
            """
            SELECT COALESCE(SUM(
                CASE WHEN state = 'ready' THEN COALESCE(actual_size, expected_size)
                     WHEN state IN ('pending', 'uploaded') THEN expected_size
                     ELSE 0 END
            ), 0) AS bytes
            FROM files
            """
        ).fetchone()["bytes"]
        high_watermark = (
            settings.storage_budget_bytes
            * settings.storage_pressure_high_watermark_percent // 100
        )
        cleanup_target = (
            settings.storage_budget_bytes
            * settings.storage_cleanup_target_percent // 100
        )
        projected = usage + max(0, required_bytes)
        if projected > high_watermark:
            reclaim_needed = projected - cleanup_target
            candidates = conn.execute(
                """
                SELECT f.id, f.object_key, COALESCE(f.actual_size, f.expected_size) AS size,
                       EXISTS(
                         SELECT 1 FROM pushes p
                         WHERE p.file_id = f.id AND p.pinned = 1
                           AND p.deleted_at IS NULL AND p.expired_at IS NULL
                       ) AS protected
                FROM files f
                WHERE f.state = 'ready'
                ORDER BY protected ASC, f.created_at ASC, size DESC, f.id ASC
                """
            ).fetchall()
            evicted_ids: list[str] = []
            for row in candidates:
                if pressure_evicted_bytes >= reclaim_needed:
                    break
                evicted_ids.append(row["id"])
                object_keys_to_delete.add(row["object_key"])
                pressure_evicted_bytes += row["size"]
            if evicted_ids:
                conn.executemany(
                    "UPDATE files SET state = 'deleted', deleted_at = ?, delete_reason = 'storage_pressure' WHERE id = ?",
                    [(now_iso, file_id) for file_id in evicted_ids],
                )
                touch_file_pushes(conn, evicted_ids, now_iso)
                retain_lightweight_file_aliases(conn, evicted_ids, now_iso)
                pressure_evicted_files = len(evicted_ids)
                usage -= pressure_evicted_bytes

        # Keep expired ticket rows briefly so the ticket endpoints can distinguish
        # an expired credential (410) from a credential that never existed (403).
        ticket_cutoff = to_iso(
            now - timedelta(seconds=settings.ticket_record_retention_seconds)
        )
        conn.execute("DELETE FROM tickets WHERE expires_at <= ?", (ticket_cutoff,))

        tombstone_cutoff = to_iso(
            now - timedelta(seconds=settings.tombstone_ttl_seconds)
        )
        result = conn.execute(
            "DELETE FROM pushes WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
            (tombstone_cutoff,),
        )
        purged_tombstones = max(result.rowcount, 0)
        result = conn.execute(
            """
            DELETE FROM files
            WHERE alias_expires_at IS NOT NULL AND alias_expires_at <= ?
              AND NOT EXISTS (SELECT 1 FROM pushes WHERE pushes.file_id = files.id)
            """,
            (now_iso,),
        )
        purged_file_aliases = max(result.rowcount, 0)
        conn.commit()

    for key in object_keys_to_delete:
        path = settings.storage_dir / key
        try:
            existed = path.exists()
            path.unlink(missing_ok=True)
            if existed:
                removed_objects += 1
        except OSError:
            # The DB remains authoritative. A later cleanup retries disk deletion.
            pass

    return {
        "expired_pushes": expired_pushes,
        "expired_files": expired_files,
        "removed_objects": removed_objects,
        "purged_tombstones": purged_tombstones,
        "purged_file_aliases": purged_file_aliases,
        "pressure_evicted_files": pressure_evicted_files,
        "pressure_evicted_bytes": pressure_evicted_bytes,
        "stored_or_reserved_bytes": max(0, usage),
    }


def clear_storage(storage_dir: Path) -> None:
    if storage_dir.exists():
        shutil.rmtree(storage_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)
