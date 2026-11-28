# Edo iOS Preflight releases

The current `main` revision becomes eligible after its own successful CI push run. The
`edo-preflight` GitHub environment permits deployments from `main` and controls publishing with
`EDO_PREFLIGHT_ENABLED`. **Edo Preflight** also supports manual dispatch against the current
checked revision. Use **force_build** to request a new native archive.

- A runtime qualifies for OTA when Expo reports a completed iOS store build and its exact
  successful submission, and fresh App Store Connect data reports the same version and build
  active in the internal **Archive Restore** group. Expo delivers the compatible bundle
  through the `preflight` channel. The channel uses its own Expo update branch.
- A runtime without a delivered binary uses the signed Expo build path. The runner can follow
  an existing build for that runtime. A fresh runner checks and submits the finished build by ID
  to the internal TestFlight group. It waits for Apple to make the binary available.
- The Expo preparation runner holds the Expo token. The read-only TestFlight runner holds the
  App Store Connect key. The submission runner uses the key with the standalone EAS submission
  command. It uses the committed app configuration without loading Expo preview variables.

The native worker pins Node 24.22.3 and pnpm 10.21.0. Declare Edo's public app variables in the
Preflight build profile so the native and OTA bundles share the same configuration. The Expo
runner checks readable preview variables as data and does not load them into its shell. Keep the
internal TestFlight group and its scope stable. Expo manages the iOS signing certificate and
profile. TestFlight version 0.1.0 build 1 predates Expo Update. Install the first automated
Preflight binary to receive subsequent updates.

## Retry and rollback

For a failed build, start a new run on the current checked revision. If the archive exists and
submission failed, the workflow reuses that exact archive and checks existing submission status
and Apple processing before retrying. If Apple has the binary and the internal group still
cannot see it, inspect the exact version and build in App Store Connect.

To roll back an OTA, set `EDO_PREFLIGHT_ENABLED` to `false`. Wait for active publishing runs to
finish or cancel them, and check whether EAS still has a build or submission in progress.
Republish the previous compatible update only after pending publishing work has stopped. Enable
the workflow again when a checked revision is ready.
