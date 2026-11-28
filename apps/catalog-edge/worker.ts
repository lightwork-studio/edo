import {
  type CatalogProvider,
  compatibleCatalog,
} from "../../packages/catalog-import/src/manifest.ts";
import {
  normalizeOpenFoodFactsBarcode,
  type PackagedFood,
} from "../../packages/core/src/packaged-food.ts";
import {
  createOpenFoodFactsLiveLookup,
  type LiveBarcodeResult,
  type LiveLookupQuota,
  liveLookupRequestsPerWindow,
  liveLookupWindowMs,
} from "../../packages/off-import/src/live-lookup.ts";
import {
  checksum,
  maxBlsManifestBytes,
  maxManifestBytes,
  maxStateBytes,
  readCatalogState,
} from "./state.ts";

interface StoredObject {
  body: ReadableStream;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
type StoredProduct = Omit<PackagedFood, "release">;

export interface CatalogEnvironment {
  CATALOGS: { get(key: string): Promise<StoredObject | null> };
  OFF_LIVE?: { getByName(name: string): { fetch(url: string): Promise<Response> } };
}

const root = "/catalog-preview";
const providers = {
  bls: {
    license: "https://creativecommons.org/licenses/by/4.0/",
    source: "https://doi.org/10.25826/Data20251217-134202-0",
  },
  "open-food-facts": {
    license: "https://opendatacommons.org/licenses/odbl/1-0/",
    source: "https://world.openfoodfacts.org/data",
  },
};
const immutable = "public, max-age=31536000, immutable";
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function sha256(bytes: ArrayBuffer) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Multiplicative hash spreads related retail codes across shards.
export function shardFor(code: string) {
  let value = 2166136261;
  for (const digit of code) value = Math.imul(value ^ digit.charCodeAt(0), 16777619);
  return (value >>> 24).toString(16).padStart(2, "0");
}

async function readJson(bucket: CatalogEnvironment["CATALOGS"], key: string, limit: number) {
  const object = await bucket.get(key);
  if (!object) throw new Error("Catalog JSON object is missing");
  return readJsonObject(object, limit);
}

async function readJsonObject(object: StoredObject, limit: number) {
  if (object.size > limit) throw new Error("Catalog JSON object is oversized");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size)
    throw new Error("Catalog JSON object has an unexpected size");
  return { bytes, value: JSON.parse(decoder.decode(bytes)) as unknown, sha: await sha256(bytes) };
}

function json(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

interface Budget {
  requests: number[];
  pausedUntil: number;
}

interface BudgetStorage {
  kv: { get(key: string): Budget | undefined; put(key: string, value: Budget): void };
  sync(): Promise<void>;
}

const quotaKey = "quota";
const dispatchGraceMs = 1000;
const liveStatus: Record<Exclude<LiveBarcodeResult["status"], "found">, number> = {
  invalid: 400,
  "not-found": 404,
  "rate-limited": 429,
  unavailable: 503,
};

export class OpenFoodFactsLive {
  private readonly state: { storage: BudgetStorage };

  constructor(state: { storage: BudgetStorage }) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const code = new URL(request.url).pathname.slice(1);
    if (request.method !== "GET" || code.length > 64 || !normalizeOpenFoodFactsBarcode(code))
      return json({ status: "invalid" }, 400);
    const { storage } = this.state;
    const readBudget = (): Budget => storage.kv.get(quotaKey) ?? { requests: [], pausedUntil: 0 };
    // Admission runs on one named object. Commit its reservation before sending the request.
    const quota: LiveLookupQuota = {
      async reserve(at) {
        const budget = readBudget();
        const requests = budget.requests.filter((time) => at - time < liveLookupWindowMs);
        if (at < budget.pausedUntil || requests.length >= liveLookupRequestsPerWindow) return null;
        // Charge the latest possible dispatch time. A slow flush cannot move a call past it.
        const dispatchBy = at + dispatchGraceMs;
        storage.kv.put(quotaKey, { ...budget, requests: [...requests, dispatchBy] });
        await storage.sync();
        return dispatchBy;
      },
      async pause(until) {
        const budget = readBudget();
        storage.kv.put(quotaKey, { ...budget, pausedUntil: Math.max(budget.pausedUntil, until) });
        await storage.sync();
      },
    };
    const lookup = createOpenFoodFactsLiveLookup(fetch, Date.now, { quota, timeoutMs: 3500 });
    const result = await lookup(code);
    if (result.status !== "found") return json(result, liveStatus[result.status]);
    return json(
      {
        status: "found",
        source: "live",
        products: [result.product],
        checkedAt: result.checkedAt,
        attribution: { name: "Open Food Facts contributors", ...providers["open-food-facts"] },
      },
      200,
    );
  }
}

async function lookup(bucket: CatalogEnvironment["CATALOGS"], code: string) {
  const key = code.length <= 64 ? normalizeOpenFoodFactsBarcode(code) : null;
  if (!key) return json({ status: "invalid" }, 400);
  const prefix = "open-food-facts";
  const { value: record } = await readJson(bucket, `${prefix}/state.json`, maxStateBytes);
  const state = readCatalogState(record);
  const active = await readJson(
    bucket,
    `${prefix}/releases/${state.active}.json`,
    maxManifestBytes,
  );
  if (active.sha !== state.active)
    throw new Error("Published catalog manifest does not match its digest");
  const manifest = compatibleCatalog(active.value, prefix, [1]);
  if (!manifest) throw new Error("Unsupported Open Food Facts release");
  const { value: index } = await readJson(bucket, `${prefix}/lookup/${active.sha}.json`, 32 * 1024);
  if (!index || typeof index !== "object" || Array.isArray(index))
    throw new Error("Invalid barcode index");
  const shardDigest = (index as Record<string, unknown>)[shardFor(key)];
  if (shardDigest === undefined) return json({ status: "not-found" }, 404);
  if (typeof shardDigest !== "string" || !checksum.test(shardDigest))
    throw new Error("Invalid barcode shard reference");

  const shard = await readJson(bucket, `${prefix}/shards/${shardDigest}.json`, 8 * 1024 * 1024);
  if (
    shard.sha !== shardDigest ||
    !shard.value ||
    typeof shard.value !== "object" ||
    Array.isArray(shard.value)
  ) {
    throw new Error("Invalid barcode shard");
  }
  const candidates = (shard.value as Record<string, StoredProduct[] | undefined>)[key];
  if (!candidates?.length) return json({ status: "not-found" }, 404);
  const products = candidates
    .map((product) => ({ ...product, release: manifest.source.release }))
    .sort((left, right) => Number(right.barcode === code) - Number(left.barcode === code));
  return json(
    {
      status: "found",
      source: "catalog",
      products,
      releaseManifestSha256: active.sha,
      checkedAt: Date.now(),
      attribution: {
        name: "Open Food Facts contributors",
        ...providers[prefix],
        catalog: `${root}/${prefix}/releases/${active.sha}.json`,
      },
    },
    200,
  );
}

async function asset(
  request: Request,
  bucket: CatalogEnvironment["CATALOGS"],
  provider: CatalogProvider,
  route: string,
) {
  const active = route === "active.json";
  const match = /^(?:releases\/([a-f0-9]{64})\.json|artifacts\/([a-f0-9]{64})\.sqlite)$/.exec(
    route,
  );
  const hash = match?.[1] ?? match?.[2];
  if (!active && !hash) return new Response(null, { status: 404 });

  const registration = await bucket.get(`${provider}/state.json`);
  if (!registration) return new Response(null, { status: active ? 503 : 404 });
  const { value } = await readJsonObject(registration, maxStateBytes);
  const state = readCatalogState(value);
  if (hash) {
    const published = match?.[1]
      ? Object.hasOwn(state.releases, hash)
      : Object.values(state.releases).includes(hash);
    if (!published) return new Response(null, { status: 404 });
  }
  const key = active ? `releases/${state.active}.json` : route;
  const object = await bucket.get(`${provider}/${key}`);
  if (!object) return new Response(null, { status: active ? 503 : 404 });
  const manifest = match?.[2]
    ? null
    : await readJsonObject(object, provider === "bls" ? maxBlsManifestBytes : maxManifestBytes);
  if (manifest && manifest.sha !== (hash ?? state.active)) {
    throw new Error("Catalog manifest does not match its published digest");
  }
  const { license, source } = providers[provider];
  const headers = new Headers({
    "Content-Type": match?.[2] ? "application/vnd.sqlite3" : "application/json",
    "Cache-Control": `${hash ? immutable : "no-cache"}${provider === "bls" ? ", no-transform" : ""}`,
    "X-Content-Type-Options": "nosniff",
    Link: `<${license}>; rel="license", <${source}>; rel="cite-as"`,
  });
  if (hash) {
    const etag = `"${hash}"`;
    headers.set("ETag", etag);
    const tags = request.headers
      .get("If-None-Match")
      ?.split(",")
      .map((tag) => tag.trim());
    if (tags?.some((tag) => tag === "*" || tag === etag || tag === `W/${etag}`)) {
      if (!manifest) await object.body.cancel();
      return new Response(null, { status: 304, headers });
    }
  }
  headers.set("Content-Length", String(object.size));
  if (request.method === "HEAD" && !manifest) await object.body.cancel();
  return new Response(request.method === "HEAD" ? null : (manifest?.bytes ?? object.body), {
    headers,
  });
}

export default {
  async fetch(request: Request, { CATALOGS, OFF_LIVE }: CatalogEnvironment): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const match = /^\/catalog-preview\/(bls|open-food-facts)\/(.+)$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const [, provider, route] = match;
    if ((provider !== "bls" && provider !== "open-food-facts") || !route)
      return new Response(null, { status: 404 });
    try {
      if (
        provider === "open-food-facts" &&
        route.startsWith("barcodes/") &&
        request.method === "GET"
      ) {
        const code = route.slice("barcodes/".length);
        const snapshot = await lookup(CATALOGS, code);
        if (snapshot.status === 404 && OFF_LIVE) {
          return await OFF_LIVE.getByName("open-food-facts").fetch(
            `https://off-live.internal/${code}`,
          );
        }
        return snapshot;
      }
      return await asset(request, CATALOGS, provider, route);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  },
};
