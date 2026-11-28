import {
  decodePackagedFood,
  type Food,
  normalizeOpenFoodFactsBarcode,
  type PackagedFood,
} from "@edo/core";
import type { DiaryStore, MyFoodsStore, PackagedFoodCache } from "@edo/storage";
import { addDays } from "./diary-view";

export type BarcodeResult =
  | { status: "found"; products: readonly PackagedFood[]; cached: boolean }
  | { status: "invalid" | "not-found" | "unavailable" | "rate-limited" };

type CatalogResult =
  | { status: "found"; products: readonly PackagedFood[]; complete: boolean }
  | Exclude<BarcodeResult, { status: "found" }>;

export const openFoodFactsLicenseUrl = "https://opendatacommons.org/licenses/odbl/1-0/";

const freshnessMs = 7 * 24 * 60 * 60 * 1000;
const lookupTimeoutMs = 5000;
const maxBarcodeLength = 64;
const maxResponseBytes = 256 * 1024;
const previewPath = "/catalog-preview/open-food-facts/barcodes/";
const recentDays = 30;

function isFresh(checkedAt: number, now: number): boolean {
  return checkedAt <= now && now - checkedAt < freshnessMs;
}

/** Expand camera-identified UPC-E using GS1 General Specifications §5.2.2.4.2. */
export function expandUpcE(code: string): string | null {
  if (!/^0[0-9]{7}$/.test(code)) return null;
  const marker = code[6];
  const prefix = code.slice(0, 3);
  const checkDigit = code.slice(7);
  let expanded: string;
  if (marker === "0" || marker === "1" || marker === "2") {
    expanded = `${prefix}${marker}0000${code.slice(3, 6)}${checkDigit}`;
  } else if (marker === "3") {
    expanded = `${code.slice(0, 4)}00000${code.slice(4, 6)}${checkDigit}`;
  } else if (marker === "4") {
    expanded = `${code.slice(0, 5)}00000${code[5]}${checkDigit}`;
  } else {
    expanded = `${code.slice(0, 6)}0000${marker}${checkDigit}`;
  }
  let sum = 0;
  for (const [position, digit] of [...expanded].entries()) {
    sum += Number(digit) * (position % 2 === 0 ? 3 : 1);
  }
  return sum % 10 === 0 ? expanded : null;
}

export function barcodeLookupOrder(code: string, cameraUpcE: boolean) {
  const expanded = expandUpcE(code);
  if (expanded === null) return { code };
  return cameraUpcE ? { code: expanded, alternateCode: code } : { code, alternateCode: expanded };
}

export function retainedProducts(
  diary: Pick<DiaryStore, "listMeals"> & Pick<MyFoodsStore, "listFavorites">,
  today: string,
): string[] {
  const ids = new Set<string>();
  for (const favorite of diary.listFavorites()) {
    if (favorite.provider === "open-food-facts") ids.add(favorite.sourceId);
  }
  // A captured local day can be up to two calendar days ahead after travel.
  for (let offset = -2; offset < recentDays; offset += 1) {
    for (const meal of diary.listMeals(addDays(today, -offset))) {
      for (const { food } of meal.items) {
        if (food.id.provider === "open-food-facts") ids.add(food.id.sourceId);
      }
    }
  }
  return [...ids];
}

export function foodForPackagedProduct(product: PackagedFood): Food {
  const { id, release, name, preparation } = product;
  return {
    id,
    release,
    name,
    preparation,
    nutrition: product.nutrition ?? {
      basis: "per-portion",
      nutrients: {
        kcal: null,
        proteinG: null,
        availableCarbohydratesG: null,
        fatG: null,
        fiberG: null,
      },
    },
  };
}

export function stalePackagedSelection(
  food: Food,
  cache: PackagedFoodCache | null | undefined,
  now: number,
): PackagedFood | null {
  if (food.id.provider !== "open-food-facts" || !cache) return null;
  try {
    const [row] = cache.findByIds([food.id.sourceId], now);
    return row && !isFresh(row.checkedAt, now) ? row.product : null;
  } catch {
    return null;
  }
}

function readProducts(value: unknown, key: string): PackagedFood[] | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("products" in value) ||
    !Array.isArray(value.products) ||
    value.products.length === 0
  ) {
    return null;
  }
  const products: PackagedFood[] = [];
  const ids = new Set<string>();
  for (const item of value.products) {
    const product = decodePackagedFood(item);
    if (
      !product ||
      normalizeOpenFoodFactsBarcode(product.barcode) !== key ||
      ids.has(product.id.sourceId)
    )
      return null;
    ids.add(product.id.sourceId);
    products.push(product);
  }
  return products;
}

type CatalogFetch = (
  url: string,
  init: {
    signal: AbortSignal;
    credentials: "omit";
    redirect: "error";
    headers: Record<string, string>;
  },
) => Promise<Response>;

async function readCatalogJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  const type = response.headers.get("content-type");
  if (
    type?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes))
  )
    return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(maxResponseBytes);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxResponseBytes - offset) return null;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, offset)));
  } finally {
    reader.releaseLock();
  }
}

async function fromCatalog(
  origin: string,
  code: string,
  key: string,
  signal: AbortSignal,
  request: CatalogFetch,
): Promise<CatalogResult> {
  try {
    const url = `${origin}${previewPath}${code}`;
    const response = await request(url, {
      signal,
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (response.redirected || (response.url && response.url !== url)) {
      return { status: "unavailable" };
    }
    if (response.status === 429) return { status: "rate-limited" };
    if (response.status === 404) {
      const value = await readCatalogJson(response);
      return value !== null &&
        typeof value === "object" &&
        "status" in value &&
        value.status === "not-found"
        ? { status: "not-found" }
        : { status: "unavailable" };
    }
    if (response.status !== 200) return { status: "unavailable" };
    const value = await readCatalogJson(response);
    if (
      value === null ||
      typeof value !== "object" ||
      !("status" in value) ||
      value.status !== "found"
    ) {
      return { status: "unavailable" };
    }
    const products = readProducts(value, key);
    if (!products) return { status: "unavailable" };
    const complete =
      "source" in value &&
      value.source === "catalog" &&
      "releaseManifestSha256" in value &&
      typeof value.releaseManifestSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.releaseManifestSha256);
    return { status: "found", products, complete };
  } catch {
    return { status: "unavailable" };
  }
}

interface LookupOptions {
  code: string;
  origin: string | null;
  cache: PackagedFoodCache | null;
  keep: () => string[];
  signal: AbortSignal;
  now?: () => number;
  request?: CatalogFetch;
}

export async function revalidatePackagedSelection(
  product: PackagedFood,
  options: Omit<LookupOptions, "code">,
): Promise<Food | null> {
  const code =
    product.barcode.length <= maxBarcodeLength
      ? product.barcode
      : normalizeOpenFoodFactsBarcode(product.barcode);
  if (!code) return null;
  const result = await lookupCode({ ...options, code }, true);
  const updated =
    result.status === "found" && !result.cached
      ? result.products.find(({ id }) => id.sourceId === product.id.sourceId)
      : undefined;
  return updated ? foodForPackagedProduct(updated) : null;
}

export async function lookupPackagedFood(
  options: LookupOptions & { alternateCode?: string },
): Promise<BarcodeResult> {
  const result = await lookupCode(options);
  if (
    !options.alternateCode ||
    options.alternateCode === options.code ||
    options.signal.aborted ||
    result.status === "found"
  )
    return result;
  // A UPC-E may be stored as printed or expanded to its GTIN-12.
  const alternate = await lookupCode({
    ...options,
    code: options.alternateCode,
    origin: result.status === "not-found" ? options.origin : null,
  });
  if (
    alternate.status === "found" ||
    (result.status === "not-found" &&
      (alternate.status === "rate-limited" || alternate.status === "unavailable"))
  ) {
    return alternate;
  }
  return result;
}

async function lookupCode(
  { code, origin, cache, keep, signal, now = Date.now, request = fetch }: LookupOptions,
  revalidate = false,
): Promise<BarcodeResult> {
  if (signal.aborted) return { status: "unavailable" };
  const cleaned = code.trim();
  const key = cleaned.length <= maxBarcodeLength ? normalizeOpenFoodFactsBarcode(cleaned) : null;
  if (!key) return { status: "invalid" };
  const checkedAt = now();
  let cached = [] as ReturnType<PackagedFoodCache["lookupBarcode"]>;
  try {
    cached = cache?.lookupBarcode(cleaned, checkedAt) ?? [];
  } catch {
    // The separately disposable cache can fail while lookup and the diary stay usable.
  }
  const cacheHit: BarcodeResult | undefined = cached.length
    ? { status: "found", products: cached.map(({ product }) => product), cached: true }
    : undefined;
  if (
    cacheHit &&
    (!origin || (!revalidate && cached.every((row) => isFresh(row.checkedAt, checkedAt))))
  )
    return cacheHit;
  if (!origin || signal.aborted) return { status: "unavailable" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, lookupTimeoutMs);
  try {
    const result = await fromCatalog(origin, cleaned, key, controller.signal, request);
    if (signal.aborted) return { status: "unavailable" };
    if (result.status !== "found") return cacheHit ?? result;
    try {
      if (result.complete)
        cache?.saveBarcodeCandidates(cleaned, result.products, checkedAt, keep());
      else cache?.save(result.products, checkedAt, keep());
    } catch {
      // A failed cache write does not change the trusted result of this lookup.
    }
    return { status: "found", products: result.products, cached: false };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
