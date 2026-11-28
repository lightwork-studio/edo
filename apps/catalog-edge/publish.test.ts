import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { publishOpenFoodFactsCatalog } from "../../packages/off-import/src/index.ts";
import { publishCatalogToR2 } from "./publish.ts";
import worker from "./worker.ts";

test("publishes and verifies catalog objects before the conditional active write", async () => {
  const root = await mkdtemp(join(tmpdir(), "edo-r2-publish-test-"));
  try {
    const inputPath = join(root, "source.jsonl.gz");
    await writeFile(
      inputPath,
      gzipSync(
        JSON.stringify({
          code: "10000000",
          countries_tags: ["en:germany"],
          product_name: "Fixture",
        }),
      ),
    );
    await publishOpenFoodFactsCatalog({ root, release: "full-fixture", inputPath });

    const objects = new Map<string, Buffer>();
    const writes: string[] = [];
    const active = "open-food-facts/state.json";
    const fakeR2: Parameters<typeof publishCatalogToR2>[0] = async (operation, key, ...args) => {
      if (operation === "get-object") {
        const object = objects.get(key);
        if (!object || !args[0]) throw new Error("test object is missing");
        await writeFile(args[0], object);
      } else {
        expect(operation).toBe("put-object");
        const [condition, etag, bodyFlag, path] = args;
        expect(bodyFlag).toBe("--body");
        if (!path) throw new Error("test upload body is missing");
        if (key === active && condition === "--if-match") {
          if (etag !== '"saved-object"') {
            throw Object.assign(new Error("PreconditionFailed"), {
              stderr: "(PreconditionFailed)",
            });
          }
          objects.set(key, await readFile(path));
          writes.push(key);
          return { ETag: '"saved-object"' };
        }
        if (objects.has(key)) {
          throw Object.assign(new Error("PreconditionFailed"), { stderr: "(PreconditionFailed)" });
        }
        expect(args.slice(0, 2)).toEqual(["--if-none-match", "*"]);
        objects.set(key, await readFile(path));
        writes.push(key);
      }
      return { ETag: '"saved-object"' };
    };

    const sha = await publishCatalogToR2(fakeR2, root, "open-food-facts", undefined, root);
    expect(writes.at(-1)).toBe(active);
    const activeObject = objects.get(active);
    if (!activeObject) throw new Error("Expected active state");
    const state = JSON.parse(activeObject.toString("utf8"));
    expect(state.active).toBe(sha);
    expect(objects.has(`open-food-facts/releases/${sha}.json`)).toBe(true);
    const indexKey = `open-food-facts/lookup/${sha}.json`;
    const index = objects.get(indexKey);
    if (!index) throw new Error("Expected the published lookup index");
    expect(state.barcodeIndexes).toEqual({
      [sha]: createHash("sha256").update(index).digest("hex"),
    });

    await expect(
      publishCatalogToR2(fakeR2, root, "open-food-facts", { etag: '"stale-object"', state }, root),
    ).rejects.toThrow("PreconditionFailed");
    expect(writes.filter((key) => key === active)).toHaveLength(1);

    const env: Parameters<typeof worker.fetch>[1] = {
      CATALOGS: {
        async get(key) {
          const object = objects.get(key);
          if (!object) return null;
          const body = new Response(new Uint8Array(object));
          return {
            size: object.byteLength,
            body: body.body as ReadableStream,
            arrayBuffer: () => new Response(new Uint8Array(object)).arrayBuffer(),
          };
        },
      },
    };
    const request = () =>
      new Request("https://edo.timweb.app/catalog-preview/open-food-facts/barcodes/10000000");
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      releaseManifestSha256: sha,
      products: [{ name: "Fixture", release: "full-fixture" }],
    });
    objects.set(indexKey, Buffer.from("{}"));
    expect((await worker.fetch(request(), env)).status).toBe(503);

    objects.set(indexKey, index);
    objects.set(
      active,
      Buffer.from(JSON.stringify({ ...state, releases: { [sha]: "f".repeat(64) } })),
    );
    expect((await worker.fetch(request(), env)).status).toBe(503);

    objects.set(active, activeObject);
    await writeFile(
      inputPath,
      gzipSync(
        JSON.stringify({
          code: "10000001",
          countries_tags: ["en:germany"],
          product_name: "Next fixture",
        }),
      ),
    );
    await publishOpenFoodFactsCatalog({ root, release: "next-fixture", inputPath });
    const next = await publishCatalogToR2(
      fakeR2,
      root,
      "open-food-facts",
      { etag: '"saved-object"', state },
      root,
    );
    expect(next).not.toBe(sha);
    const nextState = objects.get(active);
    const nextIndex = objects.get(`open-food-facts/lookup/${next}.json`);
    if (!nextState || !nextIndex) throw new Error("Expected the next publication");
    expect(JSON.parse(nextState.toString("utf8"))).toMatchObject({
      active: next,
      releases: state.releases,
      barcodeIndexes: {
        [sha]: state.barcodeIndexes[sha],
        [next]: createHash("sha256").update(nextIndex).digest("hex"),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
