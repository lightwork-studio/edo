import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array<ArrayBuffer>>(),
  directories: new Set<string>(),
  fetch: vi.fn<(url: string, options: RequestInit) => Promise<Response>>(),
  digest: vi.fn<(algorithm: string, bytes: Uint8Array) => Promise<ArrayBuffer>>(),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: sdk.digest,
}));
vi.mock("expo/fetch", () => ({ fetch: sdk.fetch }));
vi.mock("expo-asset", () => ({
  Asset: { loadAsync: async () => [{ localUri: "asset:/bls.sqlite" }] },
}));
vi.mock("../src/catalog-seed", () => ({ blsSeedAsset: 1 }));
vi.mock("expo-file-system", () => {
  class Directory {
    constructor(
      readonly base: string,
      readonly name: string,
    ) {}
    get uri() {
      return `${this.base}/${this.name}`;
    }
    get exists() {
      return sdk.directories.has(this.uri);
    }
    create() {
      sdk.directories.add(this.uri);
    }
    list() {
      return Array.from(sdk.files.keys(), (uri) => new File(uri)).filter((file) =>
        file.uri.startsWith(`${this.uri}/`),
      );
    }
  }
  class File {
    uri: string;
    constructor(base: string | Directory, ...parts: string[]) {
      this.uri = [typeof base === "string" ? base : base.uri, ...parts].join("/");
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists() {
      return sdk.files.has(this.uri);
    }
    get size() {
      return sdk.files.get(this.uri)?.byteLength ?? 0;
    }
    create() {
      if (this.exists) throw Error("File already exists");
      sdk.files.set(this.uri, new Uint8Array());
    }
    async write(bytes: Uint8Array<ArrayBuffer>) {
      sdk.files.set(this.uri, bytes);
    }
    async bytes() {
      const data = sdk.files.get(this.uri);
      if (!data) throw Error("File is missing");
      return data;
    }
    open() {
      const data = sdk.files.get(this.uri);
      if (!data) throw Error("File is missing");
      return {
        size: data.byteLength,
        async readBytes(length: number) {
          return data.slice(0, length);
        },
        close() {},
      };
    }
    delete() {
      sdk.files.delete(this.uri);
    }
    async move(destination: File) {
      if (destination.exists) throw Error("Destination already exists");
      sdk.files.set(destination.uri, await this.bytes());
      this.delete();
      this.uri = destination.uri;
    }
  }
  return { Directory, File, FileMode: { ReadOnly: "r" }, Paths: { cache: "cache:" } };
});

vi.mock("expo-sqlite", () => ({
  async deserializeDatabaseAsync(bytes: Uint8Array) {
    const directory = mkdtempSync(join(tmpdir(), "edo-mobile-bls-open-"));
    const path = join(directory, "test.sqlite");
    try {
      writeFileSync(path, bytes);
      const db = new DatabaseSync(path);
      return {
        async execAsync(sql: string) {
          db.exec(sql);
        },
        async getFirstAsync(sql: string) {
          return db.prepare(sql).get() ?? null;
        },
        async getAllAsync(sql: string, parameter: string) {
          return db.prepare(sql).all(parameter);
        },
        async closeAsync() {
          db.close();
          rmSync(directory, { recursive: true });
        },
      };
    } catch (error) {
      rmSync(directory, { recursive: true });
      throw error;
    }
  },
}));

const publisher = "Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0";
const sourceUrl = "https://doi.org/10.25826/Data20251217-134202-0";
const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
const release = "4.0-2025";
const sourceSha256 = "12b7a6ba62807ec9b301eb276f897dc85f99b2292311618dec3749a12d984c91";
const origin = "https://edo.example.test";
const route = `${origin}/catalog-preview/bls`;
const cache = "cache:/edo-bls-preview";
const bundleSha256 = "de019d3c43f8836e678d6eb32584ba1280fc2b0fe9c2ee6fb033af73c17cdf05";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown) {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
  });
}

function syntheticCatalog(banana: string, version = 1) {
  const directory = mkdtempSync(join(tmpdir(), "edo-mobile-bls-fixture-"));
  const path = join(directory, "test.sqlite");
  try {
    using db = new DatabaseSync(path);
    db.exec(`
      PRAGMA user_version = ${version};
      CREATE TABLE catalog_metadata (singleton INTEGER PRIMARY KEY, provider TEXT,
        release TEXT, source_url TEXT, attribution TEXT, license_url TEXT);
      CREATE TABLE food (source_id TEXT PRIMARY KEY, name TEXT, alternate_name TEXT,
        preparation TEXT, nutrition_basis TEXT, kcal REAL, protein_g REAL,
        available_carbohydrates_g REAL, fat_g REAL, fiber_g REAL);
      CREATE VIRTUAL TABLE food_search USING fts5(name, alternate_name, content='food', content_rowid='rowid');
      WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM rows WHERE n<7140)
      INSERT INTO food SELECT 'synthetic-' || n, 'Synthetic fixture ' || n, '', 'as-sold',
        'per-100-g', 1, 0, 0, 0, 0 FROM rows;
    `);
    db.prepare("INSERT INTO catalog_metadata VALUES (1, 'bls', ?, ?, ?, ?)").run(
      release,
      sourceUrl,
      publisher,
      licenseUrl,
    );
    db.prepare("UPDATE food SET name = ? WHERE source_id = 'synthetic-1'").run(banana);
    db.exec("INSERT INTO food_search(food_search) VALUES ('rebuild')");
    return Uint8Array.from(readFileSync(path));
  } finally {
    rmSync(directory, { recursive: true });
  }
}

const bundled = syntheticCatalog("Banane im Paket");
const artifact = syntheticCatalog("Banane aus dem Preview");
const digest = sha256(artifact);
const installed = `${cache}/${digest}.sqlite`;
const manifest = {
  manifestVersion: 1,
  provider: "bls",
  schemaVersion: 1,
  importerVersion: "1",
  source: { release, url: sourceUrl, sha256: sourceSha256 },
  attribution: { name: publisher, license: `CC BY 4.0 (${licenseUrl})`, changes: "Fixture" },
  counts: { accepted: 7140, rejected: 0 },
  artifact: { bytes: artifact.byteLength, sha256: digest },
};

beforeEach(() => {
  vi.resetModules();
  sdk.files.clear();
  sdk.files.set("asset:/bls.sqlite", bundled);
  sdk.directories.clear();
  sdk.fetch.mockReset();
  sdk.digest.mockReset();
  sdk.digest.mockImplementation(
    async (_algorithm, bytes) =>
      Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function startApp(previewOrigin?: string, pin?: string) {
  vi.stubEnv("EXPO_PUBLIC_EDO_CATALOG_ORIGIN", origin);
  vi.stubEnv("EXPO_PUBLIC_EDO_BLS_PREVIEW_ORIGIN", previewOrigin);
  vi.stubEnv("EXPO_PUBLIC_EDO_BLS_PREVIEW_SHA256", pin);
  return (await import("../src/local-catalog")).openLocalCatalog;
}

it.each([
  [undefined, undefined],
  [origin, undefined],
  ["http://edo.example.test", digest],
  [`${origin}/other`, digest],
  [origin, `${digest}\n`],
])(
  "opens the bundled BLS catalog without network when preview opt-in is invalid",
  async (url, pin) => {
    const open = await startApp(url, pin);
    const result = await open();
    expect(sdk.fetch).not.toHaveBeenCalled();
    await result.close();
  },
);

it("skips the network when the approved file is already bundled", async () => {
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  await refreshBlsPreview({ origin, digest: bundleSha256 });
  expect(sdk.fetch).not.toHaveBeenCalled();
  expect(sdk.directories.size).toBe(0);
});

it("passes the byte snapshot checked by SHA-256 to SQLite even if the cache path changes", async () => {
  sdk.files.set(installed, artifact);
  sdk.digest.mockImplementationOnce(async (_algorithm, bytes) => {
    sdk.files.set(installed, bundled);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
  const { openBlsPreview } = await import("../src/bls-preview-update");
  const { searchBls } = await import("../src/catalog");
  const approved = await openBlsPreview({ origin, digest });
  if (!approved) throw new Error("Expected the verified preview");
  try {
    expect(await searchBls(approved.db, "Banane", "de")).toMatchObject([
      { name: "Banane aus dem Preview" },
    ]);
  } finally {
    await approved.close();
  }
  expect(await openBlsPreview({ origin, digest })).toBeNull();
});

it("keeps the open bundled connection, stages once, and opens the verified download after reopening offline", async () => {
  const paused = deferred<Response>();
  sdk.fetch.mockResolvedValueOnce(jsonResponse(manifest)).mockReturnValueOnce(paused.promise);
  const open = await startApp(origin, digest);
  const first = await open();
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  const refresh = refreshBlsPreview({ origin, digest });
  expect(refreshBlsPreview({ origin, digest })).toBe(refresh);
  paused.resolve(
    new Response(artifact, { headers: { "Content-Length": String(artifact.byteLength) } }),
  );
  await refresh;
  expect(sdk.fetch.mock.calls.map(([url]) => url)).toEqual([
    `${route}/active.json`,
    `${route}/artifacts/${digest}.sqlite`,
  ]);
  for (const [, options] of sdk.fetch.mock.calls) {
    expect(options).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: { "Accept-Encoding": "identity" },
    });
    expect(options.signal).toBeDefined();
  }
  const committed = sdk.files.get(installed);
  expect(committed && sha256(committed)).toBe(digest);
  expect(sdk.files.has(`${cache}/pending.sqlite`)).toBe(false);
  const { searchBls } = await import("../src/catalog");
  expect(await searchBls(first.db, "Banane", "de")).toMatchObject([{ name: "Banane im Paket" }]);
  const reopened = await open();
  expect(await searchBls(reopened.db, "Banane", "de")).toMatchObject([
    { name: "Banane aus dem Preview" },
  ]);
  await expect(reopened.db.execAsync("DELETE FROM food")).rejects.toThrow(/readonly/);
  expect(sdk.fetch).toHaveBeenCalledTimes(2);
  await first.close();
  await reopened.close();
});

it.each([
  { provider: "open-food-facts" },
  { schemaVersion: 2 },
  { source: { ...manifest.source, release: "4.1" } },
  { source: { ...manifest.source, sha256: "0".repeat(64) } },
  { attribution: { ...manifest.attribution, license: "ODbL" } },
  { artifact: { ...manifest.artifact, sha256: "0".repeat(64) } },
  { artifact: { ...manifest.artifact, bytes: 8 * 1024 * 1024 + 1 } },
])("refuses an ineligible manifest before requesting an artifact", async (override) => {
  sdk.fetch.mockResolvedValueOnce(jsonResponse({ ...manifest, ...override }));
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  await refreshBlsPreview({ origin, digest });
  expect(sdk.fetch).toHaveBeenCalledTimes(1);
  expect(sdk.files.has(installed)).toBe(false);
});

it("rejects redirected, encoded, unframed and overlong manifest responses", async () => {
  const moved = jsonResponse(manifest);
  Object.defineProperty(moved, "redirected", { value: true });
  const encoded = jsonResponse(manifest);
  encoded.headers.set("content-encoding", "gzip");
  sdk.fetch
    .mockResolvedValueOnce(moved)
    .mockResolvedValueOnce(encoded)
    .mockResolvedValueOnce(Response.json(manifest))
    .mockResolvedValueOnce(new Response("xy", { headers: { "Content-Length": "1" } }));
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  await refreshBlsPreview({ origin, digest });
  await refreshBlsPreview({ origin, digest });
  await refreshBlsPreview({ origin, digest });
  await refreshBlsPreview({ origin, digest });
  expect(sdk.fetch.mock.calls.map(([url]) => url)).toEqual([
    `${route}/active.json`,
    `${route}/active.json`,
    `${route}/active.json`,
    `${route}/active.json`,
  ]);
  expect(sdk.files.has(installed)).toBe(false);
});

it.each(["truncated", "oversized", "bad hash", "bad database"] as const)(
  "does not install a %s artifact or leave its staging file",
  async (kind) => {
    let body = artifact;
    if (kind === "truncated") body = artifact.slice(0, -1);
    if (kind === "oversized") body = new Uint8Array(artifact.byteLength + 1);
    if (kind === "bad hash") body = new Uint8Array(artifact.byteLength);
    if (kind === "bad database") body = syntheticCatalog("Banane mit falschem Schema", 2);
    const pin = kind === "bad database" ? sha256(body) : digest;
    const size = kind === "bad database" ? body.byteLength : artifact.byteLength;
    sdk.fetch
      .mockResolvedValueOnce(jsonResponse({ ...manifest, artifact: { bytes: size, sha256: pin } }))
      .mockResolvedValueOnce(new Response(body, { headers: { "Content-Length": String(size) } }));
    const { refreshBlsPreview } = await import("../src/bls-preview-update");
    await refreshBlsPreview({ origin, digest: pin });
    expect(sdk.fetch).toHaveBeenCalledTimes(2);
    expect(sdk.files.has(`${cache}/${pin}.sqlite`)).toBe(false);
    expect(sdk.files.has(`${cache}/pending.sqlite`)).toBe(false);
  },
);

it("falls back offline with a damaged cache and removes only the abandoned stage", async () => {
  sdk.directories.add(cache);
  sdk.files.set(installed, artifact.slice(0, -1));
  sdk.files.set(`${cache}/pending.sqlite`, artifact.slice(0, 16));
  sdk.files.set(`${cache}/${"0".repeat(64)}.sqlite`, artifact);
  sdk.files.set("cache:/diary.sqlite", new Uint8Array());
  const offline = deferred<Response>();
  sdk.fetch.mockReturnValueOnce(offline.promise);
  const open = await startApp(origin, digest);
  const result = await open();
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  const refresh = refreshBlsPreview({ origin, digest });
  offline.reject(new Error("Offline"));
  await refresh;
  const { searchBls } = await import("../src/catalog");
  expect(await searchBls(result.db, "Banane", "de")).toMatchObject([{ name: "Banane im Paket" }]);
  expect(sdk.files.has(`${cache}/pending.sqlite`)).toBe(false);
  expect(sdk.files.has(`${cache}/${"0".repeat(64)}.sqlite`)).toBe(true);
  expect(sdk.files.has("cache:/diary.sqlite")).toBe(true);
  await result.close();
});

it("aborts a stalled manifest request and allows a subsequent catalog open to retry", async () => {
  const { refreshBlsPreview } = await import("../src/bls-preview-update");
  vi.useFakeTimers();
  try {
    sdk.fetch.mockImplementationOnce(
      (_url, { signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        }),
    );
    const first = refreshBlsPreview({ origin, digest });
    await vi.runAllTimersAsync();
    await first;
    expect(sdk.fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    sdk.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await refreshBlsPreview({ origin, digest });
    expect(sdk.fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
