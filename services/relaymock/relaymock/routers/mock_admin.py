from __future__ import annotations

from fastapi import APIRouter, Depends

from ..api_contract import error_responses
from ..auth import get_database, get_settings, require_mock_admin
from ..config import Settings
from ..database import Database
from ..schemas import StatsOut
from ..services import cleanup_expired, clear_storage
from ..utils import to_iso, utc_now

router = APIRouter(prefix="/v1/mock", tags=["local mock administration"])


@router.post(
    "/cleanup",
    dependencies=[Depends(require_mock_admin)],
    responses=error_responses(403),
)
def run_cleanup(
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, int | str]:
    result = cleanup_expired(database, settings)
    return {**result, "ran_at": to_iso(utc_now())}


@router.post(
    "/reset",
    dependencies=[Depends(require_mock_admin)],
    responses=error_responses(403),
)
def reset_mock(
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    database.reset()
    clear_storage(settings.storage_dir)
    return {"status": "reset"}


@router.get(
    "/stats",
    response_model=StatsOut,
    dependencies=[Depends(require_mock_admin)],
    responses=error_responses(403),
)
def get_stats(
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> StatsOut:
    cleanup_expired(database, settings)
    with database.connection() as conn:
        counts = {
            "users": conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"],
            "devices": conn.execute("SELECT COUNT(*) AS n FROM devices").fetchone()["n"],
            "active_sessions": conn.execute(
                "SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?",
                (to_iso(utc_now()),),
            ).fetchone()["n"],
            "pushes": conn.execute("SELECT COUNT(*) AS n FROM pushes").fetchone()["n"],
            "files": conn.execute("SELECT COUNT(*) AS n FROM files").fetchone()["n"],
            "subscriptions": conn.execute(
                "SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE revoked_at IS NULL"
            ).fetchone()["n"],
        }
        stored_bytes = conn.execute(
            "SELECT COALESCE(SUM(actual_size), 0) AS n FROM files WHERE state = 'ready'"
        ).fetchone()["n"]
    return StatsOut(**counts, stored_bytes=stored_bytes)
