"""Verify multiple cached barcode candidates in an offline Android release."""

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



def verify_saved_candidate():
    find("Fixture soy drink", fragments=True)
    find("80 kcal", fragments=True)
    tree = ElementTree.fromstring(adb("shell", "cat", UI_PATH))
    visible = [label for node in tree.iter("node") for label in labels(node)]
    assert not any("Fixture oat drink" in label for label in visible), visible


adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
assert_offline()
app_locale("en-US")
start()
find("Nothing logged yet")
scan("0000001234567")
find("Choose the product on your package")
find("Saved on this device")
find("Fixture oat drink", fragments=True)
tap("Fixture soy drink", fragments=True)
find("Open Food Facts contributors", fragments=True)
tap("100 g")
tap("Add to diary")
verify_saved_candidate()
print("Two cached products shared one printed code, and only the selected 80 kcal product entered the diary.")

adb("shell", "am", "force-stop", APP)
start()
assert_offline()
verify_saved_candidate()
print("The selected product and its 80 kcal survived an offline process restart.")
