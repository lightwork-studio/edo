import { copyFile, lstat, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { publishCatalog } from "@edo/catalog-import";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBarcodeLookup,
  openOpenFoodFactsCatalog,
  publishOpenFoodFactsCatalog,
} from "../src/index.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp), open: vi.fn(fs.open) };
});

const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const provider = "open-food-facts";
const code = "034000470693";
let directory: string;
let root: string;
let inputPath: string;
let snapshots: string[];

beforeEach(async () => {
  snapshots = [];
  vi.mocked(mkdtemp).mockImplementation(async (prefix, options) => {
    const path = await realFs.mkdtemp(prefix, options);
    if (String(prefix).endsWith("edo-off-reader-")) snapshots.push(path);
    return path;
  });
  directory = await mkdtemp(join(tmpdir(), "edo-reader-test-"));
  root = join(directory, "catalogs");
  inputPath = join(directory, "source.jsonl.gz");
});

afterEach(async () => {
  vi.mocked(open).mockImplementation(realFs.open);
  vi.mocked(mkdtemp).mockImplementation(realFs.mkdtemp);
  await Promise.all(
    [directory, ...snapshots].map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function publish(name: string, release: string) {
  const products = [code, "12345678"].map((barcode) => ({
    _id: barcode,
    code: barcode,
    product_name_de: name,
    countries_tags: ["en:germany"],
  }));
  await writeFile(
    inputPath,
    gzipSync(products.map((product) => JSON.stringify(product)).join("\n")),
  );
  return publishOpenFoodFactsCatalog({ root, inputPath, release });
}

function artifactPath(digest: string) {
  return join(root, provider, "artifacts", `${digest}.sqlite`);
}

async function expectSnapshotRemoved(index: number) {
  const snapshot = snapshots[index];
  if (!snapshot) throw new Error("Expected a reader snapshot");
  await expect(lstat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
}

it("opens only the verified snapshot when the source pathname is replaced during copying", async () => {
  const original = await publish("Original", "release-1");
  const path = artifactPath(original.artifact.sha256);
  const replacement = join(directory, "replacement.sqlite");
  await copyFile(path, replacement);
  {
    using database = new DatabaseSync(replacement);
    database.exec("UPDATE food SET name = 'Replaced'");
  }
  vi.mocked(open).mockImplementation(async (name, flags, mode) => {
    const file = await realFs.open(name, flags, mode);
    if (name === path) {
      vi.mocked(open).mockImplementation(realFs.open);
      await rename(replacement, path);
    }
    return file;
  });

  using reader = await openOpenFoodFactsCatalog(root);
  expect(reader?.lookupBarcode(code)[0]).toMatchObject({ name: "Original", release: "release-1" });
  await expect(openOpenFoodFactsCatalog(root)).rejects.toThrow(/checksum/);
  expect(snapshots).toHaveLength(2);
  await expectSnapshotRemoved(1);
  reader?.[Symbol.dispose]();
  await expectSnapshotRemoved(0);
});

it("keeps the last accepted release when a candidate has an invalid row for a different barcode", async () => {
  const original = await publish("Original", "release-1");
  using lookup = createBarcodeLookup(root, { liveLookup: null });
  const previous = await lookup.lookupBarcode(code);
  expect(previous).toMatchObject({
    status: "found",
    source: "catalog",
    products: [{ name: "Original", release: "release-1" }],
  });

  await publishCatalog(
    { ...original, inputPath, root, source: { ...original.source, release: "invalid" } },
    {
      async build(_source, destination) {
        await copyFile(artifactPath(original.artifact.sha256), destination);
        using database = new DatabaseSync(destination);
        database.exec(`
          UPDATE catalog_metadata SET release = 'invalid';
          UPDATE food SET name = 'Candidate';
          UPDATE food SET preparation = 'invalid' WHERE source_id = '12345678';
        `);
        return original.counts;
      },
      async validate() {},
    },
  );
  expect(await lookup.lookupBarcode(code)).toMatchObject({
    ...previous,
    checkedAt: expect.any(Number),
  });
  expect(snapshots).toHaveLength(2);
  await expectSnapshotRemoved(1);

  await publish("New healthy release", "release-2");
  expect(await lookup.lookupBarcode(code)).toMatchObject({
    status: "found",
    source: "catalog",
    products: [{ name: "New healthy release", release: "release-2" }],
  });
  await expectSnapshotRemoved(0);
});
