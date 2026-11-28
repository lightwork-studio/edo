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
    const cache = openPackagedFoodCache(connectionFor(db));
    const barcode = "0000001234567";
    const checkedAt = Date.now();
    if (cache.lookupBarcode(barcode, checkedAt).length === 0) {
      cache.save(
        [
          { sourceId: "verification-oat", name: "Fixture oat drink", kcal: 50 },
          { sourceId: "verification-soy", name: "Fixture soy drink", kcal: 80 },
        ].map(({ sourceId, name, kcal }) => ({
          id: { provider: "open-food-facts", sourceId },
          release: "verification-candidates",
          barcode,
          name,
          alternateName: null,
          preparation: "as-sold",
          nutrition: {
            basis: "per-100-g",
            nutrients: {
              kcal,
              proteinG: null,
              availableCarbohydratesG: null,
              fatG: null,
              fiberG: null,
            },
          },
        })),
        checkedAt,
        [],
      );
    }
    return { cache, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
