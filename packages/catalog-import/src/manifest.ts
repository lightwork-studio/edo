export type CatalogProvider = "bls" | "open-food-facts";

export interface CatalogManifest {
  manifestVersion: 1;
  provider: CatalogProvider;
  schemaVersion: number;
  importerVersion: string;
  source: {
    release: string;
    url: string;
    sha256: string;
    lastModified?: string;
  };
  attribution: {
    name: string;
    license: string;
    changes: string;
  };
  artifact: {
    sha256: string;
    bytes: number;
  };
  counts: {
    accepted: number;
    rejected: number;
    skipped?: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isCatalogProvider(value: unknown): value is CatalogProvider {
  return value === "bls" || value === "open-food-facts";
}

export function isCatalogManifest(value: unknown): value is CatalogManifest {
  if (!isObject(value)) return false;

  const { source, attribution, artifact, counts } = value;
  return (
    value.manifestVersion === 1 &&
    isCatalogProvider(value.provider) &&
    isCount(value.schemaVersion, 1) &&
    isText(value.importerVersion) &&
    isObject(source) &&
    isText(source.release) &&
    isText(source.url) &&
    isDigest(source.sha256) &&
    (source.lastModified === undefined ||
      (typeof source.lastModified === "string" &&
        new Date(source.lastModified).toJSON() === source.lastModified)) &&
    isObject(attribution) &&
    isText(attribution.name) &&
    isText(attribution.license) &&
    isText(attribution.changes) &&
    isObject(artifact) &&
    isDigest(artifact.sha256) &&
    isCount(artifact.bytes, 1) &&
    isObject(counts) &&
    isCount(counts.accepted, 1) &&
    isCount(counts.rejected, 0) &&
    (counts.skipped === undefined || isCount(counts.skipped, 0))
  );
}

/** An unsupported or malformed update leaves the caller's installed catalog in use. */
export function compatibleCatalog(
  value: unknown,
  provider: CatalogProvider,
  supportedSchemas: readonly number[],
): CatalogManifest | null {
  if (
    !isCatalogManifest(value) ||
    value.provider !== provider ||
    !supportedSchemas.includes(value.schemaVersion)
  ) {
    return null;
  }
  return value;
}
