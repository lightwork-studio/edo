import { decodePackagedFood, normalizeOpenFoodFactsBarcode, type PackagedFood } from "@edo/core";
import { rollback, type SqliteConnection, type SqlRow } from "./sqlite.ts";

const applicationId = 0x45444f43;
const schemaVersion = 3;
const defaultByteBudget = 4 * 1024 * 1024;
const loneSurrogate = /[\uD800-\uDFFF]/u;
const productColumns = `packaged_food.source_id, packaged_food.barcode, packaged_food.lookup_code,
  packaged_food.name, packaged_food.alternate_name, packaged_food.payload,
  CAST(packaged_food.rowid AS TEXT) AS row_id,
  CAST(packaged_food.checked_at AS TEXT) AS checked_at,
  CAST(packaged_food.accessed_at AS TEXT) AS accessed_at,
  (instr(packaged_food.payload, char(0)) = 0
    AND instr(packaged_food.source_id, char(0)) = 0
    AND instr(packaged_food.barcode, char(0)) = 0
    AND instr(packaged_food.lookup_code, char(0)) = 0
    AND instr(packaged_food.name, char(0)) = 0
    AND coalesce(instr(packaged_food.alternate_name, char(0)), 0) = 0
  ) AS text_intact`;

export interface CachedPackagedFood {
  readonly product: PackagedFood;
  readonly checkedAt: number;
}

export interface PackagedFoodCache {
  /** Retained IDs come from current favourites and recently logged products in the diary. */
  save(products: readonly PackagedFood[], checkedAt: number, retainedIds: readonly string[]): void;
  /** Save the complete match set from a verified catalog. Older rows stay searchable by name. */
  saveBarcodeCandidates(
    barcode: string,
    products: readonly PackagedFood[],
    checkedAt: number,
    retainedIds: readonly string[],
  ): void;
  prune(retainedIds: readonly string[]): void;
  lookupBarcode(barcode: string, accessedAt: number): CachedPackagedFood[];
  search(query: string, accessedAt: number): CachedPackagedFood[];
  findByIds(sourceIds: readonly string[], accessedAt: number): CachedPackagedFood[];
}

const schema = `
  CREATE TABLE main.packaged_food (
    source_id TEXT PRIMARY KEY NOT NULL,
    barcode TEXT NOT NULL,
    lookup_code TEXT NOT NULL,
    name TEXT NOT NULL,
    alternate_name TEXT,
    payload TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX main.packaged_food_lookup ON packaged_food (lookup_code);
  CREATE VIRTUAL TABLE main.packaged_food_search USING fts5(
    name, alternate_name, content='packaged_food', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER main.packaged_food_insert AFTER INSERT ON packaged_food BEGIN
    INSERT INTO packaged_food_search(rowid, name, alternate_name)
    VALUES (new.rowid, new.name, new.alternate_name);
  END;
  CREATE TRIGGER main.packaged_food_delete AFTER DELETE ON packaged_food BEGIN
    INSERT INTO packaged_food_search(packaged_food_search, rowid, name, alternate_name)
    VALUES ('delete', old.rowid, old.name, old.alternate_name);
  END;
  CREATE TRIGGER main.packaged_food_names AFTER UPDATE OF name, alternate_name ON packaged_food BEGIN
    INSERT INTO packaged_food_search(packaged_food_search, rowid, name, alternate_name)
    VALUES ('delete', old.rowid, old.name, old.alternate_name);
    INSERT INTO packaged_food_search(rowid, name, alternate_name)
    VALUES (new.rowid, new.name, new.alternate_name);
  END;
  PRAGMA main.application_id = ${applicationId};
  PRAGMA main.user_version = 1;
`;

const validationMigration = `
  ALTER TABLE main.packaged_food ADD COLUMN validation_pending INTEGER NOT NULL DEFAULT 1
    CHECK (validation_pending IN (0, 1));
  CREATE INDEX main.packaged_food_pending ON packaged_food (validation_pending);
  CREATE INDEX main.packaged_food_lru ON packaged_food (accessed_at, source_id DESC);
  CREATE TRIGGER main.packaged_food_validate AFTER UPDATE OF
    source_id, barcode, lookup_code, name, alternate_name, payload, checked_at, accessed_at
    ON packaged_food WHEN new.validation_pending = 0 BEGIN
    UPDATE packaged_food SET validation_pending = 1 WHERE source_id = new.source_id;
  END;
  PRAGMA main.user_version = 2;
`;

const barcodeCandidatesMigration = `
  CREATE TABLE main.packaged_food_barcode_set (
    lookup_code TEXT PRIMARY KEY NOT NULL,
    checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
    candidate_ids TEXT NOT NULL CHECK (json_valid(candidate_ids) AND json_type(candidate_ids) = 'array')
  ) WITHOUT ROWID, STRICT;
  PRAGMA main.user_version = ${schemaVersion};
`;

const saveRow = `
  INSERT INTO main.packaged_food
    (source_id, barcode, lookup_code, name, alternate_name, payload, checked_at, accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    const id = db.get("PRAGMA main.application_id")?.application_id;
    const version = db.get("PRAGMA main.user_version")?.user_version;
    if (id === applicationId && (version === 1 || version === 2 || version === schemaVersion)) {
      const objects = db.get(`SELECT COUNT(*) AS count FROM main.sqlite_schema WHERE
        (type = 'table' AND tbl_name = name AND name IN ('packaged_food', 'packaged_food_search')) OR
        (type = 'index' AND tbl_name = 'packaged_food' AND name = 'packaged_food_lookup') OR
        (type = 'trigger' AND tbl_name = 'packaged_food' AND name IN (
          'packaged_food_insert', 'packaged_food_delete', 'packaged_food_names'
        ))`);
      const fts = db.get(
        "SELECT sql FROM main.sqlite_schema WHERE name = 'packaged_food_search' AND type = 'table'",
      )?.sql;
      const shadows = db.get(`SELECT count(*) AS count FROM main.sqlite_schema
        WHERE type = 'table' AND name IN ('packaged_food_search_data', 'packaged_food_search_idx',
          'packaged_food_search_docsize', 'packaged_food_search_config')`);
      const total = db.get(
        "SELECT count(*) AS count FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
      );
      const expected = version === 1 ? 10 : version === 2 ? 13 : 14;
      if (
        objects?.count !== 6 ||
        shadows?.count !== 4 ||
        total?.count !== expected ||
        typeof fts !== "string" ||
        !/\bUSING\s+fts5\s*\(/i.test(fts)
      ) {
        throw new Error("Packaged-food cache schema is incomplete");
      }
    } else {
      if (id !== 0 || version !== 0 || db.get("SELECT name FROM main.sqlite_schema LIMIT 1")) {
        throw new Error("Cannot open an unrelated or unsupported catalog cache");
      }
      db.exec(schema);
    }
    if (version === 0 || version === 1) db.exec(validationMigration);
    if (version !== schemaVersion) db.exec(barcodeCandidatesMigration);
    const validationObjects = db.get(`SELECT COUNT(*) AS count FROM main.sqlite_schema
      WHERE tbl_name = 'packaged_food' AND (
        (type = 'index' AND name IN ('packaged_food_pending', 'packaged_food_lru')) OR
        (type = 'trigger' AND name = 'packaged_food_validate')
      )`);
    const barcodeSets = db.get(`SELECT name FROM main.sqlite_schema
      WHERE type = 'table' AND name = 'packaged_food_barcode_set'`);
    if (validationObjects?.count !== 3 || !barcodeSets) {
      throw new Error("Packaged-food cache schema is incomplete");
    }
    // A database can change outside SQL while it is closed, so verify its existing rows again.
    db.run("UPDATE main.packaged_food SET validation_pending = 1 WHERE validation_pending = 0");
  });
  // Only an application-owned cache may be vacuumed. Changing this mode requires a rewrite.
  if (db.get("PRAGMA main.auto_vacuum")?.auto_vacuum !== 1) {
    db.exec("PRAGMA main.auto_vacuum = FULL; VACUUM main");
  }
}

function markVerified(db: SqliteConnection, sourceId: string): void {
  db.run(
    "UPDATE main.packaged_food SET validation_pending = 0 WHERE source_id = ? AND validation_pending = 1",
    sourceId,
  );
}

function cacheRowId(row: SqlRow): string {
  if (typeof row.row_id !== "string") throw new Error("Cache row is missing its SQLite identity");
  return row.row_id;
}

function removeRow(db: SqliteConnection, row: SqlRow): void {
  db.run("DELETE FROM main.packaged_food WHERE rowid = CAST(? AS INTEGER)", cacheRowId(row));
}

function payloadBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Could not measure the catalog cache");
  }
  return value;
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
  if (
    [stored.id.sourceId, stored.name, stored.alternateName ?? ""].some(
      (text) => text.includes("\0") || loneSurrogate.test(text),
    )
  ) {
    throw new TypeError("Invalid packaged-food cache product text");
  }
  const payload = JSON.stringify(stored);
  const size = db.get("SELECT length(CAST(? AS BLOB)) AS bytes", payload)?.bytes;
  if (typeof size !== "number") throw new Error("Could not measure the catalog payload");
  if (!retained && size > budget) return;
  const previous = db.get(
    `SELECT ${productColumns} FROM main.packaged_food WHERE source_id = ?`,
    stored.id.sourceId,
  );
  if (previous && !readCachedRow(previous)) {
    // A corrupt row cannot supply the timestamp that protects a valid recent result.
    removeRow(db, previous);
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
  markVerified(db, stored.id.sourceId);
}

function evict(db: SqliteConnection, byteBudget: number, retainedIds: readonly string[]): void {
  db.exec("CREATE TEMP TABLE retained_packaged_food (source_id TEXT PRIMARY KEY NOT NULL)");
  for (const id of retainedIds) {
    db.run("INSERT OR IGNORE INTO temp.retained_packaged_food VALUES (?)", id);
  }
  const ordinary = "source_id NOT IN (SELECT source_id FROM temp.retained_packaged_food)";
  const totals = db.get(`SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes,
    COALESCE(MAX(length(CAST(payload AS BLOB))), 0) AS largest
    FROM main.packaged_food WHERE ${ordinary}`);
  let used = payloadBytes(totals?.bytes);
  const largest = payloadBytes(totals?.largest);
  if (used > byteBudget) {
    // Validate changed and legacy rows before eviction. This avoids decoding the whole cache on every save.
    const rows =
      db.all(`SELECT ${productColumns}, length(CAST(payload AS BLOB)) AS payload_bytes FROM main.packaged_food
      WHERE validation_pending = 1 AND ${ordinary}`);
    for (const row of rows) {
      const validated = readCachedRow(row);
      if (validated) markVerified(db, validated.product.id.sourceId);
      else {
        removeRow(db, row);
        used -= payloadBytes(row.payload_bytes);
      }
    }
    if (largest > byteBudget) {
      const oversized = db.all(
        `SELECT CAST(rowid AS TEXT) AS row_id, length(CAST(payload AS BLOB)) AS payload_bytes
        FROM main.packaged_food WHERE ${ordinary} AND length(CAST(payload AS BLOB)) > ?`,
        byteBudget,
      );
      for (const row of oversized) {
        removeRow(db, row);
        used -= payloadBytes(row.payload_bytes);
      }
    }
    while (used > byteBudget) {
      const oldest =
        db.all(`SELECT CAST(rowid AS TEXT) AS row_id, length(CAST(payload AS BLOB)) AS payload_bytes
        FROM main.packaged_food INDEXED BY packaged_food_lru WHERE ${ordinary}
        ORDER BY accessed_at, source_id DESC LIMIT 32`);
      if (oldest.length === 0)
        throw new Error("The catalog cache budget does not match its contents");
      for (const row of oldest) {
        removeRow(db, row);
        used -= payloadBytes(row.payload_bytes);
        if (used <= byteBudget) break;
      }
    }
  }
  db.exec("DROP TABLE temp.retained_packaged_food");
}

function decodeTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const time = Number(value);
  return Number.isSafeInteger(time) ? time : null;
}

function readCachedRow(row: SqlRow): CachedPackagedFood | null {
  const { payload } = row;
  const checkedAt = decodeTimestamp(row.checked_at);
  const accessedAt = decodeTimestamp(row.accessed_at);
  if (
    row.text_intact !== 1 ||
    typeof payload !== "string" ||
    checkedAt === null ||
    accessedAt === null ||
    accessedAt < checkedAt
  ) {
    return null;
  }
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
    if (!data) {
      db.run(
        "UPDATE main.packaged_food SET validation_pending = 1 WHERE rowid = CAST(? AS INTEGER) AND validation_pending = 0",
        cacheRowId(row),
      );
      continue;
    }
    db.run(
      "UPDATE main.packaged_food SET accessed_at = MAX(accessed_at, ?) WHERE source_id = ?",
      accessedAt,
      data.product.id.sourceId,
    );
    markVerified(db, data.product.id.sourceId);
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
  const schemaCookie = db.get("PRAGMA main.schema_version")?.schema_version;
  const inCache = <T>(work: () => T): T =>
    transaction(db, () => {
      if (
        db.get("PRAGMA main.schema_version")?.schema_version !== schemaCookie ||
        db.get("PRAGMA main.application_id")?.application_id !== applicationId ||
        db.get("PRAGMA main.user_version")?.user_version !== schemaVersion
      ) {
        throw new Error("Packaged-food cache schema changed after opening");
      }
      return work();
    });
  function saveProducts(
    products: readonly PackagedFood[],
    checkedAt: number,
    retainedIds: readonly string[],
  ): void {
    const retained = new Set(retainedIds);
    for (const product of products) {
      writeProduct(db, product, checkedAt, byteBudget, retained.has(product.id.sourceId));
    }
  }
  function pruneCache(retainedIds: readonly string[]) {
    evict(db, byteBudget, retainedIds);
    db.run(`DELETE FROM main.packaged_food_barcode_set AS match
      WHERE NOT EXISTS (SELECT 1 FROM main.packaged_food AS product
        WHERE product.lookup_code = match.lookup_code)`);
  }
  return {
    save(products, checkedAt, retainedIds) {
      timestamp(checkedAt);
      inCache(() => {
        saveProducts(products, checkedAt, retainedIds);
        pruneCache(retainedIds);
      });
    },
    saveBarcodeCandidates(barcode, products, checkedAt, retainedIds) {
      const key = normalizeOpenFoodFactsBarcode(barcode.trim());
      const ids = products.map((product) => product.id.sourceId);
      if (
        !key ||
        ids.length === 0 ||
        new Set(ids).size !== ids.length ||
        products.some((product) => normalizeOpenFoodFactsBarcode(product.barcode) !== key)
      ) {
        throw new TypeError("Invalid packaged-food cache candidate set");
      }
      timestamp(checkedAt);
      inCache(() => {
        const previous = db.get(
          `SELECT 1 AS newer FROM main.packaged_food_barcode_set
           WHERE lookup_code = ? AND checked_at > ?`,
          key,
          checkedAt,
        );
        if (previous) return;
        saveProducts(products, checkedAt, retainedIds);
        db.run(
          `INSERT INTO main.packaged_food_barcode_set VALUES (?, ?, ?)
           ON CONFLICT(lookup_code) DO UPDATE SET
             checked_at = excluded.checked_at, candidate_ids = excluded.candidate_ids`,
          key,
          checkedAt,
          JSON.stringify(ids),
        );
        pruneCache(retainedIds);
      });
    },
    prune(retainedIds) {
      inCache(() => pruneCache(retainedIds));
    },
    lookupBarcode(barcode, accessedAt) {
      const text = barcode.trim();
      const key = normalizeOpenFoodFactsBarcode(text);
      if (!key) return [];
      timestamp(accessedAt);
      return inCache(() =>
        touch(
          db,
          db.all(
            `SELECT ${productColumns} FROM main.packaged_food
             LEFT JOIN main.packaged_food_barcode_set AS match
               ON match.lookup_code = packaged_food.lookup_code
             WHERE packaged_food.lookup_code = ?
               AND (match.lookup_code IS NULL OR packaged_food.checked_at > match.checked_at OR
                 EXISTS (SELECT 1 FROM json_each(match.candidate_ids)
                   WHERE value = packaged_food.source_id))
             ORDER BY (barcode = ?) DESC, source_id`,
            key,
            text,
          ),
          accessedAt,
        ),
      );
    },
    findByIds(sourceIds, accessedAt) {
      timestamp(accessedAt);
      return inCache(() => {
        const rows: SqlRow[] = [];
        for (const id of new Set(sourceIds)) {
          const row = db.get(
            `SELECT ${productColumns} FROM main.packaged_food WHERE source_id = ?`,
            id,
          );
          if (row) rows.push(row);
        }
        return touch(db, rows, accessedAt);
      });
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
      return inCache(() => {
        const results: CachedPackagedFood[] = [];
        const pageSize = 50;
        for (let offset = 0; results.length < pageSize; offset += pageSize) {
          const rows = db.all(
            `SELECT ${productColumns} FROM main.packaged_food_search
             JOIN main.packaged_food ON packaged_food_search.rowid = packaged_food.rowid
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
