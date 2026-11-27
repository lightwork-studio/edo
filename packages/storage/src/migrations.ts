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
      ALTER TABLE diary_meals ADD COLUMN utc_offset_minutes INTEGER
        CHECK (utc_offset_minutes IS NULL OR
          (typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -1439 AND 1439));
      PRAGMA application_id = ${diaryApplicationId};
    `);
  },
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

function verifyIntegrity(db: DiarySqliteConnection, operation: string): void {
  const checks = db.all("PRAGMA quick_check");
  if (checks.length !== 1 || checks[0]?.quick_check !== "ok") {
    throw new Error(`${operation} failed SQLite integrity verification`);
  }
  if (db.get("PRAGMA foreign_key_check")) {
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
    for (const query of [
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      "SELECT * FROM diary_meals ORDER BY id",
      "SELECT * FROM diary_items ORDER BY id",
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
    if (installed < migrations.length) {
      if (installed === 0) {
        const existing = db.get("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'");
        if (existing) throw new Error("Cannot initialize a nonempty unversioned diary");
      } else {
        await verifyBackup(db, installed, backup);
      }

      for (const migrate of migrations.slice(installed)) migrate(db);
      verifyIntegrity(db, "Diary migration");
      verifyRecords(db);
      db.exec(`PRAGMA user_version = ${migrations.length}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    rollback(db, error);
  }
}
