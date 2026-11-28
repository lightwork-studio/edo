#!/usr/bin/env bash
set -euo pipefail

phase=$1
test=$2
products="$RUNNER_TEMP/$phase/Build/Products"
app="$products/Release-iphonesimulator/Edo.app"
test -d "$app"
test_files=("$products"/*.xctestrun)
test "${#test_files[@]}" = 1
test -f "${test_files[0]}"
if [[ -n "${EDO_DATA_CONTAINER:-}" ]]; then
  test "$EDO_DATA_CONTAINER" = "$(xcrun simctl get_app_container "$EDO_SIMULATOR" studio.lightwork.edo data)"
  test -f "$EDO_DATA_CONTAINER/Documents/edo-cache-outage-probe"
else
  xcrun simctl install "$EDO_SIMULATOR" "$app"
fi
xcodebuild -xctestrun "${test_files[0]}" \
  -destination "platform=iOS Simulator,id=$EDO_SIMULATOR" \
  -parallel-testing-enabled NO -resultBundlePath "$RUNNER_TEMP/$phase-$test.xcresult" \
  "-only-testing:OfflineSmokeUITests/OfflineSmokeUITests/$test" test-without-building
