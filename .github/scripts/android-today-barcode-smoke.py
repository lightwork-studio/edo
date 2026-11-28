"""Verify the Today barcode shortcut in an offline Android release."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-today-barcode"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def full_label(value):
    return f"{value:%A, %B} {value.day}, {value.year}"


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
today = date.fromisoformat(adb("shell", "date", "+%F"))
today_header = f"{today:%a, %b} {today.day}. Choose a day"
tap(today_header)
tap("Previous month")
last_month = today.replace(day=1) - timedelta(days=1)
historical = last_month.replace(day=15)
tap(full_label(historical))
historical_header = f"{historical:%a, %b} {historical.day}"
if historical.year != today.year:
    historical_header += f", {historical.year}"
historical_header += ". Choose a day"
find(historical_header)
capture("today-barcode-shortcut")
tap("Scan barcode")
tap("Don’t allow")
find("Camera access was denied.", fragments=True)
capture("today-barcode-manual-fallback")
tap("Product barcode", widget="android.widget.EditText")
adb("shell", "input", "text", "4006381333931")
find("4006381333931", widget="android.widget.EditText")
adb("shell", "input", "keyevent", "66")
tap("Search foods by name")
find("Search by food name", widget="android.widget.EditText")
tap("Back")
find(historical_header)

tap("Scan barcode")
tap("Don’t allow")
find("Camera access was denied.", fragments=True)
find("Product barcode", widget="android.widget.EditText")
tap("Back")
find(historical_header)

tap("Log")
tap("Search by food name", widget="android.widget.EditText")
adb("shell", "input", "text", "apple")
find("apple", widget="android.widget.EditText")
tap("Scan barcode")
find("Open camera")
tap("Back")
find("apple", widget="android.widget.EditText")
tap("Back")
find(historical_header)

tap("Scan barcode")
find("Camera access was denied.", fragments=True)
tap("Product barcode", widget="android.widget.EditText")
adb("shell", "input", "text", "034000470693")
find("034000470693", widget="android.widget.EditText")
adb("shell", "input", "keyevent", "66")
find("Saved on this device")
tap("Carrot juice", fragments=True)
find("Add to diary")
tap("Back")
find("Saved on this device")
tap("Carrot juice", fragments=True)
tap("Add to diary")
find(historical_header)
find("Carrot juice", fragments=True)
find("41 kcal", fragments=True)
capture("today-barcode-cached-history")

adb("shell", "am", "force-stop", APP)
start()
assert_offline()
tap(today_header)
tap("Previous month")
tap(full_label(historical))
find("Carrot juice", fragments=True)
find("41 kcal", fragments=True)
print("Verified direct permission, fallback, cached lookup, Detail Back, historical save and offline relaunch.")
