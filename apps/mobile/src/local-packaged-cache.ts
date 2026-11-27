import { openPackagedFoodCache } from "@edo/storage";
import { Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

export async function openLocalPackagedCache() {
  const db = await openDatabaseAsync(
    "edo-packaged-foods.db",
    { useNewConnection: true },
    Paths.cache.uri,
  );
  try {
    return { cache: openPackagedFoodCache(connectionFor(db)), close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
