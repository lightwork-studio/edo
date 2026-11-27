import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { publishOpenFoodFactsCatalog } from "@edo/off-import";
import { expect, test } from "vitest";
import { createHealthServer } from "../src/server.ts";

const route = "/catalog-preview/open-food-facts";
const blsRoute = "/catalog-preview/bls";
const blsLicense = "https://creativecommons.org/licenses/by/4.0/";
const blsSource = "https://doi.org/10.25826/Data20251217-134202-0";

test("previews public barcode candidates and the corresponding ODbL release on loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-catalog-preview-"));
  try {
    const inputPath = join(root, "products.jsonl.gz");
    await writeFile(
      inputPath,
      gzipSync(
        JSON.stringify({
          code: "0034000470693",
          product_name_de: "Haferdrink",
          countries_tags: ["en:germany"],
          nutrition: {
            aggregated_set: {
              per: "100ml",
              preparation: "as_sold",
              nutrients: { "energy-kcal": { value: 42, unit: "kcal" } },
            },
          },
        }),
      ),
    );
    const manifest = await publishOpenFoodFactsCatalog({
      inputPath,
      root,
      release: "test-release",
    });
    const activePath = join(root, "open-food-facts", "active.json");
    const published = await readFile(activePath);
    const releaseHash = createHash("sha256").update(published).digest("hex");
    const server = createHealthServer({ catalogRoot: root });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address");
      const get = (relative: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}${route}/${relative}`, init);

      const known = await get("barcodes/034000470693");
      expect(known.status).toBe(200);
      expect(known.headers.get("cache-control")).toBe("no-store");
      expect(await known.json()).toMatchObject({
        status: "found",
        source: "catalog",
        products: [
          {
            barcode: "0034000470693",
            release: manifest.source.release,
            nutrition: { basis: "per-100-ml", nutrients: { kcal: 42, fatG: null } },
          },
        ],
        attribution: {
          license: "https://opendatacommons.org/licenses/odbl/1-0/",
          catalog: `${route}/releases/${releaseHash}.json`,
        },
      });
      const miss = await get("barcodes/12345678");
      expect(miss.status).toBe(404);
      expect(await miss.json()).toMatchObject({ status: "not-found" });
      const malformed = await get("barcodes/bad");
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ status: "invalid" });
      expect((await get("barcodes/12345678", { method: "POST" })).status).toBe(404);

      const active = await get("active.json");
      expect(active.status).toBe(200);
      expect(active.headers.get("cache-control")).toBe("no-cache");
      const activeText = await active.text();
      expect(JSON.parse(activeText)).toEqual(manifest);
      const release = await get(`releases/${releaseHash}.json`);
      expect(await release.text()).toBe(activeText);
      expect(release.headers.get("cache-control")).toContain("immutable");

      const path = `artifacts/${manifest.artifact.sha256}.sqlite`;
      const head = await get(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(manifest.artifact.bytes));
      expect(head.headers.get("link")).toBe(
        '<https://opendatacommons.org/licenses/odbl/1-0/>; rel="license"',
      );
      const sqlite = await get(path);
      expect(
        createHash("sha256")
          .update(Buffer.from(await sqlite.arrayBuffer()))
          .digest("hex"),
      ).toBe(manifest.artifact.sha256);
      expect(
        (await get(path, { headers: { "If-None-Match": `"${manifest.artifact.sha256}"` } })).status,
      ).toBe(304);
      expect((await get(".worker.sqlite")).status).toBe(404);
      expect((await get(`artifacts/${"0".repeat(64)}.sqlite`)).status).toBe(404);
      const second = await publishOpenFoodFactsCatalog({
        inputPath,
        root,
        release: "damaged-second",
      });
      await writeFile(
        join(root, "open-food-facts", "artifacts", `${second.artifact.sha256}.sqlite`),
        "damaged second fixture",
      );
      const fallback = await get("barcodes/034000470693");
      expect(fallback.status).toBe(200);
      expect(await fallback.json()).toMatchObject({
        releaseManifestSha256: releaseHash,
        products: [{ release: manifest.source.release }],
        attribution: { catalog: `${route}/releases/${releaseHash}.json` },
      });
      expect((await get(`releases/${releaseHash}.json`)).status).toBe(200);
      expect((await get(path, { method: "HEAD" })).status).toBe(200);
      await writeFile(join(root, "open-food-facts", path), "damaged fixture");
      expect((await get(path, { method: "HEAD" })).status).toBe(503);
    } finally {
      await server[Symbol.asyncDispose]();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serves the BLS manifest and SQLite bundle from its own licensed catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-bls-preview-"));
  try {
    const staged = join(root, "fixture.sqlite");
    {
      using database = new DatabaseSync(staged);
      database.exec(`CREATE TABLE food (name TEXT NOT NULL);
        INSERT INTO food VALUES ('Synthetic food'); PRAGMA user_version = 1;`);
    }
    const bundle = await readFile(staged);
    const artifactHash = createHash("sha256").update(bundle).digest("hex");
    const manifest = {
      manifestVersion: 1,
      provider: "bls",
      schemaVersion: 1,
      importerVersion: "1",
      source: {
        release: "test-release",
        url: blsSource,
        sha256: createHash("sha256").update("Synthetic food").digest("hex"),
      },
      attribution: {
        name: "Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0",
        license: `CC BY 4.0 (${blsLicense})`,
        changes: "Synthetic preview test",
      },
      artifact: { sha256: artifactHash, bytes: bundle.length },
      counts: { accepted: 1, rejected: 0 },
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    const releaseHash = createHash("sha256").update(manifestText).digest("hex");
    const artifact = `artifacts/${artifactHash}.sqlite`;
    const release = `releases/${releaseHash}.json`;
    const blsRoot = join(root, "bls");
    await Promise.all([
      mkdir(join(blsRoot, "artifacts"), { recursive: true }),
      mkdir(join(blsRoot, "releases"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(blsRoot, "active.json"), manifestText),
      writeFile(join(blsRoot, release), manifestText),
      writeFile(join(blsRoot, artifact), bundle),
    ]);

    const server = createHealthServer({ catalogRoot: root });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address");
      const get = (path: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}${path}`, init);
      const active = await get(`${blsRoute}/active.json`);
      expect(active.status).toBe(200);
      expect(active.headers.get("cache-control")).toBe("no-cache");
      expect(await active.json()).toEqual(manifest);

      const published = await get(`${blsRoute}/${release}`);
      expect(published.status).toBe(200);
      expect(published.headers.get("etag")).toBe(`"${releaseHash}"`);
      expect(published.headers.get("cache-control")).toContain("immutable");
      expect(await published.text()).toBe(manifestText);

      const url = `${blsRoute}/${artifact}`;
      const head = await get(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bundle.length));
      expect(head.headers.get("content-type")).toBe("application/vnd.sqlite3");
      expect(head.headers.get("link")).toBe(
        `<${blsLicense}>; rel="license", <${blsSource}>; rel="cite-as"`,
      );
      expect(await head.text()).toBe("");
      const download = await get(url);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bundle);
      expect((await get(url, { headers: { "If-None-Match": `"${artifactHash}"` } })).status).toBe(
        304,
      );

      expect((await get(`${route}/${artifact}`)).status).toBe(404);
      expect((await get(`${route}/${release}`)).status).toBe(404);
      expect((await get(`${blsRoute}/barcodes/034000470693`)).status).toBe(404);
      await writeFile(join(blsRoot, artifact), "damaged BLS fixture");
      expect((await get(url, { method: "HEAD" })).status).toBe(503);
    } finally {
      await server[Symbol.asyncDispose]();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
