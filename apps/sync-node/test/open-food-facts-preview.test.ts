import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { publishOpenFoodFactsCatalog } from "@edo/off-import";
import { expect, it } from "vitest";
import { createHealthServer } from "../src/server.ts";

const prefix = "/catalog-preview/open-food-facts";
const code = "034000470693";
const license = "https://opendatacommons.org/licenses/odbl/1-0/";
const source = "https://world.openfoodfacts.org/data";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

it("links barcode products to the exact verified release and exposes its ODbL artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-off-preview-test-"));
  const server = createHealthServer({ catalogRoot: root });
  const inputPath = join(root, "export.jsonl.gz");
  const pointer = join(root, "open-food-facts", "active.json");
  async function publish(release: string, name: string) {
    await writeFile(
      inputPath,
      gzipSync(JSON.stringify({ code, product_name_de: name, countries_tags: ["en:germany"] })),
    );
    return publishOpenFoodFactsCatalog({ root, inputPath, release });
  }

  try {
    const first = await publish("first", "Haferdrink");
    const firstBytes = await readFile(pointer);
    const firstRelease = sha256(firstBytes);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const get = (route: string, init?: RequestInit) => fetch(`${endpoint}${prefix}/${route}`, init);

    const firstResponse = await get(`barcodes/${code}`);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(await firstResponse.json()).toMatchObject({
      status: "found",
      source: "catalog",
      releaseManifestSha256: firstRelease,
      products: [{ barcode: code, name: "Haferdrink", release: "first" }],
      attribution: {
        name: "Open Food Facts contributors",
        license,
        source,
        catalog: `${prefix}/releases/${firstRelease}.json`,
      },
    });
    expect((await get("barcodes/invalid")).status).toBe(400);
    expect((await get("barcodes/12345678")).status).toBe(404);
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
    expect((await fetch(`${endpoint}/catalog-preview/bls/${artifactPath}`)).status).toBe(404);

    await publish("second", "Neue Packung");
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
    await server[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
