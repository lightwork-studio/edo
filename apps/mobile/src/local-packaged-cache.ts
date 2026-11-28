import { openPackagedFoodCache } from "@edo/storage";
import { Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

let firstCacheOpen = true;

export async function openLocalPackagedCache() {
  if (firstCacheOpen) {
    firstCacheOpen = false;
    throw new Error("Synthetic transient packaged cache failure");
  }
  const db = await openDatabaseAsync(
    "edo-packaged-foods.db",
    { useNewConnection: true },
    Paths.cache.uri,
  );
  try {
    const cache = openPackagedFoodCache(connectionFor(db));
    console.info("EDO_NATIVE_RECENT_FAVORITE_CACHE_RETRIED");
    return { cache, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
