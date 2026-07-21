from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


_DEFAULT_VAPID_PUBLIC_KEY = (
    "BPMh4Es7jDUzmTy2t3ovP8TQeb4sqet0GbliHfvePweiHuRKir0uCAMUsvBSPB84"
    "SLtKu9EevHlor9kjYchXPwU"
)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int_tuple(name: str, default: tuple[int, ...]) -> tuple[int, ...]:
    value = os.getenv(name)
    if value is None:
        return default
    parsed = tuple(int(item.strip()) for item in value.split(",") if item.strip())
    if not parsed or any(item <= 0 for item in parsed):
        raise ValueError(f"{name} must contain one or more positive integers")
    return parsed


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration with localhost-safe defaults.

    Mock administration is disabled by default and must be explicitly enabled.
    """

    app_name: str = "RelayMock REST API"
    app_version: str = "0.1.1"
    environment_id: str = "relaymock-local"
    database_path: Path = Path("./data/relaymock.db")
    storage_dir: Path = Path("./data/objects")
    cors_origins: tuple[str, ...] = (
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )
    access_token_ttl_seconds: int = 30 * 24 * 60 * 60
    upload_ticket_ttl_seconds: int = 120
    download_ticket_ttl_seconds: int = 60
    ticket_record_retention_seconds: int = 24 * 60 * 60
    default_push_ttl_seconds: int = 30 * 24 * 60 * 60
    default_file_ttl_seconds: int = 30 * 24 * 60 * 60
    file_alias_ttl_seconds: int = 180 * 24 * 60 * 60
    file_ttl_seconds: tuple[int, ...] = (86400, 604800, 30 * 24 * 60 * 60)
    max_file_size_bytes: int = 25 * 1024 * 1024
    storage_budget_bytes: int = 8 * 1024 * 1024 * 1024
    storage_pressure_high_watermark_percent: int = 95
    storage_cleanup_target_percent: int = 85
    max_push_payload_bytes: int = 2_000_000
    max_devices: int = 10
    tombstone_ttl_seconds: int = 7 * 24 * 60 * 60
    cleanup_interval_seconds: int = 60
    recommended_poll_interval_seconds: int = 30
    enable_mock_admin: bool = False
    mock_admin_token: str = "local-admin"
    web_push_subscription_registration: bool = True
    web_push_delivery: bool = False
    vapid_public_key: str = _DEFAULT_VAPID_PUBLIC_KEY

    @classmethod
    def from_env(cls) -> "Settings":
        origins = tuple(
            item.strip()
            for item in os.getenv(
                "RELAYMOCK_CORS_ORIGINS",
                "http://localhost:3000,http://127.0.0.1:3000,"
                "http://localhost:5173,http://127.0.0.1:5173",
            ).split(",")
            if item.strip()
        )
        return cls(
            app_name=os.getenv("RELAYMOCK_APP_NAME", "RelayMock REST API"),
            app_version=os.getenv("RELAYMOCK_APP_VERSION", "0.1.1"),
            environment_id=os.getenv(
                "RELAYMOCK_ENVIRONMENT_ID", "relaymock-local"
            ),
            database_path=Path(
                os.getenv("RELAYMOCK_DATABASE_PATH", "./data/relaymock.db")
            ),
            storage_dir=Path(
                os.getenv("RELAYMOCK_STORAGE_DIR", "./data/objects")
            ),
            cors_origins=origins,
            access_token_ttl_seconds=int(
                os.getenv(
                    "RELAYMOCK_ACCESS_TOKEN_TTL_SECONDS",
                    str(30 * 24 * 60 * 60),
                )
            ),
            upload_ticket_ttl_seconds=int(
                os.getenv("RELAYMOCK_UPLOAD_TICKET_TTL_SECONDS", "120")
            ),
            download_ticket_ttl_seconds=int(
                os.getenv("RELAYMOCK_DOWNLOAD_TICKET_TTL_SECONDS", "60")
            ),
            ticket_record_retention_seconds=int(
                os.getenv(
                    "RELAYMOCK_TICKET_RECORD_RETENTION_SECONDS",
                    str(24 * 60 * 60),
                )
            ),
            default_push_ttl_seconds=int(
                os.getenv(
                    "RELAYMOCK_DEFAULT_PUSH_TTL_SECONDS",
                    str(30 * 24 * 60 * 60),
                )
            ),
            default_file_ttl_seconds=int(
                os.getenv(
                    "RELAYMOCK_DEFAULT_FILE_TTL_SECONDS", str(30 * 24 * 60 * 60)
                )
            ),
            file_alias_ttl_seconds=int(
                os.getenv(
                    "RELAYMOCK_FILE_ALIAS_TTL_SECONDS", str(180 * 24 * 60 * 60)
                )
            ),
            file_ttl_seconds=_env_int_tuple(
                "RELAYMOCK_FILE_TTL_SECONDS", (86400, 604800, 30 * 24 * 60 * 60)
            ),
            max_file_size_bytes=int(
                os.getenv(
                    "RELAYMOCK_MAX_FILE_SIZE_BYTES", str(25 * 1024 * 1024)
                )
            ),
            storage_budget_bytes=int(
                os.getenv("RELAYMOCK_STORAGE_BUDGET_BYTES", str(8 * 1024 * 1024 * 1024))
            ),
            storage_pressure_high_watermark_percent=int(
                os.getenv("RELAYMOCK_STORAGE_HIGH_WATERMARK_PERCENT", "95")
            ),
            storage_cleanup_target_percent=int(
                os.getenv("RELAYMOCK_STORAGE_CLEANUP_TARGET_PERCENT", "85")
            ),
            max_push_payload_bytes=int(
                os.getenv("RELAYMOCK_MAX_PUSH_PAYLOAD_BYTES", "2000000")
            ),
            max_devices=int(os.getenv("RELAYMOCK_MAX_DEVICES", "10")),
            tombstone_ttl_seconds=int(
                os.getenv(
                    "RELAYMOCK_TOMBSTONE_TTL_SECONDS", str(7 * 24 * 60 * 60)
                )
            ),
            cleanup_interval_seconds=int(
                os.getenv("RELAYMOCK_CLEANUP_INTERVAL_SECONDS", "60")
            ),
            recommended_poll_interval_seconds=int(
                os.getenv("RELAYMOCK_RECOMMENDED_POLL_INTERVAL_SECONDS", "30")
            ),
            enable_mock_admin=_env_bool("RELAYMOCK_ENABLE_MOCK_ADMIN", False),
            mock_admin_token=os.getenv(
                "RELAYMOCK_ADMIN_TOKEN", "local-admin"
            ),
            web_push_subscription_registration=_env_bool(
                "RELAYMOCK_WEB_PUSH_SUBSCRIPTION_REGISTRATION", True
            ),
            web_push_delivery=_env_bool(
                "RELAYMOCK_WEB_PUSH_DELIVERY", False
            ),
            vapid_public_key=os.getenv(
                "RELAYMOCK_VAPID_PUBLIC_KEY", _DEFAULT_VAPID_PUBLIC_KEY
            ),
        )
