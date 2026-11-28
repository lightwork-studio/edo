# Edo Preflight releases

A successful CI run for the current main commit starts the iOS Preflight publishing workflow.
The release job checks out that exact revision and verifies that it is still at the tip of main
before publishing. Compatible updates export an iOS bundle before the final tip check.
The `edo-preflight` GitHub environment restricts deployments to main.

Edo uses the existing `@webertim/edo` Expo project, the `preflight` update channel and the
internal `Archive Restore` TestFlight group. When an iOS store build with the current native
fingerprint exists on that channel, the workflow publishes the JavaScript update over the air.
A new native fingerprint queues a signed build and an automatic TestFlight submission.
Expo assigns the iOS build number remotely. Version 0.1.0 build 1 predates Expo Update. Install
the next TestFlight binary to receive updates from the Preflight channel.
Keep the `preflight` update branch exclusive to that channel. In App Store Connect, keep
automatic distribution disabled for any internal testing group outside this release.

Declare Edo's public app variables in the Preflight build profile. The release checks that
the Expo `preview` environment agrees with the profile before resolving the runtime or
exporting a bundle.

The GitHub environment holds the Expo token and the App Store Connect key, key ID and issuer ID.
EAS manages the iOS signing certificate and provisioning profile. The workflow writes the
submission key into the runner's temporary directory for the release step.

Set the environment variable `EDO_PREFLIGHT_ENABLED` to `true` to enable publishing or
`false` to pause it. To build a replacement binary, run **Edo Preflight** on main with
**force_build** selected after CI passes. EAS reports build and submission progress separately.
For an OTA regression, pause publishing and republish the earlier compatible update from the
Preflight channel. If a build succeeded and its upload needs retrying, select that exact build
ID in EAS Submit and use the Preflight submission profile.
