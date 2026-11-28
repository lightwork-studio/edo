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
const maxResponseBytes = 256 * 1024;
// One shared client stays below the provider's 15 per minute/IP allowance for product reads.
export const liveLookupWindowMs = 60_000;
export const liveLookupRequestsPerWindow = 10;

export interface LiveLookupQuota {
  /** The latest time this lookup may dispatch, or null when the quota is exhausted. */
  reserve(at: number): number | null | Promise<number | null>;
  canDispatch(at: number): boolean;
  pause(until: number): void | Promise<void>;
}

function memoryQuota(): LiveLookupQuota {
  let requests: number[] = [];
  let pausedUntil = 0;
  return {
    reserve(at) {
      requests = requests.filter((request) => at - request < liveLookupWindowMs);
      if (at < pausedUntil || requests.length >= liveLookupRequestsPerWindow) return null;
      requests.push(at);
      return Number.POSITIVE_INFINITY;
    },
    canDispatch(at) {
      return at >= pausedUntil;
    },
    pause(until) {
      pausedUntil = Math.max(pausedUntil, until);
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function retryUntil(response: Response, at: number): number {
  const delay = response.headers.get("retry-after")?.trim();
  if (delay === undefined) return at + liveLookupWindowMs;
  const retry = /^\d+$/.test(delay) ? at + Number(delay) * 1000 : Date.parse(delay);
  const earliest = at + liveLookupWindowMs;
  return Number.isFinite(retry) ? Math.max(retry, earliest) : earliest;
}

async function readProduct(response: Response): Promise<Record<string, unknown> | undefined> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (
    type !== "application/json" ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes))
  ) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }

  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const bytes = new Uint8Array(maxResponseBytes);
  let offset = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
        return object(object(JSON.parse(text))?.product);
      }
      if (value.byteLength > maxResponseBytes - offset) return undefined;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createOpenFoodFactsLiveLookup(
  fetchProduct: typeof fetch = fetch,
  now: () => number = Date.now,
  { quota = memoryQuota(), timeoutMs = 5000 }: { quota?: LiveLookupQuota; timeoutMs?: number } = {},
): (barcode: string) => Promise<LiveBarcodeResult> {
  const inFlight = new Map<string, Promise<LiveBarcodeResult>>();

  async function load(
    key: string,
    checkedAt: number,
    dispatchBy: number,
  ): Promise<LiveBarcodeResult> {
    // The v3.0 alias does not return the structured nutrition that Edo imports.
    const url = new URL(`/api/v3.6/product/${key}`, origin);
    url.searchParams.set("product_type", "food");
    url.searchParams.set("fields", fields);
    try {
      const dispatchAt = now();
      if (dispatchAt > dispatchBy || !quota.canDispatch(dispatchAt))
        return { status: "rate-limited" };
      const response = await fetchProduct(url, {
        headers: { "User-Agent": "Edo/1 (https://github.com/lightwork-studio/edo)" },
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || response.redirected) {
        if (response.status === 429) {
          await quota.pause(retryUntil(response, now()));
          await response.body?.cancel().catch(() => undefined);
          return { status: "rate-limited" };
        }
        await response.body?.cancel().catch(() => undefined);
        return {
          status: !response.redirected && response.status === 404 ? "not-found" : "unavailable",
        };
      }

      const product = await readProduct(response);
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

  async function admit(key: string, at: number): Promise<LiveBarcodeResult> {
    const dispatchBy = await quota.reserve(at);
    return dispatchBy === null ? { status: "rate-limited" } : load(key, at, dispatchBy);
  }

  return async (barcode) => {
    const key = normalizeLookupCode(barcode.trim());
    if (!key) return { status: "invalid" };
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = admit(key, now()).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}
