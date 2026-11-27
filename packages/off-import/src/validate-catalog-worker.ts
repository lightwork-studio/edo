import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
import type { CatalogManifest } from "@edo/catalog-import";
import { barcodeRows, readProduct } from "./catalog-row.ts";
import { normalizeLookupCode } from "./format.ts";
import { matchesOpenFoodFactsDatabase } from "./publish.ts";

const { path, manifest } = workerData as { path: string; manifest: CatalogManifest };
using database = new DatabaseSync(path, { readOnly: true });
if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
  throw new Error("Open Food Facts catalog must be a standalone SQLite file");
}
if (!matchesOpenFoodFactsDatabase(database, manifest)) {
  throw new Error("Open Food Facts catalog metadata does not match its manifest");
}
if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
  throw new Error("Open Food Facts catalog failed SQLite integrity verification");
}

let rows = 0;
for (const row of database.prepare(barcodeRows).iterate()) {
  const product = readProduct(row, manifest.source.release);
  const lookupCode = normalizeLookupCode(product.barcode);
  if (!lookupCode || lookupCode !== row.lookup_code) {
    throw new Error("Invalid Open Food Facts barcode index");
  }
  rows += 1;
}
if (rows !== manifest.counts.accepted) {
  throw new Error("Open Food Facts catalog row count does not match its manifest");
}
