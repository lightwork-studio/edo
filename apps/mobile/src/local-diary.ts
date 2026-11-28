import { type OpenDiaryOptions, openDiary } from "@edo/storage";
import { File } from "expo-file-system";
import { moveAsync } from "expo-file-system/legacy";
import { backupDatabaseAsync, deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

const diaryName = "edo-diary.db";
let pendingOpen = Promise.resolve();

const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
  version,
  verify,
) => {
  const sourceDatabase = await openDatabaseAsync(diaryName, { useNewConnection: true });
  try {
    const sourceUri = `file://${sourceDatabase.databasePath.split("/").map(encodeURIComponent).join("/")}`;
    const directory = new File(sourceUri).parentDirectory;
    // The diary migration holds its write lock, so no other backup can own these partial copies.
    for (const entry of directory.list()) {
      if (
        entry instanceof File &&
        /^\.edo-diary-v\d+-[0-9a-f]{32}\.db\.partial$/.test(entry.name)
      ) {
        await deleteDatabaseAsync(entry.name);
      }
    }
    const identity = await sourceDatabase.getFirstAsync<{ id: string }>(
      "SELECT lower(hex(randomblob(16))) AS id",
    );
    if (!identity || !/^[0-9a-f]{32}$/.test(identity.id)) {
      throw new Error("Could not generate a diary backup name");
    }
    const backupName = `edo-diary-v${version}-${identity.id}.db`;
    const stagedName = `.${backupName}.partial`;
    const staged = new File(directory, stagedName);
    const published = new File(directory, backupName);
    if (staged.exists || published.exists) {
      throw new Error("Diary backup destination is already in use");
    }
    try {
      const destDatabase = await openDatabaseAsync(stagedName, { useNewConnection: true });
      try {
        await backupDatabaseAsync({ sourceDatabase, destDatabase });
        const journal = await destDatabase.getFirstAsync<{ journal_mode: string }>(
          "PRAGMA journal_mode = DELETE",
        );
        if (journal?.journal_mode !== "delete") throw new Error("Diary backup must be standalone");
        verify(connectionFor(destDatabase));
      } finally {
        await destDatabase.closeAsync();
      }
      // For local files the native legacy move renames in place, including on Android 7.
      await moveAsync({ from: staged.uri, to: published.uri });
    } catch (error) {
      await deleteDatabaseAsync(stagedName).catch(() => undefined);
      throw error;
    }
  } finally {
    await sourceDatabase.closeAsync();
  }
};

async function openLocalDiaryConnection() {
  const db = await openDatabaseAsync(diaryName, { useNewConnection: true });
  try {
    const connection = connectionFor(db);
    const diary = await openDiary({ connection, backupBeforeMigration });
    if (connection.get("SELECT 1 FROM edo_sync_binding LIMIT 1")) {
      console.info("EDO_NATIVE_SYNC_BLOCKERS_REOPENED");
    } else {
      db.withTransactionSync(() => {
        connection.exec(`INSERT INTO edo_sync_binding
          VALUES (1, 'https://example.test', 'fixture-account', 'fixture-lineage', 2, 1)`);
        for (const kind of ["meal", "weigh-in"]) {
          const key = { kind, id: `native-${kind}` };
          const submissionId = `original-${kind}`;
          const content = { name: "Private fixture content" };
          const record = {
            key,
            baseRevision: null,
            base: null,
            pending: kind === "meal" ? { op: "delete", submissionId: "latest-meal" } : null,
            attempt: null,
            blocked: {
              submission: { ...key, submissionId, baseRevision: null, op: "put", content },
              result:
                kind === "meal"
                  ? {
                      submissionId,
                      status: "conflict",
                      reason: "exists",
                      current: { ...key, state: "live", revision: 1, content },
                    }
                  : {
                      submissionId,
                      status: "rejected",
                      code: "invalid-content",
                      message: "Fixture",
                    },
            },
          };
          connection.run(
            "INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)",
            key.kind,
            key.id,
            JSON.stringify(record),
          );
        }
      });
    }
    return {
      diary,
      newId() {
        const row = db.getFirstSync<{ id: string }>("SELECT lower(hex(randomblob(16))) AS id");
        if (!row) throw new Error("Could not allocate a diary ID");
        return row.id;
      },
      close: () => db.closeAsync(),
    };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

/** Serialize opens while a migration waits for its backup and return an owned handle to each caller. */
export function openLocalDiary() {
  const opened = pendingOpen.then(openLocalDiaryConnection);
  pendingOpen = opened.then(
    () => undefined,
    () => undefined,
  );
  return opened;
}
