import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { publishCatalog } from "@edo/catalog-import";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBarcodeLookup,
  type LiveBarcodeResult,
  normalizeLookupCode,
  openOpenFoodFactsCatalog,
  publishOpenFoodFactsCatalog,
} from "../src/index.ts";
import { restoreOpenFoodFactsRelease } from "../src/publish.ts";

let directory: string;
let inputPath: string;
let root: string;
const provider = "open-food-facts";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "edo-off-"));
  inputPath = join(directory, "source.jsonl.gz");
  root = join(directory, "catalogs");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function exportRows(...rows: unknown[]): Promise<void> {
  return writeFile(inputPath, gzipSync(rows.map((row) => JSON.stringify(row)).join("\n")));
}

const baseProduct = {
  _id: "034000470693",
  code: "034000470693",
  product_name_de: "Möhrensaft",
  product_name_en: "Carrot juice",
  countries_tags: ["en:germany"],
  serving_quantity: 200,
  serving_quantity_unit: "mL",
  nutrition: {
    aggregated_set: {
      per: "100ml",
      preparation: "as_sold",
      nutrients: {
        "energy-kcal": { value: 42, unit: "kcal" },
        proteins: { value: 0, unit: "g" },
        carbohydrates: { value: 9500, unit: "mg" },
        fat: { value: 0.2, modifier: "≤", unit: "g" },
        fiber: { value: 0, modifier: "~", unit: "g" },
      },
    },
  },
};

it.each([
  {
    schemaVersion: 2,
    change: "PRAGMA user_version = 2",
    error: /unsupported Open Food Facts catalog manifest/i,
  },
  {
    schemaVersion: 1,
    change: "UPDATE catalog_metadata SET release = 'another release'",
    error: /catalog metadata does not match/i,
  },
])(
  "preserves the active release when the restore target fails $error",
  async ({ schemaVersion, change, error }) => {
    await exportRows(baseProduct);
    const supported = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
    const activation = join(root, provider, "active.json");
    const supportedBytes = await readFile(activation);
    const supportedDigest = createHash("sha256").update(supportedBytes).digest("hex");
    await publishCatalog(
      { ...supported, root, inputPath, schemaVersion },
      {
        async build(_input, output) {
          await copyFile(
            join(root, provider, "artifacts", `${supported.artifact.sha256}.sqlite`),
            output,
          );
          using database = new DatabaseSync(output);
          database.exec(change);
          return supported.counts;
        },
        async validate() {},
      },
    );
    const incompatibleDigest = createHash("sha256")
      .update(await readFile(activation))
      .digest("hex");

    await expect(restoreOpenFoodFactsRelease(root, supportedDigest)).resolves.toEqual(supported);
    await expect(restoreOpenFoodFactsRelease(root, incompatibleDigest)).rejects.toThrow(error);
    expect(await readFile(activation)).toEqual(supportedBytes);
  },
);

it("opens a verified release and preserves exact and alternate barcode candidates", async () => {
  await expect(openOpenFoodFactsCatalog(root)).resolves.toBeNull();
  const alternate = {
    ...baseProduct,
    _id: "0034000470693",
    code: "0034000470693",
    nutrition: null,
  };
  await exportRows(baseProduct, alternate);
  await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  using old = await openOpenFoodFactsCatalog(root);
  if (!old) throw new Error("Expected the active catalog");
  expect(old?.manifest.attribution.license).toBe("ODbL-1.0");
  expect(Reflect.set(old.manifest.source, "release", "another-release")).toBe(false);
  expect(old?.lookupBarcode(baseProduct.code)).toMatchObject([
    {
      barcode: baseProduct.code,
      id: { provider, sourceId: baseProduct._id },
      release: "fixture-1",
      name: "Möhrensaft",
      alternateName: "Carrot juice",
      preparation: "as-sold",
      nutrition: {
        basis: "per-100-ml",
        portionSize: { amount: 200, unit: "ml" },
        nutrients: { kcal: 42, proteinG: 0, fatG: null },
      },
    },
    { barcode: alternate.code, id: { provider, sourceId: alternate._id }, nutrition: null },
  ]);
  expect(old?.lookupBarcode(alternate.code).map((candidate) => candidate.barcode)).toEqual([
    alternate.code,
    baseProduct.code,
  ]);
  expect(old?.lookupBarcode("not-a-barcode")).toEqual([]);
  expect(old?.lookupBarcode("0123456789")).toEqual([]);

  await exportRows(baseProduct);
  const next = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-2" });
  {
    using current = await openOpenFoodFactsCatalog(root);
    expect(current?.manifest.source.release).toBe("fixture-2");
    expect(current?.lookupBarcode(alternate.code).map((candidate) => candidate.barcode)).toEqual([
      baseProduct.code,
    ]);
  }
  expect(old?.lookupBarcode(alternate.code)).toHaveLength(2);

  {
    await using file = await open(
      join(root, provider, "artifacts", `${next.artifact.sha256}.sqlite`),
      "r+",
    );
    await file.write(Buffer.from([0]), 0, 1, 0);
  }
  await expect(openOpenFoodFactsCatalog(root)).rejects.toThrow(/checksum/);
  old[Symbol.dispose]();
  expect(() => old[Symbol.dispose]()).not.toThrow();
});

it("omits implausible nutrients when reading an already-published v1 artifact", async () => {
  await exportRows(baseProduct);
  const current = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-v1" });
  const publishedPath = join(root, provider, "artifacts", `${current.artifact.sha256}.sqlite`);
  const legacy = await publishCatalog(
    { ...current, root, inputPath, importerVersion: "1" },
    {
      async build(_inputPath, artifactPath) {
        await copyFile(publishedPath, artifactPath);
        using database = new DatabaseSync(artifactPath);
        database.exec(`
          UPDATE food SET nutrition_basis = 'per-portion', portion_amount = 4, portion_unit = 'g',
            kcal = 400, fat_g = 9;
        `);
        return current.counts;
      },
      async validate(artifactPath) {
        using database = new DatabaseSync(artifactPath, { readOnly: true });
        expect(database.prepare("SELECT kcal, fat_g FROM food").get()).toEqual({
          kcal: 400,
          fat_g: 9,
        });
      },
    },
  );

  using reader = await openOpenFoodFactsCatalog(root);
  expect(reader?.manifest.importerVersion).toBe("1");
  expect(reader?.lookupBarcode(baseProduct.code)).toMatchObject([
    {
      nutrition: {
        basis: "per-portion",
        portionSize: { amount: 4, unit: "g" },
        nutrients: { kcal: null, proteinG: 0, availableCarbohydratesG: null, fatG: null },
      },
    },
  ]);
  using unchanged = new DatabaseSync(
    join(root, provider, "artifacts", `${legacy.artifact.sha256}.sqlite`),
    { readOnly: true },
  );
  expect(unchanged.prepare("SELECT kcal, fat_g FROM food").get()).toEqual({ kcal: 400, fat_g: 9 });
});

it("uses the latest verified catalog before a live fallback and keeps the last good release", async () => {
  const live = vi.fn<() => Promise<LiveBarcodeResult>>(async () => ({ status: "not-found" }));
  let clock = 100;
  using lookup = createBarcodeLookup(root, { liveLookup: live, now: () => clock });
  await exportRows(baseProduct);
  await publishOpenFoodFactsCatalog({ root, inputPath, release: "first" });
  await expect(lookup.lookupBarcode(baseProduct.code)).resolves.toMatchObject({
    status: "found",
    source: "catalog",
    products: [{ release: "first" }],
  });
  expect(live).not.toHaveBeenCalled();
  await expect(lookup.lookupBarcode("12345678")).resolves.toEqual({ status: "not-found" });
  expect(live).toHaveBeenCalledExactlyOnceWith("12345678");

  await publishOpenFoodFactsCatalog({ root, inputPath, release: "second" });
  await expect
    .poll(() => lookup.lookupBarcode(baseProduct.code), { timeout: 8_000 })
    .toMatchObject({
      status: "found",
      source: "catalog",
      products: [{ release: "second" }],
    });
  const damaged = await publishOpenFoodFactsCatalog({ root, inputPath, release: "damaged" });
  const artifact = join(root, provider, "artifacts", `${damaged.artifact.sha256}.sqlite`);
  const correctBytes = await readFile(artifact);
  {
    await using file = await open(artifact, "r+");
    await file.write(Buffer.from([0]), 0, 1, 0);
  }
  await expect(lookup.lookupBarcode(baseProduct.code)).resolves.toMatchObject({
    status: "found",
    source: "catalog",
    products: [{ release: "second" }],
  });
  expect(live).toHaveBeenCalledTimes(1);
  await writeFile(artifact, correctBytes);
  await expect(lookup.lookupBarcode(baseProduct.code)).resolves.toMatchObject({
    products: [{ release: "second" }],
  });
  clock += 30_000;
  await expect
    .poll(() => lookup.lookupBarcode(baseProduct.code), { timeout: 8_000 })
    .toMatchObject({
      products: [{ release: "damaged" }],
    });
  lookup[Symbol.dispose]();
  await expect(lookup.lookupBarcode(baseProduct.code)).resolves.toEqual({ status: "unavailable" });
});

it("supports catalog-only lookup and recovers from a synchronously failing live adapter", async () => {
  using localOnly = createBarcodeLookup(root, { liveLookup: null });
  await expect(localOnly.lookupBarcode("12345678")).resolves.toEqual({ status: "unavailable" });
  await exportRows(baseProduct);
  await publishOpenFoodFactsCatalog({ root, inputPath, release: "first" });
  await expect(localOnly.lookupBarcode("12345678")).resolves.toEqual({ status: "not-found" });
  using failing = createBarcodeLookup(root, {
    liveLookup() {
      throw new Error("Provider unavailable");
    },
  });
  await expect(failing.lookupBarcode("12345678")).resolves.toEqual({ status: "unavailable" });
});

it("preserves volume, leading zeros and candidates and indexes both display names", async () => {
  await exportRows(
    baseProduct,
    {
      ...baseProduct,
      _id: "0034000470693",
      code: "0034000470693",
      product_name_de: "Andere Packung",
      product_name_en: "Other package",
      nutrition: undefined,
    },
    baseProduct,
    { ...baseProduct, _id: "other-country", countries_tags: ["en:france"] },
    { ...baseProduct, _id: "old-record", deleted: true },
  );
  const manifest = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  expect(manifest.counts).toEqual({ accepted: 2, rejected: 1, skipped: 2 });
  const path = join(root, provider, "artifacts", `${manifest.artifact.sha256}.sqlite`);
  using db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare("SELECT release, provider, license_url FROM catalog_metadata").get()).toEqual({
    release: "fixture-1",
    provider,
    license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
  });
  expect(
    db
      .prepare("SELECT code FROM barcode WHERE lookup_code=? ORDER BY code")
      .all(normalizeLookupCode("034000470693")),
  ).toEqual([{ code: "0034000470693" }, { code: "034000470693" }]);
  const query = db.prepare(
    `SELECT food.* FROM food_search JOIN food ON food.rowid=food_search.rowid
     WHERE food_search MATCH ?`,
  );
  expect(query.all("Carrot")).toMatchObject([
    {
      source_id: "034000470693",
      name: "Möhrensaft",
      nutrition_basis: "per-100-ml",
      kcal: 42,
      protein_g: 0,
      available_carbohydrates_g: 9.5,
      fat_g: null,
      fiber_g: null,
      portion_amount: 200,
      portion_unit: "ml",
    },
  ]);
  expect(query.all("Mohrensaft")).toHaveLength(1);
  expect(query.all("Packung")).toMatchObject([
    { source_id: "0034000470693", nutrition_basis: null, kcal: null },
  ]);
});

it("leaves nutrition unknown when the source only gives bounds or an estimate", async () => {
  await exportRows({
    ...baseProduct,
    nutrition: {
      aggregated_set: {
        per: "100ml",
        preparation: "as_sold",
        nutrients: {
          "energy-kcal": { value: 9, modifier: "≥", unit: "kcal" },
          proteins: { value: 1, modifier: "<", unit: "g" },
          carbohydrates: { value: 1, modifier: ">", unit: "g" },
          fat: { value: 4, modifier: "~", unit: "g" },
          fiber: { value: 0, modifier: "-", unit: "g" },
        },
      },
    },
  });
  const manifest = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  using db = new DatabaseSync(
    join(root, provider, "artifacts", `${manifest.artifact.sha256}.sqlite`),
  );
  expect(db.prepare("SELECT nutrition_basis, kcal FROM food").get()).toEqual({
    nutrition_basis: null,
    kcal: null,
  });
});

it("keeps long store codes and converts explicitly reported kilojoules", async () => {
  const code = "00012345678901234567";
  await exportRows({
    ...baseProduct,
    _id: code,
    code,
    nutrition: {
      aggregated_set: {
        per: "100g",
        preparation: "prepared",
        nutrients: { "energy-kj": { value: 418.4, unit: "kJ" } },
      },
    },
  });
  const manifest = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  using db = new DatabaseSync(
    join(root, provider, "artifacts", `${manifest.artifact.sha256}.sqlite`),
  );
  expect(db.prepare("SELECT code, lookup_code FROM barcode").get()).toEqual({
    code,
    lookup_code: "12345678901234567",
  });
  expect(db.prepare("SELECT kcal FROM food").get()?.kcal).toBeCloseTo(100);
});

it("retains a single labeled serving even if the serving size is missing", async () => {
  const serving = {
    per: "serving",
    preparation: "prepared",
    source: "packaging",
    nutrients: { "energy-kcal": { value: 41, unit: "kcal" } },
  };
  await exportRows(
    { ...baseProduct, nutrition: { input_sets: [serving] } },
    {
      ...baseProduct,
      _id: "labeled-serving",
      nutrition: { input_sets: [{ ...serving, per_quantity: 0.004, per_unit: "l" }] },
    },
    {
      ...baseProduct,
      _id: "conflicting-servings",
      nutrition: { input_sets: [serving, { ...serving, preparation: "as_sold" }] },
    },
  );
  const manifest = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  using db = new DatabaseSync(
    join(root, provider, "artifacts", `${manifest.artifact.sha256}.sqlite`),
  );
  const select = db.prepare(
    "SELECT nutrition_basis, preparation, kcal, portion_amount, portion_unit FROM food WHERE source_id=?",
  );
  expect(select.get(baseProduct._id)).toEqual({
    nutrition_basis: "per-portion",
    preparation: "prepared",
    kcal: 41,
    portion_amount: null,
    portion_unit: null,
  });
  expect(select.get("labeled-serving")).toMatchObject({ portion_amount: 4, portion_unit: "ml" });
  expect(select.get("conflicting-servings")).toMatchObject({ nutrition_basis: null, kcal: null });
});

it("sanitizes the selected reference without guessing density or replacing the reference", async () => {
  const serving = {
    per: "serving",
    preparation: "prepared",
    source: "packaging",
    per_quantity: 0.004,
    per_unit: "kg",
    nutrients: {
      "energy-kcal": { value: 400, unit: "kcal" },
      proteins: { value: 0, unit: "g" },
      fat: { value: 5500, unit: "mg" },
    },
  };
  await exportRows(
    { ...baseProduct, nutrition: { input_sets: [serving] } },
    {
      ...baseProduct,
      _id: "volume-serving",
      nutrition: { input_sets: [{ ...serving, per_unit: "l" }] },
    },
    {
      ...baseProduct,
      _id: "all-outliers",
      nutrition: {
        aggregated_set: {
          per: "100g",
          preparation: "as_sold",
          nutrients: { "energy-kcal": { value: 1001, unit: "kcal" } },
        },
        input_sets: [serving],
      },
    },
  );
  const manifest = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  expect(manifest).toMatchObject({ importerVersion: "2", schemaVersion: 1 });
  using db = new DatabaseSync(
    join(root, provider, "artifacts", `${manifest.artifact.sha256}.sqlite`),
    { readOnly: true },
  );
  const select = db.prepare("SELECT * FROM food WHERE source_id = ?");
  expect(select.get(baseProduct._id)).toMatchObject({
    nutrition_basis: "per-portion",
    preparation: "prepared",
    portion_amount: 4,
    portion_unit: "g",
    kcal: null,
    protein_g: 0,
    fat_g: null,
  });
  expect(select.get("volume-serving")).toMatchObject({
    nutrition_basis: "per-portion",
    portion_amount: 4,
    portion_unit: "ml",
    kcal: 400,
    fat_g: 5.5,
  });
  expect(select.get("all-outliers")).toMatchObject({
    nutrition_basis: "per-100-g",
    preparation: "as-sold",
    kcal: null,
  });
});

it("leaves a previous release intact after interrupted input and excludes deleted products on refresh", async () => {
  await exportRows(baseProduct, { ...baseProduct, _id: "0123456789", code: "0123456789" });
  const first = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  const repeat = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-1" });
  expect(repeat).toEqual(first);
  const active = join(root, provider, "active.json");
  const savedManifest = await readFile(active, "utf8");

  const complete = gzipSync(JSON.stringify(baseProduct));
  await writeFile(inputPath, complete.subarray(0, complete.length - 6));
  await expect(
    publishOpenFoodFactsCatalog({ root, inputPath, release: "truncated" }),
  ).rejects.toThrow();
  expect(await readFile(active, "utf8")).toBe(savedManifest);

  await exportRows(baseProduct, {
    ...baseProduct,
    _id: "0123456789",
    code: "0123456789",
    deleted: true,
  });
  const next = await publishOpenFoodFactsCatalog({ root, inputPath, release: "fixture-2" });
  expect(next.counts).toEqual({ accepted: 1, rejected: 0, skipped: 1 });
  using updated = new DatabaseSync(
    join(root, provider, "artifacts", `${next.artifact.sha256}.sqlite`),
    { readOnly: true },
  );
  expect(updated.prepare("SELECT source_id FROM food").all()).toEqual([
    { source_id: "034000470693" },
  ]);
  using previous = new DatabaseSync(
    join(root, provider, "artifacts", `${first.artifact.sha256}.sqlite`),
    { readOnly: true },
  );
  expect(previous.prepare("SELECT COUNT(*) AS count FROM food").get()).toEqual({ count: 2 });
});
