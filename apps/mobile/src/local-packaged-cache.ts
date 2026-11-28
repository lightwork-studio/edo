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
    let cache = openPackagedFoodCache(connection);
    const barcode = "0000001234567";
    const benchmarkBarcode = "123456789013";
    const now = Date.now();
    const marker = new File(Paths.document, "edo-verified-large-barcode-fixture");
    const retained = ["old-0"];
    let saveMs: number | null = null;
    let remainingBeforeUiGroup: number | null = null;
    if (!marker.exists) {
      const sample = {
        release: "r",
        preparation: "as-sold" as const,
        alternateName: null,
        nutrition: null,
      };
      const nearLimit = Array.from({ length: 1559 }, (_, index) => ({
        ...sample,
        id: {
          provider: "open-food-facts" as const,
          sourceId: String(index).padStart(4, "0"),
        },
        barcode: benchmarkBarcode,
        name: "A",
      }));
      const older = Array.from({ length: 1000 }, (_, index) => ({
        ...sample,
        id: { provider: "open-food-facts" as const, sourceId: `old-${index}` },
        barcode: String(20000000 + index),
        name: `cache ${"A".repeat(3900)}`,
      }));
      cache.save(older, now - 1, retained);
      cache = openPackagedFoodCache(connection);
      const saveStarted = performance.now();
      cache.saveBarcodeCandidates(benchmarkBarcode, nearLimit, now, retained);
      saveMs = Math.round(performance.now() - saveStarted);
      const row = connection.get(
        "SELECT count(*) AS count FROM packaged_food WHERE source_id GLOB 'old-*'",
      );
      if (row?.count !== 967) throw new Error("Near-limit native batch changed eviction");
      remainingBeforeUiGroup = row.count;
      const products = Array.from({ length: 101 }, (_, index) => ({
        id: {
          provider: "open-food-facts" as const,
          sourceId: `verification-variant-${String(index).padStart(3, "0")}`,
        },
        release: "verification-large-barcode",
        barcode: index === 0 ? barcode : `0${barcode}`,
        name: index === 100 ? "Fixture selected variant" : `Fixture variant ${index + 1}`,
        alternateName: null,
        preparation: "as-sold" as const,
        nutrition: {
          basis: "per-100-g" as const,
          nutrients: {
            kcal: index === 100 ? 80 : 20,
            proteinG: null,
            availableCarbohydratesG: null,
            fatG: null,
            fiberG: null,
          },
        },
      }));
      cache.saveBarcodeCandidates(barcode, products, now, retained);
      marker.create();
    }
    const readStarted = performance.now();
    const bulk = cache.lookupBarcode(benchmarkBarcode, Date.now());
    const readMs = Math.round(performance.now() - readStarted);
    if (bulk.length !== 1559 || cache.findByIds(retained, Date.now()).length !== 1) {
      throw new Error("Near-limit native barcode group lost candidates or a retained food");
    }
    console.info(
      "EDO_BULK_BARCODE_METRICS",
      JSON.stringify({ saveMs, readMs, products: bulk.length, remainingBeforeUiGroup }),
    );
    const checked = cache.lookupBarcode(barcode, now);
    if (
      checked.length !== 101 ||
      checked[0]?.product.name !== "Fixture variant 1" ||
      checked[100]?.product.name !== "Fixture selected variant"
    ) {
      throw new Error("Native cache did not retain the full ordered barcode group");
    }
    return { cache, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
