from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient
from relaymock.routers.deliveries import issue_delivery_token


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_requires_bearer_token(client: TestClient) -> None:
    response = client.get("/v1/devices")
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthorized"


def test_realtime_ticket_is_explicitly_unavailable_in_relaymock(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    capabilities = client.get("/v1/system/capabilities").json()
    assert capabilities["features"]["realtime"] is False
    response = client.post("/v1/realtime-ticket", headers=auth_headers)
    assert response.status_code == 501
    assert response.json()["detail"]["code"] == "realtime_not_available"


def test_storage_usage_requires_auth_and_reports_policy(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    assert client.get("/v1/storage/usage").status_code == 401
    response = client.get("/v1/storage/usage", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "used_bytes": 0,
        "reserved_bytes": 0,
        "quota_bytes": 2 * 1024 * 1024,
        "reclaimable_bytes": 0,
        "pressure": "normal",
        "policy_id": "free-v1",
        "default_retention_days": 1,
        "early_eviction_possible": True,
    }


def test_link_device_and_targeted_push(
    client: TestClient, account: dict, auth_headers: dict[str, str]
) -> None:
    linked = client.post(
        "/v1/devices/link",
        headers=auth_headers,
        json={"name": "Chrome Extension", "kind": "browser_extension"},
    )
    assert linked.status_code == 201, linked.text
    linked_body = linked.json()
    second_device_id = linked_body["device"]["id"]

    created = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "demo-1"},
        json={
            "target": {"kind": "device", "device_id": second_device_id},
            "type": "link",
            "payload": {"title": "Example", "url": "https://example.com"},
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["is_for_current_device"] is False

    second_headers = {"Authorization": f"Bearer {linked_body['access_token']}"}
    listed = client.get("/v1/pushes", headers=second_headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["is_for_current_device"] is True


def test_push_idempotency(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = {
        "type": "note",
        "payload": {"title": "One", "body": "Only once"},
    }
    first = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "same-key"},
        json=body,
    )
    second = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "same-key"},
        json=body,
    )
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.headers["Idempotent-Replayed"] == "true"
    assert first.json()["id"] == second.json()["id"]


def test_idempotency_key_rejects_different_request(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    headers = {**auth_headers, "Idempotency-Key": "conflicting-key"}
    first = client.post(
        "/v1/pushes",
        headers=headers,
        json={"type": "note", "payload": {"body": "first"}},
    )
    second = client.post(
        "/v1/pushes",
        headers=headers,
        json={"type": "note", "payload": {"body": "different"}},
    )
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "idempotency_conflict"


def test_cursor_pagination(client: TestClient, auth_headers: dict[str, str]) -> None:
    for number in range(3):
        response = client.post(
            "/v1/pushes",
            headers={**auth_headers, "Idempotency-Key": f"page-{number}"},
            json={"type": "note", "payload": {"body": str(number)}},
        )
        assert response.status_code == 201

    first_page = client.get("/v1/pushes?limit=2", headers=auth_headers)
    assert first_page.status_code == 200
    data = first_page.json()
    assert len(data["items"]) == 2
    assert data["next_cursor"]
    assert data["has_more"] is True

    second_page = client.get(
        "/v1/pushes",
        headers=auth_headers,
        params={"limit": 2, "after": data["next_cursor"]},
    )
    assert second_page.status_code == 200
    second_data = second_page.json()
    assert len(second_data["items"]) == 1
    assert second_data["has_more"] is False
    assert second_data["next_cursor"]

    empty_page = client.get(
        "/v1/pushes",
        headers=auth_headers,
        params={"after": second_data["next_cursor"]},
    )
    assert empty_page.status_code == 200
    assert empty_page.json() == {"items": [], "next_cursor": None, "has_more": False}


def test_push_ttl_cleanup_and_no_restore_by_pin(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    created = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "expires"},
        json={
            "type": "note",
            "payload": {"body": "temporary"},
            "expires_in": 3600,
        },
    )
    assert created.status_code == 201
    push_id = created.json()["id"]

    with client.app.state.database.connection() as conn:
        conn.execute(
            "UPDATE pushes SET expires_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00.000000Z", push_id),
        )
        conn.commit()

    cleanup = client.post(
        "/v1/mock/cleanup", headers={"X-Mock-Admin": "test-admin"}
    )
    assert cleanup.status_code == 200
    assert cleanup.json()["expired_pushes"] == 1

    expired = client.get(f"/v1/pushes/{push_id}", headers=auth_headers)
    assert expired.status_code == 200
    assert expired.json()["status"] == "expired"
    assert expired.json()["payload"] is None

    restore = client.patch(
        f"/v1/pushes/{push_id}",
        headers=auth_headers,
        json={"pinned": True},
    )
    assert restore.status_code == 409
    assert restore.json()["detail"]["code"] == "push_expired"


def test_file_lifecycle(client: TestClient, auth_headers: dict[str, str]) -> None:
    content = b"encrypted mock bytes"
    sha256 = hashlib.sha256(content).hexdigest()
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={
            "filename": "cipher.bin",
            "content_type": "application/octet-stream",
            "size": len(content),
            "sha256": sha256,
        },
    )
    assert initialized.status_code == 201, initialized.text
    data = initialized.json()
    file_id = data["file"]["id"]

    uploaded = client.put(
        data["upload_url"],
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["state"] == "uploaded"

    completed = client.post(f"/v1/files/{file_id}/complete", headers=auth_headers)
    assert completed.status_code == 200
    assert completed.json()["state"] == "ready"
    linked = client.post(
        "/v1/devices/link",
        headers=auth_headers,
        json={"name": "File receiver", "kind": "pwa"},
    ).json()

    file_push = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "encrypted-file-push"},
        json={
            "type": "file",
            "file_id": file_id,
            "target": {"kind": "device", "device_id": linked["device"]["id"]},
                "ciphertext": "base64url-ciphertext",
                "nonce": "base64url-nonce",
                "payload_version": 2,
                "key_version": 1,
                "encryption_salt": "base64url-salt",
        },
    )
    assert file_push.status_code == 201, file_push.text
    assert file_push.json()["file_id"] == file_id
    assert file_push.json()["payload"] is None

    with client.app.state.database.connection() as conn:
        delivery = conn.execute(
            "SELECT * FROM file_deliveries WHERE file_id = ? AND destination_device_id = ?",
            (file_id, linked["device"]["id"]),
        ).fetchone()
        assert delivery["state"] == "pending"
        assert issue_delivery_token(conn, delivery["id"], "delivery-test-token")
        conn.commit()

    wrong_ack = client.post(
        f"/v1/file-deliveries/{delivery['id']}/events",
        headers={"Authorization": "Bearer wrong"},
        json={"state": "cached"},
    )
    assert wrong_ack.status_code == 403
    fetching = client.post(
        f"/v1/file-deliveries/{delivery['id']}/events",
        headers={"Authorization": "Bearer delivery-test-token"},
        json={"state": "fetching"},
    )
    assert fetching.status_code == 200
    cached = client.post(
        f"/v1/file-deliveries/{delivery['id']}/events",
        headers={"Authorization": "Bearer delivery-test-token"},
        json={"state": "cached"},
    )
    assert cached.status_code == 200
    assert cached.json()["state"] == "cached"

    third = client.post(
        "/v1/devices/link",
        headers=auth_headers,
        json={"name": "Missed receiver", "kind": "pwa"},
    ).json()
    missed_push = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "missed-file-push"},
        json={
            "type": "file",
            "file_id": file_id,
            "target": {"kind": "device", "device_id": third["device"]["id"]},
                "ciphertext": "base64url-ciphertext-2",
                "nonce": "base64url-nonce-2",
                "payload_version": 2,
                "key_version": 1,
                "encryption_salt": "base64url-salt-2",
        },
    )
    assert missed_push.status_code == 201

    ticket = client.post(
        f"/v1/files/{file_id}/download-ticket", headers=auth_headers
    )
    assert ticket.status_code == 200
    downloaded = client.get(ticket.json()["download_url"])
    assert downloaded.status_code == 200
    assert downloaded.content == content

    deleted = client.delete(f"/v1/files/{file_id}", headers=auth_headers)
    assert deleted.status_code == 200
    deliveries = client.get(
        f"/v1/files/{file_id}/deliveries", headers=auth_headers
    ).json()
    states = {item["destination_device_id"]: item["state"] for item in deliveries}
    assert states[linked["device"]["id"]] == "cached"
    assert states[third["device"]["id"]] == "missed"


def test_account_deletion_removes_file_bytes_and_revokes_access(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    content = b"account deletion fixture"
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={
            "filename": "delete.bin",
            "content_type": "application/octet-stream",
            "size": len(content),
            "expires_in": 86400,
        },
    )
    assert initialized.status_code == 201
    upload_url = initialized.json()["upload_url"]
    assert client.put(upload_url, content=content).status_code == 200

    invalid = client.request(
        "DELETE",
        "/v1/account",
        headers=auth_headers,
        json={"confirmation": "delete"},
    )
    assert invalid.status_code == 422
    deleted = client.request(
        "DELETE",
        "/v1/account",
        headers=auth_headers,
        json={"confirmation": "DELETE"},
    )
    assert deleted.status_code == 202
    assert deleted.json()["deletion"]["state"] == "completed"
    assert client.get("/v1/devices", headers=auth_headers).status_code == 401
    assert client.put(upload_url, content=content).status_code in {403, 404}


def test_upload_reservations_reject_capacity_overflow(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    request = {
        "filename": "reserved.bin",
        "content_type": "application/octet-stream",
        "size": 1024 * 1024,
    }
    first = client.post("/v1/files/init", headers=auth_headers, json=request)
    second = client.post("/v1/files/init", headers=auth_headers, json=request)
    assert first.status_code == 201
    assert second.status_code == 201

    overflow = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={**request, "filename": "overflow.bin", "size": 1},
    )
    assert overflow.status_code == 507
    assert overflow.json()["detail"]["code"] == "storage_pressure"


def test_storage_pressure_evicts_old_ready_file_before_reserving_upload(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    content = b"x" * (1024 * 1024)
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={
            "filename": "old.bin",
            "content_type": "application/octet-stream",
            "size": len(content),
        },
    )
    assert initialized.status_code == 201
    first_id = initialized.json()["file"]["id"]
    assert client.put(initialized.json()["upload_url"], content=content).status_code == 200
    assert client.post(f"/v1/files/{first_id}/complete", headers=auth_headers).status_code == 200

    replacement = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={
            "filename": "new.bin",
            "content_type": "application/octet-stream",
            "size": len(content),
        },
    )
    assert replacement.status_code == 201
    metadata = client.get(f"/v1/files/{first_id}", headers=auth_headers)
    assert metadata.status_code == 200
    assert metadata.json()["state"] == "deleted"

    with client.app.state.database.connection() as conn:
        first = conn.execute(
            "SELECT object_key FROM files WHERE id = ?", (first_id,)
        ).fetchone()
    assert not (client.app.state.settings.storage_dir / first["object_key"]).exists()


def test_revoked_device_token_stops_working(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    linked = client.post(
        "/v1/devices/link",
        headers=auth_headers,
        json={"name": "Temporary", "kind": "test"},
    ).json()
    second_headers = {"Authorization": f"Bearer {linked['access_token']}"}
    assert client.get("/v1/devices", headers=second_headers).status_code == 200

    revoked = client.delete(
        f"/v1/devices/{linked['device']['id']}", headers=auth_headers
    )
    assert revoked.status_code == 204
    assert client.get("/v1/devices", headers=second_headers).status_code == 401


def test_admin_stats_and_reset(
    client: TestClient, account: dict, auth_headers: dict[str, str]
) -> None:
    stats = client.get("/v1/mock/stats", headers={"X-Mock-Admin": "test-admin"})
    assert stats.status_code == 200
    assert stats.json()["users"] == 1

    reset = client.post("/v1/mock/reset", headers={"X-Mock-Admin": "test-admin"})
    assert reset.status_code == 200
    assert client.get("/v1/devices", headers=auth_headers).status_code == 401


def test_request_id_is_public_contract(
    client: TestClient,
) -> None:
    response = client.get(
        "/v1/devices", headers={"X-Request-ID": "req_client-trace-1"}
    )
    assert response.status_code == 401
    assert response.headers["X-Request-ID"] == "req_client-trace-1"
    assert response.json()["detail"]["request_id"] == "req_client-trace-1"


def test_token_responses_are_not_cacheable(client: TestClient) -> None:
    bootstrapped = client.post(
        "/v1/auth/bootstrap",
        json={
            "handle": "cache-test",
            "device_name": "Cache Test Web",
            "device_kind": "web",
        },
    )
    assert bootstrapped.status_code == 201
    assert bootstrapped.headers["Cache-Control"] == "no-store"
    assert bootstrapped.headers["Pragma"] == "no-cache"

    token = bootstrapped.json()["access_token"]
    linked = client.post(
        "/v1/devices/link",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "Cache Test PWA", "kind": "pwa"},
    )
    assert linked.status_code == 201
    assert linked.headers["Cache-Control"] == "no-store"
    assert linked.headers["Pragma"] == "no-cache"


def test_capabilities_and_web_push_config(client: TestClient) -> None:
    capabilities = client.get("/v1/system/capabilities")
    assert capabilities.status_code == 200
    body = capabilities.json()
    assert body["api_version"] == "0.1.1"
    assert body["environment_id"] == "relaymock-local"
    assert body["features"]["realtime"] is False
    assert body["features"]["web_push_subscription_registration"] is True
    assert body["limits"]["max_file_bytes"] == 1024 * 1024
    assert body["limits"]["max_push_payload_bytes"] == 64 * 1024
    assert body["limits"]["file_ttl_seconds"] == [86400, 604800, 2592000]
    assert body["limits"]["file_alias_ttl_seconds"] == 180 * 24 * 60 * 60
    assert body["transports"] == {
        "realtime": ["poll"],
        "upload": ["server-ticket"],
    }

    config = client.get("/v1/web-push-config")
    assert config.status_code == 200
    config_body = config.json()
    assert config_body["subscription_registration"] is True
    assert config_body["delivery"] is False
    assert config_body["vapid_public_key"].startswith("B")


def test_web_push_subscription_upsert_is_idempotent(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    payload = {
        "endpoint": "https://push.example.test/subscription/1",
        "p256dh": "first-key",
        "auth": "first-auth",
        "storage_namespace": "alice-device",
        "local_cache_max_bytes": 536870912,
    }
    first = client.post(
        "/v1/web-push-subscriptions", headers=auth_headers, json=payload
    )
    assert first.status_code == 201, first.text

    second = client.post(
        "/v1/web-push-subscriptions",
        headers=auth_headers,
        json={**payload, "p256dh": "updated-key", "auth": "updated-auth"},
    )
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]

    with client.app.state.database.connection() as conn:
        row = conn.execute(
            "SELECT p256dh, auth, storage_namespace, local_cache_max_bytes FROM web_push_subscriptions WHERE id = ?",
            (first.json()["id"],),
        ).fetchone()
    assert dict(row) == {
        "p256dh": "updated-key",
        "auth": "updated-auth",
        "storage_namespace": "alice-device",
        "local_cache_max_bytes": 536870912,
    }


def test_push_create_rejects_invalid_schema_combinations(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    invalid_bodies = [
        {
            "type": "file",
            "ciphertext": "ciphertext",
            "nonce": "nonce",
        },
        {
            "type": "note",
            "file_id": "fil_not-valid-for-note",
            "payload": {"body": "text"},
        },
        {
            "type": "note",
            "target": {"kind": "device"},
            "payload": {"body": "text"},
        },
        {
            "type": "note",
            "payload": {"body": "text"},
            "ciphertext": "ciphertext",
            "nonce": "nonce",
        },
        {
            "type": "note",
            "ciphertext": "ciphertext",
        },
        {
            "type": "note",
            "nonce": "nonce",
        },
    ]
    for index, body in enumerate(invalid_bodies):
        response = client.post(
            "/v1/pushes",
            headers={**auth_headers, "Idempotency-Key": f"invalid-{index}"},
            json=body,
        )
        assert response.status_code == 422, (body, response.text)


def test_file_state_changes_reenter_push_cursor_stream(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    content = b"short-lived encrypted object"
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={
            "filename": "short.bin",
            "content_type": "application/octet-stream",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )
    assert initialized.status_code == 201
    file_id = initialized.json()["file"]["id"]
    assert client.put(initialized.json()["upload_url"], content=content).status_code == 200
    assert (
        client.post(f"/v1/files/{file_id}/complete", headers=auth_headers).status_code
        == 200
    )

    created = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "file-ref-sync"},
        json={
            "type": "file",
            "file_id": file_id,
                "ciphertext": "encrypted-payload",
                "nonce": "nonce",
                "payload_version": 2,
                "key_version": 1,
                "encryption_salt": "salt",
        },
    )
    assert created.status_code == 201, created.text
    push_id = created.json()["id"]
    assert created.json()["file_ref"]["state"] == "ready"

    pinned = client.patch(
        f"/v1/pushes/{push_id}", headers=auth_headers, json={"pinned": True}
    )
    assert pinned.status_code == 200
    before_modified = pinned.json()["modified_at"]

    checkpoint = client.get("/v1/pushes", headers=auth_headers).json()["next_cursor"]
    assert checkpoint
    with client.app.state.database.connection() as conn:
        conn.execute(
            "UPDATE files SET expires_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00.000000Z", file_id),
        )
        conn.commit()

    cleanup = client.post(
        "/v1/mock/cleanup", headers={"X-Mock-Admin": "test-admin"}
    )
    assert cleanup.status_code == 200
    assert cleanup.json()["expired_files"] == 1

    changes = client.get(
        "/v1/pushes", headers=auth_headers, params={"after": checkpoint}
    )
    assert changes.status_code == 200
    items = changes.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == push_id
    assert items[0]["file_ref"] == {
        "id": file_id,
        "state": "expired",
        "size": len(content),
        "expires_at": "2000-01-01T00:00:00Z",
        "deleted_at": items[0]["file_ref"]["deleted_at"],
        "delete_reason": "retention_expired",
        "alias_expires_at": items[0]["file_ref"]["alias_expires_at"],
    }
    assert items[0]["file_ref"]["deleted_at"]
    assert items[0]["file_ref"]["alias_expires_at"]
    assert items[0]["payload"] is None
    assert items[0]["ciphertext"] is None
    assert items[0]["modified_at"] > before_modified


def test_lightweight_file_alias_expires_then_is_purged(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    content = b"alias"
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={"filename": "alias.bin", "size": len(content)},
    ).json()
    file_id = initialized["file"]["id"]
    assert client.put(initialized["upload_url"], content=content).status_code == 200
    assert client.post(f"/v1/files/{file_id}/complete", headers=auth_headers).status_code == 200
    created = client.post(
        "/v1/pushes",
        headers={**auth_headers, "Idempotency-Key": "alias-expiry"},
        json={
            "type": "file",
            "file_id": file_id,
            "payload": {"file": {"name": "alias.bin", "mime_type": "application/octet-stream", "size": len(content)}},
        },
    )
    assert created.status_code == 201, created.text
    push_id = created.json()["id"]
    assert created.json()["expires_at"] == initialized["file"]["alias_expires_at"]

    old = "2000-01-01T00:00:00.000000Z"
    with client.app.state.database.connection() as conn:
        conn.execute("UPDATE files SET expires_at = ?, alias_expires_at = ? WHERE id = ?", (old, old, file_id))
        conn.execute("UPDATE pushes SET expires_at = ? WHERE id = ?", (old, push_id))
        conn.commit()
    first_cleanup = client.post("/v1/mock/cleanup", headers={"X-Mock-Admin": "test-admin"})
    assert first_cleanup.status_code == 200
    assert client.get(f"/v1/pushes/{push_id}", headers=auth_headers).json()["status"] == "deleted"

    with client.app.state.database.connection() as conn:
        conn.execute("UPDATE pushes SET deleted_at = ? WHERE id = ?", (old, push_id))
        conn.commit()
    second_cleanup = client.post("/v1/mock/cleanup", headers={"X-Mock-Admin": "test-admin"})
    assert second_cleanup.json()["purged_tombstones"] == 1
    assert second_cleanup.json()["purged_file_aliases"] == 1


def test_expired_upload_ticket_returns_gone(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    from datetime import timedelta

    from relaymock.utils import to_iso, utc_now

    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={"filename": "expired.bin", "size": 1},
    )
    assert initialized.status_code == 201
    file_id = initialized.json()["file"]["id"]
    with client.app.state.database.connection() as conn:
        conn.execute(
            "UPDATE tickets SET expires_at = ? WHERE file_id = ? AND purpose = 'upload'",
            (to_iso(utc_now() - timedelta(seconds=1)), file_id),
        )
        conn.commit()
    response = client.put(initialized.json()["upload_url"], content=b"x")
    assert response.status_code == 410, response.text
    assert response.json()["detail"]["code"] == "upload_ticket_expired"


def test_download_response_has_binary_headers(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    content = b"etag test"
    initialized = client.post(
        "/v1/files/init",
        headers=auth_headers,
        json={"filename": "etag.bin", "size": len(content)},
    ).json()
    file_id = initialized["file"]["id"]
    assert client.put(initialized["upload_url"], content=content).status_code == 200
    assert (
        client.post(f"/v1/files/{file_id}/complete", headers=auth_headers).status_code
        == 200
    )
    ticket = client.post(
        f"/v1/files/{file_id}/download-ticket", headers=auth_headers
    ).json()
    downloaded = client.get(ticket["download_url"])
    assert downloaded.status_code == 200
    assert downloaded.headers["Content-Length"] == str(len(content))
    assert downloaded.headers["Content-Disposition"]
    assert downloaded.headers["ETag"]


def test_openapi_matches_runtime_contract(client: TestClient) -> None:
    document = client.app.openapi()
    components = document["components"]
    assert components["schemas"]["ApiError"]["additionalProperties"] is False
    assert "Unauthorized" in components["responses"]
    assert "Gone" in components["responses"]
    assert "NotImplemented" in components["responses"]
    realtime = document["paths"]["/v1/realtime-ticket"]["post"]
    assert realtime["responses"]["201"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/RealtimeTicketOut")

    push_post = document["paths"]["/v1/pushes"]["post"]
    assert push_post["responses"]["200"]["headers"]["Idempotent-Replayed"][
        "schema"
    ]["const"] == "true"
    assert push_post["responses"]["201"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("/PushOut")
    assert push_post["responses"]["409"] == {
        "$ref": "#/components/responses/Conflict"
    }

    push_create = components["schemas"]["PushCreate"]
    assert len(push_create["oneOf"]) == 6
    assert len(components["schemas"]["PushTarget"]["oneOf"]) == 3
    assert components["schemas"]["NotePayloadV1"]["additionalProperties"] is False
    assert components["schemas"]["LinkPayloadV1"]["properties"]["url"][
        "format"
    ] == "uri"
    encrypted = components["schemas"]["NoteEncryptedPushCreate"]
    assert encrypted["properties"]["payload_version"]["const"] == 2
    assert {"key_version", "encryption_salt"}.issubset(encrypted["required"])

    upload = document["paths"]["/mock-storage/uploads/{ticket}"]["put"]
    upload_schema = upload["requestBody"]["content"]["application/octet-stream"][
        "schema"
    ]
    assert upload_schema["format"] == "binary"
    assert upload["responses"]["410"] == {
        "$ref": "#/components/responses/Gone"
    }

    download = document["paths"]["/mock-storage/downloads/{ticket}"]["get"]
    download_200 = download["responses"]["200"]
    assert "ETag" in download_200["headers"]
    assert (
        download_200["content"]["application/octet-stream"]["schema"]["format"]
        == "binary"
    )

    assert components["schemas"]["DeviceOut"]["properties"]["created_at"][
        "format"
    ] == "date-time"
    assert components["schemas"]["FileInitOut"]["properties"]["upload_url"][
        "format"
    ] == "uri-reference"

    admin_parameters = document["paths"]["/v1/mock/cleanup"]["post"][
        "parameters"
    ]
    admin_header = next(
        parameter
        for parameter in admin_parameters
        if parameter["name"] == "X-Mock-Admin"
    )
    assert admin_header["required"] is True
    assert admin_header["schema"] == {"type": "string", "minLength": 1}

    bootstrap_201 = document["paths"]["/v1/auth/bootstrap"]["post"][
        "responses"
    ]["201"]
    assert bootstrap_201["headers"]["Cache-Control"]["schema"]["const"] == "no-store"
    assert "X-Request-ID" in bootstrap_201["headers"]


def test_admin_router_is_disabled_unless_explicitly_enabled(tmp_path) -> None:
    from relaymock.config import Settings
    from relaymock.main import create_app

    settings = Settings(
        database_path=tmp_path / "disabled-admin.db",
        storage_dir=tmp_path / "disabled-admin-objects",
        cleanup_interval_seconds=0,
        enable_mock_admin=False,
    )
    with TestClient(create_app(settings)) as local_client:
        response = local_client.get(
            "/v1/mock/stats", headers={"X-Mock-Admin": "local-admin"}
        )
        assert response.status_code == 404
        assert response.json()["detail"]["request_id"] == response.headers[
            "X-Request-ID"
        ]
        assert "/v1/mock/stats" not in local_client.app.openapi()["paths"]
