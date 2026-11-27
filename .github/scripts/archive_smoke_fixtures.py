"""Synthetic Edo archives for the native file picker smoke."""

import json


def write_fixtures(directory):
    weigh_in = {
        "id": "edo-smoke-weight",
        "localDay": "2026-11-27",
        "occurredAt": 1795780800000,
        "kg": 82.3,
    }
    archive = {
        "format": "edo-diary",
        "formatVersion": 2,
        "meals": [],
        "customFoods": [],
        "recipes": [],
        "mealTemplates": [],
        "favorites": [],
        "weighIns": [weigh_in],
        "nutritionTargets": [],
    }
    valid = json.dumps(archive).encode()
    (directory / "Edo-valid-smoke.json").write_bytes(valid)
    (directory / "Edo-malformed-smoke.json").write_bytes(valid + b"\x00oops")
    (directory / "Edo-oversized-smoke.json").write_bytes(valid.ljust(16 * 1024 * 1024 + 1, b" "))
    weigh_in["kg"] = 93.1
    (directory / "Edo-conflict-smoke.json").write_text(json.dumps(archive), encoding="utf-8")
