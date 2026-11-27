import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBarcodeLookup,
  openFoodFactsCatalog,
  openOpenFoodFactsCatalog,
  publishOpenFoodFactsCatalog,
} from "../src/index.ts";
import { checkOpenFoodFactsHealth, refreshOpenFoodFactsCatalog } from "../src/refresh.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const product = {
  _id: "0123456789",
  code: "0123456789",
  product_name_de: "Kartoffelchips",
  countries_tags: ["en:germany"],
};
const modified = "Thu, 26 Nov 2026 05:41:49 GMT";

function compressed(...rows: unknown[]): Buffer {
  return gzipSync(rows.map((row) => JSON.stringify(row)).join("\n"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

let directory: string;
let providerRoot: string;
let activePath: string;
let origin: string;
let exportPath: string;
let source: Buffer;
let etag: string;
let lastModified: string;
let handleGet: (response: ServerResponse) => void;
let requests: { method: string | undefined; condition: string | undefined }[];
let server: ReturnType<typeof createServer>;
let fetchExport: typeof fetch;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "edo-off-refresh-"));
  providerRoot = join(directory, openFoodFactsCatalog.provider);
  activePath = join(providerRoot, "active.json");
  exportPath = "/export";
  source = compressed(product);
  etag = '"synthetic-1"';
  lastModified = modified;
  handleGet = (response) => response.end(source);
  requests = [];
  server = createServer((request, response) => {
    if (request.url === "/data/openfoodfacts-products.jsonl.gz") {
      response.writeHead(302, { Location: exportPath }).end();
      return;
    }
    requests.push({
      method: request.method,
      condition: request.headers["if-match"] ?? request.headers["if-unmodified-since"],
    });
    response.setHeader("Content-Type", "application/gzip");
    response.setHeader("Content-Length", source.length);
    response.setHeader("Last-Modified", lastModified);
    response.setHeader("ETag", etag);
    if (request.method === "HEAD") response.end();
    else handleGet(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test server");
  origin = `http://127.0.0.1:${address.port}`;
  fetchExport = (input, init) => {
    if (input !== openFoodFactsCatalog.sourceUrl) throw new Error("Unexpected export source");
    return fetch(`${origin}${new URL(input).pathname}`, init);
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  await rm(directory, { recursive: true, force: true });
});

it("publishes a verified gzip and skips downloading or reactivating an unchanged export", async () => {
  source = compressed(product, { ...product, countries_tags: ["en:france"] }, null);
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath, "utf8");
  const files = (await readdir(providerRoot, { recursive: true })).sort();

  expect(first).toMatchObject({
    status: "published",
    activatedAt: (await stat(activePath)).mtime.toISOString(),
    manifest: {
      source: {
        release: `${createHash("sha256").update(`${origin}${exportPath}`).digest("hex")}:etag:${etag}:${source.length}`,
        url: openFoodFactsCatalog.sourceUrl,
        lastModified: new Date(modified).toISOString(),
        sha256: createHash("sha256").update(source).digest("hex"),
      },
      counts: { accepted: 1, rejected: 1, skipped: 1 },
    },
  });
  expect(Date.parse(first.checkedAt)).toBeLessThanOrEqual(Date.parse(first.activatedAt));
  expect(JSON.parse(active)).toEqual(first.manifest);
  expect(requests).toEqual([
    { method: "HEAD", condition: undefined },
    { method: "GET", condition: etag },
    { method: "HEAD", condition: undefined },
  ]);
  const priorArtifact = join(providerRoot, "artifacts", `${first.manifest.artifact.sha256}.sqlite`);
  using database = new DatabaseSync(priorArtifact, { readOnly: true });
  expect(database.prepare("SELECT name FROM food").get()).toEqual({ name: "Kartoffelchips" });

  // A terminated worker can leave a partial download while the committed release remains usable.
  await writeFile(join(providerRoot, ".catalog-managed-source"), "partial download");
  await writeFile(join(providerRoot, ".refresh-source.jsonl.gz"), "legacy partial download");
  requests.length = 0;
  expect(await refreshOpenFoodFactsCatalog(directory, fetchExport)).toMatchObject({
    status: "unchanged",
    activatedAt: first.activatedAt,
    manifest: first.manifest,
  });
  expect(requests).toEqual([{ method: "HEAD", condition: undefined }]);
  expect(await readFile(activePath, "utf8")).toBe(active);
  expect((await readdir(providerRoot, { recursive: true })).sort()).toEqual(files);

  etag = '"synthetic-2"';
  source = compressed({ ...product, product_name_de: "Chips" });
  const second = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(second.status).toBe("published");
  expect(second.manifest.artifact.sha256).not.toBe(first.manifest.artifact.sha256);
  expect(await readFile(priorArtifact)).toHaveLength(first.manifest.artifact.bytes);
});

it("reimports the same upstream release when the active importer version is older", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const legacy = `${JSON.stringify({ ...first.manifest, importerVersion: "1" }, null, 2)}\n`;
  const legacyDigest = createHash("sha256").update(legacy).digest("hex");
  await writeFile(join(providerRoot, "releases", `${legacyDigest}.json`), legacy);
  await writeFile(activePath, legacy);
  requests.length = 0;

  const upgraded = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(upgraded.status).toBe("published");
  expect(upgraded.manifest).toMatchObject({ source: first.manifest.source, importerVersion: "2" });
  expect(requests).toEqual([
    { method: "HEAD", condition: undefined },
    { method: "GET", condition: etag },
    { method: "HEAD", condition: undefined },
  ]);
});

it("checks age from the source timestamp without reactivating or requesting the export", async () => {
  const result = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  const modifiedAt = Date.parse(modified);
  const now = new Date(modifiedAt + 36 * 60 * 60 * 1000);
  requests.length = 0;

  await expect(checkOpenFoodFactsHealth(directory, 36, now)).resolves.toMatchObject({
    status: "healthy",
    checkedAt: now.toISOString(),
    sourceAgeHours: 36,
    sourceLastModified: new Date(modifiedAt).toISOString(),
    activatedAt: result.activatedAt,
    artifactSha256: result.manifest.artifact.sha256,
  });
  await expect(
    checkOpenFoodFactsHealth(directory, 36, new Date(now.getTime() + 1)),
  ).resolves.toMatchObject({ status: "stale" });
  await expect(
    checkOpenFoodFactsHealth(directory, 36, new Date(modifiedAt - 1)),
  ).resolves.toMatchObject({ status: "future-source" });
  expect(requests).toEqual([]);
  expect(await readFile(activePath)).toEqual(active);
  expect((await stat(activePath)).mtime.toISOString()).toBe(result.activatedAt);
});

it("records a newly available source timestamp without downloading an unchanged export", async () => {
  lastModified = "";
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(first.manifest.source.lastModified).toBeUndefined();
  const active = await readFile(activePath);
  const digest = createHash("sha256").update(active).digest("hex");
  const previous = join(providerRoot, "releases", `${digest}.json`);
  const artifacts = join(providerRoot, "artifacts");
  const files = await readdir(artifacts);
  const file = join(artifacts, `${first.manifest.artifact.sha256}.sqlite`);
  const before = await stat(file, { bigint: true });

  lastModified = modified;
  requests.length = 0;
  const next = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(requests).toEqual([{ method: "HEAD", condition: undefined }]);
  expect(next.status).toBe("published");
  expect(next.manifest.artifact).toEqual(first.manifest.artifact);
  expect(next.manifest.source).toEqual({
    ...first.manifest.source,
    lastModified: new Date(modified).toISOString(),
  });
  expect(await readFile(previous)).toEqual(active);
  expect(await readdir(artifacts)).toEqual(files);
  expect((await stat(file, { bigint: true })).ino).toBe(before.ino);

  const now = new Date(Date.parse(modified) + 60 * 60 * 1000);
  await expect(checkOpenFoodFactsHealth(directory, 36, now)).resolves.toMatchObject({
    status: "healthy",
  });
  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).resolves.toMatchObject({
    status: "unchanged",
    manifest: next.manifest,
  });
});

it("reports missing, undated and corrupt releases without changing the filesystem", async () => {
  await expect(checkOpenFoodFactsHealth(directory, 36)).resolves.toMatchObject({
    status: "unverified",
  });
  await expect(lstat(providerRoot)).rejects.toMatchObject({ code: "ENOENT" });

  lastModified = "";
  const { manifest } = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  await expect(checkOpenFoodFactsHealth(directory, 36)).resolves.toMatchObject({
    status: "unknown-source-age",
    sourceLastModified: null,
  });

  const artifact = join(providerRoot, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  await writeFile(artifact, Buffer.alloc(manifest.artifact.bytes));
  await expect(checkOpenFoodFactsHealth(directory, 36)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(await readFile(artifact)).toEqual(Buffer.alloc(manifest.artifact.bytes));
});

it("keeps the last verified release when a new export loses more than half its products", async () => {
  const products = Array.from({ length: 10 }, (_, number) => ({
    ...product,
    _id: String(12345600 + number),
    code: String(12345600 + number),
  }));
  source = compressed(...products);
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  const before = await stat(activePath, { bigint: true });
  const files = (await readdir(providerRoot, { recursive: true })).sort();

  etag = '"unexpectedly-small"';
  source = compressed(...products.slice(0, 4));
  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
    "Open Food Facts refresh accepted 4 products, below the minimum of 5",
  );
  expect(await readFile(activePath)).toEqual(active);
  expect((await stat(activePath, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect((await readdir(providerRoot, { recursive: true })).sort()).toEqual(files);

  etag = '"recovered"';
  source = compressed(...products.slice(0, 5));
  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).resolves.toMatchObject({
    status: "published",
    manifest: { counts: { accepted: 5 } },
  });
});

it("uses a weak ETag as an identity hint and the timestamp as the download condition", async () => {
  etag = 'W/"synthetic-1"';
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(
    first.manifest.source.release.endsWith(
      `:last-modified:${new Date(modified).toISOString()}:${source.length}:${etag}`,
    ),
  ).toBe(true);
  expect(requests[1]).toEqual({ method: "GET", condition: modified });
  expect((await refreshOpenFoodFactsCatalog(directory, fetchExport)).status).toBe("unchanged");

  etag = 'W/"synthetic-2"';
  requests.length = 0;
  const second = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(second.status).toBe("published");
  expect(second.manifest.source.release).not.toBe(first.manifest.source.release);
  expect(requests[1]).toEqual({ method: "GET", condition: modified });
});

it("downloads a different redirect resource even when its strong validator and length match", async () => {
  source = compressed({ ...product, product_name_de: "Chips A" });
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);

  exportPath = "/replaced?token=fixture-secret";
  const replacement = compressed({ ...product, product_name_de: "Chips B" });
  expect(replacement.length).toBe(source.length);
  source = replacement;
  requests.length = 0;
  const second = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(second.status).toBe("published");
  expect(second.manifest.source.release).not.toBe(first.manifest.source.release);
  expect(second.manifest.source.sha256).not.toBe(first.manifest.source.sha256);
  expect(JSON.stringify(second)).not.toContain("fixture-secret");
  expect(requests[1]).toEqual({ method: "GET", condition: etag });
});

it("rejects an older upstream source before downloading it", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath, "utf8");
  etag = '"older-version"';
  lastModified = "Wed, 25 Nov 2026 05:41:49 GMT";
  requests.length = 0;

  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
    "Open Food Facts export is older than the active release",
  );
  expect(requests).toEqual([{ method: "HEAD", condition: undefined }]);
  expect(await readFile(activePath, "utf8")).toBe(active);
  expect((await stat(activePath)).mtime.toISOString()).toBe(first.activatedAt);
});

it("rejects a future source timestamp without replacing the active release", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  etag = '"future-version"';
  lastModified = "Thu, 26 Nov 2099 05:41:49 GMT";
  requests.length = 0;

  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
    "Open Food Facts export has a future source timestamp",
  );
  expect(requests).toEqual([{ method: "HEAD", condition: undefined }]);
  expect(await readFile(activePath)).toEqual(active);

  lastModified = "Fri, 27 Nov 2026 05:41:49 GMT";
  source = compressed({ ...product, product_name_de: "Corrected chips" });
  const retry = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(retry.status).toBe("published");
  expect(retry.manifest.source.release).not.toBe(first.manifest.source.release);
});

it("replaces an existing future-dated timestamp without rebuilding identical source bytes", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const future = `${JSON.stringify(
    {
      ...first.manifest,
      source: { ...first.manifest.source, lastModified: "2099-11-26T05:41:49.000Z" },
    },
    null,
    2,
  )}\n`;
  const digest = createHash("sha256").update(future).digest("hex");
  await writeFile(join(providerRoot, "releases", `${digest}.json`), future);
  await writeFile(activePath, future);
  requests.length = 0;

  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).resolves.toMatchObject({
    status: "published",
    manifest: first.manifest,
  });
  expect(requests).toEqual([{ method: "HEAD", condition: undefined }]);
});

it("does not let an unverified active timestamp block recovery", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  const digest = createHash("sha256").update(active).digest("hex");
  const immutable = join(providerRoot, "releases", `${digest}.json`);
  await writeFile(
    activePath,
    JSON.stringify({
      ...first.manifest,
      source: { ...first.manifest.source, lastModified: "2099-11-26T05:41:49.000Z" },
    }),
  );

  etag = '"recovered"';
  source = compressed({ ...product, product_name_de: "Chips" });
  const updated = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(updated.status).toBe("published");
  expect(updated.manifest.source.lastModified).toBe(new Date(modified).toISOString());
  expect(await readFile(immutable)).toEqual(active);
});

it.each(["license", "release"])(
  "rejects a hash-matched catalog with inconsistent %s",
  async (field) => {
    const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
    const { manifest } = first;
    const incompatible =
      field === "license"
        ? { ...manifest, attribution: { ...manifest.attribution, license: "CC-BY-4.0" } }
        : { ...manifest, source: { ...manifest.source, release: "different-release" } };
    const text = `${JSON.stringify(incompatible, null, 2)}\n`;
    const digest = createHash("sha256").update(text).digest("hex");
    await writeFile(join(providerRoot, "releases", `${digest}.json`), text);
    await writeFile(activePath, text);

    const now = new Date(Date.parse(modified) + 60 * 60 * 1000);
    await expect(checkOpenFoodFactsHealth(directory, 36, now)).resolves.toMatchObject({
      status: "unverified",
    });
    await expect(openOpenFoodFactsCatalog(directory)).rejects.toThrow(/manifest/);
    await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).resolves.toMatchObject({
      status: "published",
      manifest,
    });
  },
);

it("rebuilds the active pointer when it is a symlink to a valid manifest", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  const digest = createHash("sha256").update(active).digest("hex");
  const immutable = join(providerRoot, "releases", `${digest}.json`);
  await rename(activePath, join(directory, "original-active.json"));
  await symlink(immutable, activePath, "file");

  await expect(openOpenFoodFactsCatalog(directory)).rejects.toThrow(/regular file/);
  const retry = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(retry.status).toBe("published");
  expect(retry.manifest).toEqual(first.manifest);
  expect((await lstat(activePath)).isFile()).toBe(true);
  expect(await readFile(activePath)).toEqual(active);
  expect(await readFile(immutable)).toEqual(active);
});

it("retains the open catalog when the next verified artifact path is replaced with a symlink", async () => {
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  using lookup = createBarcodeLookup(directory, { liveLookup: null });
  await expect(lookup.lookupBarcode(product.code)).resolves.toMatchObject({
    status: "found",
    products: [{ name: "Kartoffelchips" }],
  });

  source = compressed({ ...product, product_name_de: "Chips" });
  etag = '"symlink-candidate"';
  const { manifest } = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const artifact = join(providerRoot, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  const elsewhere = join(directory, "candidate.sqlite");
  await rename(artifact, elsewhere);
  await symlink(elsewhere, artifact, "file");

  await expect(checkOpenFoodFactsHealth(directory, 36)).resolves.toMatchObject({
    status: "unverified",
  });
  await expect(openOpenFoodFactsCatalog(directory)).rejects.toThrow(/regular file/);
  await expect(lookup.lookupBarcode(product.code)).resolves.toMatchObject({
    status: "found",
    products: [{ name: "Kartoffelchips" }],
  });
});

it("stops the default transport before following an HTTPS downgrade", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://export.example.test/source" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "http://export.example.test/plain" },
      }),
    );
  vi.stubGlobal("fetch", request);

  await expect(refreshOpenFoodFactsCatalog(directory)).rejects.toThrow(
    "Open Food Facts export requires HTTPS",
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenNthCalledWith(
    1,
    new URL(openFoodFactsCatalog.sourceUrl),
    expect.objectContaining({ redirect: "manual" }),
  );
  expect(request).toHaveBeenNthCalledWith(
    2,
    new URL("https://export.example.test/source"),
    expect.objectContaining({ redirect: "manual" }),
  );
});

it("preserves the active release after a failed download or import and allows a retry", async () => {
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath, "utf8");
  const files = (await readdir(providerRoot, { recursive: true })).sort();
  const activatedAt = (await stat(activePath)).mtimeMs;
  etag = '"synthetic-2"';
  const checkFailure = async (message?: string) => {
    await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(message);
    expect(await readFile(activePath, "utf8")).toBe(active);
    expect((await stat(activePath)).mtimeMs).toBe(activatedAt);
    expect((await readdir(providerRoot, { recursive: true })).sort()).toEqual(files);
  };

  handleGet = (response) => {
    response.setHeader("Connection", "close");
    response.end(source.subarray(0, -5));
  };
  await checkFailure();

  handleGet = (response) => response.end(source);
  source = compressed(product).subarray(0, -5);
  await checkFailure("unexpected end of file");

  source = compressed({ ...product, countries_tags: ["en:france"] });
  await checkFailure("Open Food Facts refresh accepted 0 products, below the minimum of 1");

  source = compressed(product);
  handleGet = (response) => {
    response.end(source);
    etag = '"synthetic-3"';
  };
  await checkFailure("changed during refresh");

  handleGet = (response) => response.end(source);
  expect((await refreshOpenFoodFactsCatalog(directory, fetchExport)).status).toBe("published");
});

it.each(["headers", "body"] as const)(
  "aborts a stalled export while waiting for %s",
  async (phase) => {
    await refreshOpenFoodFactsCatalog(directory, fetchExport);
    const active = await readFile(activePath);
    const activated = (await stat(activePath, { bigint: true })).mtimeNs;
    etag = '"changed"';
    const stalled = deferred<AbortSignal>();
    const nextChunk = deferred<void>();
    let advanceBody: (() => void) | undefined;
    const fetchStalled: typeof fetch = async (_input, init) => {
      const headers = {
        "Content-Length": String(source.length),
        "Last-Modified": modified,
        ETag: etag,
      };
      const wrap = (body: ReadableStream<Uint8Array> | null) => {
        const response = new Response(body, { headers });
        Object.defineProperty(response, "url", { value: `${origin}${exportPath}` });
        return response;
      };
      if (init?.method === "HEAD") return wrap(null);
      const signal = init?.signal;
      if (!signal) throw new Error("Expected a cancellable GET");
      if (phase === "headers") {
        stalled.resolve(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      let reads = 0;
      return wrap(
        new ReadableStream<Uint8Array>(
          {
            start(stream) {
              signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
              advanceBody = () => stream.enqueue(source.subarray(1, 2));
            },
            pull(stream) {
              reads += 1;
              if (reads === 1) stream.enqueue(source.subarray(0, 1));
              if (reads === 2) stalled.resolve(signal);
              if (reads === 3) nextChunk.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = expect(refreshOpenFoodFactsCatalog(directory, fetchStalled)).rejects.toThrow(
        "Open Food Facts download stalled for 60 seconds",
      );
      const signal = await stalled.promise;
      if (phase === "body") {
        await vi.advanceTimersByTimeAsync(40_000);
        advanceBody?.();
        await nextChunk.promise;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(40_000);
      } else {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await result;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    expect(await readFile(activePath)).toEqual(active);
    expect((await stat(activePath, { bigint: true })).mtimeNs).toBe(activated);
    await expect(lstat(join(providerRoot, ".catalog-managed-source"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await refreshOpenFoodFactsCatalog(directory, fetchExport)).status).toBe("published");
  },
);

it("removes the download when the idle deadline passes while opening its destination", async () => {
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  etag = '"after-timeout"';
  const sourcePath = join(providerRoot, ".catalog-managed-source");
  const entered = deferred<void>();
  const resume = deferred<void>();
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === sourcePath && flags === "wx") {
      entered.resolve();
      await resume.promise;
    }
    return real.open(path, flags, mode);
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const rejected = expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
      "Open Food Facts download stalled for 60 seconds",
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    resume.resolve();
    await rejected;
  } finally {
    resume.resolve();
    vi.mocked(open).mockImplementation(real.open);
    vi.useRealTimers();
  }

  expect(await readFile(activePath)).toEqual(active);
  await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await refreshOpenFoodFactsCatalog(directory, fetchExport)).status).toBe("published");
});

it("rejects competing refresh and public manual publication under the same lock", async () => {
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const inputPath = join(directory, "manual-source.jsonl.gz");
  await writeFile(inputPath, source);
  requests.length = 0;
  using lock = new DatabaseSync(join(providerRoot, ".worker.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
    "Another Open Food Facts catalog job is running",
  );
  await expect(
    publishOpenFoodFactsCatalog({ root: directory, inputPath, release: "manual" }),
  ).rejects.toThrow("Another Open Food Facts catalog job is running");
  expect(requests).toEqual([]);
});

it("keeps corrupt immutable data for quarantine and can rebuild after it is moved aside", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath, "utf8");
  const artifact = join(providerRoot, "artifacts", `${first.manifest.artifact.sha256}.sqlite`);
  const corrupted = Buffer.alloc(first.manifest.artifact.bytes);
  await writeFile(artifact, corrupted);

  await expect(refreshOpenFoodFactsCatalog(directory, fetchExport)).rejects.toThrow(
    "Stored catalog file does not match its checksum",
  );
  expect(await readFile(activePath, "utf8")).toBe(active);
  expect(await readFile(artifact)).toEqual(corrupted);

  await rename(artifact, join(directory, "quarantined.sqlite"));
  expect(await refreshOpenFoodFactsCatalog(directory, fetchExport)).toMatchObject({
    status: "published",
    manifest: first.manifest,
  });
});

it("can publish a newer release when the old immutable manifest is not a regular file", async () => {
  await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const active = await readFile(activePath);
  const hash = createHash("sha256").update(active).digest("hex");
  const corruptPath = join(providerRoot, "releases", `${hash}.json`);
  const oldManifest = join(directory, "original-manifest.json");
  await rename(corruptPath, oldManifest);
  await mkdir(corruptPath);

  etag = '"newer"';
  source = compressed({ ...product, product_name_de: "Chips" });
  const updated = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(updated.status).toBe("published");
  expect(JSON.parse(await readFile(activePath, "utf8"))).toEqual(updated.manifest);
  expect((await stat(corruptPath)).isDirectory()).toBe(true);
  expect(await readFile(oldManifest)).toEqual(active);
});

it("can publish a newer release without following a corrupt prior artifact symlink", async () => {
  const first = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  const artifact = join(providerRoot, "artifacts", `${first.manifest.artifact.sha256}.sqlite`);
  const original = join(directory, "original-catalog.sqlite");
  await rename(artifact, original);
  await symlink(artifact, artifact, "file");

  etag = '"newer"';
  source = compressed({ ...product, product_name_de: "Chips" });
  const updated = await refreshOpenFoodFactsCatalog(directory, fetchExport);
  expect(updated.status).toBe("published");
  expect(JSON.parse(await readFile(activePath, "utf8"))).toEqual(updated.manifest);
  expect((await lstat(artifact)).isSymbolicLink()).toBe(true);
  const preserved = await readFile(original);
  expect(createHash("sha256").update(preserved).digest("hex")).toBe(first.manifest.artifact.sha256);
});
