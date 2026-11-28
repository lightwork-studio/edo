"""Exercise offline FDDB import through Android's real Downloads picker."""
import re
import subprocess
import sys
import time
from pathlib import Path
from xml.etree import ElementTree

APP = "studio.lightwork.edo"
UI_DUMP = "/sdcard/edo-fddb-window.xml"
CSV = "Edo-fddb-smoke.csv"


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=15, text=True)


def nodes():
    dump = adb("shell", "uiautomator", "dump", UI_DUMP)
    if "dumped to" not in dump:
        return []
    return list(ElementTree.fromstring(adb("shell", "cat", UI_DUMP)).iter("node"))


def labels(node):
    return {node.get("text"), node.get("content-desc")} - {None, ""}


def find(*expected):
    deadline = time.monotonic() + 50
    current = []
    while time.monotonic() < deadline:
        current = nodes()
        for label in expected:
            for node in current:
                if label in labels(node):
                    return label, node
        time.sleep(0.5)
    visible = sorted({label for node in current for label in labels(node)})
    raise AssertionError(f"Expected one of {expected}. Last visible labels: {visible}")


def tap_node(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    if right <= left or bottom <= top:
        raise AssertionError(f"Cannot tap empty bounds {node.attrib['bounds']}")
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def tap(label):
    _, node = find(label)
    tap_node(node)


def assert_offline():
    assert adb("shell", "settings", "get", "global", "airplane_mode_on").strip() == "1"
    assert adb("shell", "settings", "get", "global", "wifi_on").strip() == "0"


def open_importer():
    adb("shell", "am", "start", "-W", "-n", f"{APP}/.MainActivity")
    tap("Progress")
    tap("Diary files")
    tap("Import from FDDB")
    find("Choose FDDB CSV")


def choose_csv():
    tap("Choose FDDB CSV")
    label, node = find(CSV, "Show roots", "Open navigation drawer", "Downloads")
    if label != CSV:
        if label != "Downloads":
            tap_node(node)
            tap("Downloads")
        _, node = find(CSV)
    if node.get("enabled") != "true":
        raise AssertionError(f"Android reported the synthetic CSV as disabled: {node.attrib}")
    tap_node(node)
    print("Tapped the enabled CSV row in Android Downloads")


def preview_utc():
    find("Time zone of the FDDB entries")
    fields = [node for node in nodes() if node.get("class") == "android.widget.EditText"]
    assert len(fields) == 1
    field = fields[0]
    tap_node(field)
    value = field.get("text") or ""
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", *["KEYCODE_DEL"] * len(value))
    adb("shell", "input", "text", "UTC")
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    tap("Preview import")


def run(directory):
    assert_offline()
    adb("shell", "cmd", "locale", "set-app-locales", APP, "--user", "0", "--locales", "en-US")
    day = adb("shell", "date", "+%d.%m.%Y").strip()
    row = f"{day} 07:30;Soup;0000123;418,4;0;0;;"
    header = (
        "datum_tag_monat_jahr_stunde_minute;bezeichnung;interne_id;kj;"
        "kj_aktivitaeten;fett_g;kh_g;protein_g"
    )
    path = directory / CSV
    path.write_text(
        "\n".join([header, row, row, f"{day} 08:00;Walking;;;200;;;", "bad;Bread;;;;;;"]),
        encoding="utf-8-sig",
    )
    adb("shell", "mkdir", "-p", "/sdcard/Download")
    adb("push", str(path), f"/sdcard/Download/{CSV}")

    open_importer()
    tap("Choose FDDB CSV")
    find(CSV, "Show roots", "Open navigation drawer", "Downloads")
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    find("Choose FDDB CSV")
    print("Cancel returned to the FDDB import screen")

    choose_csv()
    preview_utc()
    find("2 new · 0 already saved")
    find("1 activity rows · 1 problem rows skipped")
    find("Line 5 · Invalid date or time")
    tap("Import 2 new entries")
    find("2 imported · 0 already saved")
    for _ in range(3):
        tap("Back")
    find("Soup")
    find("200 kcal")
    print("Imported two identical food rows offline with their original day and calories")

    adb("shell", "am", "force-stop", APP)
    assert_offline()
    open_importer()
    choose_csv()
    preview_utc()
    find("0 new · 2 already saved")
    assert all(
        not any(label.startswith("Import ") and label.endswith(" new entries") for label in labels(node))
        for node in nodes()
    )
    print("The same CSV after a full restart offered no duplicate entries")


if __name__ == "__main__":
    run(Path(sys.argv[1]))
