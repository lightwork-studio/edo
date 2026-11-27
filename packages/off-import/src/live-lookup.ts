import { normalizeLookupCode, readOpenFoodFactsProduct } from "./format.ts";
import type { BarcodeProduct } from "./lookup.ts";

export type LiveBarcodeResult =
  | { readonly status: "found"; readonly product: BarcodeProduct; readonly checkedAt: number }
  | { readonly status: "invalid" | "not-found" | "unavailable" | "rate-limited" };

const origin = "https://world.openfoodfacts.org";
const fields = [
  "_id",
  "code",
  "product_name",
  "product_name_de",
  "product_name_en",
  "serving_quantity",
  "serving_quantity_unit",
  "nutrition",
  "last_modified_t",
].join(",");
const minute = 60_000;
// One shared client stays below the provider's 15 per minute/IP allowance for product reads.
const requestsPerMinute = 10;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function retryUntil(response: Response, at: number): number {
  const delay = response.headers.get("retry-after")?.trim();
  if (delay === undefined) return at + minute;
  const retry = /^\d+$/.test(delay) ? at + Number(delay) * 1000 : Date.parse(delay);
  return Number.isFinite(retry) ? Math.max(retry, at + minute) : at + minute;
}

export function createOpenFoodFactsLiveLookup(
  fetchProduct: typeof fetch = fetch,
  now: () => number = Date.now,
): (barcode: string) => Promise<LiveBarcodeResult> {
  const inFlight = new Map<string, Promise<LiveBarcodeResult>>();
  let requests: number[] = [];
  let pausedUntil = 0;

  async function load(key: string, checkedAt: number): Promise<LiveBarcodeResult> {
    // The v3.0 alias does not return the structured nutrition that Edo imports.
    const url = new URL(`/api/v3.6/product/${key}`, origin);
    url.searchParams.set("product_type", "food");
    url.searchParams.set("fields", fields);
    try {
      const response = await fetchProduct(url, {
        headers: { "User-Agent": "Edo/1 (https://github.com/lightwork-studio/edo)" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          pausedUntil = Math.max(pausedUntil, retryUntil(response, now()));
          await response.body?.cancel().catch(() => undefined);
          return { status: "rate-limited" };
        }
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status === 404 ? "not-found" : "unavailable" };
      }

      const payload = object(await response.json());
      const product = object(payload?.product);
      const revision = product?.last_modified_t;
      const release =
        typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
          ? `live-revision:${revision}`
          : `live-checked:${new Date(checkedAt).toISOString()}`;
      const candidate = readOpenFoodFactsProduct(product, release, "all");
      if (!candidate || candidate === "outside-scope" || candidate.lookupCode !== key) {
        return { status: "unavailable" };
      }
      return {
        status: "found",
        checkedAt,
        product: {
          ...candidate.food,
          barcode: candidate.barcode,
          alternateName: candidate.nameDe ? candidate.nameEn : null,
        },
      };
    } catch {
      return { status: "unavailable" };
    }
  }

  return async (barcode) => {
    const key = normalizeLookupCode(barcode.trim());
    if (!key) return { status: "invalid" };
    const pending = inFlight.get(key);
    if (pending) return pending;
    const current = now();
    requests = requests.filter((at) => current - at < minute);
    if (current < pausedUntil || requests.length >= requestsPerMinute) {
      return { status: "rate-limited" };
    }
    requests.push(current);
    const request = load(key, current).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}
