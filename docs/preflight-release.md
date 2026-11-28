# Edo iOS Preflight releases

The current `main` revision becomes eligible after its own successful CI push run. The
`edo-preflight` GitHub environment permits deployments from `main` and controls publishing with
`EDO_PREFLIGHT_ENABLED`. **Edo Preflight** also supports manual dispatch against the current
checked revision. Use **force_build** to request a new native archive.

- A runtime qualifies for OTA when Expo reports a completed iOS store build and its exact
  successful submission, and fresh App Store Connect data reports the same version and build
  active in the internal **Archive Restore** group. A separate job refreshes that evidence
  after export. The publish job requires a snapshot no more than five minutes old and sends the
  bundle directly to the dedicated `preflight` branch.
- A runtime without a delivered binary uses the signed Expo build path. The runner can follow
  an existing build of that exact revision once its originating GitHub run recorded the archive.
  A fresh runner checks and submits the finished build by ID to the internal TestFlight group.
  It waits for Apple to make the binary available.
- The Expo preparation runner holds the Expo token. The read-only TestFlight runner holds the
  App Store Connect key. The submission runner uses the key with the standalone EAS submission
  command and the committed app configuration.

The native worker pins Node 24.22.3 and pnpm 10.21.0. Declare Edo's public app variables in the
Preflight build profile so the native and OTA bundles share the same configuration. The Expo
runner parses preview variables as data and requires that every value can be checked against the
profile. Keep the internal TestFlight group and its scope stable. Expo manages the iOS signing certificate and
profile. TestFlight version 0.1.0 build 1 predates Expo Update. Install the first automated
Preflight binary to receive subsequent updates.

## Retry and rollback

For a failed build, start a new run on the current checked revision. If the archive exists and
submission failed, the workflow reuses that exact archive and checks existing submission status
and Apple processing before retrying. Inspect the originating workflow if Expo has an archive
without a recorded handoff. An Apple processing rejection needs investigation before a new
`force_build` run. If Apple has the binary and either group access or the EAS receipt is missing,
inspect the exact version and archive in both services.

To roll back an OTA, set `EDO_PREFLIGHT_ENABLED` to `false`. Wait for active publishing runs to
finish or cancel them, and check whether EAS still has a build or submission in progress.
Republish the previous compatible update only after pending publishing work has stopped. Enable
the workflow again when a checked revision is ready.
