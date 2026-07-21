from __future__ import annotations

from math import ceil

from fastapi import APIRouter, Depends

from ..auth import AuthContext, get_auth_context, get_database, get_settings
from ..config import Settings
from ..database import Database
from ..schemas import (
    CapabilityFeatures,
    CapabilityLimits,
    CapabilityTransports,
    SystemCapabilitiesOut,
    StorageUsageOut,
    WebPushConfigOut,
)

router = APIRouter(tags=["system"])


@router.get(
    "/v1/system/capabilities",
    response_model=SystemCapabilitiesOut,
    summary="Describe mock features, limits, and supported transports",
)
def get_capabilities(
    settings: Settings = Depends(get_settings),
) -> SystemCapabilitiesOut:
    return SystemCapabilitiesOut(
        api_version=settings.app_version,
        environment_id=settings.environment_id,
        features=CapabilityFeatures(
            realtime=False,
            web_push_delivery=settings.web_push_delivery,
            web_push_subscription_registration=(
                settings.web_push_subscription_registration
            ),
            e2ee=False,
            direct_upload=True,
            device_registration=True,
        ),
        limits=CapabilityLimits(
            max_file_bytes=settings.max_file_size_bytes,
            max_push_payload_bytes=settings.max_push_payload_bytes,
            file_ttl_seconds=list(settings.file_ttl_seconds),
            default_push_ttl_seconds=settings.default_push_ttl_seconds,
            default_file_ttl_seconds=settings.default_file_ttl_seconds,
            file_alias_ttl_seconds=settings.file_alias_ttl_seconds,
            max_devices=settings.max_devices,
        ),
        transports=CapabilityTransports(
            realtime=["poll"],
            upload=["server-ticket"],
        ),
        recommended_poll_interval_seconds=(
            settings.recommended_poll_interval_seconds
        ),
    )


@router.get(
    "/v1/web-push-config",
    response_model=WebPushConfigOut,
    tags=["web push mock"],
    summary="Return Web Push subscription configuration",
)
def get_web_push_config(
    settings: Settings = Depends(get_settings),
) -> WebPushConfigOut:
    return WebPushConfigOut(
        subscription_registration=settings.web_push_subscription_registration,
        delivery=settings.web_push_delivery,
        vapid_public_key=settings.vapid_public_key,
    )


@router.get(
    "/v1/storage/usage",
    response_model=StorageUsageOut,
    summary="Return authenticated storage usage and pressure",
)
def get_storage_usage(
    auth: AuthContext = Depends(get_auth_context),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> StorageUsageOut:
    with database.connection() as conn:
        row = conn.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN state = 'ready' THEN actual_size ELSE 0 END), 0) AS used_bytes,
              COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
            FROM files WHERE user_id = ?
            """,
            (auth.user_id,),
        ).fetchone()
        reclaimable = conn.execute(
            """
            SELECT COALESCE(SUM(f.actual_size), 0) AS bytes
            FROM files AS f
            WHERE f.user_id = ? AND f.state = 'ready'
              AND NOT EXISTS (
                SELECT 1 FROM pushes AS p
                WHERE p.file_id = f.id AND p.user_id = f.user_id AND p.pinned = 1
                  AND p.deleted_at IS NULL
              )
            """,
            (auth.user_id,),
        ).fetchone()["bytes"]

    used = int(row["used_bytes"])
    reserved = int(row["reserved_bytes"])
    ratio = (used + reserved) / settings.storage_budget_bytes
    pressure = (
        "emergency" if ratio >= settings.storage_pressure_high_watermark_percent / 100
        else "constrained" if ratio >= 0.85
        else "notice" if ratio >= 0.70
        else "normal"
    )
    return StorageUsageOut(
        used_bytes=used,
        reserved_bytes=reserved,
        quota_bytes=settings.storage_budget_bytes,
        reclaimable_bytes=int(reclaimable),
        pressure=pressure,
        policy_id="free-v1",
        default_retention_days=max(1, ceil(settings.default_file_ttl_seconds / 86_400)),
        early_eviction_possible=True,
    )
