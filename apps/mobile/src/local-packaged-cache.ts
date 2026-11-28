import { openPackagedFoodCache } from "@edo/storage";
import { File, Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

export async function openLocalPackagedCache() {
  const db = await openDatabaseAsync(
    "edo-packaged-foods.db",
    { useNewConnection: true },
    Paths.cache.uri,
  );
  try {
    const connection = connectionFor(db);
    const marker = new File(Paths.document, "edo-native-offline-recipe");
    if (marker.exists) {
      const cache = openPackagedFoodCache(connection, 0);
      cache.prune([]);
      if (cache.search("Tomaten", Date.now()).length !== 0) {
        throw new Error("The native fixture must reopen with an empty public cache");
      }
      console.info("EDO_RECIPE_NATIVE_CACHE_EVICTED");
      return { cache, close: () => db.closeAsync() };
    }
    const cache = openPackagedFoodCache(connection);
    cache.save(
      [
        {
          id: { provider: "open-food-facts", sourceId: "fixture-recipe-juice" },
          name: "Fixture recipe juice",
          alternateName: "Tomatensaft",
          barcode: "034000470693",
          release: "offline-recipe-fixture",
          preparation: "as-sold",
          nutrition: {
            basis: "per-100-ml",
            nutrients: {
              kcal: 40,
              proteinG: 0,
              availableCarbohydratesG: null,
              fatG: null,
              fiberG: null,
            },
          },
        },
      ],
      Date.now() - 8 * 86400_000,
      [],
    );
    marker.create();
    return { cache, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
