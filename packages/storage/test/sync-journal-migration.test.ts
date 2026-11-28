import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createDiaryItem, type DiaryMeal } from "@edo/core";
import { type DiarySqliteConnection, type OpenDiaryOptions, openDiary } from "@edo/storage";
import { afterEach, expect, test } from "vitest";
import { diaryMigrations, migrateDiary } from "../src/migrations.ts";

const directories: string[] = [];
const connections: DatabaseSync[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) if (db.isOpen) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function connection(db: DatabaseSync): DiarySqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...values) => {
      db.prepare(sql).run(...values);
    },
    all: (sql, ...values) => db.prepare(sql).all(...values),
    get: (sql, ...values) => db.prepare(sql).get(...values),
  };
}

const meal: DiaryMeal = {
  id: "meal-1",
  localDay: "2026-10-31",
  occurredAt: Date.parse("2026-11-01T02:30:00Z"),
  utcOffsetMinutes: -240,
  items: [
    createDiaryItem(
      "item-1",
      {
        id: { provider: "open-food-facts", sourceId: "00012345" },
        release: "catalog-1",
        name: "Soy drink",
        preparation: "as-sold",
        nutrition: {
          basis: "per-100-ml",
          nutrients: {
            kcal: 80,
            proteinG: 7,
            availableCarbohydratesG: 0,
            fatG: 3,
            fiberG: null,
          },
        },
      },
      { amount: 50, unit: "ml" },
    ),
  ],
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "edo-journal-migration-"));
  directories.push(dir);
  const path = join(dir, "diary.sqlite");
  const db = new DatabaseSync(path);
  connections.push(db);
  const sqlite = connection(db);
  await migrateDiary(
    sqlite,
    diaryMigrations.slice(0, 4),
    async () => {
      throw new Error("A new database has no prior diary to back up");
    },
    () => {},
  );

  sqlite.run(
    "INSERT INTO diary_meals (id, local_day, occurred_at, utc_offset_minutes) VALUES (?, ?, ?, ?)",
    meal.id,
    meal.localDay,
    meal.occurredAt,
    meal.utcOffsetMinutes ?? null,
  );
  for (const [position, { id, ...snapshot }] of meal.items.entries()) {
    sqlite.run(
      "INSERT INTO diary_items (id, meal_id, position, snapshot) VALUES (?, ?, ?, ?)",
      id,
      meal.id,
      position,
      JSON.stringify(snapshot),
    );
  }

  const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
    version,
    verify,
  ) => {
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      const copy = join(dir, `prior-v${version}.sqlite`);
      await backup(source, copy);
      const snapshot = new DatabaseSync(copy, { readOnly: true });
      try {
        verify(connection(snapshot));
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  };

  return { db, sqlite, path, dir, backupBeforeMigration };
}

function journalTables(db: DiarySqliteConnection) {
  return db
    .all("SELECT name FROM sqlite_schema WHERE name GLOB 'edo_sync_*' ORDER BY name")
    .map((row) => row.name);
}

test("upgrades a backed-up v4 diary with its food snapshot and journal tables intact", async () => {
  const source = await fixture();
  await openDiary({
    connection: source.sqlite,
    backupBeforeMigration: source.backupBeforeMigration,
  });
  expect(journalTables(source.sqlite)).toEqual([
    "edo_sync_binding",
    "edo_sync_outbox",
    "edo_sync_receipts",
    "edo_sync_remote",
    "edo_sync_submission_ids",
  ]);
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(5);
  expect(source.sqlite.all("SELECT * FROM edo_sync_binding")).toEqual([]);
  expect(source.sqlite.all("SELECT * FROM edo_sync_outbox")).toEqual([]);
  source.db.close();

  const backup = new DatabaseSync(join(source.dir, "prior-v4.sqlite"), { readOnly: true });
  connections.push(backup);
  const saved = connection(backup);
  expect(saved.get("PRAGMA user_version")?.user_version).toBe(4);
  expect(journalTables(saved)).toEqual([]);
  expect(saved.get("SELECT id, utc_offset_minutes FROM diary_meals")).toMatchObject({
    id: meal.id,
    utc_offset_minutes: -240,
  });

  const reopened = new DatabaseSync(source.path);
  connections.push(reopened);
  const diary = await openDiary({
    connection: connection(reopened),
    backupBeforeMigration: async () => {
      throw new Error("An already upgraded diary does not need another backup");
    },
  });
  expect(diary.getMeal(meal.id)).toEqual(meal);
});

test("rolls back the journal schema if interrupted and can retry the original upgrade", async () => {
  const source = await fixture();
  const interrupted: DiarySqliteConnection = {
    ...source.sqlite,
    exec: (sql) => {
      source.sqlite.exec(sql);
      if (sql.includes("CREATE TABLE edo_sync_outbox")) throw new Error("Simulated interruption");
    },
  };

  await expect(
    openDiary({ connection: interrupted, backupBeforeMigration: source.backupBeforeMigration }),
  ).rejects.toThrow("Simulated interruption");
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(4);
  expect(journalTables(source.sqlite)).toEqual([]);

  const diary = await openDiary({
    connection: source.sqlite,
    backupBeforeMigration: source.backupBeforeMigration,
  });
  expect(diary.getMeal(meal.id)).toEqual(meal);
  expect(journalTables(source.sqlite)).toContain("edo_sync_outbox");
});

test("rejects a backup that drops journal rows before a subsequent migration", async () => {
  const source = await fixture();
  await openDiary({
    connection: source.sqlite,
    backupBeforeMigration: source.backupBeforeMigration,
  });
  source.sqlite.run("INSERT INTO edo_sync_submission_ids (submission_id) VALUES (?)", "reserved");

  await expect(
    migrateDiary(
      source.sqlite,
      [...diaryMigrations, () => {}],
      async (_, verify) => {
        const copy = join(source.dir, "missing-submission.sqlite");
        const reader = new DatabaseSync(source.path, { readOnly: true });
        try {
          await backup(reader, copy);
        } finally {
          reader.close();
        }
        const incomplete = new DatabaseSync(copy);
        try {
          incomplete.exec("DELETE FROM edo_sync_submission_ids");
          verify(connection(incomplete));
        } finally {
          incomplete.close();
        }
      },
      () => {},
    ),
  ).rejects.toThrow("Diary backup does not match the current diary");
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(5);
  expect(source.sqlite.get("SELECT submission_id FROM edo_sync_submission_ids")).toMatchObject({
    submission_id: "reserved",
  });
});
