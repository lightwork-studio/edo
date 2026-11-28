"""Verify product drafts in an offline Android release."""

import re
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from xml.etree import ElementTree

APP = "studio.lightwork.edo"
UI_PATH = "/sdcard/edo-offline-window.xml"


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=18, text=True).strip()


def assert_offline():
    if adb("shell", "settings", "get", "global", "airplane_mode_on") != "1":
        raise AssertionError("Android is not in airplane mode")
    if adb("shell", "settings", "get", "global", "wifi_on") != "0":
        raise AssertionError("Wi-Fi is not disabled")


def labels(node):
    return [label for name in ("text", "content-desc") if (label := node.get(name))]


def find(expected, fragments=False, widget=None, resource=None):
    deadline = time.monotonic() + 55
    visible = []
    while time.monotonic() < deadline:
        try:
            if "dumped to" not in adb("shell", "uiautomator", "dump", UI_PATH):
                continue
            tree = ElementTree.fromstring(adb("shell", "cat", UI_PATH))
            visible = sorted({label for node in tree.iter("node") for label in labels(node)})
            for node in tree.iter("node"):
                node_labels = labels(node)
                if widget and node.get('class') != widget:
                    continue
                if resource and node.get("resource-id", "").endswith(resource):
                    return node
                if expected in node_labels or (
                    fragments and any(expected.casefold() in label.casefold() for label in node_labels)
                ):
                    return node
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ElementTree.ParseError):
            pass
        time.sleep(0.5)
    raise AssertionError(f"Expected {expected!r}. Last visible labels: {visible}")


def tap(label, fragments=False, widget=None, resource=None):
    node = find(label, fragments=fragments, widget=widget, resource=resource)
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    if right <= left or bottom <= top:
        raise AssertionError(f"Cannot tap empty bounds {node.attrib['bounds']}")
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def start():
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")


def app_locale(locale):
    adb("shell", "cmd", "locale", "set-app-locales", APP, "--user", "0", "--locales", locale)


def scan(code):
    tap("Add food", fragments=True)
    tap("Scan barcode")
    submit_barcode(code)


def submit_barcode(code):
    tap("Product barcode", widget="android.widget.EditText")
    adb("shell", "input", "text", code)
    tap("Find product")




def create_draft(name):
    tap("Prepare a product contribution")
    find("Open Food Facts draft")
    find("0000001234567")
    tap("Product name", widget="android.widget.EditText")
    adb("shell", "input", "text", name.replace(" ", "%s"))
    adb("shell", "input", "keyevent", "4")
    tap("Review product")
    find(name)
    tap("Save draft on this device")


def verify_persisted_drafts():
    with tempfile.TemporaryDirectory(prefix="edo-off-contribution-") as root:
        path = Path(root) / "queue.sqlite"
        location = f"/data/user/0/{APP}/files/SQLite/edo-off-contributions.db"
        path.write_bytes(subprocess.check_output(["adb", "exec-out", "cat", location], timeout=18))
        with sqlite3.connect(path) as db:
            assert db.execute("PRAGMA quick_check").fetchall() == [("ok",)]
            tables = db.execute("SELECT name FROM sqlite_schema WHERE type='table'").fetchall()
            assert tables == [("off_contributions",)], tables
            rows = db.execute("SELECT barcode, language, name, brand, package_quantity FROM off_contributions").fetchall()
            assert rows == [("0000001234567", "en", "Fixture breakfast flakes", None, None)], rows


adb("root")
adb("wait-for-device")
assert adb("shell", "id", "-u") == "0"
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
assert_offline()
app_locale("en-US")
start()
find("Nothing logged yet")
scan("0000001234567")
find("Product lookup is unavailable.", fragments=True)
create_draft("Fixture breakfast flakes")
find("Product draft saved on this device.")
verify_persisted_drafts()
print("A reviewed draft with its leading zeroes was saved in the private queue while offline.")

adb("shell", "am", "force-stop", APP)
start()
assert_offline()
find("Nothing logged yet")
scan("0000001234567")
create_draft("Fixture breakfast flakes")
find("This product draft is already saved.")
tap("Back")
create_draft("Different product draft")
find("A different draft for this barcode is already saved.", fragments=True)
verify_persisted_drafts()
print("The original draft survived relaunch and was preserved after identical and different duplicate submissions.")
