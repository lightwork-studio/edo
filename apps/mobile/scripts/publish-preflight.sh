#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${GITHUB_ACTIONS:-}" != true || "${GITHUB_REPOSITORY:-}" != lightwork-studio/edo ||
      ! "${TARGET:-}" =~ ^[0-9a-f]{40}$ || "$(git rev-parse HEAD)" != "$TARGET" ||
      -n "$(git status --porcelain)" ]]; then
  echo "Preflight requires a clean checkout of the verified Edo main revision." >&2
  exit 1
fi
: "${EXPO_TOKEN:?Configure EXPO_TOKEN in the Edo Preflight environment.}"
: "${RUNNER_TEMP:?GitHub runner temporary storage is required.}"
umask 077
work="$(mktemp -d "$RUNNER_TEMP/edo-preflight.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

eas() { pnpm exec eas "$@"; }

require_current_main() {
  local remote
  remote="$(git ls-remote --exit-code origin refs/heads/main)"
  if [[ "${remote%%$'\t'*}" != "$TARGET" ]]; then
    echo "A newer main revision is available. Skipping this release."
    exit 0
  fi
}

require_current_main
build_env="$(node -e '
  const { env } = require("./eas.json").build.preflight;
  for (const [name, value] of Object.entries(env)) console.log(name + "=" + value);
')"
while IFS= read -r entry; do export "$entry"; done <<< "$build_env"
node scripts/check-preflight-env.cjs
message="Edo Preflight ${TARGET:0:12} (${GITHUB_RUN_ID:?})"

resolve_runtime() {
  env -u EXPO_TOKEN -u ASC_API_KEY_P8 -u ASC_API_KEY_ID -u ASC_API_ISSUER_ID \
    pnpm exec expo-updates runtimeversion:resolve --platform ios --workflow managed \
    | jq -er '.runtimeVersion | select(test("^[0-9a-f]{40}$"))'
}

check_preview_profile() {
  eas env:pull preview --path "$work/preview.env" --non-interactive > "$work/preview.log"
  node scripts/check-preflight-env.cjs "$work/preview.env"
  test -z "$(git status --porcelain)"
}

read_submissions() {
  local offset=0 count
  : > "$work/submission-pages"
  while true; do
    eas submit:list --platform ios --limit 20 --offset "$offset" --json --non-interactive > "$work/page.json"
    jq -ec 'if type != "array" then error("Invalid EAS submissions") else
      map({platform,status,app:{id:.app.id},iosConfig:{ascAppIdentifier:.iosConfig.ascAppIdentifier},
           submittedBuild:{id:.submittedBuild.id}}) end' "$work/page.json" >> "$work/submission-pages"
    count="$(jq -er 'length' "$work/page.json")"
    if (( count < 20 )); then break; fi
    offset=$((offset + count))
  done
  jq -cs 'add' "$work/submission-pages" > "$work/submissions.json"
}

require_preflight_channel() {
  local allow_missing="$1" offset=0 count
  : > "$work/channel-pages"
  while true; do
    eas channel:list --limit 25 --offset "$offset" --json --non-interactive > "$work/page.json"
    jq -ec '.currentPage | if type != "array" then error("Invalid Expo channels") else
      map({name,isPaused,branchMapping,updateBranches:[.updateBranches[]|{id,name}]}) end' \
      "$work/page.json" >> "$work/channel-pages"
    count="$(jq -er '.currentPage | length' "$work/page.json")"
    if (( count < 25 )); then break; fi
    offset=$((offset + count))
  done
  jq -sec --arg allow_missing "$allow_missing" '
    add as $channels
    | [$channels[] | select(.name == "preflight")] as $selected
    | if ($selected | length) == 0 and $allow_missing == "true"
      then all($channels[]; all(.updateBranches[]; .name != "preflight"))
      elif ($selected | length) != 1 then false
      else $selected[0] as $channel
        | ($channel.branchMapping | fromjson) as $mapping
        | $mapping.data[0].branchId as $branch
        | $channel.isPaused == false and $mapping.version == 0 and ($mapping.data | length) == 1
          and $mapping.data[0].branchMappingLogic == "true" and ($branch | type) == "string"
          and $channel.updateBranches == [{id:$branch,name:"preflight"}]
          and all($channels[] | select(.name != "preflight");
            (.branchMapping | fromjson | .data | all(.branchId != $branch)))
      end
    | if . == true then true else error("Edo Preflight needs its own active Expo branch") end
  ' "$work/channel-pages" > /dev/null
}

plan() {
  jq -n --arg revision "$TARGET" --arg runtime "$runtime" --arg message "$message" --arg force "${FORCE_BUILD:-false}" \
    --slurpfile builds "$work/builds.json" --slurpfile submissions "$work/submissions.json" \
    --slurpfile testflight "$work/testflight.json" --slurpfile trusted "$work/trusted.json" \
    '{revision:$revision,runtime:$runtime,message:$message,forceBuild:($force=="true"),
      builds:$builds[0],submissions:$submissions[0],testFlight:$testflight[0],nativeBuildIds:$trusted[0]}' \
    | node scripts/preflight-plan.mts > "$work/plan.json"
}

read_exact_build() {
  local build_id="$1"
  [[ "$build_id" =~ ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$ ]]
  eas build:view "$build_id" --json > "$work/build.json"
  jq -ec --arg id "$build_id" --arg revision "$TARGET" --arg runtime "$runtime" '
    if .id == $id and .gitCommitHash == $revision and .buildProfile == "preflight" and .runtime.version == $runtime
    then [.] else error("EAS build does not match the approved revision and Preflight runtime") end
  ' \
    "$work/build.json" > "$work/builds.json"
}

wait_for_build() {
  local build_id="$1" deadline=$((SECONDS + 5400))
  while true; do
    require_current_main
    read_exact_build "$build_id"
    case "$(jq -er '.status' "$work/build.json")" in
      FINISHED) return ;;
      NEW|IN_QUEUE|IN_PROGRESS) ;;
      *) echo "The exact EAS iOS build did not complete successfully." >&2; return 1 ;;
    esac
    (( SECONDS < deadline ))
    sleep 20
  done
}

read_runtime_evidence() {
  printf '%s' "${TESTFLIGHT_EVIDENCE:?Fresh TestFlight evidence is required.}" > "$work/testflight.json"
  check_preview_profile
  runtime="$(resolve_runtime)"
  eas build:list --platform ios --channel preflight --runtime-version "$runtime" \
    --app-identifier studio.lightwork.edo --distribution store --limit 50 --json --non-interactive > "$work/builds.json"
  read_submissions
}

if [[ "$1" == ota ]]; then
  : "${PREFLIGHT_OTA_DIR:?The exported iOS bundle is required.}"
  test -s "$PREFLIGHT_OTA_DIR/metadata.json"
  printf '[]\n' > "$work/trusted.json"
  read_runtime_evidence
  test "$runtime" = "$PREFLIGHT_OTA_RUNTIME"
  require_preflight_channel false
  require_current_main
  plan
  test "$(jq -er '.action' "$work/plan.json")" = ota
  require_current_main
  eas update --branch preflight --platform ios --environment preview \
    --skip-bundler --input-dir "$PREFLIGHT_OTA_DIR" --message "$message" --non-interactive
  printf '%s\n' "$message published an iOS OTA update for $runtime." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

if [[ "$1" == expo ]]; then
  cp "${PREFLIGHT_TRUSTED_FILE:?Verified native handoffs are required.}" "$work/trusted.json"
  read_runtime_evidence
  plan
  action="$(jq -er '.action' "$work/plan.json")"
  new_archive=false
  case "$action" in
    ota)
      : "${PREFLIGHT_OTA_DIR:?The iOS export destination is required.}"
      env -u EXPO_TOKEN pnpm exec expo export --platform ios --dump-sourcemap --output-dir "$PREFLIGHT_OTA_DIR"
      printf 'action=ota\nruntime=%s\n' "$runtime" >> "$GITHUB_OUTPUT"
      exit 0
      ;;
    build)
      check_preview_profile
      require_preflight_channel true
      require_current_main
      eas build --platform ios --profile preflight --non-interactive --freeze-credentials \
        --no-wait --json --message "$message" > "$work/created.json"
      build_id="$(jq -er 'if length == 1 then .[0].id else error("Expected one EAS build") end' "$work/created.json")"
      new_archive=true
      ;;
    wait-for-build|submit|verify-delivery)
      build_id="$(jq -er '.buildId' "$work/plan.json")"
      ;;
    *) echo "Unrecognized Preflight release plan." >&2; exit 1 ;;
  esac
  [[ "$build_id" =~ ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$ ]]
  native="$(jq -nc --arg id "$build_id" --arg revision "$TARGET" --arg runtime "$runtime" \
    '{id:$id,revision:$revision,runtime:$runtime}')"
  if [[ "$new_archive" == true ]]; then
    : "${PREFLIGHT_NATIVE_FILE:?The attested build destination is required.}"
    printf '%s\n' "$native" > "$PREFLIGHT_NATIVE_FILE"
  fi
  printf 'action=native\nnew_archive=%s\nnative=%s\n' "$new_archive" "$native" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ "$1" == await ]]; then
  test "$(jq -er '.revision' <<< "$PREFLIGHT_NATIVE")" = "$TARGET"
  runtime="$(resolve_runtime)"
  test "$(jq -er '.runtime' <<< "$PREFLIGHT_NATIVE")" = "$runtime"
  build_id="$(jq -er '.id' <<< "$PREFLIGHT_NATIVE")"
  wait_for_build "$build_id"
  require_current_main
  build="$(jq -ec --arg runtime "$runtime" --arg revision "$TARGET" '{
    id,runtime:$runtime,revision:$revision,marketingVersion:.appVersion,buildNumber:.appBuildVersion
  }' "$work/build.json")"
  printf 'action=submit\nbuild=%s\n' "$build" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ "$1" != submit ]]; then
  echo "Expected a supported Preflight stage." >&2
  exit 1
fi
# This fresh runner never executes commands with Expo preview environment variables.
runtime="$(jq -er '.runtime | select(test("^[0-9a-f]{40}$"))' <<< "$PREFLIGHT_BUILD")"
test "$(jq -er '.revision' <<< "$PREFLIGHT_BUILD")" = "$TARGET"
test "$(resolve_runtime)" = "$runtime"
build_id="$(jq -er '.id' <<< "$PREFLIGHT_BUILD")"
printf '%s\n' "$(jq -nc --arg id "$build_id" '[$id]')" > "$work/trusted.json"
read_exact_build "$build_id"
jq -e \
  --arg version "$(jq -er '.marketingVersion' <<< "$PREFLIGHT_BUILD")" \
  --arg number "$(jq -er '.buildNumber' <<< "$PREFLIGHT_BUILD")" \
  '.status == "FINISHED" and .appVersion == $version and .appBuildVersion == $number' "$work/build.json" >/dev/null
require_preflight_channel false
did_submit=false
deadline=$((SECONDS + 1500))
while true; do
  node scripts/preflight-apple.mts > "$work/testflight.json"
  read_submissions
  plan
  action="$(jq -er '.action' "$work/plan.json")"
  if [[ "$action" == ota ]]; then
    printf 'Edo iOS build %s is available in internal TestFlight.\n' \
      "$(jq -er '.buildNumber' "$work/plan.json")" >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  if [[ "$action" == submit && "$did_submit" == false ]]; then
    require_current_main
    export ASC_API_KEY_PATH="$work/app-store-connect.p8"
    node -e 'require("node:fs").writeFileSync(process.env.ASC_API_KEY_PATH,
      process.env.ASC_API_KEY_P8.replaceAll("\\n", "\n").trim() + "\n", {mode:0o600})'
    eas submit --platform ios --profile preflight --id "$build_id" --wait \
      --no-auto-testflight-setup --non-interactive
    rm -f -- "$ASC_API_KEY_PATH"
    unset ASC_API_KEY_PATH
    did_submit=true
  elif [[ "$action" != verify-delivery && "$action" != submit ]]; then
    echo "The exact EAS build is no longer eligible for TestFlight submission." >&2
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    echo "The approved build has not appeared in Edo's internal TestFlight group." >&2
    exit 1
  fi
  sleep 30
done
