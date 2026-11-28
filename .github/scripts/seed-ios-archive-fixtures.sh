#!/usr/bin/env bash
set -euo pipefail

fixture_app="$RUNNER_TEMP/ArchiveFixtures.app"
fixture_id=studio.lightwork.edo.smoke-fixtures
mkdir -p "$fixture_app/FixtureFiles"
xcrun --sdk iphonesimulator swiftc .github/scripts/ArchiveFixtureExporter.swift \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios17.0-simulator" \
  -parse-as-library -o "$fixture_app/ArchiveFixtures"
python3 - "$fixture_app" "$fixture_id" <<'PYTHON'
from pathlib import Path
import plistlib
import sys

sys.path.insert(0, ".github/scripts")
from archive_smoke_fixtures import write_fixtures

app = Path(sys.argv[1])
write_fixtures(app / "FixtureFiles")
with (app / "Info.plist").open("wb") as plist:
    plistlib.dump({
        "CFBundleDisplayName": "Archive Fixtures",
        "CFBundleExecutable": "ArchiveFixtures",
        "CFBundleIdentifier": sys.argv[2],
        "CFBundleName": "Archive Fixtures",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSRequiresIPhoneOS": True,
        "MinimumOSVersion": "17.0",
        "UIDeviceFamily": [1],
    }, plist)
PYTHON

codesign --force --sign - --timestamp=none "$fixture_app"
xcrun simctl install "$EDO_SIMULATOR" "$fixture_app"
