"""Verify the Edo Foods library in an offline Android release."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-foods-library-design"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def absence(label):
    adb("shell", "uiautomator", "dump", UI_PATH)
    tree = ElementTree.fromstring(adb("shell", "cat", UI_PATH))
    assert not any(label in value for node in tree.iter("node") for value in labels(node))


def search(label, query):
    tap(label, widget="android.widget.EditText")
    adb("shell", "input", "text", query)
    find(query, widget="android.widget.EditText")
    adb("shell", "input", "keyevent", "66")


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
tap("Foods")
find("Äpfelmus", fragments=True)
find("Mock yogurt", fragments=True)
find("Search your foods", widget="android.widget.EditText")
capture("foods-library-390dp")
search("Search your foods", "apfel")
find("Äpfelmus", fragments=True)
absence("Mock yogurt")
tap("Recipes")
find("Müsli mit Apfel", fragments=True)
tap("Favorites")
find("No matches in this list.")
tap("Clear search")
find("Mock yogurt", fragments=True)
adb("shell", "input", "keyevent", "4")
tap("Saved meals")
find("Porridge breakfast", fragments=True)
tap("Today")
tap("Log")
tap("My Foods")
find("Mock yogurt", fragments=True)
absence("Search your foods")
tap("Back")
find("Search by food name", widget="android.widget.EditText")

adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1450")
adb("shell", "settings", "put", "system", "font_scale", "1.5")
app_locale("de-DE")
start()
assert_offline()
tap("Lebensmittel")
search("Sammlung durchsuchen", "apfel")
find("Äpfelmus", fragments=True)
absence("Mock yogurt")
capture("foods-library-320dp-de-150")
print("Verified offline accent-aware library search, personal categories and the existing Log route in both languages.")
