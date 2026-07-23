from __future__ import annotations

from fastapi import APIRouter, Depends, status

from ..api_contract import error_responses
from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import (
    AccountDeletionIn,
    AccountDeletionOut,
    AccountDeletionReceipt,
)
from ..utils import new_id, utc_now


router = APIRouter(tags=["authentication"])


@router.delete(
    "/v1/account",
    response_model=AccountDeletionOut,
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(401, 422, 500),
)
def delete_account(
    body: AccountDeletionIn,
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> AccountDeletionOut:
    requested_at = utc_now()
    with database.connection() as conn:
        objects = conn.execute(
            "SELECT object_key FROM files WHERE user_id = ? ORDER BY id",
            (auth.user_id,),
        ).fetchall()

    storage_root = settings.storage_dir.resolve()
    for row in objects:
        path = (storage_root / row["object_key"]).resolve()
        if path != storage_root and storage_root not in path.parents:
            raise RuntimeError("File ledger contains an unsafe object key.")
        path.unlink(missing_ok=True)

    with database.connection() as conn:
        conn.execute("DELETE FROM web_push_subscriptions WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM file_deliveries WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM tickets WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM pushes WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM files WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM devices WHERE user_id = ?", (auth.user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (auth.user_id,))
        conn.commit()

    completed_at = utc_now()
    return AccountDeletionOut(
        deletion=AccountDeletionReceipt(
            id=new_id("del"),
            state="completed",
            requested_at=requested_at,
            completed_at=completed_at,
        )
    )
