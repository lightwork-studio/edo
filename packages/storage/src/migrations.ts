import { installSyncJournalV5 } from "@edo/sync/journal-schema-v5";
import { installSyncJournalV6 } from "@edo/sync/journal-schema-v6";
import { installSyncJournalV7 } from "@edo/sync/journal-schema-v7";
import { installSyncJournalV8 } from "@edo/sync/journal-schema-v8";
import { installSyncJournalV9 } from "@edo/sync/journal-schema-v9";
import { type DiarySqliteConnection, rollback } from "./sqlite.ts";

type Migration = (db: DiarySqliteConnection) => void;

export type DiaryBackup = (
  version: number,
  verify: (snapshot: DiarySqliteConnection) => void,
) => Promise<void>;

const diaryApplicationId = 0x45444f44; // EDOD

const legacyDiarySchema = {
  diary_meals: `CREATE TABLE diary_meals (
    id TEXT PRIMARY KEY NOT NULL,
    local_day TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  )`,
  diary_meals_by_day: "CREATE INDEX diary_meals_by_day ON diary_meals (local_day, occurred_at, id)",
  diary_items: `CREATE TABLE diary_items (
    id TEXT PRIMARY KEY NOT NULL,
    meal_id TEXT NOT NULL REFERENCES diary_meals(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    UNIQUE (meal_id, position)
  )`,
};

export const diaryMigrations: readonly Migration[] = [
  (db) => db.exec(`${Object.values(legacyDiarySchema).join(";\n")};`),
  (db) => {
    db.exec(`
      ALTER TABLE main.diary_meals ADD COLUMN utc_offset_minutes INTEGER
        CHECK (utc_offset_minutes IS NULL OR
          (typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -1439 AND 1439));
      PRAGMA application_id = ${diaryApplicationId};
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE diary_weigh_ins (
        id TEXT PRIMARY KEY NOT NULL,
        local_day TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        kg REAL NOT NULL CHECK (kg > 0)
      ) STRICT;
      CREATE INDEX main.diary_weigh_ins_by_day ON diary_weigh_ins (local_day, occurred_at, id);
      CREATE TABLE diary_targets (
        save_order INTEGER PRIMARY KEY CHECK (save_order > 0),
        id TEXT UNIQUE NOT NULL,
        effective_day TEXT NOT NULL,
        configured_at INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'calculated')),
        kcal REAL NOT NULL CHECK (kcal > 0),
        protein_g REAL NOT NULL CHECK (protein_g >= 0),
        fat_g REAL NOT NULL CHECK (fat_g >= 0),
        carbohydrate_g REAL NOT NULL CHECK (carbohydrate_g >= 0)
      ) STRICT;
      CREATE INDEX main.diary_targets_by_day ON diary_targets (effective_day, save_order);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE diary_custom_foods (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
      CREATE TABLE diary_recipes (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
      CREATE TABLE diary_meal_templates (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL CHECK (json_valid(content))
      ) STRICT;
      CREATE TABLE diary_favorites (
        provider TEXT NOT NULL CHECK (provider IN ('bls', 'open-food-facts', 'usda', 'local')),
        source_id TEXT NOT NULL,
        PRIMARY KEY (provider, source_id)
      ) WITHOUT ROWID, STRICT;
    `);
  },
  installSyncJournalV5,
  installSyncJournalV6,
  installSyncJournalV7,
  installSyncJournalV8,
  installSyncJournalV9,
];

function storageVersion(db: DiarySqliteConnection): number {
  const version = db.get("PRAGMA user_version")?.user_version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Invalid diary storage version");
  }
  return version;
}

function matchesLegacyDiary(db: DiarySqliteConnection): boolean {
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const stored = new Map(
    db
      .all("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
      .map(({ name, sql }) => [name, typeof sql === "string" ? normalize(sql) : null]),
  );
  const expected = Object.entries(legacyDiarySchema);
  return (
    stored.size === expected.length &&
    expected.every(([name, sql]) => stored.get(name) === normalize(sql))
  );
}

function requireDiaryIdentity(db: DiarySqliteConnection, version: number): void {
  const applicationId = db.get("PRAGMA application_id")?.application_id;
  if (applicationId === diaryApplicationId) return;
  if (applicationId === 0) {
    if (version === 0) return;
    if (version === 1 && matchesLegacyDiary(db)) return;
  }
  throw new Error("SQLite file does not belong to the Edo diary");
}

/** Check while holding the operation's SQLite transaction. */
export function requireCurrentDiaryVersion(db: DiarySqliteConnection): void {
  if (storageVersion(db) !== diaryMigrations.length) {
    throw new Error("The diary storage version has changed. Reopen Edo before continuing.");
  }
}

export function inCurrentDiary<T>(
  db: DiarySqliteConnection,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  operation: () => T,
): T {
  db.exec(begin);
  try {
    requireCurrentDiaryVersion(db);
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    return rollback(db, error);
  }
}

export function requireUnshadowedDiary(db: DiarySqliteConnection): void {
  const shadow = db.get(`
    SELECT 1
    FROM temp.sqlite_schema AS temporary
    JOIN main.sqlite_schema AS persistent ON temporary.name = persistent.name COLLATE NOCASE
    WHERE temporary.type IN ('table', 'view') AND persistent.type = 'table'
    LIMIT 1
  `);
  if (shadow) throw new Error("Reopen the diary on a clean SQLite connection before continuing");
}

function verifyIntegrity(db: DiarySqliteConnection, operation: string): void {
  const checks = db.all("PRAGMA main.quick_check");
  if (checks.length !== 1 || checks[0]?.quick_check !== "ok") {
    throw new Error(`${operation} failed SQLite integrity verification`);
  }
  if (db.get("PRAGMA main.foreign_key_check")) {
    throw new Error(`${operation} contains invalid references`);
  }
}

async function verifyBackup(
  source: DiarySqliteConnection,
  installed: number,
  backup: DiaryBackup,
): Promise<void> {
  let verified = false;
  await backup(installed, (snapshot) => {
    if (storageVersion(snapshot) !== installed) {
      throw new Error("Diary backup has the wrong storage version");
    }
    requireDiaryIdentity(snapshot, installed);
    verifyIntegrity(snapshot, "Diary backup");
    // Compare persisted rows even if one connection also has temporary tables.
    for (const query of [
      "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name",
      "SELECT * FROM main.diary_meals ORDER BY id",
      "SELECT * FROM main.diary_items ORDER BY id",
      ...(installed >= 3
        ? [
            "SELECT * FROM main.diary_weigh_ins ORDER BY id",
            "SELECT * FROM main.diary_targets ORDER BY save_order",
          ]
        : []),
      ...(installed >= 4
        ? [
            "SELECT * FROM main.diary_custom_foods ORDER BY id",
            "SELECT * FROM main.diary_recipes ORDER BY id",
            "SELECT * FROM main.diary_meal_templates ORDER BY id",
            "SELECT * FROM main.diary_favorites ORDER BY provider, source_id",
          ]
        : []),
      ...(installed >= 5
        ? [
            "SELECT * FROM main.edo_sync_binding ORDER BY singleton",
            "SELECT * FROM main.edo_sync_outbox ORDER BY kind, id",
            "SELECT * FROM main.edo_sync_receipts ORDER BY submission_id",
            "SELECT * FROM main.edo_sync_remote ORDER BY kind, id",
            "SELECT * FROM main.edo_sync_submission_ids ORDER BY submission_id",
          ]
        : []),
      ...(installed >= 6 ? ["SELECT * FROM main.edo_sync_meal_projections ORDER BY id"] : []),
      ...(installed >= 7 ? ["SELECT * FROM main.edo_sync_staged_meal_claims ORDER BY id"] : []),
      ...(installed >= 8 ? ["SELECT * FROM main.edo_sync_weigh_in_projections ORDER BY id"] : []),
      ...(installed >= 9
        ? ["SELECT * FROM main.edo_sync_attempt_observations ORDER BY submission_id, revision"]
        : []),
    ]) {
      if (JSON.stringify(source.all(query)) !== JSON.stringify(snapshot.all(query))) {
        throw new Error("Diary backup does not match the current diary");
      }
    }
    verified = true;
  });
  if (!verified) throw new Error("Diary migration requires a verified backup");
}

/**
 * Run migrations and verification before exposing the connection to callers. The backup uses a
 * separate read connection while the migration's reserved write lock prevents concurrent changes.
 */
export async function migrateDiary(
  db: DiarySqliteConnection,
  migrations: readonly Migration[],
  backup: DiaryBackup,
  verifyRecords: (db: DiarySqliteConnection) => void,
): Promise<void> {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
  if (db.get("PRAGMA foreign_keys")?.foreign_keys !== 1) {
    throw new Error("Diary storage requires foreign key enforcement");
  }
  const observed = storageVersion(db);
  requireDiaryIdentity(db, observed);
  if (observed === migrations.length) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const installed = storageVersion(db);
    if (installed > migrations.length) {
      throw new Error("This diary was saved by a newer version of Edo");
    }
    requireDiaryIdentity(db, installed);
    requireUnshadowedDiary(db);
    if (installed < migrations.length) {
      if (installed === 0) {
        const existing = db.get("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'");
        if (existing) throw new Error("Cannot initialize a nonempty unversioned diary");
      } else {
        await verifyBackup(db, installed, backup);
      }

      for (const migrate of migrations.slice(installed)) migrate(db);
      requireUnshadowedDiary(db);
      verifyIntegrity(db, "Diary migration");
      verifyRecords(db);
      db.exec(`PRAGMA user_version = ${migrations.length}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    rollback(db, error);
  }
}
