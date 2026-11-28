import { expect, test, vi } from "vitest";
import worker, { type CatalogEnvironment, OpenFoodFactsLive, sha256, shardFor } from "./worker.ts";

const origin = "https://edo.timweb.app/catalog-preview";
const encoder = new TextEncoder();
const prefix = "open-food-facts";
const sample = {
  id: { provider: "open-food-facts", sourceId: "00001234" },
  barcode: "00001234",
  name: "Test juice",
  alternateName: null,
  preparation: "as-sold",
  nutrition: null,
};
const sha = "a".repeat(64);

function objects() {
  const files = new Map<string, ArrayBuffer>();
  const read: string[] = [];
  const env: CatalogEnvironment = {
    CATALOGS: {
      async get(key) {
        read.push(key);
        const bytes = files.get(key);
        return bytes
          ? {
              size: bytes.byteLength,
              body: new Response(bytes).body as ReadableStream,
              async arrayBuffer() {
                return bytes;
              },
            }
          : null;
      },
    },
  };
  const put = (key: string, value: unknown) => {
    const bytes = encoder.encode(JSON.stringify(value)).buffer;
    files.set(key, bytes);
    return sha256(bytes);
  };
  return { env, read, files, put };
}

async function prepare() {
  const storage = objects();
  const release = await storage.put("fixture", {
    manifestVersion: 1,
    provider: prefix,
    schemaVersion: 1,
    importerVersion: "2",
    source: { release: "fixture", url: "https://example.test", sha256: sha },
    attribution: { name: "Open Food Facts contributors", license: "ODbL-1.0", changes: "fixture" },
    artifact: { sha256: sha, bytes: 4321 },
    counts: { accepted: 1, rejected: 0 },
  });
  const releaseBytes = storage.files.get("fixture");
  if (!releaseBytes) throw new Error("Expected fixture manifest");
  storage.files.set(`${prefix}/releases/${release}.json`, releaseBytes);
  await storage.put(`${prefix}/state.json`, { active: release, releases: { [release]: sha } });
  const key = shardFor(sample.barcode);
  const shard = encoder.encode(JSON.stringify({ [sample.barcode]: [sample] })).buffer;
  const digest = await sha256(shard);
  const shardKey = `${prefix}/shards/${digest}.json`;
  await storage.put(`${prefix}/lookup/${release}.json`, { [key]: digest });
  storage.files.set(shardKey, shard);
  return { ...storage, release, shardKey };
}

test("serves the catalog barcode contract and distinguishes an unavailable shard", async () => {
  const { env, files, release, shardKey } = await prepare();
  const request = () => new Request(`${origin}/${prefix}/barcodes/1234`);
  const response = await worker.fetch(request(), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "found",
    source: "catalog",
    releaseManifestSha256: release,
    products: [{ ...sample, release: "fixture" }],
  });
  files.delete(shardKey);
  const unavailable = await worker.fetch(request(), env);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ status: "unavailable" });
});

test("calls the live lookup on a verified snapshot miss only", async () => {
  const { env, files, shardKey } = await prepare();
  const live = vi.fn(async () => Response.json({ status: "rate-limited" }, { status: 429 }));
  const getByName = vi.fn(() => ({ fetch: live }));
  const request = (code: string) => new Request(`${origin}/${prefix}/barcodes/${code}`);
  const withLive = { ...env, OFF_LIVE: { getByName } };

  expect((await worker.fetch(request("1234"), withLive)).status).toBe(200);
  expect((await worker.fetch(request("invalid"), withLive)).status).toBe(400);
  expect((await worker.fetch(request("5678"), env)).status).toBe(404);
  expect(live).not.toHaveBeenCalled();
  expect((await worker.fetch(request("5678"), withLive)).status).toBe(429);
  expect(getByName).toHaveBeenCalledExactlyOnceWith("open-food-facts");
  expect(live).toHaveBeenCalledExactlyOnceWith("https://off-live.internal/5678");

  files.delete(shardKey);
  expect((await worker.fetch(request("1234"), withLive)).status).toBe(503);
  expect(live).toHaveBeenCalledTimes(1);
});

test("keeps the upstream quota and retry delay across object restarts", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", upstream);
  let time = Date.parse("2026-11-28T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  const storage = {
    kv: new Map<string, { requests: number[]; pausedUntil: number }>(),
    sync: async () => {},
  };
  const state = {
    storage: {
      ...storage,
      kv: { get: storage.kv.get.bind(storage.kv), put: storage.kv.set.bind(storage.kv) },
    },
  };
  const request = new Request("https://off-live.internal/1234");
  try {
    const actor = new OpenFoodFactsLive(state);
    const responses = await Promise.all(Array.from({ length: 12 }, () => actor.fetch(request)));
    expect(responses.filter(({ status }) => status === 404)).toHaveLength(10);
    expect(responses.filter(({ status }) => status === 429)).toHaveLength(2);
    const reopened = new OpenFoodFactsLive(state);
    expect((await reopened.fetch(request)).status).toBe(429);

    time += 61_000;
    upstream.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    );
    expect((await reopened.fetch(request)).status).toBe(429);
    time += 119_999;
    expect((await new OpenFoodFactsLive(state).fetch(request)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(11);
    time += 1;
    expect((await reopened.fetch(request)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(12);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("expires a slow dispatch before it can violate the rolling quota", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", upstream);
  const start = Date.parse("2026-11-28T12:00:00Z");
  let time = start;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  const entries = new Map<string, { requests: number[]; pausedUntil: number }>();
  const sync = vi.fn(async () => {});
  sync.mockImplementationOnce(async () => {
    time = start + 2000;
  });
  const actor = new OpenFoodFactsLive({
    storage: {
      kv: { get: (key) => entries.get(key), put: (key, value) => entries.set(key, value) },
      sync,
    },
  });
  const request = new Request("https://off-live.internal/1234");
  try {
    expect((await actor.fetch(request)).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
    for (let count = 0; count < 9; count += 1) {
      expect((await actor.fetch(request)).status).toBe(404);
    }
    time = start + 60_000;
    expect((await actor.fetch(request)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(9);
    time = start + 61_000;
    expect((await actor.fetch(request)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(10);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("checks the upstream pause again after an earlier reservation becomes durable", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", upstream);
  const entries = new Map<string, { requests: number[]; pausedUntil: number }>();
  let flushEarlier = () => {};
  const pendingFlush = new Promise<void>((resolve) => {
    flushEarlier = resolve;
  });
  const sync = vi.fn(async () => {}).mockReturnValueOnce(pendingFlush);
  const actor = new OpenFoodFactsLive({
    storage: {
      kv: { get: (key) => entries.get(key), put: (key, value) => entries.set(key, value) },
      sync,
    },
  });
  const earlier = actor.fetch(new Request("https://off-live.internal/1234"));
  try {
    const later = await actor.fetch(new Request("https://off-live.internal/5678"));
    expect(later.status).toBe(429);
    flushEarlier();
    expect((await earlier).status).toBe(429);
    expect(upstream).toHaveBeenCalledOnce();
  } finally {
    flushEarlier();
    await earlier;
    vi.unstubAllGlobals();
  }
});

test("does not expose internal index objects or respond to write methods", async () => {
  const { env, read, release } = await prepare();
  const hidden = await worker.fetch(new Request(`${origin}/${prefix}/lookup/${release}.json`), env);
  expect(hidden.status).toBe(404);
  const write = await worker.fetch(
    new Request(`${origin}/${prefix}/active.json`, { method: "PUT" }),
    env,
  );
  expect(write.status).toBe(405);
  expect(read).toEqual([]);
});

test("serves immutable files with their digest as ETag", async () => {
  const { env, files, put } = await prepare();
  const path = `bls/artifacts/${sha}.sqlite`;
  files.set(path, encoder.encode("sqlite fixture").buffer);
  const release = "b".repeat(64);
  await put("bls/state.json", { active: release, releases: { [release]: sha } });
  const staged = "c".repeat(64);
  const stagedKey = `bls/artifacts/${staged}.sqlite`;
  files.set(stagedKey, encoder.encode("unpublished fixture").buffer);
  expect((await worker.fetch(new Request(`${origin}/${stagedKey}`), env)).status).toBe(404);
  const url = `${origin}/${path}`;
  const response = await worker.fetch(new Request(url), env);
  expect(response.headers.get("content-type")).toBe("application/vnd.sqlite3");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(await response.text()).toBe("sqlite fixture");
  const unchanged = await worker.fetch(
    new Request(url, { headers: { "if-none-match": `"${sha}"` } }),
    env,
  );
  expect(unchanged.status).toBe(304);
});

test("refuses a changed manifest even when requested with the published digest", async () => {
  const { env, files, release } = await prepare();
  const active = await worker.fetch(new Request(`${origin}/${prefix}/active.json`), env);
  expect(active.status).toBe(200);
  const key = `${prefix}/releases/${release}.json`;
  files.set(key, encoder.encode("{}").buffer);
  const changed = await worker.fetch(
    new Request(`${origin}/${key}`, {
      headers: { "if-none-match": `"${release}"` },
    }),
    env,
  );
  expect(changed.status).toBe(503);
});
