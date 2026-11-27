import { type CatalogManifest, publishCatalog } from "@edo/catalog-import";
import { blsSeedSchemaVersion, createBlsCatalogBuilder } from "./seed.ts";
import { blsAttribution } from "./workbook.ts";

const blsRelease = "4.0-2025";
const blsSourceSha256 = "12b7a6ba62807ec9b301eb276f897dc85f99b2292311618dec3749a12d984c91";
const blsFoodCount = 7140;

export async function validateBlsCatalogRelease(path: string, manifest: CatalogManifest) {
  if (
    manifest.provider !== "bls" ||
    manifest.schemaVersion !== blsSeedSchemaVersion ||
    manifest.source.release !== blsRelease ||
    manifest.source.sha256 !== blsSourceSha256 ||
    manifest.source.url !== blsAttribution.sourceUrl ||
    manifest.attribution.name !== blsAttribution.name ||
    manifest.attribution.license !== `${blsAttribution.license} (${blsAttribution.licenseUrl})` ||
    manifest.attribution.changes !== blsAttribution.changes ||
    manifest.counts.accepted !== blsFoodCount ||
    manifest.counts.rejected !== 0 ||
    (manifest.counts.skipped ?? 0) !== 0
  ) {
    throw new Error("Unsupported BLS catalog release");
  }
  await createBlsCatalogBuilder(blsRelease, blsSourceSha256).validate(path, {
    accepted: manifest.counts.accepted,
    rejected: manifest.counts.rejected,
    skipped: manifest.counts.skipped ?? 0,
  });
}

/** Publish the reviewed BLS release to the local catalog root. */
export async function publishBlsCatalog(inputPath: string, root: string) {
  const builder = createBlsCatalogBuilder(blsRelease, blsSourceSha256);
  return publishCatalog(
    {
      provider: "bls",
      schemaVersion: blsSeedSchemaVersion,
      importerVersion: "1",
      root,
      inputPath,
      source: { release: blsRelease, url: blsAttribution.sourceUrl },
      attribution: {
        name: blsAttribution.name,
        license: `${blsAttribution.license} (${blsAttribution.licenseUrl})`,
        changes: blsAttribution.changes,
      },
    },
    {
      ...builder,
      async validate(artifactPath, counts) {
        if (counts.accepted !== blsFoodCount) {
          throw new Error(
            `Expected ${blsFoodCount} foods in the BLS release, found ${counts.accepted}`,
          );
        }
        await builder.validate(artifactPath, counts);
      },
    },
  );
}
