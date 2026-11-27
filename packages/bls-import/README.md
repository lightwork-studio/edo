# BLS 4.0 catalog import

Download the German 2025 BLS 4.0 ZIP from the [Max Rubner-Institut](https://blsdb.de/download) and run:

```sh
pnpm --filter @edo/bls-import run import /absolute/path/to/BLS_4_0_2025_DE.zip /absolute/catalog-root
```

The importer verifies the reviewed archive checksum and requires 7,140 foods. A successful import publishes a standalone SQLite file in `bls/artifacts` and its manifest in `bls/active.json` under the catalog root.

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

## Attribution

Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0. [Dataset DOI](https://doi.org/10.25826/Data20251217-134202-0) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Edo selects the German and English names and five published nutrient values per food. Missing or
unquantified values become null. Edo uses preparation terms in the names and leaves unclear or
conflicting cases unknown.
