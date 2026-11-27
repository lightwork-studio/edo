# Edo development server

Publish the reviewed BLS catalog to a local folder, then start the loopback preview.

```sh
EDO_CATALOG_ROOT=/absolute/path/catalogs pnpm dev:sync
```

Use `http://127.0.0.1:8787/catalog-preview/bls/active.json` for the current release.
Download the immutable manifest through `releases/<manifest-sha256>.json` and the SQLite
file through `artifacts/<artifact-sha256>.sqlite` at the same prefix. Immutable paths
require prior activation. The response carries the BLS license and source attribution.

The preview is intended for local catalog verification. Keep the configured catalog folder
under control of the catalog publisher and leave the default loopback binding in place.
