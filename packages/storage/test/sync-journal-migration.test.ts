import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { type DiarySqliteConnection, type OpenDiaryOptions, openDiary } from "@edo/storage";
import { createSyncClient, openSyncJournal } from "@edo/sync";
import { afterEach, expect, test } from "vitest";
import { applyRecordContent } from "../../../apps/sync-node/src/record-projection.ts";
import { createHealthServer } from "../../../apps/sync-node/src/server.ts";
import { openSyncStore } from "../../../apps/sync-node/src/sync-store.ts";
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
    "edo_sync_meal_projections",
    "edo_sync_outbox",
    "edo_sync_receipts",
    "edo_sync_remote",
    "edo_sync_staged_meal_claims",
    "edo_sync_submission_ids",
  ]);
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(7);
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

test("upgrades and can recover a bound v5 diary without inventing accepted meal evidence", async () => {
  const source = fixture();
  await migrateDiary(
    source.sqlite,
    diaryMigrations.slice(0, 5),
    source.backupBeforeMigration,
    () => {},
  );
  const key = { kind: "meal", id: v4Archive.meals[0].id };
  const record = JSON.stringify({
    key,
    baseRevision: 7,
    base: null,
    pending: null,
    attempt: null,
    blocked: null,
  });
  source.sqlite.run(
    "INSERT INTO edo_sync_binding VALUES (1, ?, ?, ?, 7, 0)",
    "https://example.test",
    "account",
    "fixture",
  );
  source.sqlite.run(
    "INSERT INTO edo_sync_outbox VALUES ('meal', ?, NULL, NULL, ?)",
    key.id,
    record,
  );
  source.sqlite.run("INSERT INTO edo_sync_receipts VALUES (?)", "accepted-old");
  source.sqlite.run("INSERT INTO edo_sync_submission_ids VALUES (?)", "accepted-old");

  const interrupted: DiarySqliteConnection = {
    ...source.sqlite,
    exec: (sql) => {
      source.sqlite.exec(sql);
      if (sql.includes("CREATE TABLE edo_sync_meal_projections")) {
        throw new Error("Simulated v6 interruption");
      }
    },
  };
  await expect(
    openDiary({ connection: interrupted, backupBeforeMigration: source.backupBeforeMigration }),
  ).rejects.toThrow("Simulated v6 interruption");
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(5);
  expect(journalTables(source.sqlite)).not.toContain("edo_sync_meal_projections");
  const diary = await source.open();
  expect(JSON.parse(diary.exportPrivateArchive())).toEqual(v4Archive);
  expect(diary.sync.journal.history()).toMatchObject({ revision: 7, cursor: 0 });
  expect(source.sqlite.all("SELECT * FROM edo_sync_meal_projections")).toEqual([]);
  expect(source.sqlite.get("SELECT content FROM edo_sync_outbox")).toEqual({ content: record });
  using backup = new DatabaseSync(join(source.dir, "prior-v5-diary.sqlite"), { readOnly: true });
  expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
  expect(backup.prepare("SELECT submission_id FROM edo_sync_receipts").get()).toEqual({
    submission_id: "accepted-old",
  });
  expect(backup.prepare("SELECT content FROM edo_sync_outbox").get()).toEqual({ content: record });
});

test.each(["none", "delete", "put"] as const)("recovers a v5 meal receipt (%s)", async (edit) => {
  const source = fixture();
  await migrateDiary(
    source.sqlite,
    diaryMigrations.slice(0, 5),
    source.backupBeforeMigration,
    () => {},
  );
  using store = openSyncStore(join(source.dir, "account.sqlite"), {
    applyContent: applyRecordContent,
  });
  store.createAccount("account", "fixture");
  await using server = createHealthServer({
    sync: {
      store,
      authorize: () => ({ accountBinding: "account", sessionKey: "phone" }),
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing sync test port");
  const client = createSyncClient({
    origin: `http://127.0.0.1:${address.port}`,
    allowLoopbackHttp: true,
    authorization: () => "Bearer synthetic",
  });
  const session = await client.connect();
  const journal = openSyncJournal(source.sqlite);
  journal.bind(session);
  const meal = v4Archive.meals[0];
  const key = { kind: "meal", id: meal.id };
  journal.commitLocal(
    key,
    { op: "put", submissionId: "v5-attempt", content: meal },
    () => undefined,
  );
  const attempt = journal.prepare(session);
  const lost = await client.push(session, attempt);
  expect(lost.results).toEqual([{ status: "accepted", submissionId: "v5-attempt", revision: 1 }]);
  source.db.close();

  const upgrade = openFile(source.path, source.dir);
  const synced = await upgrade.open();
  const history = synced.sync.journal.history();
  if (!history) throw new Error("Expected the restored binding");
  const reconnected = await client.connect(history);
  synced.sync.journal.bind(reconnected);
  const editedMeal = { ...meal, occurredAt: meal.occurredAt + 60_000 };
  if (edit === "delete") synced.sync.deleteMeal(meal.id, "newer-delete");
  if (edit === "put") synced.sync.saveMeal(editedMeal, "newer-put");
  expect(synced.sync.journal.mealProjection(meal.id)).toBeNull();
  const retry = synced.sync.journal.prepare(reconnected);
  expect(retry).toEqual(attempt);
  const accepted = await client.push(reconnected, retry);
  expect(accepted).toEqual(lost);
  synced.sync.journal.applyResults(reconnected, accepted, () => undefined);
  upgrade.db.close();

  const file = openFile(source.path, source.dir);
  const reopened = await file.open();
  const evidence = {
    revision: 1,
    origin: "accepted" as const,
    content: meal,
  };
  const saved = file.sqlite.get(
    "SELECT revision, origin, content FROM edo_sync_meal_projections WHERE id = ?",
    meal.id,
  );
  expect(saved && { ...saved, content: JSON.parse(String(saved.content)) }).toEqual(evidence);
  const diaryMeal = { none: meal, delete: null, put: editedMeal }[edit];
  const pendingEdit = {
    none: null,
    delete: { op: "delete", submissionId: "newer-delete" },
    put: { op: "put", submissionId: "newer-put", content: editedMeal },
  }[edit];
  expect(reopened.getMeal(meal.id)).toEqual(diaryMeal);
  expect(reopened.sync.journal.mealProjection(meal.id)).toEqual(pendingEdit ? null : evidence);
  expect(reopened.sync.journal.queued()).toMatchObject(
    pendingEdit ? [{ key, baseRevision: 1, pending: pendingEdit }] : [],
  );
  expect(reopened.sync.journal.serverCopy(key)).toBeNull();
  expect(reopened.sync.journal.history()).toMatchObject({ revision: 1, cursor: 0 });
});

test("backs up a bound v6 diary before adding staged ownership storage and retries after interruption", async () => {
  const source = fixture();
  const v6Migrations = diaryMigrations.slice(0, 6);
  await migrateDiary(source.sqlite, v6Migrations, source.backupBeforeMigration, () => {});
  const meal = v4Archive.meals[0];
  source.sqlite.run(
    "INSERT INTO edo_sync_binding VALUES (1, ?, ?, ?, 3, 2)",
    "https://example.test",
    "account",
    "fixture",
  );
  const journal = openSyncJournal(source.sqlite);
  journal.commitLocal(
    { kind: "meal", id: meal.id },
    { op: "delete", submissionId: "pending-delete" },
    () => {
      source.sqlite.run("DELETE FROM diary_meals WHERE id = ?", meal.id);
      return undefined;
    },
  );
  source.sqlite.run("INSERT INTO edo_sync_receipts VALUES (?)", "accepted-meal");
  source.sqlite.run("INSERT INTO edo_sync_submission_ids VALUES (?)", "accepted-meal");
  source.sqlite.run(
    "INSERT INTO edo_sync_meal_projections VALUES (?, 1, 'accepted', ?)",
    meal.id,
    JSON.stringify(meal),
  );
  const serverCopy = { kind: "meal", id: meal.id, state: "deleted", revision: 2 };
  source.sqlite.run(
    "INSERT INTO edo_sync_remote VALUES ('meal', ?, 2, ?)",
    meal.id,
    JSON.stringify(serverCopy),
  );
  const before = new Map(
    journalTables(source.sqlite).map((name) => [name, source.sqlite.all(`SELECT * FROM ${name}`)]),
  );
  const interrupted: DiarySqliteConnection = {
    ...source.sqlite,
    exec: (sql) => {
      source.sqlite.exec(sql);
      if (sql.includes("CREATE TABLE edo_sync_staged_meal_claims")) {
        throw new Error("Simulated v7 interruption");
      }
    },
  };
  await expect(
    openDiary({ connection: interrupted, backupBeforeMigration: source.backupBeforeMigration }),
  ).rejects.toThrow("Simulated v7 interruption");
  expect(source.sqlite.get("PRAGMA user_version")).toEqual({ user_version: 6 });
  expect(journalTables(source.sqlite)).toEqual([...before.keys()]);
  for (const [name, rows] of before) {
    expect(source.sqlite.all(`SELECT * FROM ${name}`)).toEqual(rows);
  }
  source.db.close();

  const retry = openFile(source.path, source.dir);
  const diary = await retry.open();
  expect(retry.sqlite.get("PRAGMA user_version")).toEqual({ user_version: 7 });
  expect(retry.sqlite.all("SELECT * FROM edo_sync_staged_meal_claims")).toEqual([]);
  expect(JSON.parse(diary.exportPrivateArchive())).toEqual({
    ...v4Archive,
    meals: v4Archive.meals.filter((entry: { id: string }) => entry.id !== meal.id),
  });
  expect(diary.sync.journal.serverCopy({ kind: "meal", id: meal.id })).toEqual(serverCopy);
  expect(diary.sync.journal.queued()).toMatchObject([
    {
      key: { kind: "meal", id: meal.id },
      pending: { op: "delete", submissionId: "pending-delete" },
    },
  ]);
  using backup = new DatabaseSync(join(source.dir, "prior-v6-diary.sqlite"), { readOnly: true });
  expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(journalTables(connection(backup))).toEqual([...before.keys()]);
  for (const [name, rows] of before) {
    expect(retry.sqlite.all(`SELECT * FROM ${name}`)).toEqual(rows);
    expect(backup.prepare(`SELECT * FROM ${name}`).all()).toEqual(rows);
  }
  await expect(
    migrateDiary(retry.sqlite, v6Migrations, retry.backupBeforeMigration, () => {}),
  ).rejects.toThrow("saved by a newer version of Edo");
  expect(retry.sqlite.get("PRAGMA user_version")).toEqual({ user_version: 7 });
});

test.each([
  "edo_sync_submission_ids",
  "edo_sync_meal_projections",
  "edo_sync_staged_meal_claims",
] as const)(
  "rejects a backup that drops a row from %s before a subsequent migration",
  async (table) => {
    const source = fixture();
    await source.open();
    source.sqlite.run("INSERT INTO edo_sync_submission_ids (submission_id) VALUES (?)", "reserved");
    source.sqlite.run(
      "INSERT INTO edo_sync_meal_projections VALUES (?, 2, 'accepted', ?)",
      "meal",
      '{"id":"meal"}',
    );
    source.sqlite.run(
      "INSERT INTO edo_sync_staged_meal_claims VALUES (?, ?, 1)",
      "meal",
      '["item"]',
    );

    await expect(
      migrateDiary(
        source.sqlite,
        [...diaryMigrations, () => {}],
        async (_, verify) => {
          const copy = join(source.dir, "missing-submission.sqlite");
          await copyDatabase(source.path, copy);
          const incomplete = new DatabaseSync(copy);
          try {
            incomplete.exec(`DELETE FROM ${table}`);
            verify(connection(incomplete));
          } finally {
            incomplete.close();
          }
        },
        () => {},
      ),
    ).rejects.toThrow("Diary backup does not match the current diary");
    expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(7);
    expect(source.sqlite.get(`SELECT count(*) AS count FROM ${table}`)).toEqual({ count: 1 });
  },
);
