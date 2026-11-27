# Edo

Edo is an open source calorie tracker in development for iPhone and Android. The planned app
supports local tracking, managed or self-hosted sync, speech and photo logging, and MCP access.

The Expo app includes a private offline diary and the bundled BLS catalog. The local Node preview
serves validated BLS and German-market Open Food Facts releases.

## Run locally

With Node.js 24 and pnpm 10.21.0 installed:

```sh
pnpm install --frozen-lockfile
pnpm dev:app
```

Run `pnpm dev:sync` to start the Node server at `http://127.0.0.1:8787/health`.
Run `pnpm check` for lint, types and tests, and `pnpm check:builds` for the iOS and Android bundles.

In Add Food, the barcode flow searches the local product cache first. To enable online lookup in
a mobile build, set `EXPO_PUBLIC_EDO_CATALOG_ORIGIN` to the bare HTTPS origin of a service that
exposes the [catalog preview routes](apps/sync-node/README.md). The preview starts on loopback,
so a device needs a reachable HTTPS endpoint. The app sends the scanned barcode to that endpoint.

See the [design gallery](docs/design/index.html), [contributing guide](CONTRIBUTING.md)
and [license map](LICENSE.md).
