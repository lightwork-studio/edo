import {
  type CatalogProvider,
  compatibleCatalog,
} from "../../packages/catalog-import/src/manifest.ts";
import {
  decodePackagedFood,
  normalizeOpenFoodFactsBarcode,
  type PackagedFood,
} from "../../packages/core/src/packaged-food.ts";
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
export interface CatalogEnvironment {
  CATALOGS: { get(key: string): Promise<StoredObject | null> };
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
  if (manifest.artifact.sha256 !== state.releases[state.active])
    throw new Error("Published catalog artifact does not match its registration");
  const { value: index, sha } = await readJson(
    bucket,
    `${prefix}/lookup/${active.sha}.json`,
    32 * 1024,
  );
  const expectedIndex = state.barcodeIndexes?.[active.sha];
  if (expectedIndex !== undefined && sha !== expectedIndex)
    throw new Error("Published barcode index does not match its registration");
  if (
    !index ||
    typeof index !== "object" ||
    Array.isArray(index) ||
    !Object.entries(index).every(
      ([prefix, digest]) =>
        /^[a-f0-9]{2}$/.test(prefix) && typeof digest === "string" && checksum.test(digest),
    )
  ) {
    throw new Error("Invalid barcode index");
  }
  const shardDigest = (index as Record<string, string>)[shardFor(key)];
  if (shardDigest === undefined) return json({ status: "not-found" }, 404);

  const shard = await readJson(bucket, `${prefix}/shards/${shardDigest}.json`, 8 * 1024 * 1024);
  if (
    shard.sha !== shardDigest ||
    !shard.value ||
    typeof shard.value !== "object" ||
    Array.isArray(shard.value)
  ) {
    throw new Error("Invalid barcode shard");
  }
  const entries = shard.value as Record<string, unknown>;
  if (!Object.hasOwn(entries, key)) return json({ status: "not-found" }, 404);
  const candidates = entries[key];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Invalid barcode candidates");
  }
  const products: PackagedFood[] = [];
  const sourceIds = new Set<string>();
  for (const candidate of candidates as unknown[]) {
    const product =
      candidate !== null && typeof candidate === "object"
        ? decodePackagedFood({ ...candidate, release: manifest.source.release })
        : null;
    if (
      !product ||
      normalizeOpenFoodFactsBarcode(product.barcode) !== key ||
      sourceIds.has(product.id.sourceId)
    ) {
      throw new Error("Invalid barcode product");
    }
    sourceIds.add(product.id.sourceId);
    products.push(product);
  }
  products.sort((left, right) => Number(right.barcode === code) - Number(left.barcode === code));
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
  async fetch(request: Request, { CATALOGS }: CatalogEnvironment): Promise<Response> {
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
        return await lookup(CATALOGS, route.slice("barcodes/".length));
      }
      return await asset(request, CATALOGS, provider, route);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  },
};
