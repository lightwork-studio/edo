# BLS 4.0 catalog import

Download the German 2025 BLS 4.0 ZIP from the [Max Rubner-Institut](https://blsdb.de/download) and run:

```sh
pnpm --filter @edo/bls-import run import /absolute/path/to/BLS_4_0_2025_DE.zip /absolute/catalog-root
```

The importer verifies the reviewed archive checksum and requires 7,140 foods. A successful import publishes a standalone SQLite file in `bls/artifacts` and its manifest in `bls/active.json` under the catalog root.

Run **Rebuild reviewed BLS catalog** on `main` in GitHub Actions to replay the
pinned download with the toolchain used for the mobile seed. A successful run
matches the bundled SQLite file byte for byte and uploads the validated
`bls-4.0-reviewed` artifact with its manifest and attribution. Use the normal
catalog review and publication steps when adopting a new publisher release.

The [mobile seed](../../apps/mobile/assets/bls.sqlite) comes from the pinned release. Its
SHA-256 is `de019d3c43f8836e678d6eb32584ba1280fc2b0fe9c2ee6fb033af73c17cdf05`.
The seed was generated with Node.js 24.22.3 and SQLite 3.54.1.

The revision, source and attribution are available in `catalog_metadata`. `food` contains the source ID, German `name`, English `alternate_name` and nutrients per 100 g edible portion. Open the file read-only and search both names with `food_search`:

```sql
SELECT food.*
FROM food_search
JOIN food ON food.rowid = food_search.rowid
WHERE food_search MATCH ?
ORDER BY rank, food.source_id
LIMIT ?;
```

## Handset preview

For a development build, set `EXPO_PUBLIC_EDO_BLS_PREVIEW_ORIGIN` to the HTTPS origin
serving `/catalog-preview/bls`, and set `EXPO_PUBLIC_EDO_BLS_PREVIEW_SHA256` to the exact
SQLite digest from the reviewed published manifest. The development server itself listens
on loopback. A physical device needs an HTTPS route that preserves the uncompressed
response body and its `Content-Length`.

Search opens the bundled catalog immediately when the approved preview is absent or damaged.
The refresh runs in the background. Restart the app to use a successfully downloaded copy.
The preview cache holds public catalog data and can be reclaimed by the device.

## Attribution

Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0. [Dataset DOI](https://doi.org/10.25826/Data20251217-134202-0) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Edo selects the German and English names and five published nutrient values per food. Missing or
unquantified values become null. Edo uses preparation terms in the names and leaves unclear or
conflicting cases unknown.
