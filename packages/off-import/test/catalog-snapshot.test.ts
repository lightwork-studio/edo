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
const refreshTestWait = { timeout: 8_000 };
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function expectSnapshotRemoved(index: number) {
  await expect.poll(() => snapshots.length, refreshTestWait).toBeGreaterThan(index);
  const snapshot = snapshots[index];
  if (!snapshot) throw new Error("Expected a reader snapshot");
  await expect
    .poll(async () => {
      try {
        await lstat(snapshot);
        return null;
      } catch (error) {
        return error instanceof Error && "code" in error ? error.code : error;
      }
    }, refreshTestWait)
    .toBe("ENOENT");
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

it.each([
  [
    "an invalid preparation",
    "UPDATE food SET preparation = 'invalid' WHERE source_id = '12345678'",
  ],
  ["a whitespace-only name", "UPDATE food SET name = '   ' WHERE source_id = '12345678'"],
  [
    "a barcode table that duplicates one product and omits another",
    `DROP INDEX barcode_lookup;
     ALTER TABLE barcode RENAME TO earlier_barcode;
     CREATE TABLE barcode (source_id TEXT, code TEXT, lookup_code TEXT) STRICT;
     CREATE INDEX barcode_lookup ON barcode (lookup_code);
     INSERT INTO barcode SELECT * FROM earlier_barcode WHERE source_id = '${code}';
     INSERT INTO barcode SELECT * FROM earlier_barcode WHERE source_id = '${code}';
     DROP TABLE earlier_barcode;`,
  ],
] as const)(
  "retains the previous release when the candidate contains %s",
  async (_case, change) => {
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
          ${change};
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
    await expectSnapshotRemoved(1);
    expect(await lookup.lookupBarcode(code)).toMatchObject({
      ...previous,
      checkedAt: expect.any(Number),
    });

    await publish("New healthy release", "release-2");
    await expect
      .poll(() => lookup.lookupBarcode(code), refreshTestWait)
      .toMatchObject({
        status: "found",
        source: "catalog",
        products: [{ name: "New healthy release", release: "release-2" }],
      });
    await expectSnapshotRemoved(0);
  },
);

it("serves the current release during validation and discards a superseded candidate", async () => {
  await publish("Original", "release-1");
  using lookup = createBarcodeLookup(root, { liveLookup: null });
  expect(await lookup.lookupBarcode(code)).toMatchObject({ products: [{ name: "Original" }] });

  const candidate = await publish("Superseded", "release-2");
  const candidatePath = artifactPath(candidate.artifact.sha256);
  const opened = deferred();
  const resume = deferred();
  vi.mocked(open).mockImplementation(async (name, flags, mode) => {
    const file = await realFs.open(name, flags, mode);
    if (name === candidatePath) {
      opened.resolve();
      await resume.promise;
    }
    return file;
  });
  try {
    let result: Awaited<ReturnType<typeof lookup.lookupBarcode>> | undefined;
    void lookup.lookupBarcode(code).then((value) => {
      result = value;
    });
    await opened.promise;
    await expect
      .poll(() => result, refreshTestWait)
      .toMatchObject({ products: [{ name: "Original" }] });
    await publish("Latest", "release-3");
  } finally {
    resume.resolve();
  }

  await expectSnapshotRemoved(1);
  expect(await lookup.lookupBarcode(code)).toMatchObject({ products: [{ name: "Original" }] });
  await expect
    .poll(() => lookup.lookupBarcode(code), refreshTestWait)
    .toMatchObject({ products: [{ name: "Latest" }] });
});

it("releases a staged snapshot when the service closes during a cold lookup", async () => {
  const active = await publish("Original", "release-1");
  using lookup = createBarcodeLookup(root, { liveLookup: null });
  const opened = deferred();
  const resume = deferred();
  vi.mocked(open).mockImplementation(async (name, flags, mode) => {
    const file = await realFs.open(name, flags, mode);
    if (name === artifactPath(active.artifact.sha256)) {
      opened.resolve();
      await resume.promise;
    }
    return file;
  });

  const pending = lookup.lookupBarcode(code);
  await opened.promise;
  lookup[Symbol.dispose]();
  resume.resolve();
  await expect(pending).resolves.toEqual({ status: "unavailable" });
  await expectSnapshotRemoved(0);
});
