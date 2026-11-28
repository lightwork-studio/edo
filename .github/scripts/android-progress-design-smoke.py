"""Verify the Progress presentation against a populated offline diary."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-progress-design"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def scroll():
    adb("shell", "input", "swipe", "300", "1150", "300", "540", "360")


def scroll_until(label, fragments=False):
    for attempt in range(4):
        try:
            return find(label, fragments=fragments, timeout=4)
        except AssertionError:
            if attempt == 3:
                raise
            scroll()


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
tap("Progress")
find("7-day average")
find("78.4 kg", fragments=True)
tap("Week")
find("1,461 / 2,083 kcal", fragments=True)
find("target 2,050 kcal, 30 kcal over target", fragments=True)
find("90 kcal over target", fragments=True)
find("Today, 1,064 kcal, target 2,150 kcal", fragments=True)
find("3 logged days")
capture("progress-390dp")
scroll_until("Macros · daily average")
find("Protein, 52.7 g, target 150 g")
find("Carbs, 114 g, target 213.3 g")
find("Fat, 43.7 g, target 70 g")
capture("progress-macros-390dp")
tap("Add weight")
tap("Weight in kilograms", widget="android.widget.EditText")
adb("shell", "input", "text", "77.5")
adb("shell", "input", "keyevent", "4")
tap("Save weight")
find("Weight saved for", fragments=True)
find("77.5 kg", fragments=True)

adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1450")
adb("shell", "settings", "put", "system", "font_scale", "1.5")
app_locale("de-DE")
start()
assert_offline()
tap("Fortschritt")
tap("3 Monate")
find("77,5 kg", fragments=True)
capture("progress-320dp-de-150")
scroll_until("1.461 / 2.083 kcal", fragments=True)
scroll_until("3 erfasste Tage")
earlier = find("Ziel 2.050 kcal", fragments=True)
_, top, _, bottom = map(int, re.findall(r"\d+", earlier.attrib["bounds"]))
middle = str((top + bottom) // 2)
adb("shell", "input", "swipe", "530", middle, "115", middle, "300")
find("Heute, 1.064 kcal, Ziel 2.150 kcal", fragments=True)
capture("progress-days-320dp-de-150")
scroll_until("Makros · Tagesdurchschnitt")
capture("progress-macros-320dp-de-150")
print("Verified historical calorie targets, macro targets, range switching, weigh-in persistence and large text offline.")


