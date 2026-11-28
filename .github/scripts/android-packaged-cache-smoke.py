"""Verify retained Open Food Facts products through a real Android emulator outage."""

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


def find(expected, fragments=False, widget=None):
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


def scan(code):
    tap("Add food", fragments=True)
    tap("Scan barcode")
    tap("Product barcode", widget="android.widget.EditText")
    adb("shell", "input", "text", code)
    tap("Find product")


def leave_to_diary(count):
    for _ in range(count):
        tap("Back")
    find("Add food", fragments=True)


def check_offline_cache():
    assert_offline()
    scan("3017620422003")
    find("Saved on this device")
    find("Nutella", fragments=True)
    leave_to_diary(2)

    tap("Add food", fragments=True)
    tap("My Foods")
    find("Favorites")
    tap("Marzipan", fragments=True)
    find("Open Food Facts contributors", fragments=True)
    find("Remove", fragments=True)
    leave_to_diary(3)

    scan("5449000000996")
    find("Product lookup is unavailable", fragments=True)
    tap("Search foods by name")
    tap("Search foods by name", widget="android.widget.EditText")
    begin = time.monotonic()
    adb("shell", "input", "text", "Nutella")
    find("Nutella", fragments=True, widget="android.widget.Button")
    print(f"Cached name search became visible in {int((time.monotonic() - begin) * 1000)} ms (emulator UI polling included)")
    tap("Nutella", fragments=True, widget="android.widget.Button")
    find("Open Food Facts contributors", fragments=True)
    leave_to_diary(2)


app_locale("en-US")
start()
find("Nothing logged yet")
scan("3017620422003")
tap("Nutella", fragments=True)
tap("100 g")
tap("Add to diary")
find("Nutella", fragments=True)
find("539 kcal", fragments=True)

scan("4000417025005")
tap("Marzipan", fragments=True)
tap("to favorites", fragments=True)
find("Remove", fragments=True)
leave_to_diary(3)
print("Primed a logged-only and a favorite-only product through the public catalog")

adb("shell", "cmd", "connectivity", "airplane-mode", "enable")
adb("shell", "svc", "wifi", "disable")
check_offline_cache()
print("Logged barcode and favorite remained usable. The unseen barcode offered name search.")
adb("shell", "am", "force-stop", APP)
start()
check_offline_cache()
print("Offline cache and miss fallback survived a full process restart")

# Measure this disposable synthetic emulator cache when its image allows root reads.
try:
    if "cannot run as root" not in adb("root"):
        adb("wait-for-device")
        files = adb("shell", "stat -c '%n %s bytes' /data/user/0/studio.lightwork.edo/cache/edo-packaged-foods.db*")
        print(files)
except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
    print(f"Emulator cache footprint measurement unavailable: {error}")
