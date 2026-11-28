"""Verify the Today calendar in an offline Android release."""

from datetime import date, timedelta
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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-today-date-picker"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def full_label(value):
    return f"{value:%A, %B} {value.day}, {value.year}"


adb("shell", "wm", "size", "640x1280")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
today = date.fromisoformat(adb("shell", "date", "+%F"))
today_header = f"{today:%a, %b} {today.day}. Choose a day"
find(today_header)
capture("today-header-320dp-en")
tap(today_header)
find(today.strftime("%B %Y"))
last_day = find(full_label(today))
left, top, right, bottom = map(int, re.findall(r"\d+", last_day.attrib["bounds"]))
if right - left < 88 or bottom - top < 88:
    raise AssertionError(f"Date target smaller than 44dp: {last_day.attrib['bounds']}")
if last_day.attrib.get("selected") != "true":
    raise AssertionError("Current date is not selected in the picker")
tomorrow = today + timedelta(days=1)
if tomorrow.month == today.month:
    if find(full_label(tomorrow)).attrib.get("enabled") != "false":
        raise AssertionError("Future date is enabled")
if find("Next month").attrib.get("enabled") != "false":
    raise AssertionError("Future month is enabled")
capture("today-date-picker-320dp-en")
tap("Previous month")
last_month = today.replace(day=1) - timedelta(days=1)
find(last_month.strftime("%B %Y"))
historical = last_month.replace(day=15)
tap(full_label(historical))
historical_header = f"{historical:%a, %b} {historical.day}"
if historical.year != today.year:
    historical_header += f", {historical.year}"
historical_header += ". Choose a day"
find(historical_header)
tap(historical_header)
find(last_month.strftime("%B %Y"))
adb("shell", "input", "keyevent", "4")
find(historical_header)
tap(historical_header)
tap("Today")
find(today_header)
adb("shell", "am", "force-stop", APP)
app_locale("de-DE")
start()
tap("Tag auswählen", fragments=True)
find("Vorheriger Monat")
capture("today-date-picker-320dp-de")
tap("Abbrechen")
find("Tag auswählen", fragments=True)
print("Verified month navigation, disabled future days, historical selection, Android Back and localized date controls.")
