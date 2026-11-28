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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-food-detail-design"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


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
find("Your day with this")
find("1,034 kcal left after", fragments=True)
find("Logged 1,064 kcal", fragments=True)
capture("food-detail-new-en")
tap("Back")
tap("Back")
find("1,086")
tap("Haferflocken", fragments=True)
find("Your day with this")
find("1,086 kcal left after", fragments=True)
find("Other logged food", fragments=True)
tap("100 g")
find("938 kcal left after", fragments=True)
capture("food-detail-edit-en")
tap("Back")
find("1,086")
adb("shell", "am", "force-stop", APP)
app_locale("de-DE")
start()
tap("Haferflocken", fragments=True)
find("Dein Tag mit dieser Portion")
find("1.086 kcal danach übrig", fragments=True)
find("Sonstige erfasste Lebensmittel", fragments=True)
capture("food-detail-edit-de")
adb("shell", "am", "force-stop", APP)
app_locale("en-US")
start()
assert_offline()
find("1,086")
open_banana()
find("1,034 kcal left after", fragments=True)
tap("Add to diary")
find("1,034")
adb("shell", "am", "force-stop", APP)
start()
find("1,034")
print("Verified EN/DE offline previews, edit announcements, Back, and saved totals after restart.")
