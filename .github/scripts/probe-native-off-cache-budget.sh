#!/usr/bin/env bash
set -euo pipefail

app=studio.lightwork.edo
platform=${1:-android}
case "$platform" in
  android)
    directory="/data/user/0/$app/files"
    adb root
    adb wait-for-device
    test "$(adb shell id -u | tr -d '\r')" = 0
    adb shell cmd connectivity airplane-mode enable
    adb shell svc wifi disable
    test "$(adb shell settings get global airplane_mode_on)" = 1
    test "$(adb shell settings get global wifi_on)" = 0
    ;;
  ios)
    directory="$(xcrun simctl get_app_container "$EDO_SIMULATOR" "$app" data)/Documents"
    ;;
  *)
    printf 'Unsupported simulator platform %s\n' "$platform" >&2
    exit 2
    ;;
esac

process=''
running() {
  if [[ "$platform" == android ]]; then
    [[ "$(adb shell pidof "$app" 2>/dev/null || true)" == "$process" ]]
  else
    kill -0 "$process" 2>/dev/null
  fi
}

stop() {
  [[ -n "$process" ]] || return 0
  if [[ "$platform" == android ]]; then
    adb shell am force-stop "$app"
  else
    xcrun simctl terminate "$EDO_SIMULATOR" "$app"
  fi
  local deadline=$((SECONDS + 15))
  while running; do
    test "$SECONDS" -lt "$deadline"
    sleep 0.25
  done
  process=''
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
}

marker() {
  local file="$directory/edo-cache-$1"
  if [[ "$platform" == android ]]; then
    adb shell cat "$file" 2>/dev/null
  else
    cat "$file" 2>/dev/null
  fi
}

await_result() {
  local stage=$1 deadline=$((SECONDS + 180))
  local result
  while (( SECONDS < deadline )); do
    if result=$(marker failed); then
      printf 'Cache verification failed. %s\n' "$result" >&2
      return 1
    fi
    if result=$(marker "$stage"); then
      printf 'Edo cache %s %s\n' "$stage" "$result"
      return 0
    fi
    running
    sleep 1
  done
  printf 'Timed out waiting for cache %s\n' "$stage" >&2
  return 1
}

trap 'stop || true' EXIT
start
await_result seeded
stop
start
await_result reopened
