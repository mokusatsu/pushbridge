from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Response, status

from ..api_contract import error_responses
from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import SubscriptionIn, SubscriptionOut
from ..services import http_error
from ..utils import new_id, to_iso, utc_now

router = APIRouter(prefix="/v1/web-push-subscriptions", tags=["web push mock"])


def _out(row) -> SubscriptionOut:
    return SubscriptionOut(
        id=row["id"],
        device_id=row["device_id"],
        endpoint=row["endpoint"],
        created_at=row["created_at"],
        revoked_at=row["revoked_at"],
    )


@router.post(
    "",
    response_model=SubscriptionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        status.HTTP_200_OK: {
            "description": "Existing device endpoint updated idempotently.",
            "model": SubscriptionOut,
        },
        status.HTTP_201_CREATED: {"description": "Subscription created."},
        **error_responses(401, 409),
    },
)
def create_subscription(
    body: SubscriptionIn,
    response: Response,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> SubscriptionOut:
    if not settings.web_push_subscription_registration:
        raise http_error(
            status.HTTP_409_CONFLICT,
            "web_push_registration_disabled",
            "Web Push subscription registration is disabled.",
        )

    subscription_id = new_id("sub")
    now = to_iso(utc_now())
    endpoint = str(body.endpoint)
    with database.connection() as conn:
        existing = conn.execute(
            """
            SELECT * FROM web_push_subscriptions
            WHERE device_id = ? AND endpoint = ?
            """,
            (auth.device_id, endpoint),
        ).fetchone()
        if existing is not None:
            conn.execute(
                """
                UPDATE web_push_subscriptions
                SET p256dh = ?, auth = ?, storage_namespace = ?,
                    local_cache_max_bytes = ?, revoked_at = NULL
                WHERE id = ?
                """,
                (body.p256dh, body.auth, body.storage_namespace,
                 body.local_cache_max_bytes, existing["id"]),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM web_push_subscriptions WHERE id = ?",
                (existing["id"],),
            ).fetchone()
            response.status_code = status.HTTP_200_OK
            return _out(row)

        try:
            conn.execute(
                """
                INSERT INTO web_push_subscriptions(
                    id, user_id, device_id, endpoint, p256dh, auth, created_at, revoked_at
                    , storage_namespace, local_cache_max_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    subscription_id,
                    auth.user_id,
                    auth.device_id,
                    endpoint,
                    body.p256dh,
                    body.auth,
                    now,
                    body.storage_namespace,
                    body.local_cache_max_bytes,
                ),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM web_push_subscriptions WHERE id = ?",
                (subscription_id,),
            ).fetchone()
        except sqlite3.IntegrityError:
            # A concurrent upsert won the unique(device_id, endpoint) race.
            row = conn.execute(
                """
                SELECT * FROM web_push_subscriptions
                WHERE device_id = ? AND endpoint = ?
                """,
                (auth.device_id, endpoint),
            ).fetchone()
            if row is None:
                raise
            conn.execute(
                """
                UPDATE web_push_subscriptions
                SET p256dh = ?, auth = ?, storage_namespace = ?,
                    local_cache_max_bytes = ?, revoked_at = NULL
                WHERE id = ?
                """,
                (body.p256dh, body.auth, body.storage_namespace,
                 body.local_cache_max_bytes, row["id"]),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM web_push_subscriptions WHERE id = ?", (row["id"],)
            ).fetchone()
            response.status_code = status.HTTP_200_OK
    return _out(row)


@router.get(
    "",
    response_model=list[SubscriptionOut],
    responses=error_responses(401),
)
def list_subscriptions(
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> list[SubscriptionOut]:
    with database.connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM web_push_subscriptions
            WHERE user_id = ? AND device_id = ?
            ORDER BY created_at, id
            """,
            (auth.user_id, auth.device_id),
        ).fetchall()
    return [_out(row) for row in rows]


@router.delete(
    "/{subscription_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=error_responses(401, 404),
)
def revoke_subscription(
    subscription_id: str,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
) -> None:
    now = to_iso(utc_now())
    with database.connection() as conn:
        result = conn.execute(
            """
            UPDATE web_push_subscriptions SET revoked_at = ?
            WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL
            """,
            (now, subscription_id, auth.user_id, auth.device_id),
        )
        if result.rowcount == 0:
            raise http_error(
                status.HTTP_404_NOT_FOUND,
                "subscription_not_found",
                "Active subscription not found for the current device.",
            )
        conn.commit()
