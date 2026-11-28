import { File } from "expo-file-system";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { useEffect } from "react";
import { Text } from "react-native";
import { openLocalDiary } from "../src/local-diary";
import { expectedArchive, fixtureSql } from "./diary-v4-data";
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
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

async function v4Matches(source: SQLiteDatabase, expected: SQLiteDatabase) {
  equal(
    await source.getFirstAsync("PRAGMA user_version"),
    { user_version: 4 },
    "Expected v4 after interruption",
  );
  equal(
    await source.getFirstAsync("PRAGMA application_id"),
    await expected.getFirstAsync("PRAGMA application_id"),
    "Wrong diary identity",
  );
  equal(
    await source.getFirstAsync("PRAGMA quick_check"),
    { quick_check: "ok" },
    "Corrupt v4 diary",
  );
  equal(await tables(source, "edo_sync_*"), [], "Uncommitted sync tables survived");
  const names = await tables(expected, "diary_*");
  equal(names.length, 8, "Expected eight fixture tables");
  equal(await tables(source, "diary_*"), names, "A v4 diary table was lost");
  for (const name of names) {
    equal(
      await sortedRows(source, name),
      await sortedRows(expected, name),
      `v4 rows changed in ${name}`,
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
      entry instanceof File && /^edo-diary-v4-[0-9a-f]{32}\.db$/.test(entry.name)
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
  } finally {
    await opened.close();
  }
  return withDatabase(diaryName, async (db) => {
    equal(
      await db.getFirstAsync("PRAGMA user_version"),
      { user_version: 5 },
      "Missing committed v5 version",
    );
    equal(await tables(db, "edo_sync_*"), journalTables, "Missing committed journal tables");
    for (const name of journalTables) {
      equal(await sortedRows(db, name), [], `Unexpected account data in ${name}`);
    }
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
    const firstBackup = await withDatabase("edo-expected-v4.db", async (expected) => {
      await expected.execAsync(fixtureSql);
      return withDatabase(diaryName, async (db) => {
        await v4Matches(db, expected);
        const names = backups(directoryFor(db));
        equal(names.length, 1, "Expected the verified pre-interruption backup");
        const [name] = names;
        if (!name) throw new Error("Missing v4 backup");
        await withDatabase(name, async (backup) => {
          equal(
            await backup.getFirstAsync("PRAGMA journal_mode"),
            { journal_mode: "delete" },
            "The v4 backup is not standalone",
          );
          await v4Matches(backup, expected);
        });
        return name;
      });
    });
    const names = await verifyUpgraded();
    if (names.length !== 2 || !names.includes(firstBackup))
      throw new Error("Retry discarded the original v4 backup");
    publishRecoveryMarker("recovered", firstBackup);
    return;
  }

  const firstBackup = recoveryMarker("recovered").textSync();
  const names = await verifyUpgraded();
  if (names.length !== 2 || !names.includes(firstBackup))
    throw new Error("Reopening lost the v4 backup");
  publishRecoveryMarker("reopened");
}

export default function NativeStorageVerification() {
  useEffect(() => {
    void run().catch((error: unknown) => publishRecoveryMarker("failed", String(error)));
  }, []);
  return <Text>Native diary recovery verification</Text>;
}
