import { createDiaryItem, type Food } from "@edo/core";
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
    const diary = await openDiary({ connection: connectionFor(db), backupBeforeMigration });
    if (!diary.listCustomFoods().length) {
      const food = (sourceId: string, name: string, kcal: number): Food => ({
        id: { provider: "local", sourceId },
        name,
        release: null,
        preparation: "prepared",
        nutrition: {
          basis: "per-100-g",
          nutrients: { kcal, proteinG: 2, availableCarbohydratesG: 6, fatG: 1, fiberG: null },
        },
      });
      const applesauce = food("native-applesauce", "Äpfelmus", 60);
      const yogurt = food("native-yogurt", "Mock yogurt", 100);
      diary.saveCustomFood(applesauce);
      diary.saveCustomFood(yogurt);
      diary.setFavorite(yogurt.id, true);
      const ingredients = [
        createDiaryItem("applesauce-item", applesauce, { amount: 100, unit: "g" }),
      ];
      diary.saveRecipe({ id: "native-muesli", name: "Müsli mit Apfel", servings: 1, ingredients });
      diary.saveMealTemplate({ id: "native-meal", name: "Porridge breakfast", items: ingredients });
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
