import { expect, test } from "vitest";
import worker, { type CatalogEnvironment, sha256, shardFor } from "./worker.ts";

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

test("distinguishes a missing barcode from malformed candidates in a registered shard", async () => {
  const { env, files, put, release } = await prepare();
  const responseFor = async (value: Record<string, unknown>) => {
    const shard = encoder.encode(JSON.stringify(value)).buffer;
    const digest = await sha256(shard);
    files.set(`${prefix}/shards/${digest}.json`, shard);
    const index = await put(`${prefix}/lookup/${release}.json`, {
      [shardFor(sample.barcode)]: digest,
    });
    await put(`${prefix}/state.json`, {
      active: release,
      releases: { [release]: sha },
      barcodeIndexes: { [release]: index },
    });
    return worker.fetch(new Request(`${origin}/${prefix}/barcodes/1234`), env);
  };
  for (const candidates of [null, {}, false, 0, "", []]) {
    const response = await responseFor({ [sample.barcode]: candidates });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  }
  const response = await responseFor({});
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ status: "not-found" });
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
