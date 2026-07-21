from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from relaymock.config import Settings
from relaymock.main import create_app


@pytest.fixture()
def client(tmp_path: Path):
    settings = Settings(
        database_path=tmp_path / "test.db",
        storage_dir=tmp_path / "objects",
        cleanup_interval_seconds=0,
        access_token_ttl_seconds=3600,
        upload_ticket_ttl_seconds=60,
        download_ticket_ttl_seconds=60,
        default_push_ttl_seconds=3600,
        default_file_ttl_seconds=3600,
        max_file_size_bytes=1024 * 1024,
        storage_budget_bytes=2 * 1024 * 1024,
        max_push_payload_bytes=64 * 1024,
        tombstone_ttl_seconds=3600,
        enable_mock_admin=True,
        mock_admin_token="test-admin",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture()
def account(client: TestClient) -> dict:
    response = client.post(
        "/v1/auth/bootstrap",
        json={
            "handle": "alice",
            "device_name": "Alice Web",
            "device_kind": "web",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def auth_headers(account: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {account['access_token']}"}
