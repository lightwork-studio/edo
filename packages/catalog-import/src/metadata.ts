import type { DatabaseSync } from "node:sqlite";
import type { CatalogManifest } from "./manifest.ts";

export function matchesCatalogDatabaseMetadata(
  database: DatabaseSync,
  manifest: CatalogManifest,
  licenseUrl: string,
): boolean {
  const rows = database
    .prepare(
      "SELECT provider, release, source_url, attribution, license_url, changes FROM catalog_metadata LIMIT 2",
    )
    .all();
  const [metadata] = rows;
  const schema = database.prepare("PRAGMA user_version").get();
  return (
    rows.length === 1 &&
    metadata?.provider === manifest.provider &&
    metadata.release === manifest.source.release &&
    metadata.source_url === manifest.source.url &&
    metadata.attribution === manifest.attribution.name &&
    metadata.changes === manifest.attribution.changes &&
    metadata.license_url === licenseUrl &&
    schema?.user_version === manifest.schemaVersion
  );
}
