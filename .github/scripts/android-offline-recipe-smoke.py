"""Verify a cached packaged ingredient and saved recipe in an offline Android release."""

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


def scroll_to(label):
    sizes = re.findall(r"(\d+)x(\d+)", adb("shell", "wm", "size"))
    width, height = map(int, sizes[-1])
    for _ in range(32):
        try:
            find(label, timeout=1)
            return
        except AssertionError:
            adb(
                "shell", "input", "swipe",
                str(width // 2), str(height * 4 // 5),
                str(width // 2), str(height // 4), "70",
            )
    raise AssertionError(f"Could not scroll to {label!r}")


def start():
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")


def app_locale(locale):
    adb("shell", "cmd", "locale", "set-app-locales", APP, "--user", "0", "--locales", locale)


def open_recipes():
    tap("Add food", fragments=True)
    tap("My Foods")
    scroll_to("Create recipe")


def enter_text(label, text):
    tap(label, widget="android.widget.EditText")
    adb("shell", "input", "text", text)


adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
assert_offline()
app_locale("en-US")
start()
find("Nothing logged yet")
open_recipes()
tap("Create recipe")
enter_text("Recipe name", "Offline%sTomato%sDrink")
adb("shell", "input", "keyevent", "KEYCODE_BACK")
tap("Add ingredient", fragments=True)
enter_text("Search ingredients", "Tomaten")
adb("shell", "input", "keyevent", "KEYCODE_BACK")
find("Open Food Facts contributors", fragments=True)
find("Open Database License")
tap("Fixture recipe juice", fragments=True, widget="android.widget.Button")
find("Fixture recipe juice amount (ml)")
find("40 kcal", fragments=True)
enter_text("Fixture recipe juice amount (ml)", "200")
adb("shell", "input", "keyevent", "KEYCODE_BACK")
find("80 kcal", fragments=True)
tap("Save recipe")
find("Offline Tomato Drink", fragments=True)
print("Saved a 200 ml offline packaged recipe at 80 kcal after the stale product recheck fell back.")

adb("shell", "am", "force-stop", APP)
start()
assert_offline()
open_recipes()
scroll_to("Edit Offline Tomato Drink")
tap("Edit Offline Tomato Drink")
amount = find("Fixture recipe juice amount (ml)", widget="android.widget.EditText")
assert amount.get("text") == "200", amount.attrib
find("80 kcal", fragments=True)
find("Open Food Facts contributors", fragments=True)
print("Reopened the captured ingredient at 200 ml and 80 kcal after offline restart and cache eviction.")
