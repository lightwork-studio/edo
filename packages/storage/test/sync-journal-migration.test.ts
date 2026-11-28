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
    "edo_sync_submission_ids",
  ]);
  expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(6);
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

test.each([false, true])("recovers v5 meal evidence (deletion: %s)", async (pendingDeletion) => {
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
  if (pendingDeletion) synced.sync.deleteMeal(meal.id, "newer-delete");
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
  expect(reopened.getMeal(meal.id)).toEqual(pendingDeletion ? null : meal);
  expect(reopened.sync.journal.mealProjection(meal.id)).toEqual(pendingDeletion ? null : evidence);
  expect(reopened.sync.journal.queued()).toMatchObject(
    pendingDeletion
      ? [{ key, baseRevision: 1, pending: { op: "delete", submissionId: "newer-delete" } }]
      : [],
  );
  expect(reopened.sync.journal.serverCopy(key)).toBeNull();
  expect(reopened.sync.journal.history()).toMatchObject({ revision: 1, cursor: 0 });
});

test.each(["edo_sync_submission_ids", "edo_sync_meal_projections"] as const)(
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
    expect(source.sqlite.get("PRAGMA user_version")?.user_version).toBe(6);
    expect(source.sqlite.get("SELECT submission_id FROM edo_sync_submission_ids")).toMatchObject({
      submission_id: "reserved",
    });
  },
);
