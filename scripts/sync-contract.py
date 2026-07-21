#!/usr/bin/env python3
"""Copy the reviewed canonical OpenAPI document to server and client consumers."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "contract" / "openapi.json"
TARGETS = (
    ROOT / "services" / "relaymock" / "openapi.json",
    ROOT / "apps" / "web-pwa" / "openapi" / "relaymock.openapi.json",
)


def main() -> None:
    with SOURCE.open("r", encoding="utf-8") as handle:
        json.load(handle)
    for target in TARGETS:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE, target)
        print(f"updated {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

