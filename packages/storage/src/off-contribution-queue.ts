import { normalizeOpenFoodFactsBarcode } from "@edo/core";
import { rollback, type SqliteConnection, type SqlRow } from "./sqlite.ts";

const applicationId = 0x45444f51; // EDOQ
const schemaVersion = 1;
const productColumns = "barcode, language, name, brand, package_quantity, queued_at";

export interface OffContributionDraft {
  readonly barcode: string;
  readonly language: string;
  readonly name: string;
  readonly brand?: string | null;
  readonly packageQuantity?: string | null;
}

export interface OffContributionProduct {
  readonly barcode: string;
  readonly language: string;
  readonly name: string;
  readonly brand: string | null;
  readonly packageQuantity: string | null;
}

export interface QueuedOffContribution {
  readonly product: OffContributionProduct;
  readonly queuedAt: number;
}

function transaction<T>(
  db: SqliteConnection,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  operation: () => T,
): T {
  db.exec(begin);
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    return rollback(db, error, "Contribution queue transaction and rollback failed");
  }
}

function format(db: SqliteConnection) {
  return {
    application: db.get("PRAGMA main.application_id")?.application_id,
    version: db.get("PRAGMA main.user_version")?.user_version,
  };
}

function initialize(db: SqliteConnection) {
  db.exec("PRAGMA busy_timeout = 1000");
  transaction(db, "BEGIN IMMEDIATE", () => {
    const { application, version } = format(db);
    if (application === applicationId && version === schemaVersion) {
      requireMainQueueTable(db);
      return;
    }
    if (
      application !== 0 ||
      version !== 0 ||
      db.get("SELECT name FROM main.sqlite_schema LIMIT 1")
    ) {
      throw new Error("Unsupported Open Food Facts contribution queue");
    }
    db.exec(`
      CREATE TABLE main.off_contributions (
        barcode TEXT PRIMARY KEY NOT NULL,
        language TEXT NOT NULL,
        name TEXT NOT NULL,
        brand TEXT,
        package_quantity TEXT,
        queued_at INTEGER NOT NULL CHECK (queued_at >= 0)
      ) WITHOUT ROWID, STRICT;
      PRAGMA main.application_id = ${applicationId};
      PRAGMA main.user_version = ${schemaVersion};
    `);
  });
}

function requireMainQueueTable(db: SqliteConnection) {
  if (
    !db.get(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name = 'off_contributions'",
    )
  ) {
    throw new Error("Missing Open Food Facts contribution queue table");
  }
  db.get(`SELECT ${productColumns} FROM main.off_contributions LIMIT 0`);
}

function requireCurrentFormat(db: SqliteConnection) {
  const { application, version } = format(db);
  if (application !== applicationId || version !== schemaVersion) {
    throw new Error("Unsupported Open Food Facts contribution queue");
  }
  requireMainQueueTable(db);
}

function productText(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string" || /[\0\ud800-\udfff]/u.test(value)) {
    throw new TypeError(`Invalid contribution ${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw new TypeError(`Invalid contribution ${field}`);
  return trimmed;
}

function optionalText(value: unknown, limit: number, field: string): string | null {
  return value === null || value === undefined ? null : productText(value, limit, field);
}

function readProduct(fields: {
  barcode: unknown;
  language: unknown;
  name: unknown;
  brand?: unknown;
  packageQuantity?: unknown;
}): OffContributionProduct {
  const barcode = productText(fields.barcode, 64, "barcode");
  if (!normalizeOpenFoodFactsBarcode(barcode)) throw new TypeError("Invalid contribution barcode");
  const language = productText(fields.language, 2, "language").toLowerCase();
  if (!/^[a-z]{2}$/.test(language)) throw new TypeError("Invalid contribution language");
  return {
    barcode,
    language,
    name: productText(fields.name, 256, "name"),
    brand: optionalText(fields.brand, 256, "brand"),
    packageQuantity: optionalText(fields.packageQuantity, 64, "package quantity"),
  };
}

function queuedTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid contribution time");
  }
  return value;
}

function readQueued(row: SqlRow): QueuedOffContribution {
  return {
    product: readProduct({
      barcode: row.barcode,
      language: row.language,
      name: row.name,
      brand: row.brand,
      packageQuantity: row.package_quantity,
    }),
    queuedAt: queuedTime(row.queued_at),
  };
}

/** Open a dedicated device database for contributions the user has reviewed. */
export function openOffContributionQueue(db: SqliteConnection) {
  initialize(db);
  const previews = new WeakSet<OffContributionProduct>();
  return {
    preview(draft: OffContributionDraft): OffContributionProduct {
      const product = Object.freeze(readProduct(draft));
      previews.add(product);
      return product;
    },
    enqueue(
      reviewed: OffContributionProduct,
      now: number,
    ): { status: "queued" | "already-queued" | "different-draft"; entry: QueuedOffContribution } {
      if (!previews.has(reviewed)) throw new Error("Preview the product before queueing it");
      const queuedAt = queuedTime(now);
      return transaction(db, "BEGIN IMMEDIATE", () => {
        requireCurrentFormat(db);
        const previous = db.get(
          `SELECT ${productColumns} FROM main.off_contributions WHERE barcode = ?`,
          reviewed.barcode,
        );
        if (previous) {
          const entry = readQueued(previous);
          const repeated = JSON.stringify(entry.product) === JSON.stringify(reviewed);
          return { status: repeated ? "already-queued" : "different-draft", entry };
        }
        db.run(
          `INSERT INTO main.off_contributions (${productColumns}) VALUES (?, ?, ?, ?, ?, ?)`,
          reviewed.barcode,
          reviewed.language,
          reviewed.name,
          reviewed.brand,
          reviewed.packageQuantity,
          queuedAt,
        );
        return { status: "queued", entry: { product: reviewed, queuedAt } };
      });
    },
    pending(): QueuedOffContribution[] {
      return transaction(db, "BEGIN", () => {
        requireCurrentFormat(db);
        return db
          .all(`SELECT ${productColumns} FROM main.off_contributions ORDER BY queued_at, barcode`)
          .map(readQueued);
      });
    },
  };
}
