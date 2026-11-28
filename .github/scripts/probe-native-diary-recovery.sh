#!/usr/bin/env bash
set -euo pipefail

platform=$1
app=studio.lightwork.edo
process=''

if [[ "$platform" == android ]]; then
  adb root
  adb wait-for-device
  test "$(adb shell id -u | tr -d '\r')" = 0
  directory="/data/user/0/$app/files"
  adb shell cmd connectivity airplane-mode enable
  adb shell svc wifi disable
  test "$(adb shell settings get global airplane_mode_on)" = 1
  test "$(adb shell settings get global wifi_on)" = 0
elif [[ "$platform" == ios ]]; then
  directory="$(xcrun simctl get_app_container "$EDO_SIMULATOR" "$app" data)/Documents"
else
  printf 'Unsupported simulator platform %s\n' "$platform" >&2
  exit 2
fi

still_running() {
  if [[ "$platform" == android ]]; then
    [[ "$(adb shell pidof "$app" 2>/dev/null || true)" == "$process" ]]
  else
    kill -0 "$process" 2>/dev/null
  fi
}

start() {
  if [[ "$platform" == android ]]; then
    adb shell am start -W -n "$app/.MainActivity"
    process=$(adb shell pidof "$app")
  else
    local reply
    reply=$(xcrun simctl launch "$EDO_SIMULATOR" "$app")
    process=${reply##*: }
  fi
  [[ "$process" =~ ^[0-9]+$ ]]
  printf 'Started native diary process %s\n' "$process"
}

stop() {
  [[ -n "$process" ]] || return 0
  if [[ "$platform" == android ]]; then
    adb shell am force-stop "$app"
  else
    xcrun simctl terminate "$EDO_SIMULATOR" "$app"
  fi
  local deadline=$((SECONDS + 15))
  while still_running; do
    test "$SECONDS" -lt "$deadline"
    sleep 0.25
  done
  printf 'Verified native diary process %s stopped\n' "$process"
  process=''
}

marker() {
  if [[ "$platform" == android ]]; then
    adb shell cat "$directory/edo-recovery-$1" 2>/dev/null
  else
    cat "$directory/edo-recovery-$1" 2>/dev/null
  fi
}

await_marker() {
  local name=$1
  local failure
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if failure=$(marker failed); then
      printf 'Native diary verification failed. %s\n' "$failure" >&2
      return 1
    fi
    if marker "$name" >/dev/null; then
      still_running
      printf 'Native diary checkpoint reached %s\n' "$name"
      return 0
    fi
    if ! still_running; then
      printf 'The native app stopped before checkpoint %s\n' "$name" >&2
      return 1
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for native diary checkpoint %s\n' "$name" >&2
  return 1
}

trap 'stop || true' EXIT
start
await_marker parked
stop
start
await_marker recovered
stop
start
await_marker reopened
printf 'Verified native rollback, standalone v7 recovery backup, v8 retry, and reopen on %s\n' "$platform"
