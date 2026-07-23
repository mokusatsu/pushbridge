from __future__ import annotations

from copy import deepcopy
from typing import Any


_ERROR_STATUS_TO_COMPONENT: dict[int, str] = {
    400: "BadRequest",
    401: "Unauthorized",
    403: "Forbidden",
    404: "NotFound",
    409: "Conflict",
    410: "Gone",
    413: "PayloadTooLarge",
    422: "UnprocessableContent",
    500: "InternalError",
    501: "NotImplemented",
    507: "InsufficientStorage",
}


def error_responses(*status_codes: int) -> dict[int, dict[str, Any]]:
    """Return OpenAPI response references without sharing mutable dictionaries."""

    result: dict[int, dict[str, Any]] = {}
    for status_code in status_codes:
        component = _ERROR_STATUS_TO_COMPONENT[status_code]
        result[status_code] = {"$ref": f"#/components/responses/{component}"}
    return result


REQUEST_ID_HEADER: dict[str, Any] = {
    "description": "Request identifier echoed in server logs and error details.",
    "schema": {"type": "string", "pattern": r"^req_[A-Za-z0-9_-]+$"},
}

TOKEN_RESPONSE_HEADERS: dict[str, Any] = {
    "Cache-Control": {
        "description": "Prevents storage of the plaintext device token.",
        "required": True,
        "schema": {"type": "string", "const": "no-store"},
    },
    "Pragma": {
        "description": "Legacy cache prevention for the plaintext device token.",
        "required": True,
        "schema": {"type": "string", "const": "no-cache"},
    },
}

IDEMPOTENT_REPLAY_HEADER: dict[str, Any] = {
    "Idempotent-Replayed": {
        "description": "Always true when an existing push is returned for the same request.",
        "required": True,
        "schema": {"type": "string", "const": "true"},
    }
}


def token_response_headers() -> dict[str, Any]:
    return deepcopy(TOKEN_RESPONSE_HEADERS)


def idempotent_replay_headers() -> dict[str, Any]:
    return deepcopy(IDEMPOTENT_REPLAY_HEADER)
