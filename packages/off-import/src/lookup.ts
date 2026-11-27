import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CatalogManifest } from "@edo/catalog-import";
import type { PackagedFood } from "@edo/core";
import { barcodeRows, readProduct } from "./catalog-row.ts";
import {
  copyVerifiedCatalog,
  readCatalogManifestFile,
  validateCatalogSnapshot,
} from "./catalog-snapshot.ts";
import { normalizeLookupCode } from "./format.ts";
import { createOpenFoodFactsLiveLookup, type LiveBarcodeResult } from "./live-lookup.ts";
import { compatibleOpenFoodFactsManifest } from "./publish.ts";

export type BarcodeProduct = PackagedFood;

type ReadonlyCatalogManifest = {
  readonly [Field in keyof CatalogManifest]: Readonly<CatalogManifest[Field]>;
};

export interface OpenFoodFactsReader extends Disposable {
  readonly manifest: ReadonlyCatalogManifest;
  readonly releaseManifestSha256: string;
  lookupBarcode(barcode: string): BarcodeProduct[];
}

export type BarcodeLookupResult =
  | ({
      readonly status: "found";
      readonly products: readonly BarcodeProduct[];
      readonly checkedAt: number;
    } & (
      | { readonly source: "catalog"; readonly releaseManifestSha256: string }
      | { readonly source: "live" }
    ))
  | Exclude<LiveBarcodeResult, { status: "found" }>;

export interface BarcodeLookup extends Disposable {
  lookupBarcode(barcode: string): Promise<BarcodeLookupResult>;
}

export interface BarcodeLookupOptions {
  /** Pass null to use only verified catalogs. */
  readonly liveLookup?: ReturnType<typeof createOpenFoodFactsLiveLookup> | null;
  readonly now?: () => number;
}

const retryAfterCatalogFailureMs = 30_000;

type ActiveManifest = { manifest: CatalogManifest; text: Buffer; sha256: string };

async function readActiveManifest(providerRoot: string): Promise<ActiveManifest | null> {
  let text: Buffer;
  try {
    if (!(await lstat(providerRoot)).isDirectory()) {
      throw new Error("Open Food Facts provider must be a real directory");
    }
    text = await readCatalogManifestFile(join(providerRoot, "active.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const decoded = text.toString("utf8");
  if (!Buffer.from(decoded).equals(text)) throw new Error("Invalid Open Food Facts manifest UTF-8");
  const active = compatibleOpenFoodFactsManifest(JSON.parse(decoded));
  if (!active) {
    throw new Error("Unsupported Open Food Facts catalog manifest");
  }
  return { manifest: active, text, sha256: createHash("sha256").update(text).digest("hex") };
}

async function openVerifiedCatalog(
  providerRoot: string,
  { manifest, text, sha256 }: ActiveManifest,
  signal?: AbortSignal,
): Promise<OpenFoodFactsReader> {
  const releaseDirectory = join(providerRoot, "releases");
  const artifactDirectory = join(providerRoot, "artifacts");
  for (const directory of [releaseDirectory, artifactDirectory]) {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error("Open Food Facts catalog paths must be real directories");
    }
  }
  const releasePath = join(releaseDirectory, `${sha256}.json`);
  const immutableManifest = await readCatalogManifestFile(releasePath);
  if (!immutableManifest.equals(text))
    throw new Error("Open Food Facts release manifest does not match activation");

  const source = join(artifactDirectory, `${manifest.artifact.sha256}.sqlite`);
  const scratch = await mkdtemp(join(tmpdir(), "edo-off-reader-"));
  const snapshot = join(scratch, "catalog.sqlite");
  let database: DatabaseSync | undefined;
  try {
    await copyVerifiedCatalog(source, snapshot, manifest.artifact, signal);
    await validateCatalogSnapshot(snapshot, manifest, signal);
    signal?.throwIfAborted();
    const db = new DatabaseSync(snapshot, { readOnly: true });
    database = db;
    const release = manifest.source.release;
    const lookup = db.prepare(`
      ${barcodeRows}
      WHERE barcode.lookup_code = ?
      ORDER BY (barcode.code = ?) DESC, food.source_id
    `);
    const verifiedManifest = Object.freeze({
      ...manifest,
      source: Object.freeze(manifest.source),
      attribution: Object.freeze(manifest.attribution),
      artifact: Object.freeze(manifest.artifact),
      counts: Object.freeze(manifest.counts),
    });
    return {
      manifest: verifiedManifest,
      releaseManifestSha256: sha256,
      lookupBarcode(barcode) {
        const text = barcode.trim();
        const key = normalizeLookupCode(text);
        if (!key) return [];
        return lookup.all(key, text).map((row) => readProduct(row, release));
      },
      [Symbol.dispose]() {
        try {
          db[Symbol.dispose]();
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      database?.[Symbol.dispose]();
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/** Verify the active release once and keep its immutable catalog open for repeated lookups. */
export async function openOpenFoodFactsCatalog(root: string): Promise<OpenFoodFactsReader | null> {
  const providerRoot = join(root, "open-food-facts");
  const manifest = await readActiveManifest(providerRoot);
  return manifest ? openVerifiedCatalog(providerRoot, manifest) : null;
}

/** Use one instance per server. Keep serving the current verified catalog during an update. */
export function createBarcodeLookup(
  root: string,
  options: BarcodeLookupOptions = {},
): BarcodeLookup {
  const providerRoot = join(root, "open-food-facts");
  const { liveLookup = createOpenFoodFactsLiveLookup(), now = Date.now } = options;
  const stop = new AbortController();
  let reader: OpenFoodFactsReader | null = null;
  let current: string | null = null;
  let rejected: { manifest: string; retryAt: number } | null = null;
  let refresh: Promise<void> | null = null;
  let closed = false;

  async function adoptActiveRelease() {
    const manifest = await readActiveManifest(providerRoot);
    if (!manifest) return;
    const candidate = manifest.sha256;
    if (current === candidate || (rejected?.manifest === candidate && now() < rejected.retryAt)) {
      return;
    }
    let next: OpenFoodFactsReader;
    try {
      next = await openVerifiedCatalog(providerRoot, manifest, stop.signal);
    } catch {
      rejected = { manifest: candidate, retryAt: now() + retryAfterCatalogFailureMs };
      return;
    }
    const latest = await readActiveManifest(providerRoot).catch(() => null);
    if (closed || latest?.sha256 !== candidate) {
      next[Symbol.dispose]();
      return;
    }
    rejected = null;
    const previous = reader;
    reader = next;
    current = candidate;
    previous?.[Symbol.dispose]();
  }

  return {
    async lookupBarcode(barcode) {
      if (closed) return { status: "unavailable" };
      const code = barcode.trim();
      if (!normalizeLookupCode(code)) return { status: "invalid" };
      refresh ??= adoptActiveRelease()
        // An incomplete publication must not displace the previously verified release.
        .catch(() => undefined)
        .finally(() => {
          refresh = null;
        });
      if (!reader) await refresh;
      if (closed) return { status: "unavailable" };
      try {
        const products = reader?.lookupBarcode(code);
        if (reader && products?.length) {
          return {
            status: "found",
            source: "catalog",
            products,
            releaseManifestSha256: reader.releaseManifestSha256,
            checkedAt: now(),
          };
        }
      } catch {
        reader?.[Symbol.dispose]();
        reader = null;
        current = null;
      }
      if (!liveLookup) return { status: reader ? "not-found" : "unavailable" };
      try {
        const product = await liveLookup(code);
        if (closed) return { status: "unavailable" };
        if (product.status !== "found") return product;
        return {
          status: "found",
          source: "live",
          products: [product.product],
          checkedAt: product.checkedAt,
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    [Symbol.dispose]() {
      closed = true;
      stop.abort();
      reader?.[Symbol.dispose]();
      reader = null;
      current = null;
    },
  };
}
