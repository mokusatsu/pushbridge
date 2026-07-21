from __future__ import annotations

import base64
import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import HTTPException, status


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def from_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def expires_iso(seconds: int) -> str:
    return to_iso(utc_now() + timedelta(seconds=seconds))


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def new_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def encode_cursor(modified_at: str, resource_id: str) -> str:
    raw = json.dumps([modified_at, resource_id], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        value = json.loads(decoded)
        if not isinstance(value, list) or len(value) != 2:
            raise ValueError("invalid cursor payload")
        modified_at, resource_id = value
        if not isinstance(modified_at, str) or not isinstance(resource_id, str):
            raise ValueError("invalid cursor fields")
        # Validate that the timestamp can be parsed before it is used in SQL.
        from_iso(modified_at)
        return modified_at, resource_id
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_cursor", "message": "The cursor is invalid."},
        ) from exc


def safe_download_name(name: str) -> str:
    # Keep Content-Disposition useful without allowing path components or control chars.
    basename = Path(name).name
    cleaned = "".join(ch for ch in basename if ch.isprintable() and ch not in {'"', "\\"})
    return cleaned[:200] or "download.bin"
