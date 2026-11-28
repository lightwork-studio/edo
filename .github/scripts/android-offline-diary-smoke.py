"""Verify bilingual bundled food search and durable local diary logging."""

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


def find(expected, fragments=False):
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
                if expected in node_labels or (                    fragments and any(expected in label for label in node_labels)
                ):
                    return node
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ElementTree.ParseError):
            pass
        time.sleep(0.5)
    raise AssertionError(f"Expected {expected!r}. Last visible labels: {visible}")


def tap(label, fragments=False):
    node = find(label, fragments=fragments)
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    if right <= left or bottom <= top:
        raise AssertionError(f"Cannot tap empty bounds {node.attrib['bounds']}")
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def start():
    assert_offline()
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")


def app_locale(locale):
    adb("shell", "cmd", "locale", "set-app-locales", APP, "--user", "0", "--locales", locale)


def search(add_food, field, query, result):
    tap(add_food, fragments=True)
    tap(field)
    adb("shell", "input", "text", query.replace(" ", "%s"))
    find(result, fragments=True)


def assert_logged_meal():
    # TalkBack can expose the three values as either one row description or separate labels.
    find("Banana nectar", fragments=True)
    find("50 g", fragments=True)
    find("26 kcal", fragments=True)


assert_offline()
app_locale("en-US")
start()
find("Nothing logged yet")
search("Add food", "Search foods by name", "Bananennektar", "Banana nectar")
tap("Banana nectar", fragments=True)
tap("50 g")
tap("Add to diary")
assert_logged_meal()
print("Fresh offline install found Banana nectar by German name and logged 50 g at 26 kcal")

adb("shell", "am", "force-stop", APP)
start()
assert_logged_meal()
print("Offline diary retained the logged portion and calories after a full app restart")

adb("shell", "am", "force-stop", APP)
app_locale("de-DE")
start()
search("Lebensmittel hinzufügen", "Lebensmittel nach Name suchen", "Banana nectar", "Bananennektar")
print("German app locale found the bilingual catalog entry from its English name while offline")
