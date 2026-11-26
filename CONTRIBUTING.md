# Contributing to Edo

Fork this repository and open a focused pull request against `main`. Describe the change,
what you tested and how to recover if the change fails. Use synthetic data in tests and screenshots.
Contribute material you have permission to submit. Follow the [license map](LICENSE.md), preserve
notices, and identify third-party material and its license in the PR.

## Local setup

Use the Node.js version in `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:builds
```

`pnpm check` runs Biome, TypeScript and Vitest. `pnpm check:builds` exports the iOS and Android
JavaScript bundles. Use `pnpm dev:app` to start Metro and open the app with a compatible Expo Go
client or emulator. Use `pnpm dev:sync` to start the local Node development server.

## Where changes belong

- `apps/mobile` contains the Expo app and platform integrations.
- `apps/sync-node` contains the self-hosted server entry point.
- `packages/core` is for domain rules, `packages/contract` for the wire contract,
  `packages/storage` for persistence, and `packages/sync` for sync orchestration.
- [`docs/design`](docs/design/README.md) contains the approved UI references.

Read the [review and merge workflow](docs/review-and-merge.md) before submitting changes.
Changes to storage, sync, imports or MCP writes also follow the
[data compatibility standard](docs/data-compatibility.md). Report vulnerabilities using
[SECURITY.md](SECURITY.md).
