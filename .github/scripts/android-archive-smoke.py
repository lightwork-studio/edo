"""Exercise a fresh Edo install through the real Android Downloads picker."""

import json
import re
import subprocess
import sys
import time
from pathlib import Path
from xml.etree import ElementTree

APP = "studio.lightwork.edo"
UI_DUMP = "/sdcard/edo-window.xml"
VALID = "Edo-valid-smoke.json"
CONFLICT = "Edo-conflict-smoke.json"
MALFORMED = "Edo-malformed-smoke.json"
OVERSIZED = "Edo-oversized-smoke.json"


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=15, text=True)


def make_fixtures(directory):
    instant = 1795780800000
    weigh_in = {
        "id": "edo-smoke-weight",
        "localDay": "2026-11-27",
        "occurredAt": instant,
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
    (directory / VALID).write_bytes(valid)
    (directory / MALFORMED).write_bytes(valid + b"\x00oops")
    (directory / OVERSIZED).write_bytes(valid.ljust(16 * 1024 * 1024 + 1, b" "))
    weigh_in["kg"] = 93.1
    (directory / CONFLICT).write_text(json.dumps(archive), encoding="utf-8")
    adb("shell", "mkdir", "-p", "/sdcard/Download")
    for name in (VALID, CONFLICT, MALFORMED, OVERSIZED):
        adb("push", str(directory / name), f"/sdcard/Download/{name}")


def nodes():
    dump = adb("shell", "uiautomator", "dump", UI_DUMP)
    if "dumped to" not in dump:
        return []
    return list(ElementTree.fromstring(adb("shell", "cat", UI_DUMP)).iter("node"))


def labels(node):
    return {node.get("text"), node.get("content-desc")} - {None, ""}


def find(*expected):
    deadline = time.monotonic() + 50
    current = []
    while time.monotonic() < deadline:
        current = nodes()
        for label in expected:
            for node in current:
                if label in labels(node):
                    return label, node
        time.sleep(0.5)
    visible = sorted({label for node in current for label in labels(node)})
    raise AssertionError(f"Expected one of {expected}. Last visible labels: {visible}")


def tap_node(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    if right <= left or bottom <= top:
        raise AssertionError(f"Cannot tap empty bounds {node.attrib['bounds']}")
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def tap(label):
    _, node = find(label)
    tap_node(node)


def open_diary_files():
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")
    tap("Progress")
    tap("Diary files")


def open_picker():
    tap("Choose archive")
    return find("Show roots", "Open navigation drawer", "Downloads", VALID)


def choose(name):
    tap("Choose archive")
    label, node = find(name, "Show roots", "Open navigation drawer", "Downloads")
    if label == name:
        tap_node(node)
        return
    if label != "Downloads":
        tap_node(node)
        tap("Downloads")
    tap(name)


def assert_no_restore_button():
    assert all("Restore records" not in labels(node) for node in nodes())


def run(directory):
    make_fixtures(directory)
    open_diary_files()
    open_picker()
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    find("Share diary archive")
    print("Cancelled Android's picker and returned to Diary files")

    choose(VALID)
    find("1 new · 0 already saved")
    tap("Restore records")
    find("1 restored · 0 already saved")
    print("Restored a synthetic weigh-in through the file picker and the confirmation screen")

    adb("shell", "am", "force-stop", APP)
    open_diary_files()
    choose(VALID)
    find("0 new · 1 already saved")
    assert_no_restore_button()
    print("Relaunched Edo and verified the restored record persisted")

    choose(CONFLICT)
    find("This archive has 1 invalid or conflicting records.")
    assert_no_restore_button()
    choose(MALFORMED)
    find("Couldn’t open this Edo diary archive.")
    assert_no_restore_button()
    choose(OVERSIZED)
    find("Restore on this phone supports archives up to 16 MiB.")
    assert_no_restore_button()
    print("Rejected a changed record, trailing NUL content, and an oversized archive")


if __name__ == "__main__":
    run(Path(sys.argv[1]))
