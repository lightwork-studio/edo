import { openPackagedFoodCache } from "@edo/storage";
import { openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

export async function openLocalPackagedCache() {
  const db = await openDatabaseAsync("edo-packaged-foods.db", { useNewConnection: true });
  try {
    return { cache: openPackagedFoodCache(connectionFor(db)), close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
