# Edo

Edo is an open source calorie tracker in development for iPhone and Android. The planned app
supports local tracking, managed or self-hosted sync, speech and photo logging, and MCP access.

This repository currently contains the Expo app placeholder, a local Node health-check server,
and the shared package layout.

## Run locally

With Node.js 24 and pnpm 10.21.0 installed:

```sh
pnpm install --frozen-lockfile
pnpm dev:app
```

Run `pnpm dev:sync` to start the Node server at `http://127.0.0.1:8787/health`.
Run `pnpm check` for lint, types and tests, and `pnpm check:builds` for the iOS and Android bundles.

See the [design gallery](docs/design/index.html), [contributing guide](CONTRIBUTING.md)
and [license map](LICENSE.md).
