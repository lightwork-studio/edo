import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PackagedFood } from "@edo/core";
import { expect, it } from "vitest";
import { openPackagedFoodCache, type SqliteConnection } from "../src/index.ts";

function connection(db: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => {
      db.prepare(sql).run(...parameters);
    },
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
  };
}

function food(sourceId: string, barcode: string, name: string): PackagedFood {
  return {
    id: { provider: "open-food-facts", sourceId },
    barcode,
    name,
    alternateName: null,
    release: "synthetic-release-1",
    preparation: "as-sold",
    nutrition: null,
  };
}

it("keeps bilingual names, exact candidates and nutrient basis through a reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "edo-packaged-cache-"));
  const file = join(directory, "products.sqlite");
  const primary = {
    ...food("original", "034000470693", "Möhrensaft"),
    alternateName: "Carrot juice",
    nutrition: {
      basis: "per-100-ml",
      nutrients: { kcal: 42, proteinG: 0, fatG: null, availableCarbohydratesG: 9, fiberG: null },
      portionSize: { amount: 200, unit: "ml" },
    },
  } satisfies PackagedFood;
  const other = food("other", "0034000470693", "Other package");
  try {
    {
      using db = new DatabaseSync(file);
      openPackagedFoodCache(connection(db), 1024).save([primary, other], 10, []);
    }
    {
      using db = new DatabaseSync(file);
      const cache = openPackagedFoodCache(connection(db), 1024);
      expect(cache.lookupBarcode(other.barcode, 11)).toEqual([
        { product: other, checkedAt: 10 },
        { product: primary, checkedAt: 10 },
      ]);
      expect(cache.search("Möhrens", 12)).toEqual([{ product: primary, checkedAt: 10 }]);
      expect(cache.search("carrot", 13)).toEqual([{ product: primary, checkedAt: 10 }]);
      expect(cache.search('"*" OR Unseen!', 14)).toEqual([]);
      expect(cache.lookupBarcode("0001234567", 15)).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("uses last access for the byte budget and retains favourites or recent entries", () => {
  const favourite = food("favourite", "12345670", "Müsliriegel");
  const older = food("older", "12345671", "Oat bar");
  const newer = food("newer", "12345672", "Pretzel");
  const budget = Math.max(
    ...[favourite, older, newer].map((item) => Buffer.byteLength(JSON.stringify(item))),
  );
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db), budget);
  cache.save([older, favourite], 10, ["favourite"]);
  expect(cache.findByIds([older.id.sourceId], 30)).toEqual([{ product: older, checkedAt: 10 }]);
  cache.save([newer], 20, ["favourite"]);
  expect(cache.lookupBarcode(newer.barcode, 40)).toEqual([]);
  expect(cache.lookupBarcode(older.barcode, 41)).toHaveLength(1);
  expect(cache.lookupBarcode(favourite.barcode, 42)).toHaveLength(1);
  cache.prune(["older"]);
  expect(cache.lookupBarcode(favourite.barcode, 43)).toHaveLength(1);
  cache.prune([]);
  expect(cache.lookupBarcode(favourite.barcode, 44)).toHaveLength(1);
  expect(cache.search("oat", 45)).toEqual([]);
  cache.save([{ ...favourite, name: "Large ".repeat(100) }], 46, []);
  expect(cache.lookupBarcode(favourite.barcode, 47)).toEqual([
    { product: favourite, checkedAt: 10 },
  ]);
  expect(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(1);
});

it("keeps the latest checked snapshot and rolls back a failed batch", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db), 1024);
  const initial = food("original", "12345670", "Prior name");
  const update = { ...initial, name: "Updated name", release: "synthetic-release-2" };
  cache.save([initial], 10, []);
  cache.save([update], 20, []);
  cache.save([initial], 15, []);
  expect(cache.search("prior", 22)).toEqual([]);
  expect(cache.search("updated", 23)).toEqual([{ product: update, checkedAt: 20 }]);
  const invalid = food("invalid-product", "", "Broken barcode");
  const second = food("second", "12345671", "Other product");
  expect(() => cache.save([second, invalid], 30, [])).toThrow(/cache product/);
  expect(cache.lookupBarcode(second.barcode, 31)).toEqual([]);
  expect(cache.lookupBarcode(initial.barcode, 32)).toEqual([{ product: update, checkedAt: 20 }]);
});

it("does not initialize over another database", () => {
  using db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE private_record (id TEXT)");
  expect(() => openPackagedFoodCache(connection(db), 1024)).toThrow(/unrelated/);
  expect(db.prepare("SELECT name FROM sqlite_schema ORDER BY name").all()).toEqual([
    { name: "private_record" },
  ]);
});

it("ignores temporary tables that shadow the dedicated cache tables", () => {
  using db = new DatabaseSync(":memory:");
  const initial = food("original", "12345670", "Oat");
  openPackagedFoodCache(connection(db)).save([initial], 1, []);
  db.exec(`CREATE TEMP TABLE packaged_food AS SELECT * FROM main.packaged_food;
    CREATE UNIQUE INDEX temp.shadow_key ON packaged_food (source_id);
    CREATE TEMP TABLE packaged_food_search (name TEXT, alternate_name TEXT)`);

  const cache = openPackagedFoodCache(connection(db));
  const updated = { ...initial, name: "Rice" };
  cache.save([updated], 2, []);
  expect(cache.search("rice", 3)).toEqual([{ product: updated, checkedAt: 2 }]);
  expect(cache.lookupBarcode(initial.barcode, 4)).toEqual([{ product: updated, checkedAt: 2 }]);
  expect(cache.findByIds([initial.id.sourceId], 5)).toEqual([{ product: updated, checkedAt: 2 }]);
  expect(db.prepare("SELECT name, checked_at, accessed_at FROM temp.packaged_food").get()).toEqual({
    name: "Oat",
    checked_at: 1,
    accessed_at: 1,
  });
});

it("ignores a damaged row without hiding valid barcode and name candidates", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db));
  const first = food("first", "034000470693", "Oat drink");
  const second = food("second", "0034000470693", "Oat milk");
  cache.save([first, second], 10, []);
  const breakRow = db.prepare("UPDATE packaged_food SET payload = ? WHERE source_id = 'first'");
  for (const payload of ["{", "null", JSON.stringify({ ...first, barcode: second.barcode })]) {
    breakRow.run(payload);
    expect(cache.lookupBarcode(first.barcode, 20)).toEqual([{ product: second, checkedAt: 10 }]);
    expect(cache.search("oat", 20)).toEqual([{ product: second, checkedAt: 10 }]);
  }
  cache.save([first], 30, []);
  expect(cache.lookupBarcode(first.barcode, 40)).toHaveLength(2);
});

it("rejects a cache file with a missing index table", () => {
  using db = new DatabaseSync(":memory:");
  openPackagedFoodCache(connection(db));
  db.exec("DROP TABLE packaged_food_search");
  expect(() => openPackagedFoodCache(connection(db))).toThrow(/schema is incomplete/);
  db.exec("CREATE TABLE packaged_food_search (name TEXT, alternate_name TEXT)");
  expect(() => openPackagedFoodCache(connection(db))).toThrow(/schema is incomplete/);
});

it("requires real cache triggers instead of same-named tables", () => {
  using db = new DatabaseSync(":memory:");
  openPackagedFoodCache(connection(db));
  db.exec(
    "DROP TRIGGER main.packaged_food_delete; CREATE TABLE main.packaged_food_delete (name TEXT)",
  );
  expect(() => openPackagedFoodCache(connection(db))).toThrow(/schema is incomplete/);
});

it("rejects text SQLite cannot round-trip and preserves well-formed Unicode", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db));
  const product = food("original", "12345670", "Oat 🥛");
  cache.save([product], 1, []);
  for (const name of ["Oat\u0000 milk", "Oat\uD800"]) {
    expect(() => cache.save([{ ...product, name }], 2, [])).toThrow(/cache product text/);
  }
  expect(cache.lookupBarcode(product.barcode, 3)).toEqual([{ product, checkedAt: 1 }]);
});

it("normalizes indexed names while preserving the original display names", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db));
  const product = { ...food("first", "034000470693", "Konﬁtüre"), alternateName: "Organic ﬁgs" };
  cache.save([product], 10, []);
  expect(cache.search("Konﬁtüre", 20)).toEqual([{ product, checkedAt: 10 }]);
  expect(cache.search("Figs", 20)).toEqual([{ product, checkedAt: 10 }]);
});

it("finds a valid name result after a full page of unusable matches", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db));
  const valid = food("valid", "12345670", "Oat");
  const invalid = Array.from({ length: 55 }, (_, index) => food(`bad-${index}`, "12345670", "Oat"));
  cache.save([...invalid, valid], 10, []);
  db.exec("UPDATE packaged_food SET payload = 'null' WHERE source_id != 'valid'");
  expect(cache.search("oat", 20)).toEqual([{ product: valid, checkedAt: 10 }]);
});

it("rejects corrupted routing keys and timestamps while leaving a valid sibling usable", () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(connection(db));
  const valid = food("valid", "12345670", "Oat");
  const wrongKey = food("wrong-key", "12345671", "Oat");
  const unsafeTime = food("unsafe-time", valid.barcode, "Oat");
  cache.save([valid, wrongKey, unsafeTime], 10, []);
  db.exec(`UPDATE packaged_food SET lookup_code = '12345670' WHERE source_id = 'wrong-key';
    UPDATE packaged_food SET checked_at = 9223372036854775807 WHERE source_id = 'unsafe-time'`);
  expect(cache.lookupBarcode(valid.barcode, 20)).toEqual([{ product: valid, checkedAt: 10 }]);
  expect(cache.search("oat", 20)).toEqual([{ product: valid, checkedAt: 10 }]);
  cache.save([unsafeTime], 30, ["unsafe-time"]);
  expect(cache.lookupBarcode(valid.barcode, 40)).toHaveLength(2);
});

it("does not let corrupted payloads evict a healthy product or clear an unrelated temp table", () => {
  using db = new DatabaseSync(":memory:");
  const broken = food("broken", "12345670", "Oat");
  const valid = food("valid", "12345671", "Rice");
  const budget = Math.max(
    Buffer.byteLength(JSON.stringify(broken)),
    Buffer.byteLength(JSON.stringify(valid)),
  );
  const cache = openPackagedFoodCache(connection(db), budget);
  cache.save([broken], 30, []);
  db.exec("UPDATE packaged_food SET payload = 'null' || printf('%80s', '')");
  cache.save([valid], 20, []);
  expect(cache.lookupBarcode(valid.barcode, 40)).toEqual([{ product: valid, checkedAt: 20 }]);
  db.exec(`CREATE TEMP TABLE retained_packaged_food (source_id TEXT);
    INSERT INTO temp.retained_packaged_food VALUES ('unrelated')`);
  expect(() => cache.prune([])).toThrow(/already exists/);
  expect(db.prepare("SELECT source_id FROM temp.retained_packaged_food").get()).toMatchObject({
    source_id: "unrelated",
  });
});

it("does not let an invalid access timestamp push out a healthy cached product", () => {
  using db = new DatabaseSync(":memory:");
  const broken = food("broken", "12345670", "Oat");
  const valid = food("valid", "12345671", "Rice");
  const budget = Math.max(
    Buffer.byteLength(JSON.stringify(broken)),
    Buffer.byteLength(JSON.stringify(valid)),
  );
  const cache = openPackagedFoodCache(connection(db), budget);
  cache.save([broken], 1, []);
  db.exec("UPDATE main.packaged_food SET accessed_at = 9223372036854775807");
  cache.save([valid], 2, []);
  expect(cache.lookupBarcode(valid.barcode, 3)).toEqual([{ product: valid, checkedAt: 2 }]);
  expect(cache.search("oat", 4)).toEqual([]);
});

it("upgrades a version-one cache and checks its older rows before eviction", () => {
  using db = new DatabaseSync(":memory:");
  const cached = food("cached", "12345670", "Oat");
  const broken = food("broken", "12345671", "Rice");
  const budget = Buffer.byteLength(JSON.stringify(cached));
  openPackagedFoodCache(connection(db)).save([cached, broken], 1, []);
  db.exec(`DROP TRIGGER main.packaged_food_validate;
    DROP INDEX main.packaged_food_pending;
    ALTER TABLE main.packaged_food DROP COLUMN validation_pending;
    PRAGMA main.user_version = 1;
    UPDATE main.packaged_food SET accessed_at = 9223372036854775807 WHERE source_id = 'broken'`);

  const upgraded = openPackagedFoodCache(connection(db), budget);
  upgraded.prune([]);
  expect(upgraded.lookupBarcode(cached.barcode, 2)).toEqual([{ product: cached, checkedAt: 1 }]);
  expect(upgraded.search("rice", 3)).toEqual([]);
  expect(db.prepare("PRAGMA main.user_version").get()).toEqual({ user_version: 2 });
});

it("does not decode resident rows again during ordinary cache turnover", () => {
  using db = new DatabaseSync(":memory:");
  const adapter = connection(db);
  const ordinary = Array.from({ length: 50 }, (_, index) =>
    food(String(index).padStart(2, "0"), "12345670", "Oat"),
  );
  const budget = ordinary.reduce(
    (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
    0,
  );
  const materialized: number[] = [];
  const cache = openPackagedFoodCache(
    {
      ...adapter,
      all(sql, ...parameters) {
        const rows = adapter.all(sql, ...parameters);
        if (sql.includes("validation_pending = 1")) materialized.push(rows.length);
        return rows;
      },
    },
    budget,
  );
  cache.save(ordinary, 1, []);
  cache.save([food("50", "12345671", "Rye")], 2, []);
  expect(materialized).toEqual([0]);
  expect(cache.lookupBarcode("12345671", 3)).toHaveLength(1);
});
