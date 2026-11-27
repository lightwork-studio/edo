import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { type CatalogManifest, compatibleCatalog } from "@edo/catalog-import";
import {
  type FoodNutrition,
  type MeasuredPortion,
  type PackagedFood,
  sanitizePackagedNutrition,
} from "@edo/core";
import { normalizeLookupCode } from "./format.ts";
import { createOpenFoodFactsLiveLookup, type LiveBarcodeResult } from "./live-lookup.ts";

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

function requiredText(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string" || value === "") throw new Error("Invalid packaged-food text");
  return value;
}

function nutrient(value: SQLOutputValue | undefined): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid packaged-food nutrient");
  }
  return value;
}

function nutritionForRow(row: Record<string, SQLOutputValue>): FoodNutrition | null {
  const basis = row.nutrition_basis;
  if (basis === null) return null;
  if (basis !== "per-100-g" && basis !== "per-100-ml" && basis !== "per-portion") {
    throw new Error("Unknown packaged-food nutrition basis");
  }
  const amount = row.portion_amount;
  const unit = row.portion_unit;
  const portionSize: MeasuredPortion | undefined =
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    (unit === "g" || unit === "ml")
      ? { amount, unit }
      : undefined;
  return sanitizePackagedNutrition({
    basis,
    nutrients: {
      kcal: nutrient(row.kcal),
      proteinG: nutrient(row.protein_g),
      availableCarbohydratesG: nutrient(row.available_carbohydrates_g),
      fatG: nutrient(row.fat_g),
      fiberG: nutrient(row.fiber_g),
    },
    ...(portionSize && { portionSize }),
  });
}

function readProduct(row: Record<string, SQLOutputValue>, release: string): BarcodeProduct {
  const { preparation, alternate_name: alternateName } = row;
  if (preparation !== "as-sold" && preparation !== "prepared" && preparation !== "unknown") {
    throw new Error("Invalid packaged-food preparation");
  }
  return {
    id: { provider: "open-food-facts", sourceId: requiredText(row.source_id) },
    release,
    barcode: requiredText(row.code),
    name: requiredText(row.name),
    alternateName: alternateName === null ? null : requiredText(alternateName),
    preparation,
    nutrition: nutritionForRow(row),
  };
}

type ActiveManifest = { manifest: CatalogManifest; text: Buffer; sha256: string };

async function readActiveManifest(providerRoot: string): Promise<ActiveManifest | null> {
  let text: Buffer;
  try {
    text = await readFile(join(providerRoot, "active.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const active = compatibleCatalog(JSON.parse(text.toString("utf8")), "open-food-facts", [1]);
  if (active?.attribution.license !== "ODbL-1.0") {
    throw new Error("Unsupported Open Food Facts catalog manifest");
  }
  return { manifest: active, text, sha256: createHash("sha256").update(text).digest("hex") };
}

async function openVerifiedCatalog(
  providerRoot: string,
  { manifest, text, sha256 }: ActiveManifest,
): Promise<OpenFoodFactsReader> {
  const immutableManifest = await readFile(join(providerRoot, "releases", `${sha256}.json`));
  if (!immutableManifest.equals(text))
    throw new Error("Open Food Facts release manifest does not match activation");
  const file = join(providerRoot, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  if (bytes !== manifest.artifact.bytes || hash.digest("hex") !== manifest.artifact.sha256) {
    throw new Error("Open Food Facts catalog does not match its checksum");
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const release = manifest.source.release;
    const meta = db.prepare("SELECT provider, release FROM catalog_metadata").get();
    const schema = db.prepare("PRAGMA user_version").get();
    if (
      meta?.provider !== "open-food-facts" ||
      meta.release !== release ||
      schema?.user_version !== manifest.schemaVersion
    ) {
      throw new Error("Open Food Facts catalog metadata does not match its manifest");
    }
    const lookup = db.prepare(`
      SELECT food.*, barcode.code
      FROM barcode JOIN food USING (source_id)
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
      [Symbol.dispose]: () => db[Symbol.dispose](),
    };
  } catch (error) {
    db[Symbol.dispose]();
    throw error;
  }
}

/** Verify the active release once and keep its immutable catalog open for repeated lookups. */
export async function openOpenFoodFactsCatalog(root: string): Promise<OpenFoodFactsReader | null> {
  const providerRoot = join(root, "open-food-facts");
  const manifest = await readActiveManifest(providerRoot);
  return manifest ? openVerifiedCatalog(providerRoot, manifest) : null;
}

/** Use one instance per server. A verified catalog is reused until an active release changes. */
export function createBarcodeLookup(
  root: string,
  options: BarcodeLookupOptions = {},
): BarcodeLookup {
  const providerRoot = join(root, "open-food-facts");
  const { liveLookup = createOpenFoodFactsLiveLookup(), now = Date.now } = options;
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
      next = await openVerifiedCatalog(providerRoot, manifest);
    } catch {
      rejected = { manifest: candidate, retryAt: now() + retryAfterCatalogFailureMs };
      return;
    }
    if (closed) {
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
      await refresh;
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
      reader?.[Symbol.dispose]();
      reader = null;
      current = null;
    },
  };
}
