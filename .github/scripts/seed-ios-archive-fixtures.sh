#!/usr/bin/env bash
set -euo pipefail

files_app=com.apple.DocumentsApp
local_storage_group=group.com.apple.FileProvider.LocalStorage

find_local_storage() {
  xcrun simctl get_app_container "$EDO_SIMULATOR" "$files_app" groups 2>/dev/null |
    awk -F '\t' -v group="$local_storage_group" '$1 == group { print $2 }'
}

container=$(find_local_storage || true)
if [[ ! -d "$container" ]]; then
  xcrun simctl launch "$EDO_SIMULATOR" "$files_app"
  for _ in {1..20}; do
    container=$(find_local_storage || true)
    [[ -d "$container" ]] && break
    sleep 0.25
  done
fi
if [[ ! -d "$container" ]]; then
  echo "The local Files provider container was not found for this simulator" >&2
  exit 1
fi

fixtures="$container/File Provider Storage"
mkdir -p "$fixtures"
python3 - "$fixtures" <<'PYTHON'
from pathlib import Path
import sys

sys.path.insert(0, ".github/scripts")
from archive_smoke_fixtures import write_fixtures

write_fixtures(Path(sys.argv[1]))
PYTHON
echo "Seeded synthetic archives in Files → On My iPhone"
