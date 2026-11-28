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
    const now = new Date();
    const today = localDay(now);
    if (!diary.nutritionTargetAt(today)) {
      diary.saveNutritionTarget({
        id: "design-target",
        effectiveDay: addDays(today, -7),
        configuredAt: now.getTime(),
        mode: "manual",
        target: manualNutritionTarget({ kcal: 2150, proteinG: 150, fatG: 70 }),
      });
      function item(
        name: string,
        amount: number,
        kcal: number,
        protein: number,
        carbs: number,
        fat: number,
      ) {
        const value = 100 / amount;
        return createDiaryItem(
          `fixture-${name}`,
          {
            id: { provider: "local", sourceId: `fixture-${name}` },
            name,
            release: null,
            preparation: "prepared",
            nutrition: {
              basis: "per-100-g",
              nutrients: {
                kcal: kcal * value,
                proteinG: protein * value,
                availableCarbohydratesG: carbs * value,
                fatG: fat * value,
                fiberG: 0,
              },
            },
          },
          { amount, unit: "g" },
        );
      }
      const meal = (
        day: string,
        id: string,
        hour: number,
        minute: number,
        items: ReturnType<typeof item>[],
      ) =>
        diary.saveMeal({
          id,
          localDay: day,
          occurredAt: calendarDate(day).setUTCHours(hour, minute),
          utcOffsetMinutes: 0,
          items,
        });
      meal(today, "fixture-breakfast", 8, 10, [
        item("Haferflocken", 60, 222, 9, 39, 4),
        item("Skyr natur", 150, 95, 17, 6, 0.3),
        item("Heidelbeeren", 80, 46, 1, 12, 0.2),
      ]);
      meal(today, "fixture-lunch", 12, 40, [item("Hähnchen-Reis-Bowl", 250, 476, 36, 62, 10)]);
      meal(today, "fixture-dinner", 19, 30, [item("Brot mit Hummus", 150, 225, 10, 17, 6.5)]);
      meal(addDays(today, -2), "fixture-earlier", 12, 0, [
        item("Frühere Mahlzeit", 350, 2080, 70, 160, 60),
      ]);
      meal(addDays(today, -1), "fixture-later", 12, 0, [
        item("Letzte Mahlzeit", 350, 2240, 80, 175, 70),
      ]);
      meal(addDays(today, -3), "fixture-half-kcal", 9, 0, [
        item("Rundungstest", 82, 61.5, 8, 7, 1),
      ]);
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
