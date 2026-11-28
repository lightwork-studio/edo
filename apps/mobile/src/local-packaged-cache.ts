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
    const barcode = "034000470693";
    const now = Date.now();
    if (!cache.lookupBarcode(barcode, now).length) {
      cache.saveBarcodeCandidates(
        barcode,
        [
          {
            id: { provider: "open-food-facts", sourceId: "synthetic-juice" },
            name: "Carrot juice",
            alternateName: "Möhrensaft",
            barcode,
            release: "native-fixture",
            preparation: "as-sold",
            nutrition: {
              basis: "per-100-ml",
              nutrients: { kcal: 41, proteinG: 0, availableCarbohydratesG: 10, fatG: 0, fiberG: 0 },
            },
          },
        ],
        now,
        [],
      );
    }
    return { cache, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
