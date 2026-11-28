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
      console.info("EDO_NATIVE_WEIGH_IN_REVIEW_REOPENED");
    } else {
      const key = { kind: "weigh-in", id: "native-weigh-in-review" };
      const phone = {
        id: key.id,
        kg: 80.0021,
        localDay: "2026-11-10",
        occurredAt: Date.UTC(2026, 10, 11, 0, 30, 0, 3),
        phoneDetail: "Private phone sentinel",
      };
      const account = {
        ...key,
        revision: 3,
        state: "live",
        content: {
          ...phone,
          kg: 81.0032,
          localDay: "2026-11-11",
          occurredAt: phone.occurredAt + 1,
          future: "Private account sentinel",
        },
      };
      const submission = {
        ...key,
        op: "put",
        baseRevision: 1,
        submissionId: "native-prior",
        content: phone,
      };
      const record = {
        key,
        baseRevision: 1,
        base: null,
        pending: { op: "put", submissionId: "native-latest", content: phone },
        attempt: null,
        blocked: {
          submission,
          result: {
            status: "conflict",
            reason: "stale",
            submissionId: submission.submissionId,
            current: { ...key, revision: account.revision, state: "unavailable" },
          },
        },
      };
      db.withTransactionSync(() => {
        connection.exec(`INSERT INTO edo_sync_binding
          VALUES (1, 'https://example.test', 'fixture-account', 'fixture-lineage', 3, 3)`);
        connection.run(
          "INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)",
          key.kind,
          key.id,
          JSON.stringify(record),
        );
        connection.run(
          "INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)",
          key.kind,
          key.id,
          account.revision,
          JSON.stringify(account),
        );
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
