#!/usr/bin/env python3
"""Fail when a consumer carries a stale copy of the public OpenAPI contract."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = {
    "canonical": ROOT / "contract" / "openapi.json",
    "relaymock": ROOT / "services" / "relaymock" / "openapi.json",
    "web-pwa": ROOT / "apps" / "web-pwa" / "openapi" / "relaymock.openapi.json",
}


def normalized(path: Path) -> object:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    canonical = normalized(CONTRACTS["canonical"])
    failures = [name for name, path in CONTRACTS.items() if normalized(path) != canonical]
    if failures:
        raise SystemExit(
            "OpenAPI contract drift detected in: "
            + ", ".join(failures)
            + ". Run `make sync-contract` after reviewing the canonical change."
        )
    info = canonical.get("info", {}) if isinstance(canonical, dict) else {}
    print(f"OpenAPI copies match: {info.get('title', 'unknown')} {info.get('version', 'unknown')}")


if __name__ == "__main__":
    main()

