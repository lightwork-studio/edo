"""Verify the Android favorite fallback with an empty catalog cache."""

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


def find(expected, fragments=False, widget=None, timeout=55):
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
                if expected in node_labels or (
                    fragments and any(expected.casefold() in label.casefold() for label in node_labels)
                ):
                    return node
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ElementTree.ParseError):
            pass
        time.sleep(0.5)
    raise AssertionError(f"Expected {expected!r}. Last visible labels: {visible}")


def tap(label, fragments=False, widget=None):
    node = find(label, fragments=fragments, widget=widget)
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    if right <= left or bottom <= top:
        raise AssertionError(f"Cannot tap empty bounds {node.attrib['bounds']}")
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def start():
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")


def app_locale(locale):
    adb("shell", "cmd", "locale", "set-app-locales", APP, "--user", "0", "--locales", locale)


def reveal(label, fragments=False):
    width, height = map(int, re.findall(r"(\d+)x(\d+)", adb("shell", "wm", "size"))[-1])
    for attempt in range(5):
        try:
            return find(label, fragments=fragments, timeout=3)
        except AssertionError:
            if attempt == 4:
                raise
            x = str(width // 2)
            adb("shell", "input", "swipe", x, str(height * 4 // 5), x, str(height * 2 // 5), "350")


def check_favorite():
    assert_offline()
    find("Fallback carrot juice", fragments=True)
    tap("Add food", fragments=True)
    tap("My Foods")
    find("Favorites")
    find("Saved diary values", fragments=True)
    tap("Fallback carrot juice", fragments=True)
    find("Open Food Facts contributors", fragments=True)
    tap("100 g")
    reveal("123 kcal", fragments=True)
    for _ in range(3):
        tap("Back")
    find("Add food", fragments=True)


adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
check_favorite()
print("Previously logged favorite opened with captured nutrition and no cached catalog row.")
adb("shell", "am", "force-stop", APP)
start()
check_favorite()
print("Favorite fallback reopened in airplane mode after a full process restart.")
