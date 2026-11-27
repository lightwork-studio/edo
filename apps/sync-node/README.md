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
