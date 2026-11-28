#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${GITHUB_ACTIONS:-}" != true || "${GITHUB_REPOSITORY:-}" != lightwork-studio/edo ]]; then
  echo "Edo Preflight publishes from its protected GitHub Actions workflow." >&2
  exit 1
fi
: "${TARGET:?The verified main commit is required.}"
: "${EXPO_TOKEN:?Set EXPO_TOKEN in the edo-preflight environment.}"
head="$(git rev-parse HEAD)"
changes="$(git status --porcelain)"
if [[ "$head" != "$TARGET" || -n "$changes" ]]; then
  echo "The release checkout must match the clean, verified main revision." >&2
  exit 1
fi

eas() { npx --yes eas-cli@27.11.0 "$@"; }

require_current_main() {
  local remote
  remote="$(git ls-remote --exit-code origin refs/heads/main)"
  if [[ "${remote%%$'\t'*}" != "$TARGET" ]]; then
    echo "A newer main revision is available. Skipping this release."
    exit 0
  fi
}

report() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

require_current_main
build_env="$(node -e '
  const { env } = require("./eas.json").build.preflight;
  for (const [name, value] of Object.entries(env)) console.log(name + "=" + value);
')"
while IFS= read -r entry; do
  export "$entry"
done <<< "$build_env"
export EXPO_NO_DOTENV=1

runtime="$(eas env:exec preview \
  'pnpm exec expo-updates runtimeversion:resolve --platform ios --workflow managed' \
  --non-interactive |
  node -e '
    const output = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!/^[a-f0-9]{40}$/.test(output.runtimeVersion ?? "")) throw new Error("Invalid runtime fingerprint");
    console.log(output.runtimeVersion);
  ')"
message="Edo Preflight ${TARGET:0:12}"
echo "$message uses iOS runtime $runtime."

compatible=false
if [[ "${FORCE_BUILD:-false}" != true ]]; then
  compatible="$(eas build:list --platform ios --channel preflight --runtime-version "$runtime" \
    --app-identifier studio.lightwork.edo --distribution store --limit 50 --json --non-interactive |
    PREFLIGHT_RUNTIME="$runtime" node -e '
      const builds = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const usable = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "FINISHED"]);
      console.log(builds.some((build) =>
        build.appIdentifier === "studio.lightwork.edo" &&
        build.runtimeVersion === process.env.PREFLIGHT_RUNTIME &&
        build.channel === "preflight" &&
        build.distribution === "STORE" &&
        usable.has(build.status)
      ));
    ')"
fi

require_current_main
if [[ "$compatible" == true ]]; then
  eas update --channel preflight --platform ios --environment preview \
    --message "$message" --non-interactive
  report "$message published an OTA update for $runtime."
  exit 0
fi

: "${ASC_API_KEY_PATH:?A native build needs the App Store Connect key.}"
: "${ASC_API_KEY_ID:?A native build needs the App Store Connect key ID.}"
: "${ASC_API_ISSUER_ID:?A native build needs the App Store Connect issuer ID.}"
if [[ ! -s "$ASC_API_KEY_PATH" ]]; then
  echo "The App Store Connect key file is empty or missing." >&2
  exit 1
fi

eas build --platform ios --profile preflight --auto-submit-with-profile preflight \
  --non-interactive --freeze-credentials --no-wait --message "$message"
report "$message queued an iOS build and TestFlight submission for $runtime."
