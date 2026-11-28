"""Verify Profile targets and diary file navigation in an offline Android release."""

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
    output = Path(os.environ["RUNNER_TEMP"]) / "edo-profile-design"
    output.mkdir(exist_ok=True)
    with (output / (name + ".png")).open("wb") as file:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], stdout=file, timeout=18, check=True)


def fill_number(label, value):
    tap(label, widget="android.widget.EditText")
    adb("shell", "input", "text", value)
    find(value, widget="android.widget.EditText")
    adb("shell", "input", "keyevent", "4")


adb("shell", "wm", "size", "780x1688")
adb("shell", "wm", "density", "320")
adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
assert_offline()
tap("Profile")
find("Calories and macros")
find("Diary files")
capture("profile-empty-390dp")

tap("Calories and macros")
tap("Manual")
fill_number("Calorie target (kcal)", "2150")
fill_number("Protein (g)", "150")
fill_number("Fat (g)", "70")
tap("Save targets")
find("2,150 kcal, Protein 150 g, Carbs 230 g, Fat 70 g", fragments=True)
capture("profile-with-target-390dp")
tap("Diary files")
find("Share diary archive")
tap("Back")
find("2,150 kcal, Protein 150 g, Carbs 230 g, Fat 70 g", fragments=True)

adb("shell", "am", "force-stop", APP)
adb("shell", "wm", "size", "640x1450")
adb("shell", "settings", "put", "system", "font_scale", "1.5")
app_locale("de-DE")
start()
assert_offline()
tap("Profil")
find("2.150 kcal, Eiweiß 150 g, Kohlenhydrate 230 g, Fett 70 g", fragments=True)
find("Tagebuchdateien")
capture("profile-with-target-320dp-de-150")
print("Verified target-free Profile, real local target creation, bilingual summary, and diary file return offline.")


