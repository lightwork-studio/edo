export const checksum = /^[a-f0-9]{64}$/;
export const maxStateBytes = 1024 * 1024;
export const maxManifestBytes = 256 * 1024;
export const maxBlsManifestBytes = 16 * 1024;
export const maxBlsArtifactBytes = 8 * 1024 * 1024;

export interface CatalogState {
  active: string;
  releases: Record<string, string>;
  barcodeIndexes?: Record<string, string>;
}

export function readCatalogState(value: unknown): CatalogState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid catalog publication state");
  }
  const { active, releases, barcodeIndexes } = value as Record<string, unknown>;
  if (
    typeof active !== "string" ||
    !checksum.test(active) ||
    !releases ||
    typeof releases !== "object" ||
    Array.isArray(releases) ||
    !Object.hasOwn(releases, active) ||
    !Object.entries(releases).every(
      ([release, artifact]) =>
        checksum.test(release) && typeof artifact === "string" && checksum.test(artifact),
    )
  ) {
    throw new Error("Invalid catalog publication state");
  }
  if (
    barcodeIndexes !== undefined &&
    (!barcodeIndexes ||
      typeof barcodeIndexes !== "object" ||
      Array.isArray(barcodeIndexes) ||
      !Object.entries(barcodeIndexes).every(
        ([release, index]) =>
          Object.hasOwn(releases, release) && typeof index === "string" && checksum.test(index),
      ))
  ) {
    throw new Error("Invalid catalog barcode index registration");
  }
  return {
    active,
    releases: releases as Record<string, string>,
    ...(barcodeIndexes && { barcodeIndexes: barcodeIndexes as Record<string, string> }),
  };
}
