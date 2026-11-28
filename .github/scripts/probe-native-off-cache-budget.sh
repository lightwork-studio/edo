#!/usr/bin/env bash
set -euo pipefail

app=studio.lightwork.edo
directory="/data/user/0/$app/files"
adb root
adb wait-for-device
test "$(adb shell id -u | tr -d '\r')" = 0
adb shell cmd connectivity airplane-mode enable
adb shell svc wifi disable
test "$(adb shell settings get global airplane_mode_on)" = 1
test "$(adb shell settings get global wifi_on)" = 0

process=''
stop() {
  adb shell am force-stop "$app"
  local deadline=$((SECONDS + 15))
  while [[ "$(adb shell pidof "$app" 2>/dev/null || true)" == "$process" ]]; do
    test "$SECONDS" -lt "$deadline"
    sleep 0.25
  done
}

start() {
  adb shell am start -W -n "$app/.MainActivity"
  process=$(adb shell pidof "$app")
  [[ "$process" =~ ^[0-9]+$ ]]
}

await_result() {
  local stage=$1 deadline=$((SECONDS + 180))
  local result
  while (( SECONDS < deadline )); do
    if result=$(adb shell cat "$directory/edo-cache-failed" 2>/dev/null); then
      printf 'Cache verification failed. %s\n' "$result" >&2
      return 1
    fi
    if result=$(adb shell cat "$directory/edo-cache-$stage" 2>/dev/null); then
      printf 'Edo cache %s %s\n' "$stage" "$result"
      return 0
    fi
    test "$(adb shell pidof "$app")" = "$process"
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
