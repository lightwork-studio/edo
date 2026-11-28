import { type CatalogManifest, compatibleCatalog } from "../../catalog-import/src/manifest.ts";

export const openFoodFactsCatalog = {
  provider: "open-food-facts",
  schemaVersion: 1,
  importerVersion: "2",
  deltaIndexUrl: "https://static.openfoodfacts.org/data/delta/index.txt",
  sourceUrl: "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
} as const;

export const openFoodFactsNotice = {
  name: "Open Food Facts contributors",
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  changes:
    "Selected German-market foods, preserved source IDs, indexed names and barcodes, and omitted nutrition values inconsistent with declared mass.",
};

export function compatibleOpenFoodFactsManifest(value: unknown): CatalogManifest | null {
  const { provider, schemaVersion, sourceUrl, deltaIndexUrl } = openFoodFactsCatalog;
  const manifest = compatibleCatalog(value, provider, [schemaVersion]);
  return manifest &&
    (manifest.source.url === sourceUrl || manifest.source.url === deltaIndexUrl) &&
    manifest.attribution.name === openFoodFactsNotice.name &&
    manifest.attribution.license === openFoodFactsNotice.license
    ? manifest
    : null;
}
