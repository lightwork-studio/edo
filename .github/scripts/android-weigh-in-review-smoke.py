"""Compare saved phone and account weigh-ins in an offline Android release."""

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


def review_saved_records():
    assert_offline()
    find("Nothing logged yet")
    find("A saved change needs sync review.")
    tap("View sync issues")
    find("Sync issues")
    find("Weigh-in")
    find("Issue 1")
    find("Pending phone change")
    find("80.002 kg")
    find("Nov 10, 2026")
    find("Saved account copy")
    find("81.003 kg")
    find("Nov 11, 2026")
    labels_now = [
        label for node in ElementTree.fromstring(adb("shell", "cat", UI_PATH)).iter("node")
        for label in labels(node)
    ]
    hidden = (
        "Private phone sentinel",
        "Private account sentinel",
        "Weigh-in values unavailable",
        "native-weigh-in-review",
    )
    assert not any(value in label for value in hidden for label in labels_now), labels_now
    tap("Back")
    find("A saved change needs sync review.")


adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
app_locale("en-US")
start()
review_saved_records()
print("Compared both saved weights and diary days despite a shortened receipt at the same revision.")
adb("shell", "am", "force-stop", APP)
start()
review_saved_records()
print("The same phone and account weigh-ins survived offline process restart without reseeding.")
