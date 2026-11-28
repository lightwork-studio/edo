"""Verify camera denial and manual barcode lookup on an Android emulator."""

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


def find(expected, fragments=False, widget=None, resource=None):
    deadline = time.monotonic() + 55
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


def scan(code):
    tap("Add food", fragments=True)
    tap("Scan barcode")
    submit_barcode(code)


def submit_barcode(code):
    tap("Product barcode", widget="android.widget.EditText")
    adb("shell", "input", "text", code)
    tap("Find product")


def leave_to_diary(count):
    for _ in range(count):
        tap("Back")
    find("Add food", fragments=True)


app_locale("en-US")
start()
find("Nothing logged yet")
tap("Add food", fragments=True)
tap("Scan barcode")
tap("Open camera")
tap("Permission denied", resource="/permission_deny_button")
find("Camera access was denied. Enter the barcode below.")
print("Denied Android camera permission and verified the app offered manual entry")

submit_barcode("0000460938714")
find("Product barcode 0000460938714", fragments=True)
tap("Soja Protein Haselnuss", fragments=True)
find("Open Food Facts contributors", fragments=True)
tap("100 g")
tap("Add to diary")
find("Soja Protein Haselnuss", fragments=True)
print("The leading-zero product retained its barcode, showed its source and logged through the diary")

scan("0001100000136")
find("Product barcode 0001100000136", fragments=True)
find("Nutrition details unavailable")
leave_to_diary(2)
print("The catalog candidate with incomplete nutrition remained visible with an explicit status")

scan("9876543265197")
find("No product found for this barcode.")
tap("Search foods by name")
find("Search foods by name", widget="android.widget.EditText")
print("The online catalog miss offered the existing name search")
