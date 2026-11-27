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
    const active = "open-food-facts/active.json";
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
          expect(etag).toBe('"stale-object"');
          throw Object.assign(new Error("PreconditionFailed"), { stderr: "(PreconditionFailed)" });
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
    expect(objects.get(active)).toEqual(objects.get(`open-food-facts/releases/${sha}.json`));

    await expect(
      publishCatalogToR2(fakeR2, root, "open-food-facts", '"stale-object"', root),
    ).rejects.toThrow("PreconditionFailed");
    expect(writes.filter((key) => key === active)).toHaveLength(1);

    const response = await worker.fetch(
      new Request("https://edo.timweb.app/catalog-preview/open-food-facts/barcodes/10000000"),
      {
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
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      releaseManifestSha256: sha,
      products: [{ name: "Fixture", release: "full-fixture" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
