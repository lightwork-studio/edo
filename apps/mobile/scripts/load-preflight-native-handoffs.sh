#!/usr/bin/env bash
set +x
set -euo pipefail
export LC_ALL=C

fail() { printf '%s\n' "$1" >&2; exit 1; }

if [[ "${GITHUB_REPOSITORY:-}" != lightwork-studio/edo ||
      ! "${GITHUB_REPOSITORY_ID:-}" =~ ^[1-9][0-9]*$ ||
      ! "${TARGET:-}" =~ ^[0-9a-f]{40}$ || -z "${GH_TOKEN:-}" ]]; then
  fail "The Preflight handoff lookup requires a verified Edo revision and GitHub Actions read access."
fi

umask 077
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/edo-preflight-handoffs.XXXXXX" 2>/dev/null)" ||
  fail "Could not create temporary storage for Preflight handoffs."
trap 'rm -rf -- "$work"' EXIT
unset UNZIP UNZIPOPT ZIPINFO ZIPINFOOPT

api() { gh api --hostname github.com --method GET "repos/$GITHUB_REPOSITORY/$1" 2>/dev/null; }

workflow_id="$(api actions/workflows/preflight.yml | jq -ser '
  select(length == 1) | .[0] | select(.path == ".github/workflows/preflight.yml")
  | .id | numbers | tostring | select(test("\\A[1-9][0-9]*\\z"))
' 2>/dev/null)" || fail "Could not verify the Edo Preflight workflow ID."

artifact_name="edo-preflight-native-$TARGET"
page_size=100
max_pages=5
max_archive_bytes=16384
max_payload_bytes=1024
seen_count=0
: > "$work/pages.json"

for ((page = 1; page <= max_pages; page++)); do
  api "actions/artifacts?name=$artifact_name&per_page=$page_size&page=$page" > "$work/page.json" ||
    fail "Could not list Edo Preflight handoffs."
  page_counts="$(jq -ser --argjson limit "$((page_size * max_pages))" '
    select(length == 1) | .[0]
    | select((.total_count | type == "number" and . == floor and . >= 0 and . <= $limit)
      and (.artifacts | type == "array"))
    | [(.total_count | floor), (.artifacts | length)] | @tsv
  ' "$work/page.json" 2>/dev/null)" || fail "Invalid or oversized Edo Preflight handoff listing."
  IFS=$'\t' read -r total count <<< "$page_counts"
  if (( page == 1 )); then expected_total="$total"; fi
  remaining=$((expected_total - seen_count))
  expected_count=$((remaining < page_size ? remaining : page_size))
  if (( total != expected_total || count != expected_count )); then
    fail "The Edo Preflight handoff listing changed during lookup."
  fi
  cat "$work/page.json" >> "$work/pages.json"
  printf '\n' >> "$work/pages.json"
  seen_count=$((seen_count + count))
  if (( seen_count == expected_total )); then break; fi
done

jq -cs --arg name "$artifact_name" --arg repo "$GITHUB_REPOSITORY_ID" --arg revision "$TARGET" '
  [.[].artifacts[]] as $artifacts
  | [$artifacts[].id | numbers | tostring | select(test("\\A[1-9][0-9]*\\z"))] as $ids
  | if ($ids | unique | length) == ($artifacts | length) then $artifacts[] else error("Invalid artifact IDs") end
  | select(.name == $name and .expired == false and (.workflow_run
      | (.repository_id | tostring) == $repo and (.head_repository_id | tostring) == $repo
      and .head_branch == "main" and .head_sha == $revision))
  | {id, size_in_bytes, run: .workflow_run.id}
  | if (.run | type == "number" and (tostring | test("\\A[1-9][0-9]*\\z"))) then . else error("Invalid run ID") end
' "$work/pages.json" > "$work/candidates.jsonl" 2>/dev/null || fail "Invalid Edo Preflight artifact metadata."

: > "$work/ids.json"
while IFS= read -r candidate; do
  artifact_id="$(jq -r '.id' <<< "$candidate")"
  run_id="$(jq -r '.run' <<< "$candidate")"
  approved="$(api "actions/runs/$run_id" |
    jq -sr --arg run "$run_id" --arg workflow "$workflow_id" \
      --arg repo "$GITHUB_REPOSITORY_ID" --arg revision "$TARGET" '
      if length != 1 or (.[0].id | tostring) != $run then error("Invalid run response") else .[0]
      | (.workflow_id | tostring) == $workflow and .head_branch == "main" and .head_sha == $revision
        and (.repository.id | tostring) == $repo and (.head_repository.id | tostring) == $repo
        and (.event == "workflow_run" or .event == "workflow_dispatch")
      end
    ' 2>/dev/null)" || fail "Could not verify the run that created an Edo Preflight handoff."
  if [[ "$approved" != true ]]; then continue; fi

  jq -e --argjson limit "$max_archive_bytes" '
    .size_in_bytes | type == "number" and . == floor and . > 0 and . <= $limit
  ' <<< "$candidate" >/dev/null 2>&1 || fail "Invalid size for an approved Edo Preflight handoff."
  if ! api "actions/artifacts/$artifact_id/zip" | head -c "$((max_archive_bytes + 1))" > "$work/artifact.zip" ||
      (( $(wc -c < "$work/artifact.zip") > max_archive_bytes )); then
    fail "Could not download the approved Edo Preflight handoff archive."
  fi
  if ! unzip -Z -1 "$work/artifact.zip" 2>/dev/null | cmp -s - <(printf 'native-archive.json\n') ||
      ! unzip -p "$work/artifact.zip" native-archive.json </dev/null 2>/dev/null |
        head -c "$((max_payload_bytes + 1))" > "$work/native-archive.json" ||
      (( $(wc -c < "$work/native-archive.json") > max_payload_bytes )); then
    fail "Invalid archive for an approved Edo Preflight handoff."
  fi
  # Read the JSON key paths so repeated keys are rejected before constructing the object.
  jq --stream -se --arg revision "$TARGET" '
    select(length == 4 and (.[-1] | length == 1))
    | [.[] | select(length == 2 and (.[0] | length == 1)) | {key: .[0][0], value: .[1]}]
    | select((map(.key) | sort) == ["id", "revision", "runtime"])
    | from_entries
    | select(.revision == $revision
      and (.id | type == "string" and test("\\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\z"))
      and (.runtime | type == "string" and test("\\A[0-9a-f]{40}\\z"))) | .id
  ' "$work/native-archive.json" >> "$work/ids.json" 2>/dev/null ||
    fail "Invalid payload for an approved Edo Preflight handoff."
done < "$work/candidates.jsonl"

jq -cs 'unique' "$work/ids.json"
