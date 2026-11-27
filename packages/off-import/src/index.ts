import type { CatalogManifest } from "@edo/catalog-import";
import { type OpenFoodFactsImport, publishOpenFoodFactsRelease } from "./publish.ts";
import { runCatalogJob } from "./worker.ts";

export { normalizeLookupCode } from "./format.ts";
export * from "./live-lookup.ts";
export * from "./lookup.ts";
export {
  compatibleOpenFoodFactsManifest,
  type OpenFoodFactsImport,
  openFoodFactsCatalog,
} from "./publish.ts";

export function publishOpenFoodFactsCatalog(input: OpenFoodFactsImport): Promise<CatalogManifest> {
  return runCatalogJob(input.root, () => publishOpenFoodFactsRelease(input));
}
