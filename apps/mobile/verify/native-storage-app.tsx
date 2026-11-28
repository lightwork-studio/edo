import { File } from "expo-file-system";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { useEffect } from "react";
import { Text } from "react-native";
import { openLocalDiary } from "../src/local-diary";
import {
  expectedArchive,
  expectedAttempt,
  expectedClaim,
  expectedMealId,
  expectedObservation,
  expectedPriorMeal,
  expectedRemote,
  expectedWeighIn,
  fixtureSql,
} from "./diary-v9-data";
import {
  enableInterruption,
  journalTables,
  publishRecoveryMarker,
  recoveryMarker,
} from "./native-storage-fault";

const diaryName = "edo-diary.db";

async function withDatabase<T>(name: string, operation: (db: SQLiteDatabase) => Promise<T>) {
  const db = await openDatabaseAsync(name, { useNewConnection: true });
  try {
    return await operation(db);
  } finally {
    await db.closeAsync();
  }
}

function equal(actual: unknown, expected: unknown, message: string) {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, part: unknown) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const record = part as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    });
  if (canonical(actual) !== canonical(expected)) throw new Error(message);
}

async function tables(db: SQLiteDatabase, wildcard: string) {
  const rows = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB ? ORDER BY name",
    wildcard,
  );
  return rows.map(({ name }) => name);
}

async function sortedRows(db: SQLiteDatabase, table: string) {
  return (await db.getAllAsync(`SELECT * FROM "${table}"`))
    .map((row) => JSON.stringify(row))
    .sort();
}

async function v9Matches(source: SQLiteDatabase, expected: SQLiteDatabase) {
  equal(
    await source.getFirstAsync("PRAGMA user_version"),
    { user_version: 9 },
    "Expected v9 after interruption",
  );
  equal(
    await source.getFirstAsync("PRAGMA application_id"),
    await expected.getFirstAsync("PRAGMA application_id"),
    "Wrong diary identity",
  );
  equal(
    await source.getFirstAsync("PRAGMA quick_check"),
    { quick_check: "ok" },
    "Corrupt v9 diary",
  );
  const diaryTables = await tables(expected, "diary_*");
  const syncTables = await tables(expected, "edo_sync_*");
  equal(diaryTables.length, 8, "Expected eight diary fixture tables");
  equal(syncTables.length, 9, "Expected nine v9 sync fixture tables");
  equal(await tables(source, "diary_*"), diaryTables, "A v9 diary table was lost");
  equal(await tables(source, "edo_sync_*"), syncTables, "Unexpected v9 sync tables");
  const names = [...diaryTables, ...syncTables];
  for (const name of names) {
    equal(
      await sortedRows(source, name),
      await sortedRows(expected, name),
      `v9 rows changed in ${name}`,
    );
  }
}

function directoryFor(db: SQLiteDatabase) {
  return new File(`file://${db.databasePath.split("/").map(encodeURIComponent).join("/")}`)
    .parentDirectory;
}

function backups(directory: ReturnType<typeof directoryFor>) {
  return directory
    .list()
    .flatMap((entry) =>
      entry instanceof File && /^edo-diary-v9-[0-9a-f]{32}\.db$/.test(entry.name)
        ? [entry.name]
        : [],
    );
}

async function verifyUpgraded() {
  const opened = await openLocalDiary();
  try {
    equal(
      JSON.parse(opened.diary.exportPrivateArchive()),
      expectedArchive,
      "The native migration changed the diary archive",
    );
    equal(
      opened.diary.sync.journal.queued().map(({ attempt }) => attempt),
      [expectedAttempt],
      "The native migration changed an in-flight submission",
    );
    const history = opened.diary.sync.journal.history();
    equal(
      [history?.accountBinding, history?.lineage, history?.revision, history?.cursor],
      ["fixture-account", "fixture-lineage", 8, 8],
      "The native migration changed the account lineage or cursor",
    );
    equal(
      opened.diary.sync.journal.serverCopy({ kind: "meal", id: expectedMealId }),
      expectedRemote,
      "The native migration changed the cached account copy",
    );
  } finally {
    await opened.close();
  }
  return withDatabase(diaryName, async (db) => {
    equal(
      await db.getFirstAsync("PRAGMA user_version"),
      { user_version: 10 },
      "Missing committed v10 version",
    );
    equal(await tables(db, "edo_sync_*"), journalTables, "Missing committed journal tables");
    equal(
      await db.getFirstAsync(
        "SELECT id, revision, origin, content FROM edo_sync_meal_projections WHERE id = ?",
        expectedMealId,
      ),
      { id: expectedMealId, revision: 6, origin: "accepted", content: expectedPriorMeal },
      "The v10 migration changed the prior accepted evidence",
    );
    equal(
      await db.getFirstAsync(
        "SELECT id, item_ids, unknown_prior FROM edo_sync_staged_meal_claims WHERE id = ?",
        expectedMealId,
      ),
      { id: expectedMealId, item_ids: expectedClaim, unknown_prior: 1 },
      "The v10 migration changed the prior staged claim",
    );
    equal(
      await db.getAllAsync("SELECT id, revision, content FROM edo_sync_weigh_in_projections"),
      [expectedWeighIn],
      "The v10 migration changed the prior weigh-in evidence",
    );
    equal(
      await sortedRows(db, "edo_sync_attempt_observations"),
      [expectedObservation],
      "The v10 migration changed a displaced account copy",
    );
    equal(
      await sortedRows(db, "edo_sync_applied_weigh_ins"),
      [],
      "The v10 migration invented applied weigh-in evidence",
    );
    return backups(directoryFor(db));
  });
}

async function run() {
  if (!recoveryMarker("parked").exists) {
    await withDatabase(diaryName, (db) => db.execAsync(fixtureSql));
    enableInterruption();
    await openLocalDiary();
    throw new Error("The configured interruption did not fire");
  }

  if (!recoveryMarker("recovered").exists) {
    const firstBackup = await withDatabase("edo-expected-v9.db", async (expected) => {
      await expected.execAsync(fixtureSql);
      return withDatabase(diaryName, async (db) => {
        await v9Matches(db, expected);
        const names = backups(directoryFor(db));
        equal(names.length, 1, "Expected the verified pre-interruption backup");
        const [name] = names;
        if (!name) throw new Error("Missing v9 backup");
        await withDatabase(name, async (backup) => {
          equal(
            await backup.getFirstAsync("PRAGMA journal_mode"),
            { journal_mode: "delete" },
            "The v9 backup is not standalone",
          );
          await v9Matches(backup, expected);
        });
        return name;
      });
    });
    const names = await verifyUpgraded();
    if (names.length !== 2 || !names.includes(firstBackup))
      throw new Error("Retry discarded the original v9 backup");
    publishRecoveryMarker("recovered", firstBackup);
    return;
  }

  const firstBackup = recoveryMarker("recovered").textSync();
  const names = await verifyUpgraded();
  if (names.length !== 2 || !names.includes(firstBackup))
    throw new Error("Reopening lost the v9 backup");
  publishRecoveryMarker("reopened");
}

export default function NativeStorageVerification() {
  useEffect(() => {
    void run().catch((error: unknown) => publishRecoveryMarker("failed", String(error)));
  }, []);
  return <Text>Native diary recovery verification</Text>;
}
