import { createDiaryItem, manualNutritionTarget } from "@edo/core";
import { type OpenDiaryOptions, openDiary } from "@edo/storage";
import { File } from "expo-file-system";
import { moveAsync } from "expo-file-system/legacy";
import { backupDatabaseAsync, deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import { addDays, calendarDate, localDay } from "./diary-view";
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
    const diary = await openDiary({ connection: connectionFor(db), backupBeforeMigration });
    const today = localDay(new Date());
    if (!diary.nutritionTargetAt(today)) {
      const when = (day: string) => calendarDate(day).setUTCHours(12);
      for (const [offset, kcal] of [
        [-7, 2050],
        [-1, 2150],
      ] as const) {
        const effectiveDay = addDays(today, offset);
        diary.saveNutritionTarget({
          id: `progress-target-${offset}`,
          effectiveDay,
          configuredAt: when(effectiveDay),
          mode: "manual",
          target: manualNutritionTarget({ kcal, proteinG: 150, fatG: 70 }),
        });
      }
      const sample = [
        { offset: -3, kcal: 61.5, proteinG: 8, availableCarbohydratesG: 7, fatG: 1 },
        { offset: -2, kcal: 2080, proteinG: 70, availableCarbohydratesG: 160, fatG: 60 },
        { offset: -1, kcal: 2240, proteinG: 80, availableCarbohydratesG: 175, fatG: 70 },
        { offset: 0, kcal: 1064, proteinG: 73, availableCarbohydratesG: 136, fatG: 21 },
      ];
      for (const { offset, ...nutrients } of sample) {
        const localDay = addDays(today, offset);
        const id = `progress-meal-${offset}`;
        diary.saveMeal({
          id,
          localDay,
          occurredAt: when(localDay),
          utcOffsetMinutes: 0,
          items: [
            createDiaryItem(
              `${id}-meal`,
              {
                id: { provider: "local", sourceId: id },
                name: "Synthetic meal",
                release: null,
                preparation: "prepared",
                nutrition: { basis: "per-100-g", nutrients: { ...nutrients, fiberG: 0 } },
              },
              { amount: 100, unit: "g" },
            ),
          ],
        });
      }
      for (const [offset, kg] of [
        [-5, 79.7],
        [-3, 79.3],
        [-1, 78.5],
        [0, 78.4],
      ] as const) {
        const localDay = addDays(today, offset);
        diary.saveWeighIn({
          id: `progress-weight-${offset}`,
          localDay,
          occurredAt: calendarDate(localDay).getTime(),
          kg,
        });
      }
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
