"""Capture grouped food search on an offline Android release."""

import os
from pathlib import Path
import re
import subprocess
import time
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


def find(expected, fragments=False, widget=None, resource=None, timeout=55):
    deadline = time.monotonic() + timeout
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


def capture(name):
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-search-design"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def type_query(text, label="Search foods by name"):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        editor = find(label, widget="android.widget.EditText", timeout=5)
        if editor.get("focused") == "true":
            break
    else:
        raise AssertionError("Search input was not ready for typing")
    for character in text:
        adb("shell", "input", "text", character)
        time.sleep(0.08)
    find(text, widget="android.widget.EditText", timeout=12)
    adb("shell", "input", "keyevent", "66")


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
tap("Add food", fragments=True)
tap("Search foods by name")
type_query("skyr")
find("Database")
find("Skyr Icelandic", fragments=True)
tap("Clear search")
editor = find("Search foods by name", widget="android.widget.EditText")
assert editor.get("focused") == "true", "Clearing did not return focus to the search input"
type_query("bananennektar")
find("Database")
find("Banana nectar, BLS", fragments=True)
find("Banana nectar spritzer, BLS", fragments=True)
capture("search-en")
tap("Banana nectar, BLS", fragments=True)
find("Banana nectar")
tap("Back")
find("Banana nectar, BLS", fragments=True)
tap("Scan barcode")
find("Product barcode")
tap("Back")
find("Banana nectar, BLS", fragments=True)
tap("Clear search")
type_query("apple")
find("Database")
adb("shell", "input", "swipe", "390", "1310", "390", "640", "420")
capture("search-scroll-en")
adb("shell", "am", "force-stop", APP)
app_locale("de-DE")
start()
tap("Lebensmittel hinzufügen", fragments=True)
tap("Lebensmittel nach Name suchen")
type_query("bananennektar", label="Lebensmittel nach Name suchen")
find("Datenbank")
find("Bananennektar, BLS", fragments=True)
capture("search-de")
print("Grouped bundled BLS matches worked offline in English and German. Clear, selection and barcode return preserved search navigation.")
