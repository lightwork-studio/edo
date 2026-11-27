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

for (const table of ["food", "barcode"]) {
  const entry = database
    .prepare("SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(table);
  const keys = database.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0").all(table);
  if (entry?.type !== "table" || keys.length !== 1 || keys[0]?.name !== "source_id") {
    throw new Error("Unexpected Open Food Facts table structure");
  }
}
const foreignKeys = database.prepare("PRAGMA foreign_key_list('barcode')").all();
const lookupIndex = database.prepare("PRAGMA index_info('barcode_lookup')").all();
if (
  foreignKeys.length !== 1 ||
  foreignKeys[0]?.table !== "food" ||
  foreignKeys[0]?.from !== "source_id" ||
  foreignKeys[0]?.to !== "source_id" ||
  !database
    .prepare("PRAGMA index_list('barcode')")
    .all()
    .some((index) => index.name === "barcode_lookup") ||
  lookupIndex.length !== 1 ||
  lookupIndex[0]?.name !== "lookup_code"
) {
  throw new Error("Unexpected Open Food Facts barcode structure");
}

const { accepted } = manifest.counts;
const counts = database
  .prepare("SELECT (SELECT COUNT(*) FROM food) AS food, (SELECT COUNT(*) FROM barcode) AS barcode")
  .get();
if (counts?.food !== accepted || counts?.barcode !== accepted) {
  throw new Error("Open Food Facts catalog row count does not match its manifest");
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
if (rows !== accepted) {
  throw new Error("Open Food Facts barcode coverage does not match its food rows");
}
