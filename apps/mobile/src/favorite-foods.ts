import type { Food, FoodId } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import { foodForPackagedProduct } from "./barcode";
import { type CatalogDatabase, findBlsFoods } from "./catalog";
import type { Language } from "./strings";

export function foodKey(id: FoodId): string {
  return `${id.provider}:${id.sourceId}`;
}

export async function resolveFavoriteFoods({
  ids,
  localFoods,
  catalog,
  cache,
  language,
  accessedAt,
}: {
  ids: readonly FoodId[];
  localFoods: readonly Food[];
  catalog: CatalogDatabase | null;
  cache: Pick<PackagedFoodCache, "findByIds"> | null;
  language: Language;
  accessedAt: number;
}): Promise<ReadonlyMap<string, Food>> {
  const byId = new Map(localFoods.map((food) => [foodKey(food.id), food]));
  const offIds = ids
    .filter(({ provider }) => provider === "open-food-facts")
    .map(({ sourceId }) => sourceId);
  try {
    const cached = offIds.length ? cache?.findByIds(offIds, accessedAt) : undefined;
    for (const { product } of cached ?? []) {
      const food = foodForPackagedProduct(product);
      byId.set(foodKey(food.id), food);
    }
  } catch {
    // A disposable product cache can fail independently of the bundled and private foods.
  }
  if (catalog) {
    const blsIds = ids.filter(({ provider }) => provider === "bls").map(({ sourceId }) => sourceId);
    for (const food of await findBlsFoods(catalog, blsIds, language).catch(() => [])) {
      byId.set(foodKey(food.id), food);
    }
  }
  return byId;
}
