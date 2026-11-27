import { decodePackagedFood, normalizeOpenFoodFactsBarcode, type PackagedFood } from "@edo/core";
import { rollback, type SqliteConnection, type SqlRow } from "./sqlite.ts";

const applicationId = 0x45444f43;
const schemaVersion = 1;
const defaultByteBudget = 4 * 1024 * 1024;
const productColumns = `packaged_food.source_id, packaged_food.barcode, packaged_food.lookup_code,
  packaged_food.name, packaged_food.alternate_name, packaged_food.payload,
  CAST(packaged_food.checked_at AS TEXT) AS checked_at`;

export interface CachedPackagedFood {
  readonly product: PackagedFood;
  readonly checkedAt: number;
}

export interface PackagedFoodCache {
  /** Retained IDs come from current favourites and recently logged products in the diary. */
  save(products: readonly PackagedFood[], checkedAt: number, retainedIds: readonly string[]): void;
  prune(retainedIds: readonly string[]): void;
  lookupBarcode(barcode: string, accessedAt: number): CachedPackagedFood[];
  search(query: string, accessedAt: number): CachedPackagedFood[];
  findByIds(sourceIds: readonly string[]): CachedPackagedFood[];
}

const schema = `
  CREATE TABLE packaged_food (
    source_id TEXT PRIMARY KEY NOT NULL,
    barcode TEXT NOT NULL,
    lookup_code TEXT NOT NULL,
    name TEXT NOT NULL,
    alternate_name TEXT,
    payload TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX packaged_food_lookup ON packaged_food (lookup_code);
  CREATE VIRTUAL TABLE packaged_food_search USING fts5(
    name, alternate_name, content='packaged_food', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER packaged_food_insert AFTER INSERT ON packaged_food BEGIN
    INSERT INTO packaged_food_search(rowid, name, alternate_name)
    VALUES (new.rowid, new.name, new.alternate_name);
  END;
  CREATE TRIGGER packaged_food_delete AFTER DELETE ON packaged_food BEGIN
    INSERT INTO packaged_food_search(packaged_food_search, rowid, name, alternate_name)
    VALUES ('delete', old.rowid, old.name, old.alternate_name);
  END;
  CREATE TRIGGER packaged_food_names AFTER UPDATE OF name, alternate_name ON packaged_food BEGIN
    INSERT INTO packaged_food_search(packaged_food_search, rowid, name, alternate_name)
    VALUES ('delete', old.rowid, old.name, old.alternate_name);
    INSERT INTO packaged_food_search(rowid, name, alternate_name)
    VALUES (new.rowid, new.name, new.alternate_name);
  END;
  PRAGMA application_id = ${applicationId};
  PRAGMA user_version = ${schemaVersion};
`;

const saveRow = `
  INSERT INTO packaged_food VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (source_id) DO UPDATE SET
    barcode = excluded.barcode,
    lookup_code = excluded.lookup_code,
    name = excluded.name,
    alternate_name = excluded.alternate_name,
    payload = excluded.payload,
    checked_at = excluded.checked_at,
    accessed_at = MAX(packaged_food.accessed_at, excluded.accessed_at)
  WHERE excluded.checked_at >= packaged_food.checked_at
`;

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid catalog timestamp");
  return value;
}

function transaction<T>(db: SqliteConnection, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    return rollback(db, error, "Catalog cache rollback failed");
  }
}

function initialize(db: SqliteConnection): void {
  transaction(db, () => {
    const id = db.get("PRAGMA application_id")?.application_id;
    const version = db.get("PRAGMA user_version")?.user_version;
    if (id === applicationId && version === schemaVersion) {
      const objects = db.get(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN (
        'packaged_food', 'packaged_food_lookup', 'packaged_food_search', 'packaged_food_insert',
        'packaged_food_delete', 'packaged_food_names'
      )`);
      const fts = db.get(
        "SELECT sql FROM sqlite_schema WHERE name = 'packaged_food_search' AND type = 'table'",
      )?.sql;
      if (objects?.count !== 6 || typeof fts !== "string" || !/\bUSING\s+fts5\s*\(/i.test(fts)) {
        throw new Error("Packaged-food cache schema is incomplete");
      }
      return;
    }
    if (id !== 0 || version !== 0 || db.get("SELECT name FROM sqlite_schema LIMIT 1")) {
      throw new Error("Cannot open an unrelated or unsupported catalog cache");
    }
    db.exec(schema);
  });
  // Only an application-owned cache may be vacuumed. Changing this mode requires a rewrite.
  if (db.get("PRAGMA auto_vacuum")?.auto_vacuum !== 1) {
    db.exec("PRAGMA auto_vacuum = FULL; VACUUM");
  }
}

function writeProduct(
  db: SqliteConnection,
  product: PackagedFood,
  checkedAt: number,
  budget: number,
  retained: boolean,
): void {
  const stored = decodePackagedFood(product);
  const lookup = stored && normalizeOpenFoodFactsBarcode(stored.barcode);
  if (!stored || !lookup) throw new TypeError("Invalid packaged-food cache product");
  const payload = JSON.stringify(stored);
  const size = db.get("SELECT length(CAST(? AS BLOB)) AS bytes", payload)?.bytes;
  if (typeof size !== "number") throw new Error("Could not measure the catalog payload");
  if (!retained && size > budget) return;
  const previous = db.get(
    `SELECT ${productColumns} FROM packaged_food WHERE source_id = ?`,
    stored.id.sourceId,
  );
  if (previous && !readCachedRow(previous)) {
    // A corrupt row cannot supply the timestamp that protects a valid recent result.
    db.run("DELETE FROM packaged_food WHERE source_id = ?", stored.id.sourceId);
  }
  db.run(
    saveRow,
    stored.id.sourceId,
    stored.barcode,
    lookup,
    stored.name.normalize("NFKC"),
    stored.alternateName?.normalize("NFKC") ?? null,
    payload,
    checkedAt,
    checkedAt,
  );
}

function evict(db: SqliteConnection, byteBudget: number, retainedIds: readonly string[]): void {
  db.exec("CREATE TEMP TABLE retained_packaged_food (source_id TEXT PRIMARY KEY NOT NULL)");
  for (const id of retainedIds) {
    db.run("INSERT OR IGNORE INTO retained_packaged_food VALUES (?)", id);
  }
  const ordinary = "source_id NOT IN (SELECT source_id FROM temp.retained_packaged_food)";
  const used = db.get(`SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes
    FROM packaged_food WHERE ${ordinary}`)?.bytes;
  if (typeof used !== "number") throw new Error("Could not measure the catalog cache");
  if (used > byteBudget) {
    // Damaged candidates must never force a working product out of the offline cache.
    const rows = db.all(`SELECT ${productColumns} FROM packaged_food WHERE ${ordinary}`);
    for (const row of rows) {
      if (typeof row.source_id === "string" && !readCachedRow(row)) {
        db.run("DELETE FROM packaged_food WHERE source_id = ?", row.source_id);
      }
    }
    db.run(
      `DELETE FROM packaged_food WHERE ${ordinary} AND length(CAST(payload AS BLOB)) > ?`,
      byteBudget,
    );
    db.run(
      `DELETE FROM packaged_food WHERE source_id IN (
        SELECT source_id FROM (
          SELECT source_id, SUM(length(CAST(payload AS BLOB))) OVER (
            ORDER BY accessed_at DESC, source_id
          ) AS running_bytes
          FROM packaged_food WHERE ${ordinary}
        ) WHERE running_bytes > ?
      )`,
      byteBudget,
    );
  }
  db.exec("DROP TABLE temp.retained_packaged_food");
}

function readCachedRow(row: SqlRow): CachedPackagedFood | null {
  const { payload, checked_at: encodedTime } = row;
  if (
    typeof payload !== "string" ||
    typeof encodedTime !== "string" ||
    !/^\d+$/.test(encodedTime)
  ) {
    return null;
  }
  const checkedAt = Number(encodedTime);
  if (!Number.isSafeInteger(checkedAt)) return null;
  try {
    const product = decodePackagedFood(JSON.parse(payload));
    if (
      !product ||
      product.id.sourceId !== row.source_id ||
      product.barcode !== row.barcode ||
      normalizeOpenFoodFactsBarcode(product.barcode) !== row.lookup_code ||
      product.name.normalize("NFKC") !== row.name ||
      (product.alternateName?.normalize("NFKC") ?? null) !== row.alternate_name
    ) {
      return null;
    }
    return { product, checkedAt };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function touch(
  db: SqliteConnection,
  rows: readonly SqlRow[],
  accessedAt: number,
  limit = Number.POSITIVE_INFINITY,
): CachedPackagedFood[] {
  const results: CachedPackagedFood[] = [];
  for (const row of rows) {
    const data = readCachedRow(row);
    if (!data) continue;
    db.run(
      "UPDATE packaged_food SET accessed_at = MAX(accessed_at, ?) WHERE source_id = ?",
      accessedAt,
      data.product.id.sourceId,
    );
    results.push(data);
    if (results.length >= limit) break;
  }
  return results;
}

/** Open the device-only public-food cache. The budget covers unretained serialized payloads. */
export function openPackagedFoodCache(
  db: SqliteConnection,
  byteBudget = defaultByteBudget,
): PackagedFoodCache {
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 0) {
    throw new RangeError("The packaged-food cache needs a byte budget");
  }
  initialize(db);
  return {
    save(products, checkedAt, retainedIds) {
      timestamp(checkedAt);
      const retained = new Set(retainedIds);
      transaction(db, () => {
        for (const product of products) {
          writeProduct(db, product, checkedAt, byteBudget, retained.has(product.id.sourceId));
        }
        evict(db, byteBudget, retainedIds);
      });
    },
    prune(retainedIds) {
      transaction(db, () => evict(db, byteBudget, retainedIds));
    },
    lookupBarcode(barcode, accessedAt) {
      const text = barcode.trim();
      const key = normalizeOpenFoodFactsBarcode(text);
      if (!key) return [];
      timestamp(accessedAt);
      return transaction(db, () =>
        touch(
          db,
          db.all(
            `SELECT ${productColumns} FROM packaged_food
             WHERE lookup_code = ? ORDER BY (barcode = ?) DESC, source_id`,
            key,
            text,
          ),
          accessedAt,
        ),
      );
    },
    findByIds(sourceIds) {
      const results: CachedPackagedFood[] = [];
      for (const id of new Set(sourceIds)) {
        const row = db.get(`SELECT ${productColumns} FROM packaged_food WHERE source_id = ?`, id);
        const data = row && readCachedRow(row);
        if (data) results.push(data);
      }
      return results;
    },
    search(query, accessedAt) {
      const tokens =
        query
          .normalize("NFKC")
          .match(/[\p{L}\p{N}]+/gu)
          ?.slice(0, 8) ?? [];
      if (tokens.length === 0) return [];
      const expression = tokens.map((token) => `"${token}"*`).join(" ");
      timestamp(accessedAt);
      return transaction(db, () => {
        const results: CachedPackagedFood[] = [];
        const pageSize = 50;
        for (let offset = 0; results.length < pageSize; offset += pageSize) {
          const rows = db.all(
            `SELECT ${productColumns} FROM packaged_food_search
             JOIN packaged_food ON packaged_food_search.rowid = packaged_food.rowid
             WHERE packaged_food_search MATCH ? ORDER BY rank, source_id LIMIT ? OFFSET ?`,
            expression,
            pageSize,
            offset,
          );
          results.push(...touch(db, rows, accessedAt, pageSize - results.length));
          if (rows.length < pageSize) break;
        }
        return results;
      });
    },
  };
}
