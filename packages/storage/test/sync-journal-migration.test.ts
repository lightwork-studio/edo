import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { type DiarySqliteConnection, type OpenDiaryOptions, openDiary } from "@edo/storage";
import { createSyncClient, openSyncJournal } from "@edo/sync";
import { afterEach, expect, test } from "vitest";
import { diaryMigrations, migrateDiary } from "../src/migrations.ts";

const v4Sql = readFileSync(new URL("./fixtures/diary-v4.sql", import.meta.url), "utf8");
const v4Archive = JSON.parse(
  readFileSync(new URL("./fixtures/diary-v4-archive.json", import.meta.url), "utf8"),
);
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

async function copyDatabase(sourcePath: string, copyPath: string) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, copyPath);
  } finally {
    source.close();
  }
}

function openFile(path: string, dir: string) {
  const db = new DatabaseSync(path);
  connections.push(db);
  const sqlite = connection(db);
  const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
    version,
    verify,
  ) => {
    const destination = join(dir, `prior-v${version}-${basename(path)}`);
    await copyDatabase(path, destination);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      verify(connection(snapshot));
    } finally {
      snapshot.close();
    }
  };
  return {
    db,
    sqlite,
    backupBeforeMigration,
    open: () => openDiary({ connection: sqlite, backupBeforeMigration }),
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "edo-journal-migration-"));
  directories.push(dir);
  const path = join(dir, "diary.sqlite");
  const source = openFile(path, dir);
  source.sqlite.exec(v4Sql);
  return { ...source, path, dir };
}

function journalTables(db: DiarySqliteConnection) {
  return db
    .all("SELECT name FROM sqlite_schema WHERE name GLOB 'edo_sync_*' ORDER BY name")
    .map((row) => row.name);
}

test("upgrades a historical v4 diary and restores the full verified backup", async () => {
  const source = fixture();
  const diary = await source.open();
  expect(JSON.parse(diary.exportPrivateArchive())).toEqual(v4Archive);
  expect(journalTables(source.sqlite)).toEqual([
    "edo_sync_binding",
    "edo_sync_outbox",
    "edo_sync_receipts",
    "edo_sync_remote",
    "edo_sync_submission_ids",
  ]);
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(5);
  const journal = openSyncJournal(source.sqlite);
  expect(journal.history()).toBeNull();
  expect(journal.queued()).toEqual([]);

  const session = await createSyncClient({
    origin: "https://example.test",
    releases: [{ release: "0.1", features: ["write-records"], writableKinds: ["weigh-in"] }],
    authorization: () => "Bearer synthetic",
    fetch: async () =>
      Response.json({
        accountBinding: "account",
        lineage: "fixture",
        revision: 0,
        restoredFrom: null,
        release: "0.1",
        features: ["write-records"],
      }),
  }).connect();
  journal.bind(session);
  source.db.close();

  const reopened = openFile(source.path, source.dir);
  const existing = await openDiary({
    connection: reopened.sqlite,
    backupBeforeMigration: async () => {
      throw new Error("An upgraded diary does not need a second backup");
    },
  });
  expect(JSON.parse(existing.exportPrivateArchive())).toEqual(v4Archive);
  expect(openSyncJournal(reopened.sqlite).history()).toMatchObject({
    accountBinding: "account",
    lineage: "fixture",
    cursor: 0,
  });

  const recovery = join(source.dir, "recovered.sqlite");
  copyFileSync(join(source.dir, "prior-v4-diary.sqlite"), recovery);
  const recovered = openFile(recovery, source.dir);
  expect(recovered.sqlite.get("PRAGMA user_version")?.user_version).toBe(4);
  expect(journalTables(recovered.sqlite)).toEqual([]);
  expect(JSON.parse((await recovered.open()).exportPrivateArchive())).toEqual(v4Archive);
  expect(openSyncJournal(recovered.sqlite).history()).toBeNull();
});

test("rolls back the journal schema if interrupted and retries without data loss", async () => {
  const source = fixture();
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

  expect(JSON.parse((await source.open()).exportPrivateArchive())).toEqual(v4Archive);
  expect(journalTables(source.sqlite)).toContain("edo_sync_outbox");
});

test("rejects a backup that drops journal rows before a subsequent migration", async () => {
  const source = fixture();
  await source.open();
  source.sqlite.run("INSERT INTO edo_sync_submission_ids (submission_id) VALUES (?)", "reserved");

  await expect(
    migrateDiary(
      source.sqlite,
      [...diaryMigrations, () => {}],
      async (_, verify) => {
        const copy = join(source.dir, "missing-submission.sqlite");
        await copyDatabase(source.path, copy);
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
