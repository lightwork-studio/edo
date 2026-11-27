import { type DiarySqliteConnection, type OpenDiaryOptions, openDiary } from "@edo/storage";
import { backupDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

const diaryName = "edo-diary.db";

function connectionFor(db: SQLiteDatabase): DiarySqliteConnection {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, ...parameters) => {
      db.runSync(sql, ...parameters);
    },
    all: (sql, ...parameters) => db.getAllSync(sql, ...parameters),
    get: (sql, ...parameters) => db.getFirstSync(sql, ...parameters) ?? undefined,
  };
}

const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
  version,
  verify,
) => {
  const sourceDatabase = await openDatabaseAsync(diaryName, { useNewConnection: true });
  try {
    const identity = await sourceDatabase.getFirstAsync<{ id: string }>(
      "SELECT lower(hex(randomblob(16))) AS id",
    );
    if (!identity || !/^[0-9a-f]{32}$/.test(identity.id)) {
      throw new Error("Could not generate a diary backup name");
    }
    const destDatabase = await openDatabaseAsync(`edo-diary-v${version}-${identity.id}.db`, {
      useNewConnection: true,
    });
    try {
      const header = await destDatabase.getFirstAsync<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const table = await destDatabase.getFirstAsync("SELECT name FROM sqlite_schema");
      if (header?.user_version !== 0 || table) {
        throw new Error("Diary backup destination is already in use");
      }
      await backupDatabaseAsync({ sourceDatabase, destDatabase });
      // The migration proceeds only after it verifies the published recovery copy.
      verify(connectionFor(destDatabase));
    } finally {
      await destDatabase.closeAsync();
    }
  } finally {
    await sourceDatabase.closeAsync();
  }
};

/** The diary and its migration snapshots are independent of the public catalog databases. */
export async function openLocalDiary() {
  const db = await openDatabaseAsync(diaryName, { useNewConnection: true });
  try {
    const diary = await openDiary({ connection: connectionFor(db), backupBeforeMigration });
    return { diary, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
