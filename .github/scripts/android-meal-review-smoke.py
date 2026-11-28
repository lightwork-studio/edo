"""Compare saved phone and account meals in an offline Android release."""

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


def review_saved_records():
    assert_offline()
    find("Nothing logged yet")
    find("A saved change needs sync review.")
    tap("View sync issues")
    find("Sync issues")
    find("Meal")
    find("Issue 1")
    find("Pending phone change")
    find("Nov 10, 2026")
    reveal("2026-11-11T00:30:00.003Z")
    reveal("UTC-04:00")
    reveal("Captured oats")
    reveal("75 g", fragments=True)
    reveal("76.125 kcal", fragments=True)
    reveal("Saved account copy")
    reveal("Nov 11, 2026")
    reveal("2026-11-11T00:30:00.004Z")
    reveal("UTC+01:00")
    reveal("50 g", fragments=True)
    reveal("Energy unknown", fragments=True)
    labels_now = [
        label for node in ElementTree.fromstring(adb("shell", "cat", UI_PATH)).iter("node")
        for label in labels(node)
    ]
    hidden = (
        "Private phone sentinel",
        "Private account sentinel",
        "Meal contents unavailable",
        "native-meal-review",
    )
    assert not any(value in label for value in hidden for label in labels_now), labels_now
    tap("Back")
    find("A saved change needs sync review.")


adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
review_saved_records()
print("Compared both saved meal portions, captured energy and UTC offsets in airplane mode.")
adb("shell", "am", "force-stop", APP)
start()
review_saved_records()
print("The same phone and account meals survived offline process restart without reseeding.")
