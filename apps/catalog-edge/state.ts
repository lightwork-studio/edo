export const checksum = /^[a-f0-9]{64}$/;
export const maxStateBytes = 1024 * 1024;
export const maxManifestBytes = 256 * 1024;

export interface CatalogState {
  active: string;
  releases: Record<string, string>;
}

export function readCatalogState(value: unknown): CatalogState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid catalog publication state");
  }
  const { active, releases } = value as Record<string, unknown>;
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
  return { active, releases: releases as Record<string, string> };
}
