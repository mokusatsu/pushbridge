from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx


BASE_URL = os.getenv("RELAYMOCK_BASE_URL", "http://127.0.0.1:8000")


def show(label: str, response: httpx.Response) -> dict[str, Any]:
    print(f"\n{label}: {response.status_code}")
    try:
        body = response.json()
        print(json.dumps(body, ensure_ascii=False, indent=2))
        return body
    except ValueError:
        print(response.text)
        return {}


def main() -> int:
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        show("capabilities", client.get("/v1/system/capabilities"))
        show("web push config", client.get("/v1/web-push-config"))
        bootstrap = show(
            "bootstrap",
            client.post(
                "/v1/auth/bootstrap",
                json={
                    "handle": "demo",
                    "device_name": "Demo PWA",
                    "device_kind": "pwa",
                },
            ),
        )
        if "access_token" not in bootstrap:
            print("Reset the mock or choose a different handle.", file=sys.stderr)
            return 1
        headers = {"Authorization": f"Bearer {bootstrap['access_token']}"}
        second = show(
            "link device",
            client.post(
                "/v1/devices/link",
                headers=headers,
                json={"name": "Demo Extension", "kind": "browser_extension"},
            ),
        )
        show(
            "create note",
            client.post(
                "/v1/pushes",
                headers={**headers, "Idempotency-Key": "demo-note-001"},
                json={
                    "target": {
                        "kind": "device",
                        "device_id": second["device"]["id"],
                    },
                    "type": "note",
                    "payload": {"title": "Hello", "body": "RelayMock is running."},
                },
            ),
        )
        second_headers = {"Authorization": f"Bearer {second['access_token']}"}
        show("second device sync", client.get("/v1/pushes", headers=second_headers))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
