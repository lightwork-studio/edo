"""Capture the combined Edo design with the native Inter font offline."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-design-stack"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
find("1,086")
find("Scan barcode")
capture("combined-today-390dp")
tap("Progress")
find("7-day average")
find("1,461 / 2,083 kcal", fragments=True)
capture("combined-progress-390dp")

adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1450")
adb("shell", "settings", "put", "system", "font_scale", "1.5")
app_locale("de-DE")
start()
assert_offline()
find("1.086")
find("Barcode scannen")
capture("combined-today-320dp-de-150")
tap("Fortschritt")
find("7-Tage-Durchschnitt")
find("3 Monate")
capture("combined-progress-320dp-de-150")
tap("Profil")
find("2.150 kcal, Eiweiß 150 g, Kohlenhydrate 230 g, Fett 70 g", fragments=True)
capture("combined-profile-320dp-de-150")

tap("Heute")
tap("Erfassen")
tap("Lebensmittel suchen", widget="android.widget.EditText")
for character in "bananennektar":
    adb("shell", "input", "text", character)
    time.sleep(0.08)
adb("shell", "input", "keyevent", "66")
tap("Bananennektar", fragments=True)
find("100 g · 52 kcal eintragen")
capture("combined-food-detail-320dp-de-150")
print("Verified the combined Today, Progress, Profile, offline search and Food Detail layouts with native Inter.")
