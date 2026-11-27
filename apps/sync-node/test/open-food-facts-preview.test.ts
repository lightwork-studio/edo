import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { publishCatalog } from "@edo/catalog-import";
import { publishOpenFoodFactsCatalog } from "@edo/off-import";
import { expect, it, vi } from "vitest";
import { createHealthServer } from "../src/server.ts";

const prefix = "/catalog-preview/open-food-facts";
const code = "034000470693";
const license = "https://opendatacommons.org/licenses/odbl/1-0/";
const source = "https://world.openfoodfacts.org/data";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publish(root: string, release: string, name: string) {
  const inputPath = join(root, "export.jsonl.gz");
  await writeFile(
    inputPath,
    gzipSync(JSON.stringify({ code, product_name_de: name, countries_tags: ["en:germany"] })),
  );
  return publishOpenFoodFactsCatalog({ root, inputPath, release });
}

it("links barcode products to the exact verified release and exposes its ODbL artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-off-preview-test-"));
  const server = createHealthServer({ catalogRoot: root });
  const pointer = join(root, "open-food-facts", "active.json");
  const localFetch = globalThis.fetch;
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);

  try {
    const firstLabel = "archive-".repeat(2_048);
    const first = await publish(root, firstLabel, "Haferdrink");
    const firstBytes = await readFile(pointer);
    const firstRelease = sha256(firstBytes);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const get = (route: string, init?: RequestInit) =>
      localFetch(`${endpoint}${prefix}/${route}`, init);

    const firstResponse = await get(`barcodes/${code}`);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(await firstResponse.json()).toMatchObject({
      status: "found",
      source: "catalog",
      releaseManifestSha256: firstRelease,
      products: [{ barcode: code, name: "Haferdrink", release: firstLabel }],
      attribution: {
        name: "Open Food Facts contributors",
        license,
        source,
        catalog: `${prefix}/releases/${firstRelease}.json`,
      },
    });
    expect((await get("barcodes/invalid")).status).toBe(400);
    expect((await get("barcodes/12345678")).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect((await get(`barcodes/${code}`, { method: "POST" })).status).toBe(404);

    const release = await get(`releases/${firstRelease}.json`);
    expect(release.status).toBe(200);
    expect(release.headers.get("link")).toBe(
      `<${license}>; rel="license", <${source}>; rel="cite-as"`,
    );
    expect(Buffer.from(await release.arrayBuffer())).toEqual(firstBytes);
    const artifactPath = `artifacts/${first.artifact.sha256}.sqlite`;
    const download = await get(artifactPath);
    expect(download.status).toBe(200);
    expect(sha256(Buffer.from(await download.arrayBuffer()))).toBe(first.artifact.sha256);
    expect((await localFetch(`${endpoint}/catalog-preview/bls/${artifactPath}`)).status).toBe(404);

    await publish(root, "second", "Neue Packung");
    const secondRelease = sha256(await readFile(pointer));
    await expect
      .poll(async () => (await get(`barcodes/${code}`)).json(), { timeout: 10_000 })
      .toMatchObject({
        products: [{ name: "Neue Packung", release: "second" }],
        attribution: { catalog: `${prefix}/releases/${secondRelease}.json` },
      });
    await writeFile(pointer, "damaged activation");
    expect((await get("active.json")).status).toBe(503);
    expect(await (await get(`barcodes/${code}`)).json()).toMatchObject({
      releaseManifestSha256: secondRelease,
      attribution: { catalog: `${prefix}/releases/${secondRelease}.json` },
    });
    expect((await get(`releases/${secondRelease}.json`)).status).toBe(200);
    expect((await get(artifactPath, { method: "HEAD" })).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
    await server[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.each(["manifest attribution", "SQLite attribution"] as const)(
  "rejects an activated release with mismatched %s from barcode and artifact endpoints",
  async (mismatch) => {
    const root = await mkdtemp(join(tmpdir(), "edo-off-preview-metadata-"));
    const server = createHealthServer({ catalogRoot: root });
    try {
      const good = await publish(root, "first", "Haferdrink");
      const artifact = join(root, good.provider, "artifacts", `${good.artifact.sha256}.sqlite`);
      const bad = await publishCatalog(
        {
          ...good,
          root,
          inputPath: join(root, "export.jsonl.gz"),
          attribution: {
            ...good.attribution,
            ...(mismatch === "manifest attribution" && { name: "Incorrect publisher" }),
          },
        },
        {
          async build(_input, output) {
            await copyFile(artifact, output);
            using database = new DatabaseSync(output);
            database.exec(
              mismatch === "SQLite attribution"
                ? "UPDATE catalog_metadata SET attribution = 'Incorrect publisher'"
                : "CREATE TABLE fixture (value INTEGER)",
            );
            return good.counts;
          },
          async validate() {},
        },
      );

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address");
      const endpoint = `http://127.0.0.1:${address.port}${prefix}`;
      expect((await fetch(`${endpoint}/barcodes/${code}`)).status).toBe(503);
      expect((await fetch(`${endpoint}/active.json`)).status).toBe(503);
      expect((await fetch(`${endpoint}/artifacts/${bad.artifact.sha256}.sqlite`)).ok).toBe(false);
    } finally {
      await server[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
