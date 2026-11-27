# Local food catalog preview

Start the loopback development server with the directory used by the catalog importer.

```sh
EDO_CATALOG_ROOT=/absolute/path/catalogs pnpm dev:sync
```

Use `http://127.0.0.1:8787/catalog-preview/bls` for Bundeslebensmittelschlüssel (BLS) and
`http://127.0.0.1:8787/catalog-preview/open-food-facts` for Open Food Facts. Each serves files from
its own provider directory under the configured catalog root.

- `GET /active.json` returns the latest activation manifest after checking that it matches its
  immutable release manifest.
- `GET /releases/<sha256>.json` and `GET /artifacts/<sha256>.sqlite` serve digest-named
  released files. Both accept `HEAD` and use the digest as the ETag.
- `GET /barcodes/<code>` is available under Open Food Facts. It returns candidate products in
  JSON with their original barcodes, release and available nutrition. Set `EDO_LIVE_OPEN_FOOD_FACTS=1`
  to try the rate-limited provider lookup when the local catalog has no match.

The preview credits Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0.
BLS responses link to the dataset and its license. [Dataset DOI](https://doi.org/10.25826/Data20251217-134202-0) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Open Food Facts responses credit Open Food Facts contributors and link to their license.
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

These preview routes serve public catalog data on the loopback development server.
