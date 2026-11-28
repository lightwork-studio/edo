"""Verify portion preview without changing the diary on an offline Android release."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-food-detail-controls"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def metric_top(label):
    node = find(label, fragments=True)
    return int(re.findall(r"\d+", node.attrib["bounds"])[1])


def scroll_to_metric(expected):
    for attempt in range(4):
        try:
            return find(expected, timeout=4)
        except AssertionError:
            if attempt == 3:
                raise
            adb("shell", "input", "swipe", "24", "1350", "24", "720", "350")


def open_banana():
    tap("Log")
    tap("Search by food name", widget="android.widget.EditText")
    for character in "bananennektar":
        adb("shell", "input", "text", character)
        time.sleep(0.08)
    adb("shell", "input", "keyevent", "66")
    tap("Banana nectar", fragments=True)


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
find("1,086")
open_banana()
find("Add 100 g · 52 kcal")
tap("150 g")
find("Add 150 g · 78 kcal")
tap("Back")
tap("Back")
find("1,086")

tap("Haferflocken", fragments=True)
tap("100 g")
find("Save 100 g · 370 kcal")
tap("Back")
find("1,086")
tap("Foods")
tap("Mock yogurt", fragments=True)
find("Add 100 g · 100 kcal")
tap("portion, 150 g", fragments=True)
find("Add 1 portion · 150 kcal")
assert metric_top("Energy.") == metric_top("Carbs.")
capture("food-detail-controls-390dp")
tap("Add 1 portion · 150 kcal")
find("936")
adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1450")
app_locale("de-DE")
start()
assert_offline()
find("936")
tap("Lebensmittel")
tap("Mock yogurt", fragments=True)
tap("Portion, 150 g", fragments=True)
find("1 Portion · 150 kcal eintragen")
assert metric_top("Kohlenhydrate.") > metric_top("Energie.")
capture("food-detail-controls-320dp-de")
for _ in range(2):
    adb("shell", "input", "swipe", "300", "975", "300", "270", "360")
find("Nicht verfügbar", fragments=True)

adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1680")
adb("shell", "settings", "put", "system", "font_scale", "2.0")
start()
assert_offline()
tap("Lebensmittel")
tap("Mock yogurt", fragments=True)
tap("Menge (g)", widget="android.widget.EditText")
adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
for _ in range(3):
    adb("shell", "input", "keyevent", "KEYCODE_DEL")
adb("shell", "input", "text", "1200")
find("1200", widget="android.widget.EditText")
adb("shell", "input", "keyevent", "4")
find("1200 g · 1.200 kcal eintragen")
metric = scroll_to_metric("+1.200")
_, top, _, bottom = map(int, re.findall(r"\d+", metric.attrib["bounds"]))
assert bottom - top >= 36, "Large-text portion value is too short"
capture("food-detail-controls-320dp-de-200")
print("Verified measured portions, CTA energy, cancellation, persistence and full-size large energy text offline.")
