#!/usr/bin/env bash
set -euo pipefail

fixture_app="$RUNNER_TEMP/ArchiveFixtures.app"
fixture_id="studio.lightwork.edo.smoke-fixtures"
mkdir -p "$fixture_app"
cat > "$RUNNER_TEMP/ArchiveFixtures.swift" <<'SWIFT'
import UIKit

@main
final class FixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let view = UIViewController()
        view.view.backgroundColor = .systemBackground
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = view
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
SWIFT
xcrun --sdk iphonesimulator swiftc "$RUNNER_TEMP/ArchiveFixtures.swift" \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios17.0-simulator" \
  -parse-as-library -o "$fixture_app/ArchiveFixtures"
python3 - "$fixture_app/Info.plist" "$fixture_id" <<'PYTHON'
import plistlib
import sys

with open(sys.argv[1], "wb") as plist:
    plistlib.dump({
        "CFBundleDisplayName": "Archive Fixtures",
        "CFBundleExecutable": "ArchiveFixtures",
        "CFBundleIdentifier": sys.argv[2],
        "CFBundleName": "Archive Fixtures",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSRequiresIPhoneOS": True,
        "LSSupportsOpeningDocumentsInPlace": True,
        "MinimumOSVersion": "17.0",
        "UIDeviceFamily": [1],
        "UIFileSharingEnabled": True,
    }, plist)
PYTHON
codesign --force --sign - --timestamp=none "$fixture_app"
xcrun simctl install "$EDO_SIMULATOR" "$fixture_app"
container=$(xcrun simctl get_app_container "$EDO_SIMULATOR" "$fixture_id" data)
mkdir -p "$container/Documents"
python3 - "$container/Documents" <<'PYTHON'
from pathlib import Path
import sys

sys.path.insert(0, ".github/scripts")
from archive_smoke_fixtures import write_fixtures
write_fixtures(Path(sys.argv[1]))
PYTHON
xcrun simctl launch "$EDO_SIMULATOR" "$fixture_id"
