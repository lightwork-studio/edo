import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CatalogManifest, publishCatalog } from "@edo/catalog-import";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHealthServer } from "../src/server.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const provider = "bls";
const license = "https://creativecommons.org/licenses/by/4.0/";
const source = "https://doi.org/10.25826/Data20251217-134202-0";
const attribution = "Max Rubner-Institut";
const changes = "Indexed symmetric fixture labels";
const prefix = "/catalog-preview/bls";
let root: string;
let server: Server;
let endpoint: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edo-bls-server-test-"));
  server = createHealthServer({ catalogRoot: root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.mocked(rename).mockImplementation(realFs.rename);
  await server[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
});

function get(path: string, init?: RequestInit) {
  return fetch(`${endpoint}${prefix}/${path}`, init);
}

function releasePath(digest: string) {
  return `releases/${digest}.json`;
}

function artifactPath(manifest: CatalogManifest) {
  return `artifacts/${manifest.artifact.sha256}.sqlite`;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publish(release: string, storedRelease = release) {
  const inputPath = join(root, "source.txt");
  await writeFile(inputPath, release);
  return publishCatalog(
    {
      root,
      inputPath,
      provider,
      schemaVersion: 1,
      importerVersion: "1",
      source: { release, url: source },
      attribution: { name: attribution, license: `CC BY 4.0 (${license})`, changes },
    },
    {
      async build(_input, output) {
        using database = new DatabaseSync(output);
        database.exec(`
          CREATE TABLE catalog_metadata (
            singleton INTEGER PRIMARY KEY, provider TEXT, release TEXT, source_url TEXT,
            attribution TEXT, license_url TEXT, changes TEXT
          ) STRICT;
          PRAGMA user_version = 1;
        `);
        database
          .prepare("INSERT INTO catalog_metadata VALUES (1, ?, ?, ?, ?, ?, ?)")
          .run(provider, storedRelease, source, attribution, license, changes);
        return { accepted: 1, rejected: 0 };
      },
      async validate() {},
    },
  );
}

it("serves exact active and immutable BLS bytes with attribution and HTTP validators", async () => {
  const manifest = await publish("original");
  const active = await get("active.json");
  expect(active.status).toBe(200);
  expect(active.headers.get("cache-control")).toBe("no-cache");
  const body = Buffer.from(await active.arrayBuffer());
  expect(JSON.parse(body.toString("utf8"))).toEqual(manifest);
  const activeDigest = digest(body);
  const release = await get(releasePath(activeDigest));
  expect(release.status).toBe(200);
  expect(release.headers.get("etag")).toBe(`"${activeDigest}"`);
  expect(release.headers.get("cache-control")).toContain("immutable");
  expect(Buffer.from(await release.arrayBuffer())).toEqual(body);

  const path = artifactPath(manifest);
  const head = await get(path, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(manifest.artifact.bytes));
  expect(head.headers.get("content-type")).toBe("application/vnd.sqlite3");
  expect(head.headers.get("link")).toBe(`<${license}>; rel="license", <${source}>; rel="cite-as"`);
  expect(await head.text()).toBe("");
  expect(
    (
      await get(path, {
        headers: { "If-None-Match": `"other,tag", W/"${manifest.artifact.sha256}"` },
      })
    ).status,
  ).toBe(304);
  const artifact = await get(path);
  expect(artifact.status).toBe(200);
  await writeFile(join(root, provider, path), "later external damage");
  expect(digest(Buffer.from(await artifact.arrayBuffer()))).toBe(manifest.artifact.sha256);
  expect((await get(path, { method: "HEAD" })).status).toBe(503);
  expect((await fetch(`${endpoint}/catalog-preview/open-food-facts/${path}`)).status).toBe(404);
});

it("withholds staged immutable paths until activation and keeps the displaced release addressable", async () => {
  const previous = await publish("previous");
  const active = join(root, provider, "active.json");
  const original = await readFile(active);
  const previousPath = releasePath(digest(original));
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (to === active) throw new Error("Interrupted before activation");
    await realFs.rename(from, to);
  });
  try {
    await expect(publish("next")).rejects.toThrow("Interrupted before activation");
  } finally {
    vi.mocked(rename).mockImplementation(realFs.rename);
  }
  const files = await readdir(join(root, provider, "releases"));
  const staged = files.find((name) => `releases/${name}` !== previousPath);
  if (!staged) throw new Error("Expected an unactivated immutable manifest");
  const stagedPath = `releases/${staged}`;
  const stagedManifest = JSON.parse(
    await readFile(join(root, provider, stagedPath), "utf8"),
  ) as CatalogManifest;

  expect(Buffer.from(await (await get("active.json")).arrayBuffer())).toEqual(original);
  expect((await get(stagedPath)).status).toBe(404);
  expect((await get(artifactPath(stagedManifest), { method: "HEAD" })).status).toBe(404);
  expect((await get(previousPath)).status).toBe(200);

  await publish("next");
  expect((await get(stagedPath)).status).toBe(200);
  expect((await get(artifactPath(stagedManifest), { method: "HEAD" })).status).toBe(200);
  expect((await get(previousPath)).status).toBe(200);
  expect((await get(artifactPath(previous), { method: "HEAD" })).status).toBe(200);
});

it("rejects a checksum-valid SQLite artifact whose metadata claims a different release", async () => {
  const previous = await publish("previous");
  const mismatched = await publish("latest", "other");
  expect((await get("active.json")).status).toBe(503);
  expect((await get(artifactPath(mismatched))).status).toBe(503);
  expect((await get(artifactPath(previous), { method: "HEAD" })).status).toBe(200);
});
