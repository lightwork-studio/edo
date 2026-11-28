# Edo development server

Publish the reviewed BLS catalog to a local folder, then start the loopback preview.

```sh
EDO_CATALOG_ROOT=/absolute/path/catalogs pnpm dev:sync
```

Use `http://127.0.0.1:8787/catalog-preview/bls/active.json` for the current release.
Download the immutable manifest through `releases/<manifest-sha256>.json` and the SQLite
file through `artifacts/<artifact-sha256>.sqlite` at the same prefix. Immutable paths
require prior activation. The response carries the BLS license and source attribution.

Open Food Facts files use the same manifest and artifact routes under
`/catalog-preview/open-food-facts`. The response links to the ODbL and the Open Food Facts data
page. `GET /catalog-preview/open-food-facts/barcodes/<code>` returns products from a verified
release with a link to the exact immutable manifest. A cold lookup waits while the first
catalog verifies. The reader keeps serving its current release while it verifies replacements.

Lookups use the local catalog by default. Set `EDO_LIVE_OPEN_FOOD_FACTS=1` to allow an explicit
live fallback for unknown barcodes. Keep the catalog folder under control of the catalog publisher
and leave the default loopback binding in place.

## Account sync candidate

For local integration tests, pass a sync store and an authenticator to `createHealthServer`.
The store requires a record projector. Pass `applyRecordContent` to `openSyncStore` to
validate diary records and preserve fields that a newer release wrote. The development
entry point serves health and the optional
catalog preview. Account sync becomes available when the caller supplies an authenticator.

Use `GET /health` for process liveness. `GET /ready` or `HEAD /ready` checks the configured
sync database's file identity, local write access and required SQLite schema. An exclusive SQLite
lock returns unavailable immediately. The response contains only the readiness status.

The server rechecks authorization after reading a request. After a restart, the device
negotiates again and can retry the same submission ID against its receipt in SQLite. An
accepted change advances the account revision. A pull returns the current records and
tombstones, so superseded revisions can leave gaps.
A favourite can be re-added under its existing provider and source ID after the client
has pulled the current deletion revision. Stale changes leave the deletion in place.

Requests can be up to 768 KiB and replies up to 1 MiB. A conflict can report a record ID
and revision with its content marked unavailable if the reply would otherwise exceed
the limit. The server retains each terminal receipt in its private database. Receipt
retention remains open for managed rollout.
